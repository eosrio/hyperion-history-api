/** Bounded retained-Wire qualification through the real launcher and existing workers. */
import assert from 'node:assert/strict';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {mkdir, lstat, open, readFile, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {dirname, join, parse, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Client} from '@elastic/elasticsearch';
import {Redis} from 'ioredis';
import {MongoClient} from 'mongodb';
import {canonical, digest} from './contract-fixture.ts';
import {assertOwnedServices, assertResourceIsolation, assertEmptyProjection} from './contract-replay.ts';
import {validateFixture} from './es955-replicas.ts';
import {assertSuccessfulWorkerShutdown} from './es955-workers.ts';
import {startBulkLedger, summarizeBulkLedger} from './replay-bulk-ledger.ts';
import {auditWireReplayFixture, createWireReplayRpc, serveWireReplay, assertWireReplayComplete,
    wireReplayPins, type AuditedWireReplayFixture} from './wire-replay-fixture.ts';
import {assertWireStateSnapshot, readWireState, wireStateBarriers, wireStateContracts, type WireStateMode} from './wire-state-outputs.ts';
import type {WireReplayExpectations} from './wire-replay-outputs.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
export const wireReplayLimits = Object.freeze({runMs: 600_000, completionMs: 240_000, requestMs: 5000,
    rpcRequests: 128, rpcBytes: 4096, observerFiles: 64, observerBytes: 128 * 1024 * 1024});
export const wireReplayAccounts = Object.freeze(['wiremap', 'wiresec', 'wireproto', 'wireorder', 'wirenotify', 'wireinline', 'wireupgrade']);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const errorText = (error: unknown) => String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 8192);

export function parseWireWorkerReplayArguments(args: string[]) {
    assert.ok([2, 4, 6].includes(args.length),
        'usage: node wire-worker-replay.ts STATE_FILE NEW_OUTPUT_DIRECTORY [--package-root INSTALLED_PACKAGE_DIRECTORY] [--contract-state enabled|disabled]');
    assert.ok(args.slice(0, 2).every(value => value.trim().length > 0 && !value.startsWith('--')), 'invalid Wire replay argument');
    let packageRoot: string | undefined, stateMode: WireStateMode | undefined;
    const seen = new Set<string>();
    for (let index = 2; index < args.length; index += 2) {
        const option = args[index], value = args[index + 1];
        assert.ok(!seen.has(option), 'duplicate Wire replay option'); seen.add(option);
        assert.ok(value.trim().length > 0 && !value.startsWith('--'), 'invalid Wire replay option value');
        if (option === '--package-root') packageRoot = value;
        else {assert.equal(option, '--contract-state', 'unknown Wire replay option');
            assert.ok(value === 'enabled' || value === 'disabled', 'invalid Wire state mode'); stateMode = value;}
    }
    return {stateFile: args[0], outputDirectory: args[1], packageRoot, ...(stateMode ? {stateMode} : {})};
}

async function ordinary(path: string, directory = false) {
    path = resolve(path); const parents: string[] = [];
    for (let current = path;; current = dirname(current)) {
        parents.unshift(current); if (current === parse(current).root) break;
    }
    for (const parent of parents) {
        const info = await lstat(parent); assert.ok(!info.isSymbolicLink(), `reparse input/output refused: ${parent}`);
        if (parent !== path) assert.ok(info.isDirectory(), 'ordinary parent directory required');
    }
    const info = await lstat(path); assert.ok(directory ? info.isDirectory() : info.isFile(), 'ordinary file/directory required');
    return path;
}

export async function assertNewWireReplayOutput(path: string) {
    path = resolve(path); await ordinary(dirname(path), true);
    try { await lstat(path); } catch (error: any) { if (error.code === 'ENOENT') return path; throw error; }
    throw new Error('Wire replay output must be a new directory; existing evidence is never overwritten');
}

async function boundedFile(path: string, maximum = 16 * 1024 * 1024) {
    await ordinary(path); const info = await lstat(path); assert.ok(info.size <= maximum, 'input file exceeds bound');
    const bytes = await readFile(path); assert.ok(bytes.length === info.size && bytes.length <= maximum, 'input changed or exceeded bound');
    return bytes;
}

/** Qualification input cannot inherit a worker role, fault injector or executable preload. */
export function wireWorkerEnvironment(environment: NodeJS.ProcessEnv, output: string, configFile: string, chain: string): NodeJS.ProcessEnv {
    const selected = {...environment};
    for (const key of Object.keys(selected)) if (key.startsWith('ES198_') || key.startsWith('worker_') ||
        ['NODE_OPTIONS', 'NODE_PATH', 'live_mode', 'first_block', 'last_block', 'CONFIG_JSON', 'CHAIN_NAME'].includes(key)) delete selected[key];
    return {...selected, NODE_OPTIONS: '', CONFIG_JSON: configFile, CHAIN_NAME: chain,
        ES198_OBSERVER_DIR: join(output, 'observer'), ES198_CPU_PROFILE: '0'};
}

export function wireWorkerConfig(chain: string, stateMode?: WireStateMode, expected?: WireReplayExpectations) {
    assert.match(chain, /^hyp-wire-[a-f0-9]{12}$/);
    assert.ok(stateMode === undefined || stateMode === 'enabled' || stateMode === 'disabled', 'invalid Wire state mode');
    assert.equal(expected === undefined, stateMode === undefined, 'state config requires source expectations and explicit mode together');
    const contractState = stateMode ? {enabled: stateMode === 'enabled', contracts: wireStateContracts(expected!)} : {enabled: false, contracts: {}};
    return {api: {enabled: false, disable_tx_cache: true},
        indexer: {enabled: true, start_on: 2, stop_on: 0, rewrite: false, purge_queues: false,
            live_reader: true, live_only_mode: true, abi_scan_mode: false, fetch_block: true, fetch_traces: true,
            fetch_deltas: true, process_deltas: true, disable_reading: false, disable_indexing: false},
        settings: {chain, parser: '3.2', eosio_alias: 'sysio', system_contract: 'sysio',
            protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: 'wire-sysio-7dede884-engineering-v1'},
            index_version: 'v1', index_partition_size: 10000000, es_replicas: 1, auto_stop: 300,
            auto_mode_switch: false, ds_profiling: true, rate_monitoring: true, bp_monitoring: false,
            max_ws_payload_mb: 16, use_global_agent: false, debug: false},
        scaling: {readers: 1, ds_queues: 1, ds_threads: 1, ds_pool_size: 1, indexing_queues: 1, ad_idx_queues: 1, dyn_idx_queues: 1,
            max_autoscale: 0, batch_size: 128, resume_trigger: 16, auto_scale_trigger: 1000000,
            max_queue_limit: 64, block_queue_limit: 64, polling_interval: 500, routing_mode: 'round_robin'},
        prefetch: {read: 8, block: 8, index: 32},
        features: {streaming: {enable: false, traces: false, deltas: false},
            tables: {proposals: false, accounts: false, voters: false, permissions: false, user_resources: false},
            contract_state: contractState, index_deltas: true, index_all_deltas: true,
            index_deltas_deletions: true, deferred_trx: false, failed_trx: false, resource_limits: false, resource_usage: false},
        blacklists: {actions: [], deltas: []}, whitelists: {actions: wireReplayAccounts.map(account => `${account}::*`), deltas: [], max_depth: 10, root_only: false},
        plugins: {}, hub: {enabled: false}, alerts: {enabled: false}};
}

export function assertWireReaderConfirmations(rows: any[], records: readonly {blockNum: number}[]) {
    const expected = records.map(record => record.blockNum);
    assert.ok(expected.length > 0 && expected.every((number, index) => Number.isSafeInteger(number) &&
        (index === 0 || number === expected[index - 1] + 1)), 'invalid expected reader interval');
    for (const kind of ['ipc_send', 'ipc_receive']) {
        const confirmed = rows.filter(row => row.kind === kind && row.event === 'read_block' && row.role === 'continuous_reader');
        assert.deepEqual(confirmed.map(row => row.message.block_num), expected, `continuous reader ${kind} confirmation coverage/order differs`);
        assert.equal(new Set(confirmed.map(row => row.pid)).size, 1, 'multiple processes supplied one confirmation lane');
        assert.ok(confirmed.every(row => row.message.live === true), 'bulk confirmation substituted for live source');
    }
    assert.ok(!rows.some(row => row.kind === 'ipc_send' && row.event === 'read_block' && row.role === 'reader'), 'unexpected parallel bulk source');
    return {blocks: expected.length, first: expected[0], last: expected.at(-1), confirmationsSha256: digest(canonical(expected))};
}

export interface WireBulkPublication {operation: string; index: string; id: string; source?: any; receiptNumber: number; itemStatus?: number; error?: any;}
/** Preserve attempts individually; no ID-based deduplication can hide a publication. */
export function wireBulkPublications(receipt: any, bytes: Buffer): WireBulkPublication[] {
    assert.equal(bytes.length, receipt.request.bytes); assert.equal(digest(bytes), receipt.request.sha256, 'bulk body changed');
    assert.ok(bytes.length > 0 && bytes.at(-1) === 10, 'bulk body must end in a newline');
    const rows = bytes.toString('utf8').split('\n'); rows.pop(); const result: WireBulkPublication[] = [];
    for (const [offset, operation] of receipt.operations.entries()) {
        assert.ok(rows.length, 'bulk operation metadata missing'); const metadata = JSON.parse(rows.shift()!);
        assert.deepEqual(Object.keys(metadata), [operation.operation]); const entry = metadata[operation.operation];
        assert.equal(String(entry._id), operation.id); assert.equal(entry._index ?? decodeURIComponent(receipt.path.split('?')[0].split('/').filter(Boolean)[0]), operation.index);
        let source: any;
        if (operation.operation !== 'delete') { assert.ok(rows.length, 'bulk operation source missing'); source = JSON.parse(rows.shift()!); }
        const response = receipt.response?.items?.[offset]?.[operation.operation];
        result.push({operation: operation.operation, index: operation.index, id: operation.id, ...(source === undefined ? {} : {source}),
            receiptNumber: receipt.number, itemStatus: response?.status, ...(response?.error ? {error: response.error} : {})});
    }
    assert.deepEqual(rows, [], 'extra bulk source rows'); return result;
}

async function observerRows(output: string, complete = false) {
    const directory = join(output, 'observer'); const files = (await readdir(directory)).filter(file => /^worker-\d+\.jsonl$/.test(file));
    assert.ok(files.length <= wireReplayLimits.observerFiles, 'observer file count exceeds bound');
    let total = 0; const result: any[] = [];
    for (const file of files) {
        const bytes = await boundedFile(join(directory, file), 24 * 1024 * 1024); total += bytes.length;
        assert.ok(total <= wireReplayLimits.observerBytes, 'observer byte budget exceeded');
        const text = bytes.toString(); if (complete) assert.ok(text.endsWith('\n'), 'observer ended with a partial record');
        const lines = text.split('\n'); lines.pop(); for (const line of lines) if (line) result.push(JSON.parse(line));
    }
    return result;
}

async function serveRpc(fixture: AuditedWireReplayFixture, errors: string[]) {
    const rpc = createWireReplayRpc(fixture); const requests: any[] = [];
    const server = createServer(async (incoming, outgoing) => {
        const timer = setTimeout(() => incoming.destroy(new Error('bounded Wire RPC request timeout')), wireReplayLimits.requestMs);
        let record: any;
        try {
            assert.ok(requests.length < wireReplayLimits.rpcRequests, 'Wire RPC request budget exceeded');
            record = {method: incoming.method, path: incoming.url?.slice(0, 256), denied: true}; requests.push(record);
            let size = 0; const chunks: Buffer[] = [];
            for await (const chunk of incoming) { size += chunk.length; assert.ok(size <= wireReplayLimits.rpcBytes, 'Wire RPC request byte budget exceeded'); chunks.push(Buffer.from(chunk)); }
            const bytes = Buffer.concat(chunks); const body = bytes.length ? JSON.parse(bytes.toString()) : {};
            const reply = Buffer.from(JSON.stringify(rpc.reply(incoming.method, incoming.url, body)));
            assert.ok(reply.length <= wireReplayLimits.rpcBytes, 'Wire RPC response exceeds bound');
            Object.assign(record, {denied: false, requestSha256: digest(bytes), responseSha256: digest(reply), source: rpc.lineage});
            outgoing.writeHead(200, {'content-type': 'application/json'}); outgoing.end(reply);
        } catch (error) {
            if (record) record.error = errorText(error); if (errors.length < 64) errors.push(errorText(error));
            if (!outgoing.destroyed) { outgoing.writeHead(503, {'content-type': 'application/json'}); outgoing.end('{"error":"bounded Wire fixture RPC unavailable"}'); }
        } finally { clearTimeout(timer); }
    });
    server.requestTimeout = wireReplayLimits.requestMs; server.headersTimeout = wireReplayLimits.requestMs; server.maxHeadersCount = 32; server.maxConnections = 16;
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return {url: `http://127.0.0.1:${(server.address() as any).port}`, requests, lineage: rpc.lineage,
        close: async () => {server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));}};
}

const runtimeSources = ['package.json', 'package-lock.json', '.bun-version', 'AGENTS.md',
    'scripts/qualification/wire-worker-replay.ts', 'scripts/qualification/wire-replay-fixture.ts', 'scripts/qualification/wire-replay-outputs.ts',
    'scripts/qualification/wire-state-outputs.ts',
    'scripts/qualification/contract-replay.ts', 'scripts/qualification/contract-fixture.ts', 'scripts/qualification/replay-bulk-ledger.ts',
    'scripts/qualification/es955-worker-observer.mjs', 'scripts/qualification/es955-workers.ts', 'scripts/qualification/es955-replicas.ts',
    'node_modules/@eosrio/hyperion-wire-plugin/package.json', 'node_modules/@eosrio/hyperion-sdk/package.json',
    'node_modules/@elastic/elasticsearch/package.json', 'node_modules/amqplib/package.json', 'node_modules/uWebSockets.js/package.json',
    'node_modules/mongodb/package.json',
    ...['launcher', 'workers/hyperionWorker', 'workers/state-reader', 'workers/deserializer', 'workers/ds-pool', 'workers/indexer',
        'modules/master', 'modules/loader', 'modules/parsers/base-parser', 'modules/parsers/3.2-parser', 'helpers/reader-progress',
        'helpers/elastic-routes', 'helpers/mongo-routes', 'helpers/mongo-batch', 'protocol/selection', 'protocol/source-bindings', 'protocol/abi-observation-store',
        'protocol/abi-coordinator', 'protocol/abi-frontier-store', 'protocol/abi-reducer', 'protocol/abi-proof',
        'protocol/immutable-bundle-store'].flatMap(file => [`src/indexer/${file}.ts`, `build/indexer/${file}.js`])];

/** Keep the installed components' exact bytes, including source-only Rust members. */
export async function readWireComponentSources(packageRoot: string, selected: readonly {runtime: string; sha256: string}[]) {
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(component => component.runtime).sort(), ['node', 'rust']);
    const files = new Map<string, Buffer>();
    const expected = new Map<string, string>();
    for (const file of ['package.json', 'protocol-profile.json', 'dist/protocol-provider.json',
        'dist/protocol-node-artifact.json', 'dist/protocol-rust-artifact.json']) files.set(file, await boundedFile(join(packageRoot, file)));
    assert.equal(JSON.parse(files.get('package.json')!.toString()).name, '@eosrio/hyperion-wire-plugin');
    for (const component of selected) {
        const bytes = files.get(`dist/protocol-${component.runtime}-artifact.json`)!;
        assert.equal(digest(bytes), component.sha256, 'selected Wire component manifest changed');
        const manifest = JSON.parse(bytes.toString());
        assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.sourceModified, false);
        assert.equal(manifest.sourceRevision, wireReplayPins.packageRevision);
        assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 512);
        for (const member of manifest.files) {
            assert.ok(typeof member.path === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(member.path)
                && member.path.split('/').every((part: string) => part !== '.' && part !== '..'), 'invalid Wire artifact member path');
            assert.match(member.sha256, /^[0-9a-f]{64}$/);
            const previous = expected.get(member.path);
            assert.ok(previous === undefined || previous === member.sha256, 'conflicting Wire artifact member hashes');
            expected.set(member.path, member.sha256);
        }
    }
    let total = 0;
    for (const [file, sha256] of expected) {
        const bytes = files.get(file) ?? await boundedFile(join(packageRoot, file));
        assert.equal(digest(bytes), sha256, `Wire artifact member changed: ${file}`);
        total += bytes.length; assert.ok(total <= 32 * 1024 * 1024, 'Wire artifact source byte budget exceeded'); files.set(file, bytes);
    }
    return files;
}

async function sourceSnapshot(selected: readonly {runtime: string; sha256: string}[], output?: string) {
    const hashes: Record<string, string> = {}; let total = 0;
    const prefix = 'node_modules/@eosrio/hyperion-wire-plugin';
    const componentFiles = await readWireComponentSources(join(repo, prefix), selected);
    const members = new Map([...componentFiles].map(([file, bytes]) => [prefix + '/' + file, bytes]));
    for (const file of runtimeSources) if (!members.has(file)) members.set(file, await boundedFile(join(repo, file)));
    for (const [file, bytes] of members) {
        total += bytes.length; assert.ok(total <= 64 * 1024 * 1024, 'source evidence exceeds byte bound');
        hashes[file] = digest(bytes);
        if (output) {const target = join(output, 'sources', file); await mkdir(dirname(target), {recursive: true}); await writeFile(target, bytes, {flag: 'wx'});}
    }
    for (const file of ['src/indexer/workers/hyperionWorker.ts', 'build/indexer/workers/hyperionWorker.js']) {
        const text = (await boundedFile(join(repo, file))).toString();
        assert.match(text, /get actionSourceAdmissionEnabled\(\)(?:: boolean)?\s*\{\s*return false;?\s*\}/, 'public action admission must remain disabled');
    }
    return hashes;
}

export async function runWireWorkerReplay(stateFile: string, outputDirectory: string, packageRoot?: string, stateMode?: WireStateMode) {
    assert.equal(process.release.name, 'node', 'Wire worker qualification requires native Node');
    assertNativeQualificationRuntime();
    const deadline = performance.now() + wireReplayLimits.runMs;
    const remaining = () => {const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, 'Wire qualification run deadline exceeded'); return value;};
    const docker = (args: string[]) => execFileSync('docker', args, {encoding: 'utf8', timeout: Math.min(30000, remaining()), maxBuffer: 16 * 1024 * 1024}).trim();
    const output = await assertNewWireReplayOutput(outputDirectory);
    const stateBytes = await boundedFile(resolve(stateFile), 1024 * 1024); const state = JSON.parse(stateBytes.toString());
    assert.equal(state.schemaVersion, 1); assert.equal(state.status, 'ready'); validateFixture(state.core);
    const chain = `hyp-wire-${state.run}`;
    // Source audit/independent expectations precede Docker, output creation and all service writes.
    const fixture = await auditWireReplayFixture(packageRoot ? {packageRoot} : {});
    const {buildWireReplayExpectations, assertWireReplayOutputs, assertWireReplayPublications} = await import('./wire-replay-outputs.ts');
    const expectations = buildWireReplayExpectations(fixture, chain);
    assert.ok(stateMode === undefined || stateMode === 'enabled' || stateMode === 'disabled', 'invalid Wire state mode');
    assert.equal(fixture.replayStart, 2); assert.equal(fixture.replayEnd, 120); assert.equal(fixture.records.length, 119); remaining();
    const containers = [...state.core.nodes, state.core.broker, state.spring, state.redis, state.mongo];
    const values = JSON.parse(docker(['inspect', ...containers.map(item => item.containerId)])); const inspections: Record<string, any> = {};
    for (const item of containers) inspections[item.name] = values.find((value: any) => value.Id === item.containerId);
    assertOwnedServices(state, inspections);
    const network = JSON.parse(docker(['network', 'inspect', state.network]))[0];
    const volumes = JSON.parse(docker(['volume', 'inspect', ...containers.map(item => item.volume)])); const users: Record<string, string[]> = {};
    for (const item of containers) users[item.volume] = docker(['ps', '-a', '--no-trunc', '--filter', `volume=${item.volume}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
    assertResourceIsolation(state, network, volumes, users); remaining();
    await mkdir(output); await mkdir(join(output, 'observer')); const reportHandle = await open(join(output, 'report.json'), 'wx');
    const report: any = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), mode: 'retained-wire-full-worker',
        chain, fixtureRun: state.run, stateSha256: digest(stateBytes), runtime: {node: process.version, platform: process.platform, arch: process.arch},
        publicActionAdmission: false, cleanup: [], replayErrors: [], inspections, resourceIsolation: {network, volumes, users},
        limits: ['119 retained original 7d blocks only; initial ancestry/ABI frontier remains unknown.',
            'Real existing worker/IPC/RabbitMQ/history paths; no current/head ABI fallback or seeded ABI index.',
            'Primary present:0 history tombstones are tested; dynamic state projections and secondary deletion are not qualified.',
            'No225 sink/canonical/PIT/public-admission, Rust ingestion, fork/reconnect, performance, Bun runtime or selected-testnet qualification.',
            'No reset/purge or fixture service deletion; ownership-checked service cleanup is a separate root operation.']};
    const client = new Client({node: state.core.nodes[0].url, maxRetries: 0, requestTimeout: 15000});
    let redis: Redis | undefined, mongo: MongoClient | undefined, master: ChildProcess | undefined;
    let replay: Awaited<ReturnType<typeof serveWireReplay>> | undefined, rpc: Awaited<ReturnType<typeof serveRpc>> | undefined;
    let ledger: Awaited<ReturnType<typeof startBulkLedger>> | undefined;
    const queues = async () => {
        const response = await fetch(state.core.broker.managementUrl + '/api/queues/%2F', {headers: {Authorization: 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64')}, signal: AbortSignal.timeout(Math.min(wireReplayLimits.requestMs, remaining()))});
        assert.ok(response.ok, `owned RabbitMQ management HTTP ${response.status}`);
        const chunks: Uint8Array[] = []; let size = 0;
        assert.ok(response.body); for await (const chunk of response.body) {size += chunk.length; assert.ok(size <= 1024 * 1024, 'broker inventory exceeds bound'); chunks.push(chunk);}
        const rows = JSON.parse(Buffer.concat(chunks).toString()); assert.ok(Array.isArray(rows) && rows.length <= 4096, 'broker inventory count exceeds bound');
        return rows.filter(row => typeof row.name === 'string' && row.name.startsWith(chain + ':')).map(row => ({name: row.name,
            ready: row.messages_ready, unacked: row.messages_unacknowledged, messages: row.messages, consumers: row.consumers}));
    };
    try {
        report.sourceHashes = await sourceSnapshot(fixture.lineage.components, output); report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8', timeout: 5000}).trim();
        report.runtime.executable = process.execPath; report.runtime.executableSha256 = digest(await boundedFile(process.execPath, 256 * 1024 * 1024)); report.runtime.versions = process.versions;
        report.fixture = {profileId: fixture.profileId, chainId: fixture.chainId, packageRevision: fixture.packageRevision,
            lineage: fixture.lineage, blocks: fixture.records.length, range: {start: fixture.replayStart, end: fixture.replayEnd}};
        for (const [name, value] of Object.entries({audit: fixture.audit, lineage: fixture.lineage, expectations}))
            await writeFile(join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
        const info = await client.info(); report.server = info;
        assert.equal(info.cluster_name, state.core.clusterName); assert.equal(info.cluster_uuid, state.core.clusterUuid); assert.equal(info.version.number, '9.5.5');
        const indices = await client.indices.get({index: chain + '-*', ignore_unavailable: true, allow_no_indices: true});
        assertEmptyProjection(indices, await queues());
        redis = new Redis(state.redis.url, {lazyConnect: true, connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1, enableOfflineQueue: false});
        redis.on('error', error => {if (report.replayErrors.length < 64) report.replayErrors.push(errorText(error));}); await redis.connect();
        assert.deepEqual(await redis.keys(chain + '::*'), [], 'refusing existing Wire progress');
        if (stateMode) {
            mongo = new MongoClient(state.mongo.url, {serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000});
            await mongo.connect();
            const database = mongo.db(chain + '_' + chain);
            assert.deepEqual(await database.listCollections({}, {nameOnly: true}).toArray(), [], 'refusing existing Wire state collections');
            const server = await mongo.db('admin').command({buildInfo: 1}); assert.equal(server.version, '8.0.32');
            report.stateWrites = {mode: stateMode, database: database.databaseName, serverVersion: server.version,
                servingReadinessQualified: false, snapshots: []};
            report.limits[2] = 'Legacy Mongo effects are checked separately; no portable runtime initialization, canonical rollback or state API readiness is certified.';
            await mkdir(join(output, 'state'));
        }
        replay = await serveWireReplay(fixture, report.replayErrors, stateMode === 'enabled' ? {initialThroughBlock: wireStateBarriers[0]} : {});
        rpc = await serveRpc(fixture, report.replayErrors);
        report.replayRequests = replay.requests; report.replayMetrics = replay.metrics; report.rpcRequests = rpc.requests; report.rpcLineage = rpc.lineage;
        await mkdir(join(output, 'bulk')); ledger = await startBulkLedger(state.core.nodes[0].url, join(output, 'bulk'), report.replayErrors); report.bulkReceipts = ledger.receipts;
        const control = createServer(); control.listen(0, '127.0.0.1'); await once(control, 'listening'); const controlPort = (control.address() as any).port;
        await new Promise<void>(done => control.close(() => done()));
        const redisUrl = new URL(state.redis.url), mongoUrl = new URL(state.mongo.url);
        const connections = {elasticsearch: {protocol: 'http', host: new URL(state.core.nodes[0].url).host, ingest_nodes: [new URL(ledger.url).host], user: '', pass: ''},
            amqp: {protocol: 'http', host: new URL(state.core.broker.url).host, api: new URL(state.core.broker.managementUrl).host,
                user: 'qualifier', pass: 'qualifier-test-only', vhost: '/', frameMax: '0x10000'},
            redis: {host: redisUrl.hostname, port: Number(redisUrl.port)},
            mongodb: {enabled: stateMode !== undefined, host: mongoUrl.hostname, port: Number(mongoUrl.port), database_prefix: chain, user: '', pass: ''},
            chains: {[chain]: {chain_id: fixture.chainId, http: rpc.url, ship: [{label: 'verified-retained-wire', url: replay.url}], control_port: controlPort}}, alerts: {enabled: false}};
        const config = wireWorkerConfig(chain, stateMode, stateMode ? expectations : undefined); const configFile = join(output, 'config/chain.json');
        await mkdir(join(output, 'config/chains'), {recursive: true}); await writeFile(join(output, 'package.json'), await boundedFile(join(repo, 'package.json')), {flag: 'wx'});
        await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', {flag: 'wx'});
        await writeFile(join(output, 'config/connections.json'), JSON.stringify(connections, null, 2) + '\n', {flag: 'wx'});
        report.config = config; report.connections = connections;
        const stdout = await open(join(output, 'master.stdout.log'), 'wx'), stderr = await open(join(output, 'master.stderr.log'), 'wx');
        try {
            master = spawn(process.execPath, ['--import', pathToFileURL(join(repo, 'scripts/qualification/es955-worker-observer.mjs')).href, join(repo, 'build/indexer/launcher.js')],
                {cwd: output, env: wireWorkerEnvironment(process.env, output, configFile, chain), detached: process.platform !== 'win32', stdio: ['ignore', stdout.fd, stderr.fd, 'ipc']});
            master.on('error', error => report.replayErrors.push(errorText(error))); report.masterPid = master.pid;
        } finally {await stdout.close(); await stderr.close();}
        const completeAt = Math.min(deadline, performance.now() + wireReplayLimits.completionMs); let last: unknown;
        if (stateMode === 'enabled') {
            for (const through of wireStateBarriers) {
                replay.releaseThrough(through);
                let completed = false;
                while (performance.now() < completeAt) {
                    assert.equal(master.exitCode, null, 'Wire master exited during state barrier');
                    assert.equal(master.signalCode, null, 'Wire master signaled during state barrier');
                    assert.deepEqual(report.replayErrors, [], 'Wire state source/transport failed');
                    try {
                        await client.indices.refresh({index: chain + '-*'});
                        const block = await client.search({index: chain + '-block-*', size: 1, track_total_hits: true,
                            allow_partial_search_results: false, timeout: '5s', query: {term: {block_num: through}}});
                        assert.equal(block.timed_out, false); assert.equal(block._shards.failed, 0);
                        assert.equal((block.hits.total as any).value, 1);
                        assert.equal((block.hits.hits[0]._source as any).block_id, expectations.blocks.find(value => value.blockNum === through)!.blockId);
                        const observed = await readWireState(mongo!.db(chain + '_' + chain), expectations);
                        const evidence = assertWireStateSnapshot(expectations, through, stateMode, observed);
                        const pending = await queues();
                        assert.ok(pending.length > 0 && pending.every(queue => queue.messages === 0 && queue.ready === 0 && queue.unacked === 0), 'state barrier queues not drained');
                        const bytes = Buffer.from(JSON.stringify({through, observed, block, queues: pending}, null, 2) + '\n');
                        const file = `state/block-${through}.json`; await writeFile(join(output, file), bytes, {flag: 'wx'});
                        report.stateWrites.snapshots.push({...evidence, file, observationSha256: digest(bytes)});
                        completed = true; break;
                    } catch (error) {last = error;}
                    await sleep(250);
                }
                assert.ok(completed, `Wire state barrier ${through} deadline exceeded: ${errorText(last)}`);
            }
        }
        while (performance.now() < completeAt) {
            assert.equal(master.exitCode, null, `Wire master exited prematurely: ${master.exitCode}`);
            assert.equal(master.signalCode, null, 'Wire master exited by signal'); assert.deepEqual(report.replayErrors, [], 'Wire replay input/transport failed');
            try {
                await client.indices.refresh({index: chain + '-*'}); report.outputs = await assertWireReplayOutputs(client, chain, fixture);
                report.readerConfirmations = assertWireReaderConfirmations(await observerRows(output), fixture.records);
                assertWireReplayComplete(fixture, replay);
                const currentQueues = await queues(); assert.ok(currentQueues.length > 0 && currentQueues.every(queue => queue.ready === 0 && queue.unacked === 0 && queue.messages === 0), 'Wire worker queues are not drained');
                ledger.assertIdle(); report.finalQueues = currentQueues; last = undefined; break;
            } catch (error) {last = error;}
            await sleep(250);
        }
        if (!report.finalQueues) throw new Error('Wire completion deadline exceeded: ' + errorText(last));
        if (stateMode) {
            const observed = await readWireState(mongo!.db(chain + '_' + chain), expectations);
            report.stateWrites.final = assertWireStateSnapshot(expectations, 120, stateMode, observed);
            await writeFile(join(output, 'state/final.json'), JSON.stringify(observed, null, 2) + '\n', {flag: 'wx'});
        }
        report.durableCopies = [];
        for (const node of state.core.nodes.filter((entry: any) => entry.role === 'data')) {
            remaining(); const copy = new Client({node: node.url, maxRetries: 0, requestTimeout: 15000});
            try {
                const identity = await copy.nodes.info({node_id: '_local'}); const nodeId = Object.keys(identity.nodes)[0]; assert.ok(nodeId);
                const evidence = await assertWireReplayOutputs(copy, chain, fixture, `_only_nodes:${nodeId}`);
                report.durableCopies.push({nodeId, evidence});
            } finally {await copy.close();}
        }
        assert.equal(report.durableCopies.length, 2); report.bulkAccounting = summarizeBulkLedger(ledger.receipts);
        const publications: WireBulkPublication[] = [];
        for (const receipt of ledger.receipts) publications.push(...wireBulkPublications(receipt, await boundedFile(join(output, 'bulk', receipt.request.file))));
        report.publicationEvidence = assertWireReplayPublications(expectations, publications);
        await writeFile(join(output, 'bulk/publications.json'), JSON.stringify(publications, null, 2) + '\n', {flag: 'wx'});
        report.indexSettings = await client.indices.getSettings({index: chain + '-*', include_defaults: true});
        for (const entry of Object.values(report.indexSettings) as any[]) {
            assert.equal(entry.settings.index.number_of_replicas, '1');
            assert.equal(String(entry.settings.index.translog?.durability ?? entry.defaults.index.translog.durability).toLowerCase(), 'request');
        }
        assert.deepEqual(rpc.requests.filter(entry => entry.denied), [], 'Wire replay used forbidden RPC');
        assert.deepEqual(await sourceSnapshot(fixture.lineage.components), report.sourceHashes, 'qualification sources changed during replay');
        report.lastIndexedBeforeShutdown = await redis.get(chain + '::last_indexed_block'); report.status = 'passed';
    } catch (error) {report.status = 'failed'; report.error = errorText(error);}
    finally {
        if (master) {
            try {
                if (master.exitCode === null && master.signalCode === null && master.connected) master.send({event: 'qualifier_shutdown'});
                if (master.exitCode === null && master.signalCode === null) await Promise.race([once(master, 'exit'), sleep(10000)]);
                report.masterExit = {code: master.exitCode, signal: master.signalCode};
                report.shutdown = assertSuccessfulWorkerShutdown(await observerRows(output, true), report.masterPid, master.exitCode, master.signalCode);
                report.cleanup.push({name: 'workers', ok: true});
            } catch (error) {report.status = 'failed'; report.cleanup.push({name: 'workers', ok: false, error: errorText(error)});}
            if (report.cleanup.some((entry: any) => entry.name === 'workers' && !entry.ok) && master.pid) {
                try {
                    // This child owns its Unix process group; Windows taskkill targets only its tree.
                    if (process.platform === 'win32') {
                        if (master.exitCode === null && master.signalCode === null) execFileSync('taskkill', ['/PID', String(master.pid), '/T', '/F'], {timeout: 5000});
                    } else process.kill(-master.pid, 'SIGKILL');
                    report.cleanup.push({name: 'forced-owned-worker-tree', ok: true, pid: master.pid});
                } catch (error: any) {report.cleanup.push({name: 'forced-owned-worker-tree', ok: error.code === 'ESRCH', error: errorText(error)});}
            }
        }
        for (const [name, close] of [['replay', () => replay?.close()], ['rpc', () => rpc?.close()], ['bulk-ledger', () => ledger?.close()],
            ['redis', () => redis?.disconnect()], ['mongodb-observer', () => mongo?.close()], ['elasticsearch', () => client.close()]] as const) {
            try {await close(); report.cleanup.push({name, ok: true});} catch (error) {report.status = 'failed'; report.cleanup.push({name, ok: false, error: errorText(error)});}
        }
        if (report.replayErrors.length) report.status = 'failed'; report.completedAt = new Date().toISOString();
        await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportHandle.sync(); await reportHandle.close();
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = parseWireWorkerReplayArguments(process.argv.slice(2));
    const report = await runWireWorkerReplay(args.stateFile, args.outputDirectory, args.packageRoot, args.stateMode);
    console.log(JSON.stringify({status: report.status, error: report.error, chain: report.chain, blocks: report.fixture?.blocks,
        stateMode: report.stateWrites?.mode, limits: report.limits}));
    if (report.status !== 'passed') process.exitCode = 1;
}
