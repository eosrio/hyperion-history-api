import {createHash} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {loadChainProtocol} from '../../indexer/protocol/selection.js';
import {ProtocolAbiFrontierStore} from '../../indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader, ProtocolAbiProofUnavailableError,
    type ProtocolActionProofMetadata, type ProtocolAbiProofView} from '../../indexer/protocol/abi-proof.js';
import {ProtocolNativeActionReader, ProtocolNativeActionUnavailableError,
    type ProtocolNativeActionProofMetadata, type ProtocolNativeActionView, type ProtocolNativeActionGrant} from '../../indexer/protocol/native-authorization.js';
import {ProtocolNativeObservationStore} from '../../indexer/protocol/native-observation-store.js';
import {protocolImmutableJson} from '../../indexer/protocol/immutable-bundle-store.js';
import {parseProtocolNativeActionMetadata} from '../../indexer/protocol/native-action-metadata.js';
import {isProtocolHex} from '../../indexer/protocol/hex.js';
import {assertProtocolProofRequestActive, withProtocolProofRequest} from './protocol-proof-request.js';

type ActionMetadata = ProtocolActionProofMetadata | ProtocolNativeActionProofMetadata;
interface NativeAuthority {
    readonly metadata: ProtocolNativeActionProofMetadata;
    readonly view: ProtocolNativeActionView;
    readonly grant: ProtocolNativeActionGrant;
    readonly value: unknown;
    readonly membership: ProtocolAbiProofView;
}
interface NativeProof extends NativeAuthority {readonly envelope: Readonly<Record<string, unknown>>}
type SelectedProtocol = Awaited<ReturnType<typeof loadChainProtocol>>;
const contexts = new WeakMap<FastifyInstance, Promise<ProtocolActionConsumer>>();
const requests = new WeakMap<object, {actions: ActionMetadata[]; views: ProtocolAbiProofView[];
    classifications: ProtocolNativeActionView[]; native: NativeProof[]; nodeResponse?: boolean}>();
const cacheProofKey = '_hyperion_protocol_abi_v3';
const maximumProtocolApiActions = 10000;
const actionResponseRoutes = new Set(['get_actions', 'get_transaction', 'get_block', 'get_controlled_accounts',
    'get_created_accounts', 'get_creator', 'get_key_accounts', 'get_resource_usage', 'get_account']);

export function isExtensionActionResponse(fastify: FastifyInstance, route: string): boolean {
    return fastify.manager.config.settings?.protocol?.provider === 'extension'
        && actionResponseRoutes.has(route);
}

/** Internal host service for an already selected, component-verified provider. It never loads executable code. */
export class ProtocolActionConsumer {
    readonly reader: ProtocolAbiProofReader;
    readonly nativeReader?: ProtocolNativeActionReader;
    constructor(private readonly host: FastifyInstance, readonly selected: SelectedProtocol) {
        const chain = host.manager.chain, chainId = host.manager.conn?.chains[chain]?.chain_id;
        if (!chainId) throw unavailable('Configured chain identity is unavailable');
        const profile = {id: selected.id, profileId: selected.provider.profileId, components: selected.components ?? []};
        this.reader = new ProtocolAbiProofReader({chainId, profile,
            maxAncestryBlocks: host.manager.config.settings.protocol_abi_coordination?.recovery_window_blocks,
            store: new ProtocolAbiFrontierStore(host.elastic, chain, host.manager.config.settings.es_replicas ?? 0, {readOnly: true})});
        this.nativeReader = selected.provider.nativeActions ? new ProtocolNativeActionReader({chainId, profile,
            provider: selected.provider, proofReader: this.reader,
            store: new ProtocolNativeObservationStore(host.elastic, chain,
                host.manager.config.settings.es_replicas ?? 0, undefined, {readOnly: true})}) : undefined;
    }
    belongsTo(host: FastifyInstance): boolean {
        // Fastify route plugins inherit their host's decorators through encapsulation.
        for (let current: object | null = host, depth = 0; current && depth < 64; current = Object.getPrototypeOf(current), depth++)
            if (current === this.host) return true;
        return false;
    }
}

async function context(fastify: FastifyInstance) {
    let value = contexts.get(fastify);
    if (!value) {
        const service = (fastify as FastifyInstance & {protocolActionConsumer?: ProtocolActionConsumer}).protocolActionConsumer;
        if (service !== undefined && (!(service instanceof ProtocolActionConsumer) || !service.belongsTo(fastify)))
            throw unavailable('has an invalid host action consumer');
        value = service ? Promise.resolve(service)
            : loadChainProtocol(fastify.manager.config.settings.protocol).then(selected => new ProtocolActionConsumer(fastify, selected));
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
    if (!value) {value = {actions: [], views: [], classifications: [], native: []}; requests.set(request, value);}
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

function successfulMetadata(input: any): input is ActionMetadata {
    const common = input && input.source && typeof input.selectionId === 'string' && input.input
        && Number.isInteger(input.input.inputActionOrdinal) && input.status === undefined;
    if (!common) return false;
    if (input.schemaVersion === 2) {
        const parsed = parseProtocolNativeActionMetadata(input);
        return parsed.kind === 'native' && !('status' in parsed);
    }
    const fields = input.schemaVersion === 1 ? ['schemaVersion', 'source', 'selectionId', 'input'] : [];
    return fields.length > 0 && Object.keys(input).length === fields.length && fields.every(key => Object.hasOwn(input, key));
}
const metadataJson = (value: unknown) => protocolImmutableJson(value, 64 * 1024 * 1024);
const copyMetadata = <T>(value: T): T => JSON.parse(metadataJson(value));

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
    if (!successfulMetadata(metadata) || metadata.schemaVersion !== 1) throw unavailable('requires complete contract occurrence metadata');
    return withProtocolProofRequest(scope, async options => {
        const selected = await context(fastify);
        const view = await selected.reader.waitForOpen(metadata.source, metadata.selectionId, options);
        let classification: ProtocolNativeActionView | undefined;
        if (view.nativeActionInterfaceVersion === 1) {
            if (!selected.nativeReader) throw unavailable('requires its installed native classification provider');
            classification = await selected.nativeReader.open(metadata.source, metadata.selectionId, options);
            const decision = await selected.nativeReader.authorize(classification, metadata.input, options);
            if (decision.kind !== 'contract') throw unavailable('cannot downgrade a native or incomplete origin to contract metadata');
        }
        const resolved = await selected.reader.action(view, metadata.input, options);
        return {...selected, view, resolved, classification};
    });
}

async function resolveNative(fastify: FastifyInstance, scope: object, metadata: ProtocolNativeActionProofMetadata): Promise<NativeAuthority> {
    if (!successfulMetadata(metadata) || metadata.schemaVersion !== 2) throw unavailable('requires complete native occurrence metadata');
    return withProtocolProofRequest(scope, async options => {
        const {reader, nativeReader} = await context(fastify);
        if (!nativeReader) throw unavailable('has no installed native provider');
        // Wait only for canonical membership, without selecting a deployed contract ABI.
        const membership = await reader.waitForOpen(metadata.source, metadata.selectionId, options);
        if (membership.nativeActionInterfaceVersion !== 1)
            throw unavailable('has no canonical native-classification epoch');
        const view = await nativeReader.open(metadata.source, metadata.selectionId, options);
        const decision = await nativeReader.authorize(view, metadata.input, options);
        if (decision.kind !== 'native') throw unavailable('does not select a supported native origin');
        const canonical = await nativeReader.metadata(decision.grant, options);
        if (metadataJson(canonical) !== metadataJson(metadata)) throw unavailable('does not match its canonical native journal references');
        const value = await nativeReader.decodeValue(decision.grant, options);
        return {metadata: canonical, view, grant: decision.grant, value, membership};
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
        const metadata = copyMetadata(action.protocol);
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
        if (metadata.schemaVersion === 2) {
            const proof = await resolveNative(fastify, request, metadata);
            const {nativeReader, selected} = await context(fastify);
            if (!nativeReader) throw unavailable('has no installed native provider');
            const envelope = await withProtocolProofRequest(request, readOptions => nativeReader.verifyEnvelope(proof.grant, action, readOptions));
            await withProtocolProofRequest(request, readOptions => nativeReader.verifyValue(proof.grant,
                data === undefined || retainedRaw ? proof.value : (envelope.act as any).data, readOptions));
            await withProtocolProofRequest(request, readOptions => nativeReader.revalidate(proof.view, readOptions));
            if (action.act.hex_data !== undefined && action.act.hex_data !== input.rawHex)
                throw unavailable('changes the native raw hex value');
            proofs.actions.push(copyMetadata(proof.metadata)); proofs.native.push({...proof, envelope: copyMetadata(envelope)});
            // Existing v1 renderers retain the act object before awaiting this helper.
            const act = action.act;
            for (const key of Object.keys(act)) delete act[key];
            Object.assign(act, envelope.act);
            for (const key of Object.keys(action)) delete action[key];
            Object.assign(action, envelope);
            action.act = act;
            if (options.decode || !retainedRaw) action.act.data = structuredClone(proof.value);
            if (annotation !== undefined) delete action[annotationKey];
            if (options.encoding) action.act.hex_encoder = selected.id;
            return input.rawHex;
        }
        const {reader, selected, view, resolved, classification} = await resolve(fastify, request, metadata);
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
        if (classification) proofs.classifications.push(classification);
        if (options.decode) action.act.data = certifiedValue;
        else if (!retainedRaw) action.act.data = enrichContractValue(certifiedValue, data, annotation);
        if (annotation !== undefined) delete action[annotationKey];
        if (options.encoding) action.act.hex_encoder = selected.id;
        return encoded;
    } catch (error) {
        assertProtocolProofRequestActive(request);
        if (error instanceof ProtocolAbiProofUnavailableError || error instanceof ProtocolNativeActionUnavailableError) throw error;
        throw unavailable('cannot validate the retained action');
    }
}

function bodyDigest(response: any): string {
    const {[cacheProofKey]: _proof, cached: _cached, query_time_ms: _time,
        last_indexed_block: _block, last_indexed_block_time: _blockTime, ...body} = response;
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function capsuleDigest(capsule: any): string {
    return createHash('sha256').update(JSON.stringify([capsule.schemaVersion, capsule.bodySha256,
        capsule.actions, capsule.nodeResponse === true])).digest('hex');
}

function hasDecodedActions(route: string, body: any): boolean {
    const actions = [...(body.actions ?? []).map((value: any) => value.action_trace ?? value), ...(body.traces ?? []),
        ...(body.simple_actions ?? []).map((value: any) => ({act: {data: value.data}})),
        ...(body.transactions ?? []).flatMap((value: any) => value.actions ?? [])];
    if (actions.some((value: any) => {
        const act = value.act ?? value;
        return act.data !== undefined && (!isProtocolHex(act.data, true) || act.hex_data !== undefined);
    })) return true;
    return (route === 'get_created_accounts' && body.accounts?.length > 0)
        || (route === 'get_controlled_accounts' && body.controlled_accounts?.length > 0)
        || (route === 'get_creator' && !!body.creator && body.creator !== '__self__');
}

function assertCachedActionCoverage(body: any, proofs: ReturnType<typeof requestProofs>): void {
    const candidates = [
        ...(body.actions ?? []).map((entry: any) => {const action = entry.action_trace ?? entry; return {
            action, account: action.act?.account, name: action.act?.name, trx: action.trx_id,
            block: action.block_num, ordinal: action.action_ordinal, sequence: entry.global_action_seq ?? action.global_sequence};}),
        ...(body.traces ?? []).map((action: any) => ({action, account: action.act?.account, name: action.act?.name,
            trx: action.trx_id ?? body.id, block: action.block_num, sequence: action.receipt?.global_sequence})),
        ...(body.simple_actions ?? []).map((action: any) => ({action, account: action.contract, name: action.action,
            trx: action.transaction_id, block: action.block})),
        ...(body.transactions ?? []).flatMap((transaction: any) => (transaction.actions ?? []).map((action: any) => ({
            action, account: action.account, name: action.action, trx: transaction.id, block: body.number, receiver: action.receiver}))),
    ];
    for (const candidate of candidates) {
        const act = candidate.action.act ?? candidate.action;
        if (act.data === undefined || (isProtocolHex(act.data, true) && act.hex_data === undefined)) continue;
        const matched = proofs.actions.some(metadata => {
            const input = metadata.input;
            if (candidate.account !== input.account || candidate.name !== input.name
                || candidate.trx !== input.transactionId || candidate.block !== metadata.source.blockNum
                || ('ordinal' in candidate && candidate.ordinal !== undefined && candidate.ordinal !== input.actionOrdinal)) return false;
            const membership = metadata.schemaVersion === 2
                ? proofs.native.find(proof => metadataJson(proof.metadata) === metadataJson(metadata))?.membership
                : proofs.views.find(view => view.selectionId === metadata.selectionId);
            if (!membership) return false;
            return membership.bindings.some(binding => binding.transactionId === input.transactionId
                && binding.inputActionOrdinal === input.inputActionOrdinal && binding.account === input.account && binding.name === input.name
                && (!('sequence' in candidate) || candidate.sequence === undefined || candidate.sequence === binding.globalSequence)
                && (!('receiver' in candidate) || candidate.receiver === undefined || candidate.receiver === binding.receiver));
        });
        if (!matched) throw unavailable('does not cover a decoded cached action occurrence');
    }
}

/** Cache metadata stays in Redis, never in public JSON or the contract payload. */
export async function protocolResponseForCache(fastify: FastifyInstance, request: FastifyRequest, route: string, response: any): Promise<any> {
    if (!isExtensionActionResponse(fastify, route)) return response;
    const proofs = requestProofs(request);
    // Render once before awaiting final authority. Neither cache nor returned JSON retains source/provider objects.
    const detached = JSON.parse(JSON.stringify(response));
    await revalidateProtocolActionScope(fastify, request);
    const capsule = {schemaVersion: 2, bodySha256: bodyDigest(detached), actions: proofs.actions.map(metadata =>
        metadata.schemaVersion === 1 ? {metadata} : (() => {
            const proof = proofs.native.find(proof => metadataJson(proof.metadata) === metadataJson(metadata));
            if (!proof) throw unavailable('lacks its checked native response');
            return {metadata, value: proof.value, envelope: proof.envelope};
        })()),
        ...(proofs.nodeResponse ? {nodeResponse: true} : {})};
    return {...detached, [cacheProofKey]: {...capsule, proofSha256: capsuleDigest(capsule)}};
}

/** The final cache/response snapshot shares no mutable source objects; its proof capsule stays private. */
export function protocolResponseForReturn(fastify: FastifyInstance, route: string, response: any): any {
    if (!isExtensionActionResponse(fastify, route)) return response;
    const {[cacheProofKey]: _proof, ...body} = response;
    return body;
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
    if (proofs.native.length) {
        await withProtocolProofRequest(scope, async options => {
            const {nativeReader} = await context(fastify);
            if (!nativeReader) throw unavailable('has no installed native provider');
            for (const proof of proofs.native) {
                await nativeReader.verifyEnvelope(proof.grant, proof.envelope, options);
                await nativeReader.verifyValue(proof.grant, proof.value, options);
                await nativeReader.revalidate(proof.view, options);
            }
        });
    }
    if (proofs.classifications.length) {
        await withProtocolProofRequest(scope, async options => {
            const {nativeReader} = await context(fastify);
            if (!nativeReader) throw unavailable('requires its installed native classification provider');
            for (const view of proofs.classifications) await nativeReader.revalidate(view, options);
        });
    }
    assertProtocolProofRequestActive(scope);
}

/** Unversioned response-cache entries miss; cached derived values reopen the exact proof before serving. */
export async function validateProtocolCachedResponse(fastify: FastifyInstance, request: FastifyRequest, route: string, response: any): Promise<boolean> {
    if (!isExtensionActionResponse(fastify, route)) return true;
    assertProtocolProofRequestActive(request);
    const detached = JSON.parse(JSON.stringify(response));
    const cached = detached?.[cacheProofKey];
    // Old capsules safely miss; this does not change schema-v1 ABI documents or public responses.
    if (cached?.schemaVersion !== 2 || !Array.isArray(cached.actions) || cached.actions.length > maximumProtocolApiActions
        || cached.bodySha256 !== bodyDigest(detached)) return false;
    if (route === 'get_key_accounts' && cached.nodeResponse !== true) return false;
    try {
        if (cached.proofSha256 !== capsuleDigest(cached))
            throw unavailable('has a changed cached proof capsule');
        if (cached.actions.length === 0 && !cached.nodeResponse && hasDecodedActions(route, detached))
            throw unavailable('lacks original cached occurrence metadata');
        const proofs = requestProofs(request);
        for (const entry of cached.actions) {
            const metadata = copyMetadata(entry?.metadata);
            if (!successfulMetadata(metadata))
                throw unavailable('has unsupported cached occurrence metadata');
            proofs.actions.push(metadata);
            if (metadata.schemaVersion === 2) {
                if (!Object.hasOwn(entry, 'value') || !Object.hasOwn(entry, 'envelope')) throw unavailable('lacks its checked native value or envelope');
                const proof = await resolveNative(fastify, request, metadata), {nativeReader} = await context(fastify);
                if (!nativeReader) throw unavailable('has no installed native provider');
                await withProtocolProofRequest(request, options => nativeReader.verifyValue(proof.grant, entry.value, options));
                const envelope = await withProtocolProofRequest(request, options => nativeReader.verifyEnvelope(proof.grant, entry.envelope, options));
                proofs.native.push({...proof, envelope});
            } else {
                const {reader, view, classification} = await resolve(fastify, request, metadata);
                await withProtocolProofRequest(request, options => reader.revalidate(view, options));
                proofs.views.push(view);
                if (classification) proofs.classifications.push(classification);
            }
        }
        assertCachedActionCoverage(detached, proofs);
        // Recheck earlier views after later asynchronous lookups, immediately before return.
        await revalidateProtocolActionScope(fastify, request);
        delete detached[cacheProofKey];
        for (const key of Object.keys(response)) delete response[key];
        Object.defineProperties(response, Object.getOwnPropertyDescriptors(detached));
        return true;
    } catch (error) {
        assertProtocolProofRequestActive(request);
        if (error instanceof ProtocolAbiProofUnavailableError || error instanceof ProtocolNativeActionUnavailableError) throw error;
        throw unavailable('cannot validate cached action evidence');
    }
}
