import {createHash} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {loadChainProtocol} from '../../indexer/protocol/selection.js';
import {ProtocolAbiFrontierStore} from '../../indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError,
    type ProtocolActionProofMetadata, type ProtocolAbiProofView} from '../../indexer/protocol/abi-proof.js';
import {isProtocolHex} from '../../indexer/protocol/hex.js';

const contexts = new WeakMap<FastifyInstance, Promise<{selected: Awaited<ReturnType<typeof loadChainProtocol>>; reader: ProtocolAbiProofReader}>>();
const requests = new WeakMap<FastifyRequest, {actions: ProtocolActionProofMetadata[]; views: ProtocolAbiProofView[]}>();
const cacheProofKey = '_hyperion_protocol_abi_v2';
const maximumActions = 10000;

export function isExtensionActionResponse(fastify: FastifyInstance, route: string): boolean {
    return fastify.manager.config.settings?.protocol?.provider === 'extension'
        && (route === 'get_actions' || route === 'get_transaction');
}

async function context(fastify: FastifyInstance) {
    let value = contexts.get(fastify);
    if (!value) {
        value = (async () => {
            const selected = await loadChainProtocol(fastify.manager.config.settings.protocol);
            const chain = fastify.manager.chain;
            const chainId = fastify.manager.conn?.chains[chain]?.chain_id;
            if (!chainId) throw unavailable('Configured chain identity is unavailable');
            return {selected, reader: new ProtocolAbiProofReader({chainId,
                profile: {id: selected.id, profileId: selected.provider.profileId, components: selected.components ?? []},
                maxAncestryBlocks: fastify.manager.config.settings.protocol_abi_coordination?.recovery_window_blocks,
                store: new ProtocolAbiFrontierStore(fastify.elastic, chain, fastify.manager.config.settings.es_replicas ?? 0, {readOnly: true})})};
        })();
        contexts.set(fastify, value);
    }
    return value;
}

function unavailable(message: string): ProtocolAbiProofUnavailableError {
    return new ProtocolAbiProofUnavailableError('api_action_proof_unavailable',
        'Protocol action unavailable: source-bound ABI coverage ' + message);
}

function requestProofs(request: FastifyRequest) {
    let value = requests.get(request);
    if (!value) {value = {actions: [], views: []}; requests.set(request, value);}
    return value;
}

interface EncodingAbi {
    types?: {new_type_name: string; type: string}[];
    structs?: {name: string; base: string; fields: {name: string; type: string}[]}[];
    actions?: {name: unknown; type: string}[];
}

/** Projection enrichment is not part of an action's binary contract value. */
export function protocolActionInput(abi: EncodingAbi, type: string, data: unknown): unknown {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const seen = new Set<string>();
    const fields = (name: string): string[] | undefined => {
        if (seen.has(name) || seen.size >= 128) throw new Error('Invalid action ABI type ancestry');
        seen.add(name);
        const alias = abi.types?.find(entry => entry.new_type_name === name);
        if (alias) return fields(alias.type);
        const struct = abi.structs?.find(entry => entry.name === name);
        if (!struct) return;
        return [...(struct.base ? fields(struct.base) ?? [] : []), ...struct.fields.map(field => field.name)];
    };
    const allowed = fields(type);
    return allowed ? Object.fromEntries(allowed.filter(name => Object.hasOwn(data, name))
        .map(name => [name, (data as Record<string, unknown>)[name]])) : data;
}

function successfulMetadata(input: any): input is ProtocolActionProofMetadata {
    return input?.schemaVersion === 1 && input.status === undefined && input.source
        && typeof input.selectionId === 'string' && input.input && Number.isInteger(input.input.inputActionOrdinal);
}

async function resolve(fastify: FastifyInstance, metadata: ProtocolActionProofMetadata) {
    if (!successfulMetadata(metadata)) throw unavailable('requires complete original occurrence metadata');
    const selected = await context(fastify);
    const view = await selected.reader.waitForOpen(metadata.source, metadata.selectionId);
    const resolved = await selected.reader.action(view, metadata.input);
    return {...selected, view, resolved};
}

/** Call before grouping/shaping drops original anchors. Raw history remains available without ABI authority. */
export async function protectProtocolAction(fastify: FastifyInstance, request: FastifyRequest, action: any, encoding = false): Promise<string | undefined> {
    if (fastify.manager.config.settings?.protocol?.provider !== 'extension') return;
    const data = action.act?.data;
    const retainedRaw = isProtocolHex(data, true) && (action.protocol === undefined
        || action.protocol?.input?.rawHex === data.toLowerCase());
    if (!encoding && (data === undefined || retainedRaw)) {
        return;
    }
    try {
        const metadata = action.protocol;
        if (!successfulMetadata(metadata)) throw unavailable('requires complete original occurrence metadata');
        const input = metadata.input;
        if (action.block_num !== metadata.source.blockNum || action.block_id !== metadata.source.blockId
            || action.trx_id !== input.transactionId || action.action_ordinal !== input.actionOrdinal
            || action.act?.account !== input.account || action.act?.name !== input.name
            || !Array.isArray(action.receipts) || !action.receipts.some((receipt: any) => receipt.receiver === input.receiver)) {
            throw unavailable('does not match the indexed action occurrence');
        }
        const proofs = requestProofs(request);
        if (proofs.actions.length >= maximumActions) throw unavailable('exceeds the bounded response proof budget');
        const {reader, selected, view, resolved} = await resolve(fastify, metadata);
        if (!resolved.state.present || !resolved.state.abiHex) throw unavailable('does not select a usable input ABI');
        const codec = selected.provider.contractCodec;
        const abi = codec.decodeAbi(Buffer.from(resolved.state.abiHex, 'hex')) as EncodingAbi;
        const type = abi.actions?.find(entry => String(entry.name) === input.name)?.type;
        if (!type) throw unavailable('does not define the requested action');
        const value = isProtocolHex(data, true) && data.toLowerCase() === input.rawHex
            ? codec.decodeValue(abi, type, Buffer.from(input.rawHex, 'hex')) : protocolActionInput(abi, type, data);
        const encoded = Buffer.from(codec.encodeValue(abi, type, value)).toString('hex');
        if (encoded !== input.rawHex) {
            throw unavailable('does not match the original raw action bytes');
        }
        await reader.revalidate(view);
        proofs.actions.push(structuredClone(metadata)); proofs.views.push(view);
        if (encoding) action.act.hex_encoder = selected.id;
        return encoded;
    } catch (error) {
        if (error instanceof ProtocolAbiProofUnavailableError) throw error;
        throw unavailable(String((error as Error)?.message ?? error).slice(0, 4096).toWellFormed());
    }
}

function bodyDigest(response: any): string {
    const {[cacheProofKey]: _proof, cached: _cached, query_time_ms: _time,
        last_indexed_block: _block, last_indexed_block_time: _blockTime, ...body} = response;
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** Cache metadata stays in Redis, never in public JSON or the contract payload. */
export async function protocolResponseForCache(fastify: FastifyInstance, request: FastifyRequest, route: string, response: any): Promise<any> {
    if (!isExtensionActionResponse(fastify, route)) return response;
    const proofs = requestProofs(request);
    if (proofs.views.length) {
        const {reader} = await context(fastify);
        for (const view of proofs.views) await reader.revalidate(view);
    }
    return {...response, [cacheProofKey]: {schemaVersion: 1, bodySha256: bodyDigest(response), actions: proofs.actions}};
}

/** Unversioned response-cache entries miss; cached derived values reopen the exact proof before serving. */
export async function validateProtocolCachedResponse(fastify: FastifyInstance, request: FastifyRequest, route: string, response: any): Promise<boolean> {
    if (!isExtensionActionResponse(fastify, route)) return true;
    const cached = response?.[cacheProofKey];
    if (cached?.schemaVersion !== 1 || !Array.isArray(cached.actions) || cached.actions.length > maximumActions
        || cached.bodySha256 !== bodyDigest(response)) return false;
    try {
        const proofs = requestProofs(request);
        for (const metadata of cached.actions) {
            const {reader, view} = await resolve(fastify, metadata);
            await reader.revalidate(view);
            proofs.views.push(view);
        }
        // Recheck earlier views after later asynchronous lookups, immediately before return.
        if (proofs.views.length) {
            const {reader} = await context(fastify);
            for (const view of proofs.views) await reader.revalidate(view);
        }
        delete response[cacheProofKey];
        return true;
    } catch (error) {
        if (error instanceof ProtocolAbiProofUnavailableError) throw error;
        throw unavailable(String((error as Error)?.message ?? error).slice(0, 4096).toWellFormed());
    }
}
