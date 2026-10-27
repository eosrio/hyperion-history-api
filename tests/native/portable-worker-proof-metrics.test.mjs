import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@elastic/elasticsearch';
import {UndiciConnection} from '@elastic/transport';
import {ProtocolAbiProofReader, protocolAbiCertificateForControl} from '../../build/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from '../unit/protocol-frontier-memory.mjs';
import {LatencyHistogram, ObserverIoMetrics, installProofMetrics} from '../../scripts/qualification/portable-state-worker-proof-metrics.mjs';

assert.ok([24, 26].includes(Number(process.versions.node.split('.')[0])), 'run with native Node 24/26');
const id = number => number.toString(16).padStart(64, '0');
const profile = {id: 'fixture', profileId: 'constructed-proof-metrics-v1', components: [
    {id: 'fixture-node', runtime: 'node', version: '0.0.0', sourceRevision: 'b'.repeat(40), sha256: 'c'.repeat(64)}]};

test('nanosecond histogram stays bounded and retains exact totals without calling bucket bounds exact percentiles', () => {
    const histogram = new LatencyHistogram();
    for (const ns of [0n, 1n, 2n, 3n, 4n, 2n ** 70n]) histogram.add(ns);
    const value = histogram.snapshot();
    assert.equal(value.count, 6); assert.equal(value.totalNs, String(10n + 2n ** 70n));
    assert.equal(value.minimumNs, '0'); assert.equal(value.maximumNs, String(2n ** 70n));
    assert.equal(value.buckets.length, 64); assert.deepEqual(value.buckets.slice(0, 4), [1, 1, 2, 1]);
    assert.equal(value.buckets[63], 1); value.buckets.fill(999);
    assert.equal(histogram.snapshot().buckets[0], 1);
});

test('observer accounting preserves write returns, partial byte counts, syncs and exact thrown errors', () => {
    const io = new ObserverIoMetrics(), failure = new Error('owned test write failure');
    assert.equal(io.write(7, () => 5), 5);
    assert.equal(io.sync(() => 'unchanged'), 'unchanged');
    assert.throws(() => io.write(3, () => {throw failure;}), error => error === failure);
    assert.throws(() => io.sync(() => {throw failure;}), error => error === failure);
    const value = io.snapshot();
    assert.deepEqual([value.attemptedBytes, value.writtenBytes, value.writeFailures, value.syncFailures], [10, 5, 1, 1]);
    assert.equal(value.writeElapsed.count, 2); assert.equal(value.syncElapsed.count, 2);
});

async function fixture(run, {compressed = false, retry = false} = {}) {
    const memory = frontierMemoryClient(), chain = 'proof-metrics-fixture';
    const store = new ProtocolAbiFrontierStore(memory.client, chain);
    let previousCommitId = null, head;
    const sources = [];
    for (let blockNum = 1; blockNum <= 3; blockNum++) {
        const source = {chainId: id(100), blockNum, blockId: id(blockNum), previousBlockId: blockNum === 1 ? null : id(blockNum - 1)};
        const value = {schemaVersion: 1, kind: 'canonical-abi-block', chainId: source.chainId, profile, generation: 'fixture-generation',
            source, selectionId: 'h45srcsel1:' + id(blockNum), previousCommitId, status: 'complete',
            stateRootId: null, bindings: [], coverageStart: 1, lastGlobalSequence: null,
            observationId: 'h45abi1:' + id(blockNum), observationDigest: id(blockNum)};
        previousCommitId = (await store.prepareCommit(value)).id;
        head = {blockNum, blockId: source.blockId, commitId: previousCommitId, stateRootId: null, coverageStart: 1, lastGlobalSequence: null};
        sources.push({chainId: source.chainId, blockNum, blockId: source.blockId});
    }
    const control = {schemaVersion: 1, chainId: id(100), profile, ownerId: 'fixture-owner', generation: 'fixture-generation',
        revision: 1, phase: 'following', replayFromBlock: null, source: {contextId: 'h45srcctx1:' + id(1), readerSessionId: 'fixture-session'}, head};
    await store.prepareCertificate(protocolAbiCertificateForControl(control)); await store.compareAndSet(null, control);
    const requests = [];
    const server = createServer(async (request, response) => {
        const send = (statusCode, body) => {
            // Whitespace is deliberate: JSON.stringify(parsedBody) would produce the wrong byte count.
            const plain = Buffer.from(' \n' + JSON.stringify(body) + '\n '), bytes = compressed ? gzipSync(plain) : plain;
            requests.push({path: request.url, bytes: bytes.length, statusCode});
            response.writeHead(statusCode, {'content-type': 'application/json', 'x-elastic-product': 'Elasticsearch',
                ...(compressed ? {'content-encoding': 'gzip'} : {})});
            response.end(bytes);
        };
        try {
            assert.equal(request.method, 'GET');
            const segments = new URL(request.url, 'http://fixture').pathname.slice(1).split('/').map(decodeURIComponent);
            const [index, route, key] = segments;
            let body, statusCode = 200;
            if (retry && requests.length === 0) {statusCode = 503; body = {error: {type: 'unavailable_shards_exception', reason: 'constructed retry'}, status: 503};}
            else if (route === '_mapping') body = await memory.client.indices.getMapping({index});
            else if (route === '_settings') body = await memory.client.indices.getSettings({index});
            else {assert.equal(route, '_doc'); body = await memory.client.get({index, id: key});}
            send(statusCode, body);
        } catch (error) {send(error.meta?.statusCode ?? 500, error.meta?.body ?? {error: String(error)});}
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const client = new Client({node: `http://127.0.0.1:${server.address().port}`, maxRetries: retry ? 1 : 0});
    const reader = new ProtocolAbiProofReader({chainId: id(100), profile, store: new ProtocolAbiFrontierStore(client, chain, 0, {readOnly: true})});
    try {await run({reader, sources, requests, revoke: async () => {
        const current = await store.readControl();
        await store.compareAndSet(current, {...control, generation: 'replacement-generation'});
    }});}
    finally {await client.close(); server.close(); await once(server, 'close');}
}

for (const compressed of [false, true]) test(`real proof walk matches independent loopback GET/body counts; compressed=${compressed}`, async () => {
    await fixture(async ({reader, sources, requests}) => {
        const original = await reader.open(sources[0]); requests.length = 0;
        const reports = [], metrics = installProofMetrics({ProofReader: ProtocolAbiProofReader, BundleStore: ImmutableProtocolBundleStore,
            Connection: UndiciConnection, record: (event, value) => reports.push({event, value})});
        try {
            const actual = await reader.open(sources[0]); assert.deepEqual(actual, original);
            assert.equal(reports.length, 1); assert.equal(reports[0].event, 'proof_open_finished');
            const value = reports[0].value, bytes = requests.reduce((total, row) => total + row.bytes, 0);
            assert.equal(value.httpGetAttempts, requests.length); assert.equal(value.httpCompleted, requests.length);
            assert.equal(value.httpErrors, 0); assert.equal(value.unknownBodySizes, 0);
            assert.equal(value[compressed ? 'compressedBodyBytes' : 'utf8ReencodedBodyBytes'], bytes);
            assert.equal(value[compressed ? 'utf8ReencodedBodyBytes' : 'compressedBodyBytes'], 0);
            assert.equal(value.immutableGets, 8); assert.equal(value.bundleReads, 4); assert.equal(value.commitValidationCalls, 3);
            assert.deepEqual(value.stageFailures, {});
            assert.equal(requests.filter(row => row.path.includes('-records-v1/_doc/')).length, value.immutableGets);
            assert.equal(value.firstAuthority.generation, 'fixture-generation'); assert.equal(value.firstAuthority.headBlockNum, 3);
            assert.equal(value.lastAuthority.headBlockNum, 3); assert.equal(value.operationsInFlight, 0);
            assert.equal(value.timings.authority.count, 2); assert.equal(value.timings.validateCommit.count, 3);
            assert.equal(value.timings.connectionRequest.count, requests.length);
            const cancelled = AbortSignal.abort(new Error('owned cancellation'));
            await assert.rejects(reader.open(sources[0], undefined, {signal: cancelled}), {code: 'proof_cancelled'});
            assert.equal(reports.at(-1).value.httpGetAttempts, 0);
            assert.equal(reports.at(-1).value.outcome, 'proof_cancelled');
            assert.deepEqual(metrics.snapshot(), {started: 2, settled: 2, reportFailures: 0});
        } finally {metrics.restore();}
    }, {compressed});
});

test('actual transport retries are counted separately from logical immutable reads', async () => {
    await fixture(async ({reader, sources, requests}) => {
        const reports = [], metrics = installProofMetrics({ProofReader: ProtocolAbiProofReader, BundleStore: ImmutableProtocolBundleStore,
            Connection: UndiciConnection, record: (event, value) => reports.push(value)});
        try {
            await reader.open(sources[0]); const value = reports[0];
            assert.equal(requests[0].statusCode, 503); assert.equal(value.httpNonSuccess, 1);
            assert.equal(value.httpGetAttempts, requests.length); assert.equal(value.httpCompleted, requests.length);
            assert.equal(value.immutableGets, 8); assert.equal(value.outcome, 'returned');
            assert.equal(value.utf8ReencodedBodyBytes, requests.reduce((sum, row) => sum + row.bytes, 0));
        } finally {metrics.restore();}
    }, {retry: true});
});

test('real canonical revocation remains unavailable and is recorded as a failure', async () => {
    await fixture(async ({reader, sources, revoke}) => {
        const reports = [], metrics = installProofMetrics({ProofReader: ProtocolAbiProofReader, BundleStore: ImmutableProtocolBundleStore,
            Connection: UndiciConnection, record: (event, value) => reports.push(value)});
        try {
            await revoke();
            await assert.rejects(reader.open(sources[0]), {code: 'certificate_unavailable'});
            assert.equal(reports[0].outcome, 'certificate_unavailable');
            assert.equal(reports[0].firstAuthority.generation, 'replacement-generation');
            assert.equal(reports[0].commitValidationCalls, 0); assert.equal(reports[0].httpNonSuccess, 1);
            assert.deepEqual(reports[0].stageFailures, {get: 1, read: 1});
            assert.ok(reports[0].httpGetAttempts > 0);
        } finally {metrics.restore();}
    });
});

test('concurrent proof scopes, cancellation settlement and late I/O remain distinct; observer failures preserve original errors', async () => {
    let release;
    const held = new Promise(resolve => {release = resolve;}), originalError = Object.assign(new Error('original'), {code: 'proof_cancelled'});
    class Connection {async request() {await held; return {body: 'late', statusCode: 200, headers: {}};}}
    class BundleStore {async get() {} async read() {}}
    class ProofReader {
        async authority() {} validateCommit(value) {return value;}
        async open(source) {
            if (source.blockNum === 1) {void new Connection().request({method: 'GET'}); throw originalError;}
            return source;
        }
    }
    const reports = [], metrics = installProofMetrics({ProofReader, BundleStore, Connection, record: (event, value) => reports.push({event, value})});
    try {
        const reader = new ProofReader(), result = {blockNum: 2};
        const [failed, passed] = await Promise.allSettled([reader.open({blockNum: 1}), reader.open(result)]);
        assert.equal(failed.reason, originalError); assert.equal(passed.value, result);
        const first = reports.find(row => row.value.source.blockNum === 1).value;
        assert.equal(first.operationsInFlight, 1); assert.equal(first.httpGetAttempts, 1);
        assert.equal(first.httpCompleted, 0); assert.equal(first.utf8ReencodedBodyBytes, 0);
        assert.equal(reports.find(row => row.value.source.blockNum === 2).value.httpGetAttempts, 0);
        release(); await new Promise(resolve => setImmediate(resolve));
        const late = reports.at(-1); assert.equal(late.event, 'proof_open_late_operation');
        assert.equal(late.value.openId, first.openId); assert.equal(late.value.accounting.httpCompleted, 1);
        assert.equal(late.value.accounting.utf8ReencodedBodyBytes, 4); assert.equal(late.value.accounting.operationsInFlight, 0);
    } finally {metrics.restore();}
    const broken = installProofMetrics({ProofReader, BundleStore, Connection, record() {throw new Error('observer full');}});
    try {await assert.rejects(new ProofReader().open({blockNum: 1}), error => error === originalError);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(broken.snapshot().reportFailures, 2);}
    finally {broken.restore();}
});

test('thrown transport errors retain their identity and mark body size unavailable', async () => {
    const failure = Object.assign(new Error('constructed socket failure'), {code: 'OWNED_TEST_SOCKET'});
    class Connection {async request() {throw failure;}}
    class BundleStore {async get() {} async read() {}}
    class ProofReader {async authority() {} validateCommit(value) {return value;} async open() {return new Connection().request({method: 'GET'});}}
    const rows = [], metrics = installProofMetrics({ProofReader, BundleStore, Connection, record: (_event, value) => rows.push(value)});
    try {
        await assert.rejects(new ProofReader().open({blockNum: 1}), error => error === failure);
        assert.equal(rows[0].outcome, failure.code); assert.equal(rows[0].httpGetAttempts, 1);
        assert.equal(rows[0].httpCompleted, 0); assert.equal(rows[0].httpErrors, 1); assert.equal(rows[0].unknownBodySizes, 1);
        assert.equal(rows[0].utf8ReencodedBodyBytes, 0); assert.equal(rows[0].compressedBodyBytes, 0);
    } finally {metrics.restore();}
});

for (const stageTiming of [false, true]) test(`actual native preload retains write+fsync and delimited counters; stageTiming=${stageTiming}`, () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hyperion-proof-metrics-')));
    try {
        const config = join(directory, 'config.json');
        writeFileSync(config, JSON.stringify({settings: {chain: 'hyp-p191-0123456789ab', protocol: {profileId: 'wire-sysio-6508c9e8-native-engineering-v1'}},
            indexer: {}, features: {streaming: {enable: false}}}));
        mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
        const preload = new URL('../../scripts/qualification/portable-state-worker-native-observer.mjs', import.meta.url).href;
        const child = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', ''], {timeout: 30000, encoding: 'utf8', cwd: directory,
            env: {...process.env, NODE_OPTIONS: '', HYPERION_PORTABLE_NATIVE_QUALIFICATION: '1', CHAIN_NAME: 'hyp-p191-0123456789ab',
                CONFIG_JSON: config, ES198_OBSERVER_DIR: directory,
                ...(stageTiming ? {HYPERION_PORTABLE_NATIVE_STAGE_TIMING: '1'} : {})}});
        assert.equal(child.status, 0, JSON.stringify({stderr: child.stderr, stdout: child.stdout, error: child.error?.message}));
        assert.equal(child.signal, null);
        const rows = readFileSync(join(directory, `native-${child.pid}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(rows.map(row => row.event), ['start', 'observer_metrics', 'exit']);
        assert.equal(rows[1].coverage, 'before-this-row');
        assert.equal(rows[1].io.writeElapsed.count, 1); assert.equal(rows[1].io.syncElapsed.count, 1);
        assert.equal(rows[1].io.writtenBytes, Buffer.byteLength(JSON.stringify(rows[0]) + '\n'));
        assert.deepEqual(rows[1].proofs, {started: 0, settled: 0, reportFailures: 0});
        if (stageTiming) {
            assert.equal(rows[1].stageTimings.enabled, true); assert.equal(rows[1].stageTimings.starts, 0);
            assert.deepEqual(rows[1].stageTimings.active, []); assert.equal(rows[1].stageTimings.runtime.pid, child.pid);
        } else assert.equal(rows[1].stageTimings, undefined);
    } finally {
        assert.equal(dirname(directory), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('hyperion-proof-metrics-'));
        rmSync(directory, {recursive: true, force: true});
    }
});
