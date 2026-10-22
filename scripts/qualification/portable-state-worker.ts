/** #191 actual launcher + broker + portable Mongo adapter + HTTP qualification.
 * Lifecycle/namespace/observation patterns are adapted from PR236/239 wire-worker-replay.ts.
 * This driver imports no old source corpus or evidence archive and never initializes a projection.
 */
import assert from 'node:assert/strict';
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
import {OwnedMongoFixture, MONGODB_VERSION, waitForMongo} from './projection-fixture.mjs';
import {auditPortableWorkerSource, boundedPortableFile, ordinaryPortablePath, portableSourceHash,
    portableSourceLimits, servePortableWorkerSource, type PortableSourceInput, type PortableSourceFile,
    type PortableWorkerSource, type PortableSourceProfile} from './portable-state-worker-source.ts';
import {assertPortableWorkerOracle} from './portable-state-worker-oracle.ts';
import {auditPortableNativeOracle, createPortableNativeQualification, nativePortableHolds, portableLegacyProfile,
    portableNativeProfile} from './portable-state-worker-native.ts';

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

export function portableWorkerEnvironment(environment: NodeJS.ProcessEnv, output: string, config: string, chain: string) {
    const selected = {...environment};
    for (const name of Object.keys(selected)) if (name.startsWith('ES198_') || name.startsWith('worker_') || name.startsWith('HYPERION_PORTABLE_') ||
        ['NODE_OPTIONS', 'NODE_PATH', 'CONFIG_JSON', 'CHAIN_NAME', 'first_block', 'last_block', 'live_mode'].includes(name)) delete selected[name];
    return {...selected, NODE_OPTIONS: '', CONFIG_JSON: config, CHAIN_NAME: chain,
        ES198_OBSERVER_DIR: join(output, 'observer'), ES198_CPU_PROFILE: '0'};
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
            limits: {}, explorer: {home_redirect: false, upstream: '', theme: ''}},
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

async function sourceRpc(source: PortableWorkerSource, errors: string[]) {
    const requests: any[] = []; let totalBytes = 0;
    const server = createServer(async (incoming, outgoing) => {
        try {
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const value of incoming) {bytes += value.length; assert.ok(bytes <= 4096); chunks.push(Buffer.from(value));}
            totalBytes += bytes; assert.ok(totalBytes <= 1024 * 1024 && requests.length < 512);
            const body = bytes ? JSON.parse(Buffer.concat(chunks).toString()) : {};
            const allowed = (incoming.method === 'POST' || incoming.method === 'GET') && incoming.url === '/v1/chain/get_info' && Object.keys(body).length === 0;
            requests.push({method: incoming.method, path: incoming.url, body, allowed});
            assert.ok(allowed, 'RPC fallback is outside the retained startup view');
            outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(JSON.stringify(source.startupInfo));
        } catch (error) {errors.push(describeError(error)); outgoing.writeHead(503, {'content-type': 'application/json'}); outgoing.end('{"error":"retained RPC input unavailable"}');}
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return {url: `http://127.0.0.1:${(server.address() as any).port}`, requests,
        lineage: {kind: 'derived-startup-control', blockNum: 1, blockId: source.records[0].blockId,
            description: 'get_info control fields derive from original block1; original SHiP status/frame head and LIB are untouched.'},
        close: () => new Promise<void>(done => {server.closeAllConnections(); server.close(() => done());})};
}

export async function runPortableStateWorker(stateFile: string, planFile: string, outputDirectory: string, options: {native?: boolean} = {}) {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every(key => key === 'native'));
    if (Object.hasOwn(options, 'native')) assert.equal(typeof options.native, 'boolean');
    assert.equal(process.release.name, 'node'); assert.ok(!process.versions.bun && /^(22|24)\./.test(process.versions.node));
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
    const state = JSON.parse((await boundedPortableFile(resolve(stateFile), 1024 * 1024)).toString());
    const services = [...state.core.nodes, state.core.broker, state.redis, ...['spring', 'mongo'].filter(key => state[key]).map(key => state[key])];
    const inspected = JSON.parse(docker(['inspect', ...services.map(service => service.containerId)]));
    const inspections = Object.fromEntries(services.map(service => [service.name, inspected.find((item: any) => item.Id === service.containerId)]));
    const network = JSON.parse(docker(['network', 'inspect', state.network]))[0];
    assertPortableWorkerServices(state, inspections, network);
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
    const reportHandle = await open(join(output, 'report.json'), 'wx');
    const report: any = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), source: {
        chainId: source.chainId, profileId: source.profileId, revision: source.sourceRevision, components: source.components,
        range: {first: 1, last: source.endBlock}, inputHashes: source.inputHashes, originalStatus: source.originalStatus},
        planSha256: portableSourceHash(planBytes), oracleHashes, expectationOrigin: plan.expectationOrigin,
        mode: options.native ? 'installed-native-wire-engineering' : 'legacy-wire-state',
        preloads: options.native ? ['action-source-admission-preload.mjs', 'portable-state-worker-native-observer.mjs', 'es955-worker-observer.mjs'] : ['es955-worker-observer.mjs'],
        runtime: {node: process.version, executable: process.execPath}, inspections, network, volumes: volumeEvidence,
        prefixes: [], cleanup: [], errors: [], limits: {releaseQualified: false, forkRecoveryQualified: false, rustQualified: false,
            processCrashRecoveryQualified: false, writeFailureIsolationQualified: false,
            note: 'Actual Node worker/Mongo/HTTP tracer; no AtomicAssets, full release, fork or Bun qualification.'}};
    const chain = `hyp-p191-${state.run}`, database = `h45_p191_${state.run}`;
    const invalidDefinition = portableWorkerFaultDefinition(plan), faultThrough = plan.barriers[0].through;
    const mongoFixture = new OwnedMongoFixture({command: docker});
    let mongo: MongoClient | undefined, redis: Redis | undefined, master: ChildProcess | undefined, api: ChildProcess | undefined;
    let replay: Awaited<ReturnType<typeof servePortableWorkerSource>> | undefined, rpc: Awaited<ReturnType<typeof sourceRpc>> | undefined;
    let ledger: Awaited<ReturnType<typeof startBulkLedger>> | undefined;
    let mongoWriteFaultActive = false;
    const configureMongoWriteFault = async (mode: 'alwaysOn' | 'off') => {
        assert.ok(mongo); mongoFixture.ownedContainer('replica');
        return mongo.db('admin').command({configureFailPoint: 'failCommand', mode,
            ...(mode === 'alwaysOn' ? {data: {failCommands: ['update'], errorCode: 2}} : {})});
    };
    const es = new Client({node: state.core.nodes[0].url, requestTimeout: 10000, maxRetries: 0});
    const wait = async (name: string, condition: () => Promise<void>, milliseconds = 60000) => {
        const end = Math.min(deadline, performance.now() + milliseconds); let last: unknown;
        while (performance.now() < end) {for (const child of [master, api]) if (child) assert.ok(child.exitCode === null && child.signalCode === null, `${name}: actual child exited`);
            assert.deepEqual(report.errors, []); try {await condition(); return;} catch (error) {last = error;} await pause(100);}
        throw new Error(`${name} did not complete: ${describeError(last)}`);
    };
    const queues = async () => {
        const response = await fetch(state.core.broker.managementUrl + '/api/queues/%2F', {
            headers: {authorization: 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64')}, signal: AbortSignal.timeout(Math.min(5000, remaining()))});
        assert.equal(response.status, 200); const rows = await boundedResponse(response, 1024 * 1024);
        assert.ok(Array.isArray(rows) && rows.length <= 4096);
        return rows.filter((row: any) => row.name.startsWith(chain + ':')).map((row: any) => ({name: row.name,
            ready: row.messages_ready, unacked: row.messages_unacknowledged, messages: row.messages, consumers: row.consumers,
            ack: row.message_stats?.ack ?? 0, delivered: row.message_stats?.deliver_get ?? 0, redelivered: row.message_stats?.redeliver ?? 0}));
    };
    const observedRows = async (kind = 'master', complete = false) => {
        const directory = join(output, 'observer', kind);
        const names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')); assert.ok(names.length <= 64);
        const rows: any[] = []; for (const name of names) {const bytes = await boundedPortableFile(join(directory, name), 64 * 1024 * 1024);
            const lines = bytes.toString().split(/\r?\n/); for (const [index, line] of lines.entries()) if (line.trim()) {
                try {rows.push(JSON.parse(line));} catch (error) {if (complete || index < lines.length - 1) throw error;}
            }}
        return rows;
    };
    const spawnOwned = async (entry: string, config: string) => {
        const name = entry.includes('/api/') ? 'api' : 'master';
        const stdout = await open(join(output, name + '.stdout.log'), 'wx'), stderr = await open(join(output, name + '.stderr.log'), 'wx');
        const nativePreloads = options.native ? ['action-source-admission-preload.mjs', 'portable-state-worker-native-observer.mjs']
            .flatMap(file => ['--import', pathToFileURL(join(repo, 'scripts/qualification', file)).href]) : [];
        try {const child = spawn(process.execPath, [...nativePreloads, '--import', pathToFileURL(join(repo, 'scripts/qualification/es955-worker-observer.mjs')).href, join(repo, entry)],
            {cwd: output, env: {...portableWorkerEnvironment(process.env, output, config, chain), ES198_OBSERVER_DIR: join(output, 'observer', name),
                ...(options.native ? {HYPERION_PORTABLE_NATIVE_QUALIFICATION: '1'} : {})},
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
        replay = await servePortableWorkerSource(source, report.errors); rpc = await sourceRpc(source, report.errors);
        report.rpc = {requests: rpc.requests, lineage: rpc.lineage};
        ledger = await startBulkLedger(state.core.nodes[0].url, join(output, 'bulk'), report.errors, 20000);
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
        report.config = config; report.bindings = bindings; report.connections = connections;
        report.contractFailure = {definition: invalidDefinition, binding: invalidBinding,
            description: 'Fixture-only missing required source field; healthy definitions and independent expected rows are unchanged.', observations: []};
        master = await spawnOwned('build/indexer/launcher.js', configFile); report.masterPid = master.pid;
        api = await spawnOwned('build/api/server.js', configFile); report.apiPid = api.pid;
        const query = async (projection: string, value: ProjectionQuery = {filter: [], limit: 256, count: {upTo: 1000}}) => {
            const response = await fetch(`http://127.0.0.1:${apiPort}/v2/state/query`, {method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({projection, query: value}), signal: AbortSignal.timeout(Math.min(5000, remaining()))});
            return {status: response.status, headers: response.headers, body: await boundedResponse(response)};
        };
        const responseReceipt = (response: Awaited<ReturnType<typeof query>>) =>
            ({status: response.status, headers: Object.fromEntries(response.headers), body: response.body});
        const history = async (through: number) => {
            const block = source.records[through - 1];
            await es.indices.refresh({index: chain + '-block-*'});
            const information = await es.nodes.info(); const dataNodes = Object.entries(information.nodes).filter(([, node]) =>
                state.core.nodes.some((owned: any) => owned.role === 'data' && owned.name === node.name));
            assert.equal(dataNodes.length, 2); const physical: any[] = [];
            for (const [nodeId, node] of dataNodes) {
                const result = await es.search<any>({index: chain + '-block-*', size: 2, track_total_hits: true,
                    preference: `_only_nodes:${nodeId}`, query: {term: {block_num: through}}});
                assert.equal(result.timed_out, false); assert.equal(result._shards.failed, 0);
                assert.ok(result._shards.total > 0); assert.equal(result._shards.successful, result._shards.total);
                assert.deepEqual(result.hits.total, {value: 1, relation: 'eq'}); const hit = result.hits.hits[0];
                assert.equal(hit._id, String(through)); assert.equal(hit._source.block_num, through);
                assert.equal(hit._source.block_id, block.blockId); assert.equal(hit._source.prev_id, block.previousBlockId);
                physical.push({nodeId, nodeName: node.name, response: result});
            }
            const response = await fetch(`http://127.0.0.1:${apiPort}/v2/history/get_block?block_num=${through}`,
                {signal: AbortSignal.timeout(Math.min(5000, remaining()))});
            const body = await boundedResponse(response); assert.equal(response.status, 200);
            assert.equal(body.block_num, through); assert.equal(body.block_id, block.blockId); assert.equal(body.prev_id, block.previousBlockId);
            return {through, blockId: block.blockId, physical, api: {status: response.status, headers: Object.fromEntries(response.headers), body}};
        };
        await wait('API unavailable before actual block1', async () => {const response = await query(plan.definitions[0].id);
            assertPortableUnavailable(response); report.beforeSource = responseReceipt(response);});
        const http = async (path: string) => {const response = await fetch(`http://127.0.0.1:${apiPort}` + path,
            {signal: AbortSignal.timeout(Math.min(10000, remaining()))});
            return {status: response.status, headers: response.headers, body: await boundedResponse(response)};};
        const unrelated = async (height: number) => {
            const block = source.records[height - 1], states: any[] = [];
            // Older history remains usable while state queries report the current covered head.
            for (const [index, definition] of plan.definitions.entries()) {const response = await query(definition.id);
                assert.equal(response.status, 200); assert.equal(response.body.view.binding.projectionId, bindings[index].projectionId);
                assert.equal(response.headers.get('hyperion-state-last-valid'), 'false'); states.push(responseReceipt(response));}
            return {history: await history(block.blockNum), states};
        };
        const native = nativeOracle ? await createPortableNativeQualification({source, oracle: nativeOracle, client: es, chain, apiPort,
            events: () => observedRows(), http, unrelated, wait, bulk: {directory: join(output, 'bulk'), receipts: ledger.receipts}}) : undefined;
        if (native) report.native = {profile: native.profile, oracleHashes: native.oracleHashes, holds: [],
            activation: 'Existing admission engineering preload only; ordinary installed native provider; public/default operator activation remains disabled.',
            constructedControls: native.controls, notificationInventory: native.originalNotifications};
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
            let isolation: any;
            if (through >= faultThrough) await wait(`invalid mapping remains durably isolated at${through}`, async () => {
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
                    assert.equal(response.status, 200); assertPortableApiResult(response.body, response.headers, bindings[index], {blockNum: through, blockId: block.blockId}, barrier.rows[definition.id]);
                    responses[index] = {status: response.status, headers: Object.fromEntries(response.headers), body: response.body};});
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
            await wait(`owned Rabbit queues drained at${through}`, async () => {const rows = await queues(); assert.ok(rows.length > 0);
                assert.ok(rows.every((row: any) => row.ready === 0 && row.unacked === 0 && row.messages === 0));});
            if (native) {await es.indices.refresh({index: chain + '-action-*'}); const observed = await native.hold(through);
                const file = `prefixes/native-${through}.json`, bytes = Buffer.from(JSON.stringify(observed, null, 2) + '\n');
                await writeFile(join(output, file), bytes, {flag: 'wx'}); report.native.holds.push({through, file, sha256: portableSourceHash(bytes)});}
            const observed = {through, blockId: block.blockId, responses, queues: await queues(), recovery: report.lastRecovery, source: replay.metrics(), isolation};
            const bytes = Buffer.from(JSON.stringify(observed, null, 2) + '\n'); const file = `prefixes/block-${through}.json`;
            await writeFile(join(output, file), bytes, {flag: 'wx'}); report.prefixes.push({through, file, sha256: portableSourceHash(bytes)});
        }
        replay.assertThrough(source.endBlock); ledger.assertIdle();
        await wait('broker actual consumer ACK statistics', async () => {const rows = await queues();
            const sourceQueues = rows.filter((row: any) => row.name === chain + ':live_blocks');
            assert.ok(sourceQueues.length > 0, 'source block queue is missing');
            assert.equal(sourceQueues.reduce((sum: number, row: any) => sum + row.ack, 0), source.endBlock, 'broker ACK count differs from original source blocks');
            assert.equal(sourceQueues.reduce((sum: number, row: any) => sum + row.delivered, 0), source.endBlock, 'broker delivery count differs from original source blocks');
            assert.equal(sourceQueues.reduce((sum: number, row: any) => sum + row.redelivered, 0), 0);
            assert.ok(rows.every((row: any) => row.ready === 0 && row.unacked === 0 && row.messages === 0)); report.brokerAcks = rows;
        });
        const observer = await observedRows(), expected = source.records.map(record => record.blockNum);
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
        report.limits.writeFailureIsolationQualified = true;
        report.status = 'passed';
    } catch (error) {report.status = 'failed'; report.error = describeError(error);}
    finally {
        cleanupDeadline = performance.now() + 90_000;
        if (mongoWriteFaultActive) {
            try {report.writeFailureCleanup = await configureMongoWriteFault('off'); mongoWriteFaultActive = false;}
            catch (error) {report.status = 'failed'; report.cleanup.push({name: 'owned-mongodb-failpoint', ok: false, error: describeError(error)});}
        }
        for (const [name, child] of [['api', api], ['master', master]] as const) if (child) {
            try {if (child.exitCode === null && child.signalCode === null && child.connected) child.send({event: 'qualifier_shutdown'});
                if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), pause(10000)]);
                report[name + 'Exit'] = {code: child.exitCode, signal: child.signalCode};
                const all = await observedRows(name, true); report[name + 'Shutdown'] = assertSuccessfulWorkerShutdown(all, child.pid!, child.exitCode, child.signalCode);
                report.cleanup.push({name, ok: true});
            } catch (error) {report.status = 'failed'; report.cleanup.push({name, ok: false, error: describeError(error)});
                try {if (child.pid && child.exitCode === null && child.signalCode === null) {
                    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {timeout: 5000});
                    else process.kill(-child.pid, 'SIGKILL');
                }} catch (cleanupError: any) {if (cleanupError.code !== 'ESRCH') report.cleanup.push({name: name + '-forced', ok: false, error: describeError(cleanupError)});}}
        }
        for (const [name, close] of [['replay', () => replay?.close()], ['rpc', () => rpc?.close()], ['bulk', () => ledger?.close()],
            ['redis', () => redis?.disconnect()], ['mongo-client', () => mongo?.close()], ['elasticsearch', () => es.close()],
            ['owned-mongodb', () => mongoFixture.cleanup()]] as const) {
            try {await close(); report.cleanup.push({name, ok: true});} catch (error) {report.status = 'failed'; report.cleanup.push({name, ok: false, error: describeError(error)});}
        }
        if (ledger) report.bulkCapture = {...ledger.limits, recordedRequests: ledger.receipts.length};
        report.mongoCleanup = mongoFixture.cleanupResult; report.completedAt = new Date().toISOString();
        await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportHandle.sync(); await reportHandle.close();
    }
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.ok(process.argv.length === 5 || (process.argv.length === 6 && process.argv[5] === '--native'),
        'usage: node portable-state-worker.ts STATE_FILE PLAN_JSON NEW_OUTPUT_DIRECTORY [--native]');
    const result = await runPortableStateWorker(process.argv[2], process.argv[3], process.argv[4], {native: process.argv[5] === '--native'});
    console.log(JSON.stringify({status: result.status, error: result.error, prefixes: result.prefixes}));
    if (result.status !== 'passed') process.exitCode = 1;
}
