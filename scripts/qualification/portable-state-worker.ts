/** #191 actual launcher + broker + portable Mongo adapter + HTTP qualification.
 * Lifecycle/namespace/observation patterns are adapted from PR236/239 wire-worker-replay.ts.
 * This driver imports no old source corpus or evidence archive and never initializes a projection.
 */
import assert from 'node:assert/strict';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {mkdir, open, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Client} from '@elastic/elasticsearch';
import {MongoClient} from 'mongodb';
import {Redis} from 'ioredis';
import type {ProjectionBinding, ProjectionDefinition, ProjectionQuery, ProjectionQueryResult, ProjectionRecoveryView} from '@eosrio/hyperion-sdk/projection';
import {validateFixture, assertNodeOwnership} from './es955-replicas.ts';
import {assertOwnedBinding, assertSuccessfulWorkerShutdown} from './es955-workers.ts';
import {startBulkLedger, summarizeBulkLedger} from './replay-bulk-ledger.ts';
import {createPortableHistoryDiagnostics, portableHistoryClock} from './portable-state-history-diagnostics.ts';
import {auditWorkerRejectionDiagnostics} from './worker-rejection-diagnostics.mjs';
import {OwnedMongoFixture, MONGODB_VERSION, waitForMongo} from './projection-fixture.mjs';
import {auditPortableWorkerSource, boundedPortableFile, ordinaryPortablePath, portableSourceHash,
    portableSourceLimits, servePortableWorkerSource, type PortableSourceInput, type PortableSourceFile,
    type PortableWorkerSource, type PortableSourceProfile} from './portable-state-worker-source.ts';
import {assertPortableWorkerOracle, portableWorkerAbiAvailability} from './portable-state-worker-oracle.ts';
import {auditPortableNativeOracle, createPortableNativeQualification, nativePortableHolds, portableLegacyProfile,
    portableNativeProfile, type PortableNativePhaseBudget} from './portable-state-worker-native.ts';
import {createPortableMongoSamples, samplePortableMongoIsolation} from './portable-state-mongo-sampling.ts';
import {auditPortableWorkerProfiles, portableWorkerProfileEnvironment, portableWorkerProfileLimits} from './portable-state-worker-profiles.ts';
import {createWireRecoveryControl, readWireRecoveryEvidence, auditWireAttemptRecovery, wireRecoveryShutdownRows} from './portable-state-worker-recovery.mjs';
import {createWireMasterRestartControl, inspectWireMasterCheckpoint, crashWireMaster, describeWireMasterCrash,
    auditWireMasterRestart} from './portable-state-master-recovery.mjs';
import {createWireReaderRecoveryControl, readWireReaderRecoveryEvidence, snapshotWireReader, describeWireReaderSnapshot,
    crashWireReader, describeWireReaderCrash, wireReaderStatus, releaseWireReaderRpc, auditWireReaderHandover,
    wireReaderShutdownRows, wireReaderControlDigest} from './portable-state-reader-recovery.mjs';
import {auditWireRecoveryEnd} from './wire-recovery-end-audit.mjs';
import {createWireBrokerRecoveryControl, readWireBrokerRecoveryEvidence, assertWireBrokerHeldReceipt,
    releaseWireBrokerReceipt, auditWireBrokerSourceCounterWindows, assertWireBrokerHeldQueues,
    auditWireBrokerAttemptRecovery} from './portable-state-broker-recovery.mjs';
import {captureOwnedWireBroker, describeOwnedWireBroker, restartOwnedWireBroker} from './owned-wire-broker.mjs';
import {captureOwnedWireReplica, describeOwnedWireReplica} from './owned-wire-replica.mjs';
import {qualifyWireStorageRestart} from './portable-state-storage-recovery.mjs';
import {portableNativeHistoryRemaining} from './portable-native-history-witness.ts';
import {portableWorkerSourceFrame} from './portable-state-worker-source.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
export function describePortableWorkerError(error: unknown): string {
    const seen = new Set<unknown>(); const parts: string[] = [];
    const visit = (value: unknown, label: string, depth: number) => {
        if (depth > 4 || seen.has(value)) return;
        seen.add(value); parts.push(label + String(value instanceof Error ? value.stack ?? value.message : value).slice(0, 4096));
        if (value instanceof Error && value.cause !== undefined) visit(value.cause, '\nCaused by: ', depth + 1);
        if (value instanceof AggregateError) for (const item of value.errors.slice(0, 4)) visit(item, '\nAggregate member: ', depth + 1);
    };
    visit(error, '', 0); return parts.join('').slice(0, 16384);
}
const describeError = describePortableWorkerError;
type Row = ProjectionQueryResult['rows'][number];
export interface PortableWorkerBarrier {readonly through: number; readonly rows: Readonly<Record<string, readonly Row[]>>}
export interface PortableWorkerPlan {
    readonly schemaVersion: 1; readonly source: PortableSourceInput; readonly definitions: readonly ProjectionDefinition[];
    /** Independently derived official/source oracle files; never outputs from the worker under test. */
    readonly oracleFiles: readonly PortableSourceFile[];
    readonly expectationOrigin: string; readonly barriers: readonly PortableWorkerBarrier[];
}
const rowOrder = (left: Row, right: Row) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key));

/** A deliberately invalid mapping is qualification configuration, never a replacement source oracle. */
export function portableWorkerFaultDefinition(plan: PortableWorkerPlan): ProjectionDefinition {
    const original = plan.definitions.find(definition => plan.barriers[0].rows[definition.id].length > 0);
    assert.ok(original, 'the first held prefix must contain an independently expected insertion');
    assert.ok(plan.barriers[0].through > 1, 'the failure needs a real completed predecessor');
    const definition = {...structuredClone(original), id: 'qualification-invalid-' + portableSourceHash(JSON.stringify(original)).slice(0, 16),
        fields: [{name: 'qualification_missing_required', path: ['__hyperion_qualification_missing_required_v1__'], type: 'string' as const}]};
    assert.ok(!plan.definitions.some(value => value.id === definition.id));
    return {...definition, mappingRevision: portableSourceHash(JSON.stringify({...definition, mappingRevision: 'qualification-invalid-required-v1'}))};
}

export function assertPortableUnavailable(response: {status: number; headers: Headers; body: any}) {
    assert.equal(response.status, 503); assert.equal(response.body.retryable, true); assert.equal(response.headers.get('retry-after'), '1');
    for (const name of ['hyperion-state-block-num', 'hyperion-state-block-id', 'hyperion-state-last-valid']) assert.equal(response.headers.get(name), null);
    assert.equal(response.body.view, undefined); assert.equal(response.body.rows, undefined);
}

export function assertPortablePredeployment(response: {status: number; headers: Headers; body: any}) {
    assertPortableUnavailable(response); assert.equal(response.body.code, 'projection.incomplete');
}

export function assertPortablePending(recovery: ProjectionRecoveryView, binding: ProjectionBinding,
                                      previous: {blockNum: number; blockId: string}, block: {blockNum: number; blockId: string}, contractFailure: boolean) {
    // SDK records may have a null prototype; durable/HTTP JSON snapshots have ordinary prototypes.
    assert.deepEqual(recovery.binding, {...binding}); assert.equal(recovery.initialized, true); assert.deepEqual(recovery.checkpoint, previous);
    assert.deepEqual(recovery.pending?.block, {...block, previousBlockId: previous.blockId}); assert.equal(recovery.gap, null);
    if (contractFailure) {assert.equal(recovery.pending!.digest, null); assert.match(recovery.pending!.reason!, /Required source field is missing/);}
    else {assert.match(recovery.pending!.digest!, /^[a-f0-9]{64}$/);
        assert.equal(recovery.pending!.reason, 'Canonical projection source admitted; durable application is pending');}
}

export function validatePortableWorkerPlan(value: unknown): PortableWorkerPlan {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value)); const plan = value as PortableWorkerPlan;
    assert.equal(plan.schemaVersion, 1); assert.ok(plan.source && Number.isSafeInteger(plan.source.endBlock));
    assert.ok(Array.isArray(plan.definitions) && plan.definitions.length > 0 && plan.definitions.length <= 8);
    assert.equal(new Set(plan.definitions.map(definition => definition.id)).size, plan.definitions.length);
    assert.ok(typeof plan.expectationOrigin === 'string' && plan.expectationOrigin.length >= 16 && plan.expectationOrigin.length <= 4096);
    assert.ok(Array.isArray(plan.oracleFiles) && plan.oracleFiles.length > 0 && plan.oracleFiles.length <= 64);
    assert.ok(Array.isArray(plan.barriers) && plan.barriers.length >= 2 && plan.barriers.length <= 16);
    const ids: string[] = plan.definitions.map(definition => definition.id).sort(); let prior = 0;
    for (const barrier of plan.barriers) {
        assert.ok(Number.isSafeInteger(barrier.through) && barrier.through > prior && barrier.through <= plan.source.endBlock);
        assert.deepEqual(Object.keys(barrier.rows).sort(), ids);
        for (const rows of Object.values(barrier.rows)) {
            assert.ok(Array.isArray(rows) && rows.length <= 256);
            assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
            assert.deepEqual([...rows].sort(rowOrder), rows, 'expected rows must use binary UTF-8 key order');
        }
        prior = barrier.through;
    }
    assert.equal(prior, plan.source.endBlock, 'final source prefix must have an independent row expectation');
    // The tracer must actually exercise replacement and deletion, rather than an empty-chain success.
    let replaced = false, deleted = false, inserted = false;
    for (const id of ids) {
        let previous = new Map<string, Row>();
        for (const barrier of plan.barriers) {
            const current = new Map<string, Row>(barrier.rows[id].map((row: Row) => [row.key, row]));
            for (const [key, row] of current) {if (!previous.has(key)) inserted = true;
                else if (JSON.stringify(row.value) !== JSON.stringify(previous.get(key)!.value)) replaced = true;}
            for (const key of previous.keys()) if (!current.has(key)) deleted = true;
            previous = current;
        }
    }
    assert.ok(inserted && replaced && deleted, 'the independently specified prefixes must cover insert, update and delete');
    return structuredClone(plan);
}

export function portableWorkerEnvironment(environment: NodeJS.ProcessEnv, output: string, config: string, chain: string, profile = false) {
    const selected = {...environment};
    for (const name of Object.keys(selected)) if (name.startsWith('ES198_') || name.startsWith('worker_') || name.startsWith('HYPERION_PORTABLE_') ||
        ['NODE_OPTIONS', 'NODE_PATH', 'CONFIG_JSON', 'CHAIN_NAME', 'first_block', 'last_block', 'live_mode'].includes(name)) delete selected[name];
    return {...selected, NODE_OPTIONS: '', CONFIG_JSON: config, CHAIN_NAME: chain,
        ES198_OBSERVER_DIR: join(output, 'observer'), ...portableWorkerProfileEnvironment(profile)};
}

export function portableWorkerConfig(chain: string, database: string, definitions: readonly ProjectionDefinition[], port: number, rpc: string,
    profileId: PortableSourceProfile = portableLegacyProfile) {
    assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/); assert.match(database, /^h45_p191_[0-9a-f]{12}$/);
    assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65536);
    assert.ok([portableLegacyProfile, portableNativeProfile].includes(profileId));
    return {
        api: {enabled: true, chain_name: 'Owned portable qualification', server_addr: '127.0.0.1', server_port: port,
            server_name: `http://127.0.0.1:${port}`, chain_api: rpc, push_api: '', access_log: false,
            enable_caching: false, disable_rate_limit: true, disable_tx_cache: true, v1_chain_cache: [],
            limits: profileId === portableNativeProfile ? {get_actions: 100} : {},
            explorer: {home_redirect: false, upstream: '', theme: ''}},
        indexer: {enabled: true, start_on: 1, stop_on: 0, rewrite: false, purge_queues: false, live_reader: true,
            live_only_mode: true, abi_scan_mode: false, fetch_block: true, fetch_traces: true, fetch_deltas: true,
            process_deltas: true, disable_reading: false, disable_indexing: false},
        settings: {chain, parser: '3.2', eosio_alias: 'sysio', system_contract: 'sysio',
            protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
            index_version: 'v1', index_partition_size: 10000000, es_replicas: 1, auto_stop: 300,
            auto_mode_switch: false, ds_profiling: true, rate_monitoring: true, bp_monitoring: false,
            max_ws_payload_mb: 16, use_global_agent: false, debug: false},
        scaling: {readers: 1, ds_queues: 1, ds_threads: 1, ds_pool_size: 1, indexing_queues: 1,
            ad_idx_queues: 1, dyn_idx_queues: 1, max_autoscale: 0, batch_size: 32, resume_trigger: 8,
            auto_scale_trigger: 1000000, max_queue_limit: 64, block_queue_limit: 64, polling_interval: 500, routing_mode: 'round_robin'},
        prefetch: {read: 8, block: 8, index: 32},
        features: {portable_state: {backend: {kind: 'mongodb', id: `p191-${chain.slice(-12)}`, database}, projections: definitions},
            streaming: {enable: false, traces: false, deltas: false}, contract_state: {enabled: false, contracts: {}},
            tables: {proposals: false, accounts: false, voters: false, permissions: false, user_resources: false},
            index_all_deltas: true, index_deltas: true, index_deltas_deletions: true, deferred_trx: false,
            failed_trx: false, resource_limits: false, resource_usage: false},
        whitelists: {actions: [], deltas: [], max_depth: 10, root_only: false}, blacklists: {actions: [], deltas: []},
        plugins: {}, hub: {enabled: false}, alerts: {enabled: false}, experimental: {}}
    ;
}

async function newOutput(path: string) {
    path = resolve(path); await ordinaryPortablePath(dirname(path), true);
    try {await ordinaryPortablePath(path, true);} catch (error: any) {if (error.code === 'ENOENT') return path; throw error;}
    throw new Error('qualification output must be a new directory');
}
async function freePort() {const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port; await new Promise<void>(done => server.close(() => done())); return port as number;}
async function boundedResponse(response: Response, maximum = 4 * 1024 * 1024) {
    assert.ok(response.body); const parts: Buffer[] = []; let size = 0;
    for await (const bytes of response.body) {size += bytes.length; assert.ok(size <= maximum, 'HTTP response exceeds qualification bound'); parts.push(Buffer.from(bytes));}
    return JSON.parse(Buffer.concat(parts).toString());
}

export function assertPortableApiResult(result: any, headers: Headers, binding: unknown, block: {blockNum: number; blockId: string}, rows: readonly Row[]) {
    assert.deepEqual(result.view, {binding: {...binding as ProjectionBinding}, checkpoint: block}); assert.deepEqual(result.rows, rows);
    assert.equal(result.count?.value, rows.length); assert.equal(result.count?.exact, true);
    assert.equal(result.nextAfterKey, undefined);
    assert.equal(headers.get('hyperion-state-block-num'), String(block.blockNum));
    assert.equal(headers.get('hyperion-state-block-id'), block.blockId);
    assert.equal(headers.get('hyperion-state-last-valid'), 'false'); assert.equal(headers.get('cache-control'), 'no-store');
}

/** Validate the exact worker fixture plus optional unused legacy services. No external endpoint is accepted. */
export function assertPortableWorkerServices(state: any, inspections: Record<string, any>, network: any) {
    validateFixture(state.core); assert.equal(state.run, state.core.run); assert.equal(state.network, state.core.network);
    for (const node of state.core.nodes) {assertNodeOwnership(inspections[node.name], node, state.run); assertOwnedBinding(inspections[node.name], '9200/tcp', node.url);}
    const images: Record<string, string> = {broker: 'rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef',
        redis: 'redis@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241',
        spring: 'igorls/spring-nodeos@sha256:13130dbeeaf519209d8aec8b79edfa14ee3e1de958f461506b63569a91714c5a',
        mongo: 'mongo@sha256:4968f22d0c6c10ef29952f3e807f62872ba22b3312f25803564fbfc08255efc2'};
    const services = [['broker', state.core.broker], ['redis', state.redis], ...['spring', 'mongo'].filter(key => state[key]).map(key => [key, state[key]])] as const;
    for (const [kind, service] of services) {
        const inspected = inspections[service.name]; assert.ok(inspected);
        assert.equal(inspected.Id, service.containerId); assert.equal(inspected.Name, '/' + service.name);
        assert.equal(inspected.Config.Image, images[kind]); assert.equal(inspected.Config.Labels?.['io.eosrio.run'], state.run);
        assert.equal(inspected.Config.Labels?.['io.eosrio.qualifier'], kind === 'broker' ? 'es198-replicas' : 'es198-workers');
        if (kind === 'broker') {assertOwnedBinding(inspected, '5672/tcp', service.url); assertOwnedBinding(inspected, '15672/tcp', service.managementUrl);}
        if (kind === 'redis') assertOwnedBinding(inspected, '6379/tcp', service.url);
    }
    const containers = [...state.core.nodes, ...services.map(([, service]) => service)];
    assert.equal(network.Name, state.network); assert.equal(network.Labels?.['io.eosrio.run'], state.run);
    assert.equal(network.Labels?.['io.eosrio.qualifier'], 'es198-replicas');
    assert.deepEqual(Object.keys(network.Containers).sort(), containers.map(item => item.containerId).sort());
    return containers;
}

export function portableSourceRpcIdentity(source: PortableWorkerSource, blockNum: number) {
    assert.ok(Number.isSafeInteger(blockNum) && blockNum >= 1 && blockNum <= 0xffffffff);
    return source.records[blockNum - 1]?.blockId ?? source.irreversibleAnchors[String(blockNum)];
}

export async function portableSourceRpc(source: PortableWorkerSource, errors: string[], options: {authorityRpc?: string;
    replayThrough?: () => number} = {}) {
    assert.equal(!!options.authorityRpc, !!options.replayThrough,
        'live RPC checks require the owned replay cursor');
    const upstream = options.authorityRpc ? portableAuthorityRpcOrigin(options.authorityRpc) : undefined;
    const upstreamRequest = async (path: string, body: object) => {
        assert.ok(upstream);
        const response = await fetch(new URL(path, upstream), {method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000)});
        assert.equal(response.status, 200, 'qualification authority RPC failed');
        assert.ok(response.body);
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length; assert.ok(length <= 2 * 1024 * 1024, 'qualification authority RPC response exceeds bound');
            chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks); return {bytes, value: JSON.parse(bytes.toString())};
    };
    const upstreamInfo = upstream ? (await upstreamRequest('/v1/chain/get_info', {})).value : undefined;
    if (upstreamInfo) {
        assert.equal(upstreamInfo.chain_id, source.chainId, 'qualification authority RPC chain differs');
        assert.ok(Number(upstreamInfo.last_irreversible_block_num) >=
            Number(source.originalStatus[1].last_irreversible.block_num),
        'qualification authority RPC is behind the captured irreversible anchors');
    }
    const upstreamBlocks = new Map<number, Promise<{bytes: Buffer; id: string}>>();
    const verifiedBlock = async (blockNum: number) => {
        const expected = portableSourceRpcIdentity(source, blockNum);
        assert.ok(expected, 'RPC block is outside original source and observed LIB anchors');
        let request = upstreamBlocks.get(blockNum);
        if (!request) {
            request = (async () => {
                const result = await upstreamRequest('/v1/chain/get_block', {block_num_or_id: blockNum});
                assert.equal(Number(result.value.block_num), blockNum);
                assert.equal(result.value.id, expected, 'live RPC block differs from original SHIP source');
                const original = source.records[blockNum - 1];
                if (original) assert.equal(result.value.previous, original.headerPreviousBlockId,
                    'live RPC predecessor differs from original SHIP header');
                return {bytes: result.bytes, id: expected};
            })();
            upstreamBlocks.set(blockNum, request);
            request.catch(() => upstreamBlocks.delete(blockNum));
        }
        return request;
    };
    const requests: any[] = []; let totalBytes = 0;
    const server = createServer(async (incoming, outgoing) => {
        try {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const value of incoming) {bytes += value.length; assert.ok(bytes <= 4096); chunks.push(Buffer.from(value));}
            totalBytes += bytes; assert.ok(totalBytes <= (upstream ? 8 : 1) * 1024 * 1024
                && requests.length < (upstream ? 16384 : 512));
            const body = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : {};
            const info = (incoming.method === 'POST' || incoming.method === 'GET')
                && incoming.url === '/v1/chain/get_info' && Object.keys(body).length === 0;
            const blockNum = body?.block_num_or_id;
            const block = !!upstream && incoming.method === 'POST' && incoming.url === '/v1/chain/get_block'
                && Object.keys(body).length === 1 && Number.isSafeInteger(blockNum)
                && !!portableSourceRpcIdentity(source, blockNum);
            const allowed = info || block;
            const observedRequest: any = {method: incoming.method, path: incoming.url, body, allowed,
                peer: {address: incoming.socket.remoteAddress, port: incoming.socket.remotePort},
                userAgent: incoming.headers['user-agent']?.slice(0, 256)};
            requests.push(observedRequest);
            // Host discovery also probes this loopback listener. Decline its exact health request;
            // it is not source RPC authority and must not invent a successful Hyperion health view.
            if (incoming.method === 'GET' && incoming.url === '/v2/health' && bytes === 0) {
                observedRequest.kind = 'unsupported-health-probe';
                outgoing.writeHead(404, {'content-type': 'application/json'});
                outgoing.end('{"error":"source RPC fixture has no Hyperion health route"}'); return;
            }
            assert.ok(allowed, 'RPC fallback is outside the retained startup view');
            if (block) {
                const verified = await verifiedBlock(blockNum);
                observedRequest.sourceCheckedId = verified.id;
                outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(verified.bytes); return;
            }
            const through = upstream ? Math.max(1, options.replayThrough!()) : 1;
            assert.ok(Number.isSafeInteger(through) && through <= source.endBlock);
            const current = source.records[through - 1];
            const response = upstream ? {...source.startupInfo, head_block_num: through,
                last_irreversible_block_num: through, head_block_id: current.blockId,
                last_irreversible_block_id: current.blockId, head_block_time: current.timestamp,
                last_irreversible_block_time: current.timestamp, head_block_producer: current.producer,
                fork_db_head_block_num: through, fork_db_head_block_id: current.blockId} : source.startupInfo;
            outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(JSON.stringify(response));
        } catch (error) {errors.push(describeError(error)); outgoing.writeHead(503, {'content-type': 'application/json'}); outgoing.end('{"error":"retained RPC input unavailable"}');}
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return {url: `http://127.0.0.1:${(server.address() as any).port}`, requests,
        async checkedBlockResponse(blockNum: number) {
            assert.ok(upstream && Number.isSafeInteger(blockNum) && upstreamBlocks.has(blockNum),
                'no original source-checked RPC response was observed for this block');
            const result = await upstreamBlocks.get(blockNum)!;
            return {blockNum, blockId: result.id, bytes: Buffer.from(result.bytes)};
        },
        lineage: upstream ? {kind: 'source-bounded-live-rpc-check', chainId: source.chainId,
            description: 'Replay get_info follows released original irreversible frames; each get_block is checked against original SHIP bytes and the selected current RPC. This does not qualify a live SHIP fork.'}
            : {kind: 'derived-startup-control', blockNum: 1, blockId: source.records[0].blockId,
                description: 'get_info control fields derive from original block1; original SHiP status/frame head and LIB are untouched.'},
        close: () => new Promise<void>(done => {server.closeAllConnections(); server.close(() => done());})};
}

export interface PortableWorkerOptions {readonly native?: boolean; readonly authorityRpc?: string; readonly profile?: boolean;
    readonly workerRecovery?: boolean; readonly masterRecovery?: boolean; readonly readerRecovery?: boolean;
    readonly brokerRecovery?: boolean; readonly storageRecovery?: boolean}

function portableAuthorityRpcOrigin(value: string): URL {
    const upstream = new URL(value);
    assert.ok(['http:', 'https:'].includes(upstream.protocol) && upstream.pathname === '/'
        && !upstream.username && !upstream.password && !upstream.search && !upstream.hash,
    'qualification authority RPC must be an ordinary HTTP origin');
    return upstream;
}

export function validatePortableWorkerOptions(options: unknown): asserts options is PortableWorkerOptions {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options)
        && [Object.prototype, null].includes(Object.getPrototypeOf(options))
        && Object.keys(options).every(key => ['native', 'authorityRpc', 'profile', 'workerRecovery', 'masterRecovery', 'readerRecovery', 'brokerRecovery', 'storageRecovery'].includes(key)));
    const selected = options as PortableWorkerOptions;
    if (Object.hasOwn(selected, 'native')) assert.equal(typeof selected.native, 'boolean');
    if (Object.hasOwn(selected, 'profile')) assert.equal(typeof selected.profile, 'boolean');
    if (Object.hasOwn(selected, 'workerRecovery')) assert.equal(typeof selected.workerRecovery, 'boolean');
    if (Object.hasOwn(selected, 'masterRecovery')) assert.equal(typeof selected.masterRecovery, 'boolean');
    if (Object.hasOwn(selected, 'readerRecovery')) assert.equal(typeof selected.readerRecovery, 'boolean');
    if (Object.hasOwn(selected, 'brokerRecovery')) assert.equal(typeof selected.brokerRecovery, 'boolean');
    if (Object.hasOwn(selected, 'storageRecovery')) assert.equal(typeof selected.storageRecovery, 'boolean');
    if (Object.hasOwn(selected, 'authorityRpc')) {
        assert.ok(selected.native === true && typeof selected.authorityRpc === 'string',
            'the source-bounded RPC check requires explicit native qualification');
        portableAuthorityRpcOrigin(selected.authorityRpc);
    }
    assert.ok(!selected.profile || selected.native === true && typeof selected.authorityRpc === 'string',
        'CPU profiling requires explicit native source-bounded RPC qualification');
    assert.ok(!selected.workerRecovery || selected.native === true && typeof selected.authorityRpc === 'string' && !selected.profile,
        'Worker recovery requires native source-bounded RPC qualification without CPU capture');
    assert.ok(!selected.masterRecovery || selected.native === true && typeof selected.authorityRpc === 'string'
        && !selected.profile && !selected.workerRecovery && !selected.readerRecovery,
        'Master recovery requires native source-bounded RPC qualification without CPU capture or another fault');
    assert.ok(!selected.readerRecovery || selected.native === true && typeof selected.authorityRpc === 'string'
        && !selected.profile && !selected.workerRecovery && !selected.masterRecovery,
        'Reader recovery requires native source-bounded RPC qualification without CPU capture or another fault');
    assert.ok(!selected.brokerRecovery || selected.native === true && typeof selected.authorityRpc === 'string'
        && !selected.profile && !selected.workerRecovery && !selected.masterRecovery && !selected.readerRecovery,
        'Broker recovery requires native source-bounded RPC qualification without CPU capture or another fault');
    assert.ok(!selected.storageRecovery || selected.brokerRecovery === true,
        'Storage recovery requires the explicit native broker handover case');
}

export function parsePortableWorkerArguments(args: readonly string[]) {
    assert.ok(args.slice(0, 3).length === 3 && args.slice(0, 3).every(value => typeof value === 'string' && value.length > 0)
        && (args.length === 3 || args.length === 4 && args[3] === '--native'
            || (args.length === 6 || args.length === 7 && ['--profile', '--worker-recovery', '--master-recovery', '--reader-recovery', '--broker-recovery', '--broker-storage-recovery'].includes(args[6]))
                && args[3] === '--native' && args[4] === '--authority-rpc'),
    'usage: node portable-state-worker.ts STATE_FILE PLAN_JSON NEW_OUTPUT_DIRECTORY [--native [--authority-rpc URL [--profile|--worker-recovery|--master-recovery|--reader-recovery|--broker-recovery|--broker-storage-recovery]]]');
    const options = {...(args.length > 3 ? {native: true} : {}), ...(args.length >= 6 ? {authorityRpc: args[5]} : {}),
        ...(args[6] === '--profile' ? {profile: true} : {}), ...(args[6] === '--worker-recovery' ? {workerRecovery: true} : {}),
        ...(args[6] === '--master-recovery' ? {masterRecovery: true} : {}),
        ...(args[6] === '--reader-recovery' ? {readerRecovery: true} : {}),
        ...(['--broker-recovery', '--broker-storage-recovery'].includes(args[6]) ? {brokerRecovery: true} : {}),
        ...(args[6] === '--broker-storage-recovery' ? {storageRecovery: true} : {})};
    validatePortableWorkerOptions(options);
    return {stateFile: args[0], planFile: args[1], outputDirectory: args[2], options};
}

export async function runPortableStateWorker(stateFile: string, planFile: string, outputDirectory: string, options: PortableWorkerOptions = {}) {
    validatePortableWorkerOptions(options);
    assertNativeQualificationRuntime();
    if (options.masterRecovery) assert.equal(process.platform, 'linux', 'production master crash qualification requires Linux');
    if (options.readerRecovery) assert.equal(process.platform, 'linux', 'production reader handover qualification requires Linux');
    if (options.brokerRecovery) assert.equal(process.platform, 'linux', 'owned broker restart qualification requires Linux');
    const deadline = performance.now() + portableSourceLimits.runMs;
    const remaining = () => {const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, 'portable worker deadline exceeded'); return value;};
    let cleanupDeadline: number | undefined;
    const docker = (args: string[]) => {
        const available = cleanupDeadline === undefined ? remaining() : Math.floor(cleanupDeadline - performance.now());
        assert.ok(available > 0, 'owned fixture cleanup deadline exceeded');
        return execFileSync('docker', args, {encoding: 'utf8', timeout: Math.min(30000, available), maxBuffer: 16 * 1024 * 1024}).trim();
    };
    const output = await newOutput(outputDirectory);
    const planBytes = await boundedPortableFile(resolve(planFile), 8 * 1024 * 1024), plan = validatePortableWorkerPlan(JSON.parse(planBytes.toString()));
    const source = await auditPortableWorkerSource(plan.source, options.native ? portableNativeProfile : portableLegacyProfile); // before service writes
    const nativeOracle = options.native ? await auditPortableNativeOracle(source) : undefined;
    const oracleHashes: Record<string, string> = {}, officialOracles: any[] = [];
    for (const item of plan.oracleFiles) {
        const bytes = await boundedPortableFile(resolve(dirname(planFile), item.path), 16 * 1024 * 1024);
        assert.equal(bytes.length, item.bytes); assert.equal(portableSourceHash(bytes), item.sha256); oracleHashes[item.path] = item.sha256;
        const parsed = JSON.parse(bytes.toString()); if (parsed.sourceAbi && Array.isArray(parsed.rows) && Array.isArray(parsed.conversions)) officialOracles.push(parsed);
    }
    assert.equal(officialOracles.length, 1, 'exactly one independent physical-row/clio oracle must bind the expected prefixes');
    assertPortableWorkerOracle(source, plan, officialOracles[0]);
    const stateAbiAvailability = portableWorkerAbiAvailability(plan, officialOracles[0]);
    const state = JSON.parse((await boundedPortableFile(resolve(stateFile), 1024 * 1024)).toString());
    const services = [...state.core.nodes, state.core.broker, state.redis, ...['spring', 'mongo'].filter(key => state[key]).map(key => state[key])];
    const inspected = JSON.parse(docker(['inspect', ...services.map(service => service.containerId)]));
    const inspections = Object.fromEntries(services.map(service => [service.name, inspected.find((item: any) => item.Id === service.containerId)]));
    const network = JSON.parse(docker(['network', 'inspect', state.network]))[0];
    assertPortableWorkerServices(state, inspections, network);
    if (options.brokerRecovery) describeOwnedWireBroker(captureOwnedWireBroker(state.core, docker));
    if (options.storageRecovery) describeOwnedWireReplica(captureOwnedWireReplica(state.core, docker));
    const volumeEvidence: any[] = [];
    for (const service of services) {
        const volume = JSON.parse(docker(['volume', 'inspect', service.volume]))[0];
        assert.equal(volume.Labels?.['io.eosrio.run'], state.run);
        assert.deepEqual(docker(['ps', '-a', '--no-trunc', '--filter', `volume=${service.volume}`, '--format', '{{.ID}}']).split(/\r?\n/).filter(Boolean), [service.containerId]);
        volumeEvidence.push(volume);
    }
    await mkdir(output); await mkdir(join(output, 'observer')); await mkdir(join(output, 'observer/master')); await mkdir(join(output, 'observer/api'));
    await mkdir(join(output, 'config/chains'), {recursive: true});
    await mkdir(join(output, 'bulk')); await mkdir(join(output, 'prefixes'));
    if (options.native) await mkdir(join(output, 'history-diagnostics'));
    const reportHandle = await open(join(output, 'report.json'), 'wx');
    const report: any = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), source: {
        chainId: source.chainId, profileId: source.profileId, revision: source.sourceRevision, components: source.components,
        range: {first: 1, last: source.endBlock}, inputHashes: source.inputHashes, originalStatus: source.originalStatus},
        planSha256: portableSourceHash(planBytes), oracleHashes, expectationOrigin: plan.expectationOrigin, stateAbiAvailability,
        mode: options.authorityRpc ? 'installed-native-wire-source-bounded-rpc'
            : options.native ? 'installed-native-wire-engineering' : 'legacy-wire-state',
        preloads: options.native ? ['action-source-admission-preload.mjs', 'portable-state-worker-native-observer.mjs', 'es955-worker-observer.mjs'] : ['es955-worker-observer.mjs'],
        runtime: {node: process.version, executable: process.execPath}, inspections, network, volumes: volumeEvidence,
        profiling: {enabled: options.profile === true, status: options.profile === true ? 'pending' : 'disabled',
            limits: portableWorkerProfileLimits, components: [], failures: []},
        prefixes: [], cleanup: [], errors: [], limits: {releaseQualified: false, forkRecoveryQualified: false, rustQualified: false,
            processCrashRecoveryQualified: false, writeFailureIsolationQualified: false,
            note: 'Actual Node worker/Mongo/HTTP tracer; no AtomicAssets, full release, fork or Bun qualification.'}};
    const mongoSamples = createPortableMongoSamples(join(output, 'mongo-physical-samples'));
    report.mongoPhysicalSamples = mongoSamples.evidence;
    const historyDiagnostics = options.native ? createPortableHistoryDiagnostics(join(output, 'history-diagnostics'), report.errors) : undefined;
    const chain = `hyp-p191-${state.run}`, database = `h45_p191_${state.run}`;
    const invalidDefinition = portableWorkerFaultDefinition(plan), faultThrough = plan.barriers[0].through;
    const mongoFixture = new OwnedMongoFixture({command: docker});
    let mongo: MongoClient | undefined, redis: Redis | undefined, master: ChildProcess | undefined, api: ChildProcess | undefined;
    let replay: Awaited<ReturnType<typeof servePortableWorkerSource>> | undefined, rpc: Awaited<ReturnType<typeof portableSourceRpc>> | undefined;
    let ledger: Awaited<ReturnType<typeof startBulkLedger>> | undefined;
    let recoveryControl: ReturnType<typeof createWireRecoveryControl> | undefined;
    let masterControl: ReturnType<typeof createWireMasterRestartControl> | undefined;
    let masterCrash: Awaited<ReturnType<typeof crashWireMaster>> | undefined, masterRestarted = false;
    let readerControl: ReturnType<typeof createWireReaderRecoveryControl> | undefined;
    let readerCrash: Awaited<ReturnType<typeof crashWireReader>> | undefined;
    let brokerControl: ReturnType<typeof createWireBrokerRecoveryControl> | undefined, brokerReceiptReleased = false;
    let brokerAttemptAudit: Awaited<ReturnType<typeof auditWireBrokerAttemptRecovery>> | undefined;
    let mongoWriteFaultActive = false;
    const configureMongoWriteFault = async (mode: 'alwaysOn' | 'off') => {
        assert.ok(mongo); mongoFixture.ownedContainer('replica');
        return mongo.db('admin').command({configureFailPoint: 'failCommand', mode,
            ...(mode === 'alwaysOn' ? {data: {failCommands: ['update'], errorCode: 2}} : {})});
    };
    const es = new Client({node: state.core.nodes[0].url, requestTimeout: 10000, maxRetries: 0});
    const readTimeout = (maximum: number, budget?: PortableNativePhaseBudget) =>
        Math.min(maximum, remaining(), budget ? portableNativeHistoryRemaining(budget) : Infinity);
    const readOptions = (maximum: number, budget?: PortableNativePhaseBudget) => budget ? {requestTimeout: readTimeout(maximum, budget)} : {};
    let lastQueues: {observed: ReturnType<typeof portableHistoryClock>; rows: any[]} | undefined;
    const refreshActions = async (through: number, phase: string, budget?: PortableNativePhaseBudget) => {
        const request = {index: chain + '-action-*'}, refresh = () => es.indices.refresh(request,
            budget ? {requestTimeout: Math.min(10000, portableNativeHistoryRemaining(budget))} : {});
        return historyDiagnostics ? historyDiagnostics.observe('action-refresh', {request, through, phase,
            phaseBudget: budget && {clock: 'performance.now', deadline: budget.deadline},
            source: source.records[through - 1], replay: replay?.metrics(), queues: lastQueues, recovery: report.lastRecovery}, refresh) : refresh();
    };
    const wait = async (name: string, condition: () => Promise<void>, milliseconds = 60000, inherited?: PortableNativePhaseBudget) => {
        const end = Math.min(deadline, performance.now() + milliseconds, inherited?.deadline ?? Infinity); let last: unknown;
        while (performance.now() < end) {for (const child of [master, api]) if (child) assert.ok(child.exitCode === null && child.signalCode === null, `${name}: actual child exited`);
            assert.deepEqual(report.errors, []); try {await condition();
                assert.ok(performance.now() < end, `${name}: original phase deadline exceeded`);
                return Object.freeze({deadline: end});} catch (error) {last = error;} await pause(100);}
        throw new Error(`${name} did not complete: ${describeError(last)}`);
    };
    const queues = async () => {
        const response = await fetch(state.core.broker.managementUrl + '/api/queues/%2F', {
            headers: {authorization: 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64')}, signal: AbortSignal.timeout(Math.min(5000, remaining()))});
        assert.equal(response.status, 200); const rows = await boundedResponse(response, 1024 * 1024);
        assert.ok(Array.isArray(rows) && rows.length <= 4096);
        const selected = rows.filter((row: any) => row.name.startsWith(chain + ':')).map((row: any) => ({name: row.name,
            ready: row.messages_ready, unacked: row.messages_unacknowledged, messages: row.messages, consumers: row.consumers,
            ack: row.message_stats?.ack ?? 0, delivered: row.message_stats?.deliver_get ?? 0, redelivered: row.message_stats?.redeliver ?? 0}));
        lastQueues = {observed: portableHistoryClock(), rows: selected}; return selected;
    };
    const observedDirectoryRows = async (kind = 'master', complete = false) => {
        const directory = join(output, 'observer', kind);
        const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')); assert.ok(names.length <= 64);
        const rows: any[] = []; for (const name of names) {const bytes = await boundedPortableFile(join(directory, name), 64 * 1024 * 1024);
            const interruptedReader = kind === 'master' && readerCrash
                && name === `worker-${describeWireReaderCrash(readerCrash).fence.reader.pid}.jsonl`;
            const content = interruptedReader ? bytes.subarray(0, bytes.lastIndexOf(10) + 1) : bytes;
            const lines = content.toString().split(/\r?\n/); for (const [index, line] of lines.entries()) if (line.trim()) {
                try {rows.push(JSON.parse(line));} catch (error) {if (complete || index < lines.length - 1) throw error;}
            }}
        return rows;
    };
    const observedRows = async (kind = 'master', complete = false) => kind === 'master' && masterRestarted
        ? [...await observedDirectoryRows('master'), ...await observedDirectoryRows('master-restarted', complete)]
        : observedDirectoryRows(kind, complete);
    const spawnOwned = async (entry: string, config: string) => {
        const name = entry.includes('/api/') ? 'api' : 'master';
        const instance = name === 'master' && masterRestarted ? 'master-restarted' : name;
        if (instance === 'master-restarted') await mkdir(join(output, 'observer', instance));
        const stdout = await open(join(output, instance + '.stdout.log'), 'wx'), stderr = await open(join(output, instance + '.stderr.log'), 'wx');
        const nativePreloads = options.native ? ['action-source-admission-preload.mjs', 'portable-state-worker-native-observer.mjs']
            .flatMap(file => ['--import', pathToFileURL(join(repo, 'scripts/qualification', file)).href]) : [];
        if (name === 'master' && recoveryControl) nativePreloads.push('--import',
            pathToFileURL(join(repo, 'scripts/qualification/portable-state-worker-recovery-preload.mjs')).href);
        if (name === 'master' && masterControl) nativePreloads.push('--import',
            pathToFileURL(join(repo, 'scripts/qualification/portable-state-master-recovery-preload.mjs')).href);
        if (name === 'master' && readerControl) nativePreloads.push('--import',
            pathToFileURL(join(repo, 'scripts/qualification/portable-state-reader-recovery-preload.mjs')).href);
        if (name === 'master' && brokerControl) nativePreloads.push('--import',
            pathToFileURL(join(repo, 'scripts/qualification/portable-state-broker-recovery-preload.mjs')).href);
        try {const child = spawn(process.execPath, [...nativePreloads, '--import', pathToFileURL(join(repo, 'scripts/qualification/es955-worker-observer.mjs')).href, join(repo, entry)],
            {cwd: output, env: {...portableWorkerEnvironment(process.env, output, config, chain, options.profile === true), ES198_OBSERVER_DIR: join(output, 'observer', instance),
                ...(options.native ? {HYPERION_PORTABLE_NATIVE_QUALIFICATION: '1'} : {}),
                ...(name === 'master' && recoveryControl ? {ES198_WIRE_RECOVERY_CONTROL: recoveryControl.file} : {}),
                ...(name === 'master' && masterControl ? {ES198_WIRE_MASTER_CONTROL: masterControl.file,
                    ES198_WIRE_MASTER_PHASE: masterRestarted ? 'after' : 'before'} : {}),
                ...(name === 'master' && readerControl ? {ES198_WIRE_READER_CONTROL: readerControl.file} : {}),
                ...(name === 'master' && brokerControl ? {ES198_WIRE_BROKER_CONTROL: brokerControl.file} : {})},
                detached: process.platform !== 'win32', stdio: ['ignore', stdout.fd, stderr.fd, 'ipc']});
            child.on('error', error => report.errors.push(describeError(error))); return child;
        } finally {await stdout.close(); await stderr.close();}
    };
    try {
        report.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8', timeout: 5000}).trim();
        report.runtime.sha256 = portableSourceHash(await boundedPortableFile(process.execPath, 256 * 1024 * 1024));
        const identity = await es.info(); assert.equal(identity.version.number, '9.5.5'); assert.equal(identity.cluster_uuid, state.core.clusterUuid);
        assert.deepEqual(Object.keys(await es.indices.get({index: chain + '-*', allow_no_indices: true, ignore_unavailable: true})), []);
        assert.deepEqual(await queues(), []);
        redis = new Redis(state.redis.url, {lazyConnect: true, commandTimeout: 5000, connectTimeout: 5000, enableOfflineQueue: false, maxRetriesPerRequest: 1});
        redis.on('error', error => report.errors.push(describeError(error))); await redis.connect(); assert.deepEqual(await redis.keys(chain + '::*'), []);
        const kernel = docker(['info', '--format', '{{.KernelVersion}}']); const match = /^(\d+)\.(\d+)\.(\d+)/.exec(kernel);
        assert.ok(!match || !(Number(match[1]) === 6 && Number(match[2]) >= 19 || Number(match[1]) === 7 && Number(match[2]) === 0 && Number(match[3]) < 14), 'Mongo8.0.34 incompatible host kernel');
        mongoFixture.prepare(); const mongoUri = mongoFixture.start('replica');
        const initial = await waitForMongo(() => new MongoClient(mongoUri, {directConnection: true, serverSelectionTimeoutMS: 1500, timeoutMS: 5000})); await initial.close();
        mongoFixture.initializeReplica(); mongo = await waitForMongo(() => new MongoClient(mongoUri, {directConnection: true, retryWrites: false,
            replicaSet: mongoFixture.replicaSet, serverSelectionTimeoutMS: 1500, timeoutMS: 5000}), {primary: true, replicaSet: mongoFixture.replicaSet});
        assert.ok(mongo); assert.equal((await mongo.db('admin').command({hello: 1})).setName, mongoFixture.replicaSet);
        assert.equal((await mongo.db('admin').command({buildInfo: 1})).version, MONGODB_VERSION);
        assert.deepEqual(await mongo.db(database).listCollections({}, {nameOnly: true}).toArray(), []);
        report.mongo = {uri: mongoUri, version: MONGODB_VERSION, replicaSet: mongoFixture.replicaSet, container: mongoFixture.ownedContainer('replica'), database};
        replay = await servePortableWorkerSource(source, report.errors);
        rpc = await portableSourceRpc(source, report.errors, options.authorityRpc
            ? {authorityRpc: options.authorityRpc, replayThrough: () => replay!.metrics().through} : {});
        report.rpc = {requests: rpc.requests, lineage: rpc.lineage};
        ledger = await startBulkLedger(state.core.nodes[0].url, join(output, 'bulk'), report.errors, 20000, options.native === true);
        report.bulkCapture = {...ledger.limits, recordedRequests: 0};
        const apiPort = await freePort(), controlPort = await freePort(), config = portableWorkerConfig(chain, database,
            [...plan.definitions, invalidDefinition], apiPort, rpc.url, source.profileId as PortableSourceProfile);
        const configFile = join(output, 'chain.json');
        const configModule = await import(new URL('../../build/indexer/projection/config.js', import.meta.url).href);
        const selectedConfig = configModule.resolvePortableStateConfiguration(config.features.portable_state, source.chainId);
        const bindings = plan.definitions.map(definition => configModule.portableStateBinding(selectedConfig, definition, source.chainId));
        const invalidBinding = configModule.portableStateBinding(selectedConfig, invalidDefinition, source.chainId);
        const backendModule = await import(new URL('../../packages/backend-mongodb/dist/index.js', import.meta.url).href);
        const adapters = bindings.map(() => backendModule.createMongoDbProjectionAdapter({client: mongo, databaseName: database, backendId: config.features.portable_state.backend.id}));
        const invalidAdapter = backendModule.createMongoDbProjectionAdapter({client: mongo, databaseName: database, backendId: config.features.portable_state.backend.id});
        assert.ok(adapters.every(adapter => typeof adapter.recovery === 'function'), 'a non-serving durable recovery cursor is required for bounded replay');
        const mongoUrl = new URL(mongoUri), redisUrl = new URL(state.redis.url);
        const connections = {elasticsearch: {protocol: 'http', host: new URL(state.core.nodes[0].url).host, ingest_nodes: [new URL(ledger.url).host], user: '', pass: ''},
            amqp: {protocol: 'http', host: new URL(state.core.broker.url).host, api: new URL(state.core.broker.managementUrl).host,
                user: 'qualifier', pass: 'qualifier-test-only', vhost: '/', frameMax: '0x10000'},
            redis: {host: redisUrl.hostname, port: Number(redisUrl.port)}, mongodb: {enabled: true, host: mongoUrl.hostname, port: Number(mongoUrl.port),
                directConnection: true, replicaSet: mongoFixture.replicaSet, database_prefix: chain, user: '', pass: ''},
            chains: {[chain]: {chain_id: source.chainId, http: rpc.url, ship: [{label: 'original-actual6508-prefix', url: replay.url}], control_port: controlPort}}, alerts: {enabled: false}};
        for (const [path, value] of [[configFile, config], [join(output, 'config/chains', chain + '.config.json'), config],
            [join(output, 'config/connections.json'), connections], [join(output, 'package.json'), JSON.parse((await boundedPortableFile(join(repo, 'package.json'), 65536)).toString())]] as const)
            await writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
        if (options.workerRecovery) {
            recoveryControl = createWireRecoveryControl({output, configFile, chain, source,
                frameSha256: portableSourceHash(portableWorkerSourceFrame(source, 33))});
            report.attemptRecovery = {status: 'pending', control: recoveryControl.control};
        }
        if (options.masterRecovery) {
            masterControl = createWireMasterRestartControl({output, configFile, chain, source,
                frameSha256: portableSourceHash(portableWorkerSourceFrame(source, 33)),
                resumeFrameSha256: portableSourceHash(portableWorkerSourceFrame(source, 34))});
            report.masterRestart = {status: 'pending', control: masterControl.control};
            report.preloads.push('portable-state-master-recovery-preload.mjs');
        }
        if (options.readerRecovery) {
            readerControl = createWireReaderRecoveryControl({output, configFile, chain, source,
                frameSha256: portableSourceHash(portableWorkerSourceFrame(source, 33)),
                resumeFrameSha256: portableSourceHash(portableWorkerSourceFrame(source, 34))});
            report.readerRecovery = {status: 'pending', control: readerControl.control};
            report.preloads.push('portable-state-reader-recovery-preload.mjs');
        }
        if (options.brokerRecovery) {
            brokerControl = createWireBrokerRecoveryControl({output, configFile, chain, source,
                frameSha256: portableSourceHash(portableWorkerSourceFrame(source, 33))});
            report.brokerRecovery = {status: 'pending', control: brokerControl.control,
                recoveryQualified: false, note: 'Restart observation alone grants no recovery, ACK settlement or capacity acceptance.'};
            report.preloads.push('portable-state-broker-recovery-preload.mjs');
            if (options.storageRecovery) report.storageRecovery = {status: 'pending', brokerHandover: 'pending',
                freshWriteAuthority: false, capacityAuthority: false, releaseQualified: false};
        }
        report.config = config; report.bindings = bindings; report.connections = connections;
        report.contractFailure = {definition: invalidDefinition, binding: invalidBinding,
            description: 'Fixture-only missing required source field; healthy definitions and independent expected rows are unchanged.', observations: []};
        master = await spawnOwned('build/indexer/launcher.js', configFile); report.masterPid = master.pid;
        api = await spawnOwned('build/api/server.js', configFile); report.apiPid = api.pid;
        const query = async (projection: string, value: ProjectionQuery = {filter: [], limit: 256, count: {upTo: 1000}}, budget?: PortableNativePhaseBudget) => {
            const available = Math.min(5000, remaining(), budget ? Math.floor(budget.deadline - performance.now()) : Infinity);
            assert.ok(available > 0, 'portable query inherited isolation deadline exceeded');
            const response = await fetch(`http://127.0.0.1:${apiPort}/v2/state/query`, {method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({projection, query: value}), signal: AbortSignal.timeout(available)});
            const body = await boundedResponse(response); if (budget) portableNativeHistoryRemaining(budget);
            return {status: response.status, headers: response.headers, body};
        };
        const responseReceipt = (response: Awaited<ReturnType<typeof query>>) =>
            ({status: response.status, headers: Object.fromEntries(response.headers), body: response.body});
        const history = async (through: number, budget?: PortableNativePhaseBudget) => {
            const block = source.records[through - 1];
            await es.indices.refresh({index: chain + '-block-*'}, readOptions(10000, budget));
            await wait(`physical block replicas for ${through}`, async () => {
                const timeoutMS = readTimeout(5000, budget);
                const health = await es.cluster.health({index: chain + '-block-*', wait_for_status: 'green', timeout: budget ? `${timeoutMS}ms` : '5s'},
                    readOptions(5000, budget));
                if (budget) portableNativeHistoryRemaining(budget);
                assert.equal(health.timed_out, false); assert.equal(health.status, 'green');
                assert.equal(health.number_of_data_nodes, 2);
            }, 60000, budget);
            const information = await es.nodes.info({}, readOptions(10000, budget));
            if (budget) portableNativeHistoryRemaining(budget);
            const dataNodes = Object.entries(information.nodes).filter(([, node]) =>
                state.core.nodes.some((owned: any) => owned.role === 'data' && owned.name === node.name));
            assert.equal(dataNodes.length, 2); const physical: any[] = [];
            for (const [nodeId, node] of dataNodes) {
                const result = await es.search<any>({index: chain + '-block-*', size: 2, track_total_hits: true,
                    preference: `_only_nodes:${nodeId}`, query: {term: {block_num: through}}}, readOptions(10000, budget));
                if (budget) portableNativeHistoryRemaining(budget);
                assert.equal(result.timed_out, false); assert.equal(result._shards.failed, 0);
                assert.ok(result._shards.total > 0); assert.equal(result._shards.successful, result._shards.total);
                assert.deepEqual(result.hits.total, {value: 1, relation: 'eq'}); const hit = result.hits.hits[0];
                assert.equal(hit._id, String(through)); assert.equal(hit._source.block_num, through);
                assert.equal(hit._source.block_id, block.blockId); assert.equal(hit._source.prev_id, block.headerPreviousBlockId);
                physical.push({nodeId, nodeName: node.name, response: result});
            }
            const response = await fetch(`http://127.0.0.1:${apiPort}/v2/history/get_block?block_num=${through}`,
                {signal: AbortSignal.timeout(readTimeout(5000, budget))});
            const body = await boundedResponse(response); assert.equal(response.status, 200);
            if (budget) portableNativeHistoryRemaining(budget);
            assert.equal(body.block_num, through); assert.equal(body.block_id, block.blockId); assert.equal(body.prev_id, block.headerPreviousBlockId);
            return {through, blockId: block.blockId, physical, api: {status: response.status, headers: Object.fromEntries(response.headers), body}};
        };
        await wait('API unavailable before actual block1', async () => {const response = await query(plan.definitions[0].id);
            assertPortableUnavailable(response); report.beforeSource = responseReceipt(response);});
        const http = async (path: string, budget?: PortableNativePhaseBudget) => {const response = await fetch(`http://127.0.0.1:${apiPort}` + path,
            {signal: AbortSignal.timeout(readTimeout(10000, budget))});
            const body = await boundedResponse(response); if (budget) portableNativeHistoryRemaining(budget);
            return {status: response.status, headers: response.headers, body};};
        const unrelated = async (height: number, budget?: PortableNativePhaseBudget) => {
            const block = source.records[height - 1], states: any[] = [];
            // Older history remains usable while state queries report the current covered head.
            for (const [index, definition] of plan.definitions.entries()) {const response = await query(definition.id, undefined, budget);
                assert.equal(response.status, 200); assert.equal(response.body.view.binding.projectionId, bindings[index].projectionId);
                assert.equal(response.headers.get('hyperion-state-last-valid'), 'false'); states.push(responseReceipt(response));}
            return {history: await history(block.blockNum, budget), states};
        };
        const native = nativeOracle ? await createPortableNativeQualification({source, oracle: nativeOracle, client: es, chain, apiPort,
            events: () => observedRows(), http, unrelated, rawHistory: history,
            wait: (name, work, budget) => wait(name, work, 60000, budget), historyDiagnostics,
            refreshActions: (through, budget) => refreshActions(through, 'native-hold', budget),
            bulk: {directory: join(output, 'bulk'), receipts: ledger.receipts},
            ...(options.workerRecovery ? {attemptRecovery: () => report.attemptRecovery?.status === 'observed'
                ? report.attemptRecovery.evidence : undefined} : {}),
            ...(options.masterRecovery ? {masterRestart: () => masterCrash && master?.pid
                ? {receipt: masterCrash, masterPid: master.pid} : undefined} : {}),
            ...(options.readerRecovery ? {readerRestart: () => readerCrash && master?.pid
                ? {receipt: readerCrash, masterPid: master.pid} : undefined} : {}),
            ...(options.brokerRecovery ? {brokerRecovery: () => brokerAttemptAudit} : {})}) : undefined;
        if (native) report.native = {profile: native.profile, oracleHashes: native.oracleHashes, holds: [], historyDiagnostics: historyDiagnostics!.evidence,
            activation: 'Existing admission engineering preload only; ordinary installed native provider; public/default operator activation remains disabled.',
            constructedControls: native.controls, notificationInventory: native.originalNotifications};
        const observeBrokerCut = async () => {
            assert.ok(brokerControl); const control = brokerControl.control;
            await wait('original Wire handoff manifest receipt held after actual confirmed publication', async () => {
                const evidence = readWireBrokerRecoveryEvidence(control), held = assertWireBrokerHeldReceipt(control, evidence.held);
                assert.equal(held.parentPid, master!.pid);
                assert.equal(evidence.events.filter(row => row.event === 'handoff-receipt-held'
                    && row.pid === held.pid && row.attempt.attemptId === held.attempt.attemptId).length, 1);
                assert.ok(!evidence.events.some(row => row.event === 'fresh-observation-attempt' && row.pid === held.pid
                    || row.event === 'end' && row.end.attemptId === held.attempt.attemptId));
                const publications = (await observedRows()).filter(row => row.kind === 'native_boundary'
                    && row.event === 'admitted_broker_confirmed' && row.pid === held.pid
                    && row.headers['hyperion-action-admission-v1'] === held.admissionId && row.headers.block_num === 33);
                assert.ok(publications.length > 0);
                const counters = await queues(); assertWireBrokerHeldQueues(chain, counters);
                replay!.assertThrough(33); report.brokerRecovery.before = {held, publications, counters};
            });
        };
        let writeFailureObserved = false;
        let through = 0;
        const schedule = native ? nativePortableHolds(plan.barriers.map(barrier => barrier.through)).map(through =>
            plan.barriers.find(barrier => barrier.through === through) ?? {through, rows: Object.fromEntries(plan.definitions.map(definition => [definition.id, [] as Row[]]))}) : plan.barriers;
        for (const barrier of schedule) {
            while (through < barrier.through) {
                if (!writeFailureObserved && through === faultThrough - 1) {
                    const previous = {blockNum: through, blockId: source.records[through - 1].blockId};
                    const failed = {blockNum: faultThrough, blockId: source.records[faultThrough - 1].blockId};
                    let beforeInvalid: ProjectionRecoveryView | undefined;
                    await wait('invalid tracer completed the real failure predecessor', async () => {
                        beforeInvalid = await invalidAdapter.recovery(invalidBinding);
                        assert.equal(beforeInvalid!.initialized, true); assert.deepEqual(beforeInvalid!.checkpoint, previous);
                        assert.equal(beforeInvalid!.pending, null); assert.equal(beforeInvalid!.gap, null);
                    });
                    const beforeApi: ReturnType<typeof responseReceipt>[] = [];
                    for (const [index, definition] of plan.definitions.entries()) {
                        const response = await query(definition.id); assert.equal(response.status, 200);
                        assertPortableApiResult(response.body, response.headers, bindings[index], previous, []); beforeApi.push(responseReceipt(response));
                    }
                    mongoWriteFaultActive = true;
                    const enabled = await configureMongoWriteFault('alwaysOn');
                    assert.equal(enabled.ok, 1); assert.ok(Number.isSafeInteger(enabled.count) && enabled.count >= 0);
                    report.writeFailure = {block: failed, previous, enabled, beforeInvalid, beforeApi,
                        description: 'Owned replica failCommand rejects actual update commands with error2 after durable source intent; history acknowledgments remain independent.'};
                    replay.releaseThrough(faultThrough);
                    await wait('actual Mongo failpoint entered', async () => {
                        report.writeFailure.entered = await mongo!.db('admin').command({waitForFailPoint: 'failCommand',
                            timesEntered: enabled.count + 1, maxTimeMS: Math.min(1000, remaining())});
                        assert.equal(report.writeFailure.entered.ok, 1);
                    }, 15000);
                    await wait('durable failed Mongo intent and fenced HTTP', async () => {
                        const recoveries = await Promise.all(adapters.map((adapter, index) => adapter.recovery(bindings[index])));
                        const responses: ReturnType<typeof responseReceipt>[] = [];
                        for (const [index, recovery] of recoveries.entries()) {
                            assertPortablePending(recovery, bindings[index], previous, failed, false);
                            const response = await query(plan.definitions[index].id); assertPortableUnavailable(response); responses.push(responseReceipt(response));
                        }
                        const invalidRecovery = await invalidAdapter.recovery(invalidBinding);
                        assertPortablePending(invalidRecovery, invalidBinding, previous, failed, true);
                        const invalidResponse = await query(invalidDefinition.id); assertPortableUnavailable(invalidResponse);
                        report.writeFailure.invalidWhilePending = {recovery: invalidRecovery, api: responseReceipt(invalidResponse)};
                        replay!.assertThrough(faultThrough); report.writeFailure.pending = recoveries; report.writeFailure.api = responses;
                        report.writeFailure.historyWhilePending = await history(faultThrough); report.writeFailure.queuesWhilePending = await queues();
                    });
                    const disabled = await configureMongoWriteFault('off'); mongoWriteFaultActive = false;
                    assert.equal(disabled.ok, 1); assert.ok(Number.isSafeInteger(disabled.count) && disabled.count > enabled.count);
                    report.writeFailure.disabled = disabled; writeFailureObserved = true;
                }
                through = Math.min(through + portableSourceLimits.window, barrier.through,
                    !writeFailureObserved ? faultThrough - 1 : source.endBlock); replay.releaseThrough(through);
                const block = source.records[through - 1];
                await wait(`durable contiguous projection cursor ${through}`, async () => {
                    const recoveries = await Promise.all(adapters.map((adapter, index) => adapter.recovery(bindings[index])));
                    for (const recovery of recoveries) {assert.equal(recovery.initialized, true); assert.deepEqual(recovery.checkpoint, {blockNum: through, blockId: block.blockId});
                        assert.equal(recovery.pending, null); assert.equal(recovery.gap, null);}
                    replay!.assertThrough(through); report.lastRecovery = recoveries;
                });
            }
            let isolation: any, isolationBudget: PortableNativePhaseBudget | undefined;
            if (through >= faultThrough) isolationBudget = await wait(`invalid mapping remains durably isolated at${through}`, async () => {
                const recovery = await invalidAdapter.recovery(invalidBinding);
                assertPortablePending(recovery, invalidBinding,
                    {blockNum: faultThrough - 1, blockId: source.records[faultThrough - 2].blockId},
                    {blockNum: faultThrough, blockId: source.records[faultThrough - 1].blockId}, true);
                const response = await query(invalidDefinition.id); assertPortableUnavailable(response);
                isolation = {through, recovery, api: responseReceipt(response), history: await history(through)};
            });
            if (isolation) report.contractFailure.observations.push(isolation);
            const block = source.records[through - 1], responses: any[] = [];
            for (const [index, definition] of plan.definitions.entries()) {
                await wait(`actual HTTP ${definition.id} prefix${through}`, async () => {const response = await query(definition.id);
                    if (through < stateAbiAvailability.fromBlock) assertPortablePredeployment(response);
                    else {assert.equal(response.status, 200); assertPortableApiResult(response.body, response.headers, bindings[index],
                        {blockNum: through, blockId: block.blockId}, barrier.rows[definition.id]);}
                    responses[index] = {status: response.status, headers: Object.fromEntries(response.headers), body: response.body};});
                if (through < stateAbiAvailability.fromBlock) continue;
                const expectedRows = barrier.rows[definition.id];
                if (expectedRows.length > 1) {
                    const first = await query(definition.id, {filter: [], limit: 1}); assert.equal(first.status, 200);
                    assert.deepEqual(first.body.rows, expectedRows.slice(0, 1)); assert.equal(first.body.nextAfterKey, expectedRows[0].key);
                    const next = await query(definition.id, {filter: [], limit: 256, afterKey: first.body.nextAfterKey});
                    assert.equal(next.status, 200); assert.deepEqual(next.body.rows, expectedRows.slice(1));
                }
                if (expectedRows.length) {
                    const field = definition.fields[0].name, value = expectedRows[0].value[field];
                    const filtered = await query(definition.id, {filter: [{field, op: 'eq', value}], limit: 256, count: {upTo: 1000}});
                    assert.equal(filtered.status, 200); assertPortableApiResult(filtered.body, filtered.headers, bindings[index],
                        {blockNum: through, blockId: block.blockId}, expectedRows.filter(row => row.value[field] === value));
                }
            }
            if (brokerControl && through === 33) await observeBrokerCut();
            else await wait(`owned Rabbit queues drained at${through}`, async () => {const rows = await queues(); assert.ok(rows.length > 0);
                assert.ok(rows.every((row: any) => row.ready === 0 && row.unacked === 0 && row.messages === 0));});
            if (recoveryControl && through === 33) {
                const {ActionSourceAdmissionStore} = await import(new URL('../../build/indexer/history/action-source-admission.js', import.meta.url).href);
                const store = new ActionSourceAdmissionStore(es, chain, 1);
                await wait('actual Wire worker redelivery and production-master adjudication', async () => {
                    const evidence = readWireRecoveryEvidence(recoveryControl!.control);
                    report.attemptRecovery = {status: 'observed', control: recoveryControl!.control,
                        evidence: await auditWireAttemptRecovery({control: recoveryControl!.control, ...evidence,
                            queues: await queues(), masterPid: master!.pid, store})};
                });
            }
            let physicalMongo;
            if (plan.barriers.some(value => value.through === through)) {
                replay.assertThrough(through); mongoFixture.ownedContainer('replica');
                assert.ok(isolationBudget, 'physical Mongo barrier requires the original isolation phase budget');
                const sampled = await samplePortableMongoIsolation({input: {client: mongo, database, backendId: config.features.portable_state.backend.id,
                    chainId: source.chainId, replicaSet: mongoFixture.replicaSet, version: MONGODB_VERSION, through, source: source.records,
                    expectations: [...plan.definitions.map((definition, index) => ({definition, binding: bindings[index],
                        checkpoint: {blockNum: through, blockId: block.blockId}, rows: barrier.rows[definition.id]})),
                    {definition: invalidDefinition, binding: invalidBinding, rows: [],
                        checkpoint: {blockNum: faultThrough - 1, blockId: source.records[faultThrough - 2].blockId},
                        failedBlock: {blockNum: faultThrough, blockId: source.records[faultThrough - 1].blockId,
                            previousBlockId: source.records[faultThrough - 2].blockId}}]}, budget: isolationBudget,
                    recovery: operationTimeoutMS => backendModule.createMongoDbProjectionAdapter({client: mongo, databaseName: database,
                        backendId: config.features.portable_state.backend.id, operationTimeoutMS}).recovery(invalidBinding),
                    query: async budget => responseReceipt(await query(invalidDefinition.id, undefined, budget)),
                    capture: sample => mongoSamples.record(sample),
                    guard: () => {
                        for (const child of [master, api]) if (child) assert.ok(child.exitCode === null && child.signalCode === null, 'physical Mongo sampling: actual child exited');
                        assert.deepEqual(report.errors, []); replay!.assertThrough(through); mongoFixture.ownedContainer('replica');
                    }});
                physicalMongo = sampled.physical; isolation = sampled.isolation;
                report.contractFailure.observations.push({...isolation, phase: 'coherent-physical'});
                replay.assertThrough(through); mongoFixture.ownedContainer('replica');
            }
            if (native) {const observed = await native.hold(through);
                const file = `prefixes/native-${through}.json`, bytes = Buffer.from(JSON.stringify(observed, null, 2) + '\n');
                await writeFile(join(output, file), bytes, {flag: 'wx'}); report.native.holds.push({through, file, sha256: portableSourceHash(bytes)});}
            const observed = {through, blockId: block.blockId, responses, history: await history(through),
                stateAbiAvailability, queues: await queues(), recovery: report.lastRecovery, source: replay.metrics(), isolation, physicalMongo,
                ...(brokerControl && through === 33 ? {brokerReceiptHeld: true, queuesDrained: false} : {})};
            const bytes = Buffer.from(JSON.stringify(observed, null, 2) + '\n'); const file = `prefixes/block-${through}.json`;
            await writeFile(join(output, file), bytes, {flag: 'wx'}); report.prefixes.push({through, file, sha256: portableSourceHash(bytes)});
            if (brokerControl && through === 33) {
                await observeBrokerCut(); const control = brokerControl.control;
                if (options.storageRecovery) {
                    await qualifyWireStorageRestart({core: state.core, docker, es, control, masterPid: master!.pid, replay, wait, evidence: report.storageRecovery});
                    const file = 'prefixes/storage-restart-33.json', bytes = Buffer.from(JSON.stringify(report.storageRecovery, null, 2) + '\n');
                    await writeFile(join(output, file), bytes, {flag: 'wx'});
                    report.prefixes.push({through, file, sha256: portableSourceHash(bytes)});
                }
                const token = captureOwnedWireBroker(state.core, docker);
                report.brokerRecovery.originalIncarnation = describeOwnedWireBroker(token);
                try {
                    report.brokerRecovery.restart = restartOwnedWireBroker(token);
                    replay.allowBrokerRestart(report.brokerRecovery.restart, control);
                    report.brokerRecovery.status = 'restart-observed';
                    await wait('original handoff attempt fenced while its actual receipt remains held', async () => {
                        const evidence = readWireBrokerRecoveryEvidence(control);
                        const held = evidence.held, fences = evidence.events.filter(row => row.event === 'held-attempt-fenced'
                            && row.pid === held.pid && row.attemptId === held.attempt.attemptId);
                        assert.equal(fences.length, 1); assert.equal(fences[0].returned, false);
                        assert.equal(fences[0].scope.state, 'fenced'); assert.equal(fences[0].attempt.masterEnd, null);
                        assert.ok(evidence.events.some(row => row.event === 'channel-close' && row.pid === held.pid));
                        assert.ok(!evidence.events.some(row => row.event === 'handoff-receipt-released'
                            || row.event === 'end' && row.end.attemptId === held.attempt.attemptId));
                        report.brokerRecovery.heldAfterRestart = evidence;
                    });
                } finally {
                    releaseWireBrokerReceipt(control); brokerReceiptReleased = true;
                }
                await wait('owned RabbitMQ management returned after physical restart', async () => {
                    report.brokerRecovery.restartedIncarnationCounters = await queues();
                    replay!.assertBrokerReconnected();
                    report.brokerRecovery.sourceReconnection = replay!.metrics();
                });
                const unavailable: any[] = [];
                await wait('state APIs remain unavailable before the new source continuation', async () => {
                    for (const [index, definition] of plan.definitions.entries()) {
                        const response = await query(definition.id); assertPortableUnavailable(response);
                        assert.equal(response.body.code, 'projection_source_unavailable');
                        unavailable[index] = {projectionId: definition.id, ...responseReceipt(response)};
                    }
                });
                report.brokerRecovery.unavailableBeforeContinuation = unavailable;
                // A new reader session cannot settle canonical authority without its next real frame.
                // The original 33 oracles above remain intact; release exactly one bounded continuation.
                replay.releaseBrokerContinuation(); through = 34;
                const resumedBlock = source.records[through - 1];
                assert.ok(through < stateAbiAvailability.fromBlock, 'continuation must precede the pinned projection ABI deployment');
                await wait('broker continuation reached the actual projection checkpoint', async () => {
                    const recoveries = await Promise.all(adapters.map((adapter, index) => adapter.recovery(bindings[index])));
                    for (const recovery of recoveries) {
                        assert.equal(recovery.initialized, true);
                        assert.deepEqual(recovery.checkpoint, {blockNum: through, blockId: resumedBlock.blockId});
                        assert.equal(recovery.pending, null); assert.equal(recovery.gap, null);
                    }
                    replay!.assertBrokerContinued(); replay!.assertThrough(through); report.lastRecovery = recoveries;
                });
                const responses: any[] = [];
                await wait('original predeployment APIs restored after canonical continuation', async () => {
                    for (const [index, definition] of plan.definitions.entries()) {
                        const response = await query(definition.id); assertPortablePredeployment(response);
                        responses[index] = {projectionId: definition.id, ...responseReceipt(response)};
                    }
                });
                let counterWindows: ReturnType<typeof auditWireBrokerSourceCounterWindows> | undefined;
                await wait('owned Rabbit queues drained and incarnation counters reconciled after broker continuation', async () => {
                    const rows = await queues(); assert.ok(rows.length > 0);
                    assert.ok(rows.every((row: any) => row.ready === 0 && row.unacked === 0 && row.messages === 0));
                    counterWindows = auditWireBrokerSourceCounterWindows({chain, through,
                        restart: report.brokerRecovery.restart, before: report.brokerRecovery.before.counters, after: rows});
                });
                const {ActionSourceAdmissionStore} = await import(new URL('../../build/indexer/history/action-source-admission.js', import.meta.url).href);
                const store = new ActionSourceAdmissionStore(es, chain, 1);
                await wait('broker retry has its own retained source-bound attempt association', async () => {
                    brokerAttemptAudit = await auditWireBrokerAttemptRecovery({control, masterPid: master!.pid, store});
                });
                report.brokerRecovery.attemptAudit = brokerAttemptAudit;
                assert.ok(counterWindows);
                assert.ok(native);
                const nativePrefix = await native.hold(through);
                const nativeFile = `prefixes/native-${through}.json`, nativeBytes = Buffer.from(JSON.stringify(nativePrefix, null, 2) + '\n');
                await writeFile(join(output, nativeFile), nativeBytes, {flag: 'wx'});
                report.native.holds.push({through, file: nativeFile, sha256: portableSourceHash(nativeBytes)});
                report.brokerRecovery.continuation = {through, blockId: resumedBlock.blockId, responses,
                    source: replay.metrics(), recovery: report.lastRecovery, queues: await queues(),
                    evidence: readWireBrokerRecoveryEvidence(control), counterWindows, recoveryQualified: false};
                report.brokerRecovery.status = 'observed';
                if (options.storageRecovery) report.storageRecovery.brokerHandover = {status: 'observed', through,
                    report: `prefixes/broker-restart-${through}.json`, originalAttemptId: brokerAttemptAudit!.originalEnd.attemptId,
                    replacementAttemptId: brokerAttemptAudit!.end.attemptId, brokerSettlement: 'unknown'};
                const file = `prefixes/broker-restart-${through}.json`, bytes = Buffer.from(JSON.stringify(report.brokerRecovery, null, 2) + '\n');
                await writeFile(join(output, file), bytes, {flag: 'wx'});
                report.prefixes.push({through, file, sha256: portableSourceHash(bytes)});
            }
            if (readerControl && through === 33) {
                const {ActionSourceAdmissionStore} = await import(new URL('../../build/indexer/history/action-source-admission.js', import.meta.url).href);
                const {ProtocolSourceBindingStore} = await import(new URL('../../build/indexer/protocol/source-bindings.js', import.meta.url).href);
                const store = new ActionSourceAdmissionStore(es, chain, 1);
                const selections = new ProtocolSourceBindingStore(es, chain, 1, {readOnly: true});
                let checkpoint: any;
                await wait('original same master holds its selected source-backed canonical RPC', async () => {
                    const evidence = readWireReaderRecoveryEvidence(readerControl!.control), held = evidence.held;
                    assert.equal(held.masterPid, master!.pid); assert.equal(held.parentPid, process.pid);
                    assert.equal(held.controlSha256, wireReaderControlDigest(readerControl!.control));
                    const original = await auditWireRecoveryEnd(readerControl!.control, held.end, store);
                    const counters = await queues(); assert.ok(counters.length > 0);
                    assert.ok(counters.every((row: any) => row.ready === 0 && row.unacked === 0 && row.messages === 0));
                    replay!.assertThrough(33); ledger!.assertIdle(); checkpoint = {held, original, counters};
                });
                const captured = await snapshotWireReader({control: readerControl.control, child: master!, rows: await observedDirectoryRows()});
                const snapshot = describeWireReaderSnapshot(captured); assert.deepEqual(snapshot.end, checkpoint.held.end);
                const response = await rpc.checkedBlockResponse(snapshot.readBlockNum);
                assert.equal(response.blockId, snapshot.response.blockId);
                const responseValue = JSON.parse(response.bytes.toString()); assert.equal(responseValue.block_num, snapshot.readBlockNum);
                assert.equal(responseValue.previous, snapshot.response.previousBlockId);
                const rpcFile = 'reader-recovery/held-rpc-response.json';
                await writeFile(join(output, rpcFile), response.bytes, {flag: 'wx'});
                report.readerRecovery.checkpoint = checkpoint; report.readerRecovery.snapshot = snapshot;
                report.readerRecovery.rpcResponse = {file: rpcFile, bytes: response.bytes.length, sha256: portableSourceHash(response.bytes),
                    blockNum: snapshot.readBlockNum, blockId: response.blockId};
                await assert.rejects(() => crashWireReader(structuredClone(captured)), /unissued/);
                readerCrash = await crashWireReader(captured); report.readerRecovery.crash = describeWireReaderCrash(readerCrash);
                report.cleanup.push({name: 'original-reader-crash', ok: true, fence: report.readerRecovery.crash.fence});
                assert.throws(() => describeWireReaderCrash(structuredClone(readerCrash)), /unissued/);
                const oldObserver = `observer/master/worker-${report.readerRecovery.crash.fence.reader.pid}.jsonl`;
                const oldRows = await boundedPortableFile(join(output, oldObserver), 64 * 1024 * 1024);
                report.readerRecovery.interruptedObserver = {file: oldObserver, bytes: oldRows.length,
                    sha256: portableSourceHash(oldRows), unterminatedTailBytes: oldRows.length - oldRows.lastIndexOf(10) - 1};
                await wait('original reader stream closes before the normal resumed stream is permitted', async () => {
                    await replay!.allowReaderRestart(readerCrash);
                });
                through = readerControl.control.resumeBlockNum; replay.releaseThrough(through);
                await wait('same master establishes its replacement reader source and LIB', async () => {
                    const status = await wireReaderStatus(readerCrash); assert.equal(status.masterPid, master!.pid);
                    assert.equal(status.terminated, true); assert.ok(status.replacement);
                    report.readerRecovery.currentReader = status.replacement;
                });
                await releaseWireReaderRpc(readerCrash);
                const resumedBlock = source.records[through - 1];
                const handoverBudget = await wait('old canonical return rejects while the same master records a fresh source-bound association', async () => {
                    replay!.assertThrough(34); ledger!.assertIdle();
                    report.readerRecovery.evidence = await auditWireReaderHandover({receipt: readerCrash, masterPid: master!.pid,
                        rows: await observedDirectoryRows(), store, selections, es, queues: await queues()});
                    const recoveries = await Promise.all(adapters.map((adapter, index) => adapter.recovery(bindings[index])));
                    for (const recovery of recoveries) {
                        assert.equal(recovery.initialized, true); assert.deepEqual(recovery.checkpoint, {blockNum: 34, blockId: resumedBlock.blockId});
                        assert.equal(recovery.pending, null); assert.equal(recovery.gap, null);
                    }
                    report.readerRecovery.recovery = recoveries; report.readerRecovery.stateResponses = [];
                    assert.ok(through < stateAbiAvailability.fromBlock, 'this fixed handover case precedes the original ABI deployment');
                    for (const definition of plan.definitions) {
                        const response = await query(definition.id); assertPortablePredeployment(response);
                        report.readerRecovery.stateResponses.push(responseReceipt(response));
                    }
                });
                const absenceFile = 'reader-recovery/old-association-absence.json';
                await writeFile(join(output, absenceFile), JSON.stringify(report.readerRecovery.evidence.absence, null, 2) + '\n', {flag: 'wx'});
                report.readerRecovery.absenceFile = absenceFile;
                await refreshActions(through, 'reader-handover');
                assert.ok(native); report.readerRecovery.nativeReplay = await native.resumedHead(handoverBudget);
                assert.equal(report.readerRecovery.nativeReplay.current.value.source.readerSessionId, report.readerRecovery.currentReader.readerSessionId);
                assert.equal(report.readerRecovery.nativeReplay.current.value.generation, report.readerRecovery.currentReader.generation);
                report.readerRecovery.status = 'observed';
                await writeFile(join(output, 'prefixes/reader-handover-33.json'), JSON.stringify(report.readerRecovery, null, 2) + '\n', {flag: 'wx'});
            }
            if (masterControl && through === 33) {
                const {ActionSourceAdmissionStore} = await import(new URL('../../build/indexer/history/action-source-admission.js', import.meta.url).href);
                const store = new ActionSourceAdmissionStore(es, chain, 1), originalMaster = master!;
                await wait('original master holds same-attempt adjudication after durable handoff', async () => {
                    report.masterRestart.checkpoint = await inspectWireMasterCheckpoint({control: masterControl!.control,
                        masterPid: originalMaster.pid, store, queues: await queues()});
                    ledger!.assertIdle();
                });
                masterCrash = await crashWireMaster({control: masterControl.control, child: originalMaster,
                    rows: await observedDirectoryRows(), store, queues: await queues()});
                const copiedCrash = describeWireMasterCrash(masterCrash); copiedCrash.control.blockNum = 1;
                assert.equal(describeWireMasterCrash(masterCrash).control.blockNum, 33);
                assert.throws(() => describeWireMasterCrash(structuredClone(masterCrash)), /unissued/);
                report.masterRestart.crash = describeWireMasterCrash(masterCrash);
                report.masterRestart.originalExit = {code: originalMaster.exitCode, signal: originalMaster.signalCode};
                report.masterRestart.crashedObserverFiles = [];
                for (const name of (await readdir(join(output, 'observer/master'))).filter(value => value.endsWith('.jsonl'))) {
                    const content = await boundedPortableFile(join(output, 'observer/master', name), 64 * 1024 * 1024);
                    report.masterRestart.crashedObserverFiles.push({file: 'observer/master/' + name, bytes: content.length,
                        sha256: portableSourceHash(content), unterminatedTailBytes: content.length - content.lastIndexOf(10) - 1});
                }
                report.cleanup.push({name: 'original-master-crash', ok: true, fence: report.masterRestart.crash.fence});
                master = undefined;
                await wait('old master source stream closes before a single resumed stream is permitted', async () => {
                    await replay!.allowMasterRestart(masterCrash);
                });
                const copiedSource = replay.metrics(); assert.ok(copiedSource.restart); copiedSource.restart.blockNum = 1;
                assert.equal(replay.metrics().restart?.blockNum, 34, 'diagnostic source metadata changed restart authority');
                through = masterControl.control.resumeBlockNum; replay.releaseThrough(through);
                const resumedBlock = source.records[through - 1];
                masterRestarted = true; master = await spawnOwned('build/indexer/launcher.js', configFile);
                report.masterPid = master.pid; report.masterRestart.status = 'restarted';
                report.masterRestart.replacementMasterPid = master.pid;
                const handoverBudget = await wait('replacement master rejects the old end and completes its own fresh block34 association', async () => {
                    replay!.assertThrough(34); ledger!.assertIdle();
                    report.masterRestart.evidence = await auditWireMasterRestart({receipt: masterCrash, newMasterPid: master!.pid,
                        rows: await observedDirectoryRows('master-restarted'), store, queues: await queues()});
                    const recoveries = await Promise.all(adapters.map((adapter, index) => adapter.recovery(bindings[index])));
                    for (const recovery of recoveries) {
                        assert.equal(recovery.initialized, true);
                        assert.deepEqual(recovery.checkpoint, {blockNum: 34, blockId: resumedBlock.blockId});
                        assert.equal(recovery.pending, null); assert.equal(recovery.gap, null);
                    }
                    report.masterRestart.recovery = recoveries;
                    report.masterRestart.stateResponses = [];
                    assert.ok(through < stateAbiAvailability.fromBlock, 'this fixed restart case precedes the original ABI deployment');
                    for (const definition of plan.definitions) {
                        const response = await query(definition.id);
                        assertPortablePredeployment(response);
                        report.masterRestart.stateResponses.push(responseReceipt(response));
                    }
                });
                await refreshActions(through, 'master-restart');
                assert.ok(native); report.masterRestart.nativeReplay = await native.resumedHead(handoverBudget);
                report.masterRestart.status = 'observed';
                const result = Buffer.from(JSON.stringify(report.masterRestart, null, 2) + '\n');
                await writeFile(join(output, 'prefixes/master-restart-33.json'), result, {flag: 'wx'});
            }
        }
        replay.assertThrough(source.endBlock); ledger.assertIdle();
        await wait('broker actual consumer ACK statistics', async () => {const rows = await queues();
            const sourceQueues = rows.filter((row: any) => row.name === chain + ':live_blocks');
            assert.ok(sourceQueues.length > 0, 'source block queue is missing');
            const expectedDeliveries = brokerControl ? source.endBlock - 33 : source.endBlock;
            assert.equal(sourceQueues.reduce((sum: number, row: any) => sum + row.ack, 0), expectedDeliveries, 'broker ACK count differs from the exact original/resumed source sequence');
            assert.equal(sourceQueues.reduce((sum: number, row: any) => sum + row.delivered, 0), expectedDeliveries, 'broker delivery count differs from the exact original/resumed source sequence');
            assert.equal(sourceQueues.reduce((sum: number, row: any) => sum + row.redelivered, 0), 0);
            assert.ok(rows.every((row: any) => row.ready === 0 && row.unacked === 0 && row.messages === 0)); report.brokerAcks = rows;
            if (brokerControl) report.brokerRecovery.sourceCounterWindows = auditWireBrokerSourceCounterWindows({chain,
                through: source.endBlock, restart: report.brokerRecovery.restart, before: report.brokerRecovery.before.counters, after: rows});
        });
        const observer = await observedRows(), expected = Array.from({length: source.endBlock}, (_, index) => index + 1);
        for (const direction of ['ipc_send', 'ipc_receive']) assert.deepEqual(observer.filter(row => row.kind === direction && row.event === 'read_block' && row.role === 'continuous_reader')
            .map(row => row.message.block_num), expected, 'publisher-confirmed source interval differs');
        report.replay = replay.metrics(); report.bulk = summarizeBulkLedger(ledger.receipts);
        if (native) report.native.final = await native.final();
        report.productionProgressKey = await redis.get(chain + '::last_indexed_block');
        const invalid = await query(plan.definitions[0].id, {filter: [], limit: 1, native: {$where: 'invalid'}} as any); assert.equal(invalid.status, 400);
        assert.equal((await query('unconfigured-projection')).status, 404);
        const afterSource = await auditPortableWorkerSource(plan.source, source.profileId as PortableSourceProfile);
        assert.deepEqual(afterSource.inputHashes, source.inputHashes); assert.deepEqual(afterSource.components, source.components);
        assert.equal(writeFailureObserved, true); assert.ok(report.contractFailure.observations.length >= 2);
        if (recoveryControl) assert.equal(report.attemptRecovery.status, 'observed');
        if (masterControl) assert.equal(report.masterRestart.status, 'observed');
        if (readerControl) assert.equal(report.readerRecovery.status, 'observed');
        assert.equal(mongoSamples.evidence.failedCaptures, 0, 'physical Mongo sample capture incomplete');
        if (historyDiagnostics) assert.deepEqual(report.errors, []);
        report.limits.writeFailureIsolationQualified = true;
        report.status = 'passed';
    } catch (error) {report.status = 'failed'; report.error = describeError(error);}
    finally {
        if (brokerControl) report.brokerRecovery.fullWorkloadVerdict = report.status;
        if (report.storageRecovery) report.storageRecovery.fullWorkloadVerdict = report.status;
        cleanupDeadline = performance.now() + 90_000;
        if (brokerControl && !brokerReceiptReleased) {
            try {releaseWireBrokerReceipt(brokerControl.control); brokerReceiptReleased = true;}
            catch (error) {report.status = 'failed'; report.cleanup.push({name: 'held-broker-receipt', ok: false, error: describeError(error)});}
        }
        if (mongoWriteFaultActive) {
            try {report.writeFailureCleanup = await configureMongoWriteFault('off'); mongoWriteFaultActive = false;}
            catch (error) {report.status = 'failed'; report.cleanup.push({name: 'owned-mongodb-failpoint', ok: false, error: describeError(error)});}
        }
        for (const [name, child] of [['api', api], ['master', master]] as const) if (child) {
            try {if (child.exitCode === null && child.signalCode === null && child.connected) child.send({event: 'qualifier_shutdown'});
                if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), pause(10000)]);
                report[name + 'Exit'] = {code: child.exitCode, signal: child.signalCode};
                const observerInstance = name === 'master' && masterRestarted ? 'master-restarted' : name;
                const all = await observedDirectoryRows(observerInstance, true);
                if (options.native) report[name + 'RejectionDiagnostics'] = {raw: auditWorkerRejectionDiagnostics(all, child.pid!)};
                const fault = name === 'master' && recoveryControl
                    && (await readdir(join(output, 'attempt-recovery'))).includes('fault.json')
                    ? readWireRecoveryEvidence(recoveryControl.control).marker : undefined;
                const readerFault = name === 'master' && readerCrash ? readerCrash : undefined;
                const checked = readerFault ? wireReaderShutdownRows(all, readerFault, child.pid!, child.exitCode, child.signalCode)
                    : fault ? wireRecoveryShutdownRows(all, fault, child.pid!, child.exitCode, child.signalCode) : all;
                if (options.native) {
                    // Existing private fault verification alone selects this survivor view. Raw missing
                    // SIGKILL summaries stay incomplete above; diagnostics introduce no exit membership.
                    const coverage = auditWorkerRejectionDiagnostics(checked, child.pid!);
                    report[name + 'RejectionDiagnostics'].requiredSurvivors = coverage;
                    assert.equal(coverage.status, 'complete', 'Required native worker rejection capture is incomplete');
                }
                report[name + 'Shutdown'] = assertSuccessfulWorkerShutdown(checked, child.pid!, fault || readerFault ? 0 : child.exitCode, child.signalCode);
                if (fault) report.expectedWorkerExit = {marker: fault, rawMasterExit: report[name + 'Exit'],
                    rawShutdown: all.find(row => row.kind === 'shutdown' && row.pid === child.pid),
                    note: 'Only the proven deliberate worker exit is normalized in the detached cleanup verifier input.'};
                if (readerFault) report.expectedReaderExit = {fence: describeWireReaderCrash(readerFault).fence, rawMasterExit: report[name + 'Exit'],
                    rawShutdown: all.find(row => row.kind === 'shutdown' && row.pid === child.pid),
                    note: 'Only the privately issued, ownership-verified reader SIGKILL is removed from detached normal-lifecycle checks; all raw evidence is retained.'};
                report.cleanup.push({name, ok: true});
            } catch (error) {report.status = 'failed'; report.cleanup.push({name, ok: false, error: describeError(error)});
                try {if (child.pid && child.exitCode === null && child.signalCode === null) {
                    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {timeout: 5000});
                    else process.kill(-child.pid, 'SIGKILL');
                }} catch (cleanupError: any) {if (cleanupError.code !== 'ESRCH') report.cleanup.push({name: name + '-forced', ok: false, error: describeError(cleanupError)});}}
            try {
                if (name === 'master' && report.expectedWorkerExit) {
                    report.profiling.recoveryCensus = {cpuCapture: false, expectedUnflushedWorker: report.expectedWorkerExit.marker.pid,
                        processes: (await observedRows(name, true)).filter(row => row.kind === 'start').map(row => ({pid: row.pid, role: row.role})),
                        note: 'Raw exits and full physical process census validated by the recovery shutdown oracle; no profile capture claimed.'};
                } else {
                    const observerInstance = name === 'master' && masterRestarted ? 'master-restarted' : name;
                    const rawRows = await observedDirectoryRows(observerInstance, true);
                    const profileRows = name === 'master' && readerCrash
                        ? wireReaderShutdownRows(rawRows, readerCrash, child.pid!, child.exitCode, child.signalCode) : rawRows;
                    report.profiling.components.push({component: observerInstance, processes: await auditPortableWorkerProfiles(output, observerInstance,
                        profileRows, child.pid!, options.profile === true)});
                }
            } catch (error) {
                report.status = 'failed'; report.profiling.failures.push({component: name, error: describeError(error)});
            }
        }
        if (options.profile) report.profiling.status = report.profiling.failures.length === 0 && report.profiling.components.length === 2
            ? 'captured' : 'incomplete';
        for (const [name, close] of [['replay', () => replay?.close()], ['rpc', () => rpc?.close()], ['bulk', () => ledger?.close()],
            ['redis', () => redis?.disconnect()], ['mongo-client', () => mongo?.close()], ['elasticsearch', () => es.close()],
            ['owned-mongodb', () => mongoFixture.cleanup()]] as const) {
            try {
                if (name === 'replay' && replay) report.replay = {...replay.metrics(), requests: replay.requests};
                await close(); report.cleanup.push({name, ok: true});
            } catch (error) {report.status = 'failed'; report.cleanup.push({name, ok: false, error: describeError(error)});}
        }
        if (ledger) report.bulkCapture = {...ledger.limits, recordedRequests: ledger.receipts.length};
        if (mongoSamples.evidence.failedCaptures > 0) report.status = 'failed';
        if (historyDiagnostics && (historyDiagnostics.evidence.failedCaptures > 0 || report.errors.length > 0)) report.status = 'failed';
        if (brokerControl) {
            try {report.brokerRecovery.terminalEvidence = readWireBrokerRecoveryEvidence(brokerControl.control);}
            catch (error) {report.brokerRecovery.evidenceError = describeError(error);}
        }
        report.mongoCleanup = mongoFixture.cleanupResult; report.completedAt = new Date().toISOString();
        await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportHandle.sync(); await reportHandle.close();
    }
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = parsePortableWorkerArguments(process.argv.slice(2));
    const result = await runPortableStateWorker(args.stateFile, args.planFile, args.outputDirectory, args.options);
    console.log(JSON.stringify({status: result.status, error: result.error, prefixes: result.prefixes}));
    if (result.status !== 'passed') process.exitCode = 1;
}
