import {createHash} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {loadChainProtocol} from '../../indexer/protocol/selection.js';
import {ProtocolAbiFrontierStore} from '../../indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError,
    type ProtocolActionProofMetadata, type ProtocolAbiProofView} from '../../indexer/protocol/abi-proof.js';
import {isProtocolHex} from '../../indexer/protocol/hex.js';
import {assertProtocolProofRequestActive, withProtocolProofRequest} from './protocol-proof-request.js';

const contexts = new WeakMap<FastifyInstance, Promise<{selected: Awaited<ReturnType<typeof loadChainProtocol>>; reader: ProtocolAbiProofReader}>>();
const requests = new WeakMap<object, {actions: ProtocolActionProofMetadata[]; views: ProtocolAbiProofView[]; nodeResponse?: boolean}>();
const cacheProofKey = '_hyperion_protocol_abi_v3';
const maximumProtocolApiActions = 10000;
const actionResponseRoutes = new Set(['get_actions', 'get_transaction', 'get_block', 'get_controlled_accounts',
    'get_created_accounts', 'get_creator', 'get_key_accounts', 'get_resource_usage', 'get_account']);

export function isExtensionActionResponse(fastify: FastifyInstance, route: string): boolean {
    return fastify.manager.config.settings?.protocol?.provider === 'extension'
        && actionResponseRoutes.has(route);
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

function requestProofs(request: object) {
    let value = requests.get(request);
    if (!value) {value = {actions: [], views: []}; requests.set(request, value);}
    return value;
}

/** Node-authorized key-account results do not rely on local decoded-field membership. */
export function markProtocolNodeResponse(request: object): void {
    requestProofs(request).nodeResponse = true;
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
        if (name.endsWith('?') || name.endsWith('$')) return fields(name.slice(0, -1));
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

/** Core handlers compact declared members into annotations. Restore absent members from
 * certified bytes, retaining supplied members so exact re-encoding still detects tampering.
 */
function restoreContractMembers(certified: any, retained: any, depth = 0): any {
    if (depth > 128) throw unavailable('exceeds the contract value traversal budget');
    if (Array.isArray(certified) && Array.isArray(retained)) {
        return retained.map((value, index) => index < certified.length
            ? restoreContractMembers(certified[index], value, depth + 1) : value);
    }
    if (certified && retained && typeof certified === 'object' && typeof retained === 'object'
        && !Array.isArray(certified) && !Array.isArray(retained)) {
        return Object.fromEntries([...new Set([...Object.keys(certified), ...Object.keys(retained)])].map(key => [key,
            !Object.hasOwn(retained, key) ? certified[key] : Object.hasOwn(certified, key)
                ? restoreContractMembers(certified[key], retained[key], depth + 1) : retained[key]]));
    }
    return retained;
}

/** Enrichment remains compatible, but declared contract members always come from certified bytes. */
function enrichContractValue(certified: any, retained: any, annotation: any, depth = 0): any {
    if (depth > 128) throw unavailable('exceeds the contract value traversal budget');
    if (Array.isArray(certified) && Array.isArray(retained)) {
        return certified.map((value, index) => enrichContractValue(value, retained[index], undefined, depth + 1));
    }
    if (certified && typeof certified === 'object' && !Array.isArray(certified)) {
        const original = retained && typeof retained === 'object' && !Array.isArray(retained) ? retained : {};
        const extra = annotation && typeof annotation === 'object' && !Array.isArray(annotation) ? annotation : {};
        return Object.fromEntries([...new Set([...Object.keys(extra), ...Object.keys(original), ...Object.keys(certified)])].map(key => [key,
            Object.hasOwn(certified, key) ? enrichContractValue(certified[key],
                Object.hasOwn(original, key) ? original[key] : undefined, Object.hasOwn(extra, key) ? extra[key] : undefined, depth + 1)
                : Object.hasOwn(original, key) ? original[key] : extra[key]]));
    }
    return retained === undefined ? certified : retained;
}

async function resolve(fastify: FastifyInstance, scope: object, metadata: ProtocolActionProofMetadata) {
    if (!successfulMetadata(metadata)) throw unavailable('requires complete original occurrence metadata');
    return withProtocolProofRequest(scope, async options => {
        const selected = await context(fastify);
        const view = await selected.reader.waitForOpen(metadata.source, metadata.selectionId, options);
        const resolved = await selected.reader.action(view, metadata.input, options);
        return {...selected, view, resolved};
    });
}

/** Call before grouping/shaping drops original anchors. Raw history remains available without ABI authority. */
export async function protectProtocolAction(fastify: FastifyInstance, request: object, action: any,
    options: {encoding?: boolean; decode?: boolean} = {}): Promise<string | undefined> {
    if (fastify.manager.config.settings?.protocol?.provider !== 'extension') return;
    assertProtocolProofRequestActive(request);
    const data = action.act?.data;
    const annotationKey = '@' + action.act?.name;
    const candidateAnnotation = annotationKey === '@timestamp' ? undefined : action[annotationKey];
    const annotation = candidateAnnotation !== null && typeof candidateAnnotation === 'object' && !Array.isArray(candidateAnnotation)
        ? candidateAnnotation : undefined;
    const retainedRaw = isProtocolHex(data, true) && (action.protocol === undefined
        || action.protocol?.input?.rawHex === data.toLowerCase());
    if (!options.encoding && !options.decode && ((data === undefined && annotation === undefined) || retainedRaw)) {
        if (annotation !== undefined) delete action[annotationKey];
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
        if (proofs.actions.length >= maximumProtocolApiActions) throw unavailable('exceeds the bounded response proof budget');
        const {reader, selected, view, resolved} = await resolve(fastify, request, metadata);
        if (!resolved.state.present || !resolved.state.abiHex) throw unavailable('does not select a usable input ABI');
        const codec = selected.provider.contractCodec;
        const abi = codec.decodeAbi(Buffer.from(resolved.state.abiHex, 'hex')) as EncodingAbi;
        const type = abi.actions?.find(entry => String(entry.name) === input.name)?.type;
        if (!type) throw unavailable('does not define the requested action');
        const certifiedValue = codec.decodeValue(abi, type, Buffer.from(input.rawHex, 'hex'));
        const value = data === undefined || retainedRaw ? certifiedValue
            : restoreContractMembers(certifiedValue, protocolActionInput(abi, type, data));
        const encoded = Buffer.from(codec.encodeValue(abi, type, value)).toString('hex');
        if (encoded !== input.rawHex) {
            throw unavailable('does not match the original raw action bytes');
        }
        await withProtocolProofRequest(request, options => reader.revalidate(view, options));
        proofs.actions.push(structuredClone(metadata)); proofs.views.push(view);
        if (options.decode) action.act.data = certifiedValue;
        else if (!retainedRaw) action.act.data = enrichContractValue(certifiedValue, data, annotation);
        if (annotation !== undefined) delete action[annotationKey];
        if (options.encoding) action.act.hex_encoder = selected.id;
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
    await revalidateProtocolActionScope(fastify, request);
    return {...response, [cacheProofKey]: {schemaVersion: 1, bodySha256: bodyDigest(response), actions: proofs.actions,
        ...(proofs.nodeResponse ? {nodeResponse: true} : {})}};
}

/** HTTP requests and individual stream batches own separate bounded proof scopes. */
export async function revalidateProtocolActionScope(fastify: FastifyInstance, scope: object): Promise<void> {
    assertProtocolProofRequestActive(scope);
    const proofs = requests.get(scope);
    if (!proofs) return;
    if (proofs.views.length) {
        await withProtocolProofRequest(scope, async options => {
            const {reader} = await context(fastify);
            for (const view of proofs.views) await reader.revalidate(view, options);
        });
    }
    assertProtocolProofRequestActive(scope);
}

/** Unversioned response-cache entries miss; cached derived values reopen the exact proof before serving. */
export async function validateProtocolCachedResponse(fastify: FastifyInstance, request: FastifyRequest, route: string, response: any): Promise<boolean> {
    if (!isExtensionActionResponse(fastify, route)) return true;
    assertProtocolProofRequestActive(request);
    const cached = response?.[cacheProofKey];
    if (cached?.schemaVersion !== 1 || !Array.isArray(cached.actions) || cached.actions.length > maximumProtocolApiActions
        || cached.bodySha256 !== bodyDigest(response)) return false;
    if (route === 'get_key_accounts' && cached.nodeResponse !== true) return false;
    try {
        const proofs = requestProofs(request);
        for (const metadata of cached.actions) {
            const {reader, view} = await resolve(fastify, request, metadata);
            await withProtocolProofRequest(request, options => reader.revalidate(view, options));
            proofs.views.push(view);
        }
        // Recheck earlier views after later asynchronous lookups, immediately before return.
        await revalidateProtocolActionScope(fastify, request);
        delete response[cacheProofKey];
        return true;
    } catch (error) {
        if (error instanceof ProtocolAbiProofUnavailableError) throw error;
        throw unavailable(String((error as Error)?.message ?? error).slice(0, 4096).toWellFormed());
    }
}
