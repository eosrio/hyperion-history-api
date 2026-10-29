import type {FastifyInstance, FastifyReply, FastifyRequest, onSendAsyncHookHandler} from 'fastify';
import {composeStatefulOwnerReadV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {HyperionModuleLoader} from '../../indexer/modules/loader.js';
import {loadChainProtocol} from '../../indexer/protocol/selection.js';
import {protocolImmutableJson} from '../../indexer/protocol/immutable-bundle-store.js';
import {PortableProjectionSource} from '../../indexer/projection/source.js';
import {StatefulProjectionRegistryV2, type RegisteredStatefulProjectionV2} from '../../indexer/projection/stateful-registry.js';
import {statefulOwnerExpectationDigest, type StatefulOwnerExpectation} from '../../indexer/projection/stateful-controller.js';
import type {ResolvedStatefulOwnerConfigurationV2} from '../../indexer/projection/stateful-config.js';
import type {StatefulOwnerQueryHostV2, StatefulPluginApiContextV2} from '../../indexer/projection/stateful-plugin.js';
import {STATE_RESPONSE_HEADERS, stateResponseHeaders} from './state-headers.js';

export class StatefulApiUnavailableError extends Error {
    readonly statusCode = 503; readonly code = 'stateful.query-unavailable'; readonly retryable = true;
    readonly headers = {'retry-after': '1', 'cache-control': 'no-store'};
    constructor() {super('The requested projection is unavailable; retry later.');}
}
interface RequestProbe {currentSocket(): object | undefined; probe(target: string, signal: AbortSignal): Promise<boolean>}
interface RegistryPort {
    readonly entries: ReadonlyMap<string, RegisteredStatefulProjectionV2>;
    initializeMissing(): Promise<void>;
    assertSourceView: StatefulProjectionRegistryV2['assertSourceView'];
}
interface RequestState {
    readonly abort: AbortController; readonly timer: ReturnType<typeof setTimeout>; readonly connection: object | undefined;
    readonly deadline: number;
    readonly host: StatefulOwnerQueryHostV2; used: boolean; failed: boolean;
    result?: {registry: RegistryPort; entry: RegisteredStatefulProjectionV2; expected: StatefulOwnerExpectation};
}
const same = (left: unknown, right: unknown) => protocolImmutableJson(left) === protocolImmutableJson(right);
function requireReady(value: unknown): asserts value {if (!value) throw new StatefulApiUnavailableError();}
function cancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new StatefulApiUnavailableError());
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
    });
}

/** Real request composition and last route onSend hook; no listener, native handle or readiness setter is exposed. */
export function installStatefulApiHostV2(fastify: FastifyInstance, options: {configuration: ResolvedStatefulOwnerConfigurationV2;
    registry: () => Promise<RegistryPort>; probe: RequestProbe}): StatefulPluginApiContextV2 {
    const requests = new WeakMap<FastifyRequest, RequestState>();
    const started = new WeakMap<FastifyRequest, number>();
    const closed = new WeakSet<FastifyRequest>();
    fastify.addHook('onRequest', async (request, reply) => {
        started.set(request, performance.now());
        reply.raw.once('close', () => {if (!reply.raw.writableEnded) {closed.add(request); requests.get(request)?.abort.abort();}});
    });
    const guard = (state: RequestState) => {
        requireReady(!state.abort.signal.aborted && performance.now() < state.deadline && !state.failed
            && state.connection && options.probe.currentSocket() === state.connection);
    };
    const verify = async (state: RequestState) => {
        guard(state); const selected = state.result; requireReady(selected);
        const recovery = await selected.entry.adapter.recovery(); guard(state);
        requireReady(recovery?.initialized && recovery.owner && same(recovery.owner, selected.expected.owner)
            && same(recovery.view, selected.expected.view) && recovery.gap === null
            && (!recovery.rollback || recovery.rollback.status === 'complete'));
        await selected.registry.assertSourceView(selected.entry.declaration, selected.expected.view); guard(state);
        requireReady(await options.probe.probe(statefulOwnerExpectationDigest(selected.expected), state.abort.signal)); guard(state);
    };
    const failure = (reply: FastifyReply) => {
        for (const header of STATE_RESPONSE_HEADERS) reply.removeHeader(header);
        reply.removeHeader('content-length'); reply.removeHeader('etag');
        reply.code(503).header('retry-after', '1').header('cache-control', 'no-store').header('content-type', 'application/json; charset=utf-8');
        return JSON.stringify({statusCode: 503, code: 'stateful.query-unavailable', error: 'Service Unavailable',
            message: 'The requested projection is unavailable; retry later.'});
    };
    const publish: onSendAsyncHookHandler = async (request, reply, payload) => {
        const state = requests.get(request); if (!state?.used) return payload;
        try {
            requireReady(state.result && (typeof payload === 'string' || Buffer.isBuffer(payload)));
            requireReady(Buffer.byteLength(payload as string | Buffer) <= state.result.entry.declaration.projection.limits.responseBytes);
            await cancelled(verify(state), state.abort.signal); guard(state);
            reply.headers(stateResponseHeaders(state.result.expected.view));
            return payload;
        } catch {state.failed = true; return failure(reply);}
    };
    // Route hooks run after global onSend hooks, including plugin serialization work.
    fastify.addHook('onRoute', route => {
        const hooks = route.onSend ? Array.isArray(route.onSend) ? route.onSend : [route.onSend] : [];
        route.onSend = [...hooks.filter(hook => hook !== publish), publish];
    });
    fastify.addHook('onResponse', async request => {const state = requests.get(request); if (state) {clearTimeout(state.timer); state.abort.abort();}});
    return Object.freeze({statefulQueryHost(request: FastifyRequest) {
        const previous = requests.get(request); if (previous) return previous.host;
        const abort = new AbortController(), connection = options.probe.currentSocket();
        const deadline = (started.get(request) ?? performance.now()) + options.configuration.api.timeoutMs;
        if (closed.has(request) || request.raw.aborted) abort.abort();
        let state: RequestState;
        const host: StatefulOwnerQueryHostV2 = Object.freeze({interfaceVersion: 2, sourceInputVersion: 2,
            async compose(projectionId, compose) {
                try {
                    requireReady(!state.used); state.used = true; guard(state);
                    return await cancelled((async () => {
                        const registry = await options.registry(); guard(state); await registry.initializeMissing(); guard(state);
                        const entry = registry.entries.get(projectionId); requireReady(entry);
                        const recovery = await entry.adapter.recovery(); guard(state);
                        requireReady(recovery?.owner && recovery.initialized && recovery.view.checkpoint.blockNum > 0
                            && recovery.gap === null && (!recovery.rollback || recovery.rollback.status === 'complete'));
                        const expected = {declarationDigest: entry.declaration.digest, owner: recovery.owner, view: recovery.view};
                        state.result = {registry, entry, expected};
                        await verify(state);
                        const result = await composeStatefulOwnerReadV2(entry.declaration, entry.adapter, expected.owner.identity, expected.view,
                            compose, () => guard(state));
                        await verify(state); guard(state); return result;
                    })(), abort.signal);
                } catch {state.failed = true; throw new StatefulApiUnavailableError();}
            }});
        state = {abort, connection, deadline, timer: setTimeout(() => abort.abort(), Math.max(0, deadline - performance.now())), host, used: false, failed: false};
        requests.set(request, state);
        request.raw.once('aborted', () => abort.abort());
        request.raw.once('close', () => {if (request.raw.aborted) abort.abort();});
        return host;
    }});
}

/** Startup creates a lazy read-only attachment. Only ProjectionWorker acquires native ownership. */
export function statefulApiRegistryFactory(fastify: FastifyInstance, loader: HyperionModuleLoader,
    configuration: ResolvedStatefulOwnerConfigurationV2): () => Promise<StatefulProjectionRegistryV2> {
    let pending: Promise<StatefulProjectionRegistryV2> | undefined;
    return () => {
        pending ??= (async () => {
            const manager = fastify.manager; requireReady(manager.mongodbClient);
            const selected = await loadChainProtocol(manager.config.settings.protocol), chainId = manager.conn.chains[manager.chain].chain_id;
            const profile = {id: selected.id, profileId: selected.provider.profileId, components: selected.components ?? []};
            const source = new PortableProjectionSource({client: manager.elasticsearchClient, chain: manager.chain, chainId, profile, provider: selected.provider,
                maxAncestryBlocks: manager.config.settings.protocol_abi_coordination?.recovery_window_blocks,
                replicas: manager.config.settings.es_replicas ?? 0});
            return StatefulProjectionRegistryV2.create({chainId, configuration, mongo: manager.mongodbClient, client: manager.elasticsearchClient, source, profile}, loader);
        })().catch(error => {pending = undefined; throw error;});
        return pending;
    };
}
