import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {assertIdentity, assertOwner, validateOptions} from './es955.ts';
import {assertDurableBulkAcknowledged, runPressureQualification} from './es955-pressure.ts';

const expectedServerBuild = '48acba663b09e70b115dd879329141506c377890';
const image = 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const docker = (args: string[]) => execFileSync('docker', args, {encoding: 'utf8', timeout: 30_000}).trim();

export function assertReplicaReceipt(item: any, copies: number): void {
    assert.ok(Number.isSafeInteger(copies) && copies >= 1 && copies <= 2, 'one or two copies required');
    assert.ok([200, 201].includes(item?.status), 'write was not acknowledged');
    assert.equal(item.error, undefined, 'write error present');
    assert.equal(item._shards?.total, 2, 'one replica must remain configured');
    assert.equal(item._shards.successful, copies, 'incorrect number of acknowledging copies');
    assert.equal(item._shards.failed, 0, 'replication failure present');
}

export function assertTranslogReplay(before: any, after: any, recovery: any): void {
    assert.ok(typeof before.node === 'string' && before.node.length > 0, 'pre-crash node identity missing');
    assert.ok(Number.isSafeInteger(before.uncommitted_operations) && before.uncommitted_operations > 0,
        'no uncommitted operations before crash');
    assert.ok(Number.isSafeInteger(before.flush_before) && before.flush_before >= 0, 'pre-write flush counter missing');
    assert.ok(Number.isSafeInteger(before.flush_after) && before.flush_after >= 0, 'post-write flush counter missing');
    assert.equal(before.flush_after, before.flush_before, 'Lucene flush occurred before crash');
    assert.equal(recovery?.stage, 'DONE', 'store recovery incomplete');
    assert.equal(recovery.type, 'EXISTING_STORE', 'recovery did not reuse the crashed node store');
    assert.ok(Number.isSafeInteger(recovery.translog?.recovered) && recovery.translog.recovered >= before.uncommitted_operations,
        'not all uncommitted translog operations recovered');
    assert.equal(after.node, before.node, 'single-copy recovery moved to another node');
}

export function validateFixture(state: any): void {
    assert.match(state.run, /^[a-f0-9]{12}$/);
    assert.equal(state.network, `hyp-es955-replicas-${state.run}`);
    assert.equal(state.status, 'ready'); assert.equal(state.esImage, image);
    assert.equal(state.nodes?.length, 3); assert.equal(state.nodes.filter((n: any) => n.role === 'data').length, 2);
    assert.equal(new Set(state.nodes.map((n: any) => n.containerId)).size, 3);
    for (const node of state.nodes) {
        assert.match(node.containerId, /^[a-f0-9]{64}$/);
        assert.equal(node.volume, `${node.name}-data`);
        validateOptions({url: node.url, clusterName: state.clusterName, clusterUuid: state.clusterUuid,
            prefix: `hyp-es955-${state.run}`, output: 'identity-check', transport: 'default', documents: 1000});
    }
    const broker = new URL(state.broker.url);
    assert.equal(broker.protocol, 'amqp:'); assert.equal(broker.hostname, '127.0.0.1');
    assert.ok(broker.port && broker.port !== '5672');
}

export function assertNodeOwnership(inspected: any, node: any, run: string): void {
    assert.equal(inspected.Id, node.containerId, 'container identity changed');
    assert.equal(inspected.Config?.Labels?.['io.eosrio.qualifier'], 'es198-replicas');
    assert.equal(inspected.Config.Labels['io.eosrio.run'], run);
    assert.equal(inspected.Config.Image, image, 'fixture image changed');
    assert.equal(inspected.Name, '/' + node.name);
    assert.ok(inspected.Mounts?.some((m: any) => m.Type === 'volume' && m.Name === node.volume &&
        m.Destination === '/usr/share/elasticsearch/data'), 'owned data volume missing');
}

export async function runReplicaQualification(stateFile: string, outputFile: string, transport: 'http' | 'default') {
    assert.ok(['http', 'default'].includes(transport));
    const manifestBytes = await readFile(stateFile);
    const state = JSON.parse(manifestBytes.toString('utf8')); validateFixture(state);
    for (const node of state.nodes) {
        const inspected = JSON.parse(docker(['inspect', node.containerId]))[0];
        assertNodeOwnership(inspected, node, state.run);
        const bindings = inspected.NetworkSettings.Ports['9200/tcp'];
        assert.equal(bindings?.length, 1); assert.equal(bindings[0].HostIp, '127.0.0.1');
        // Docker can assign a new ephemeral host port when the same container restarts.
        node.url = `http://127.0.0.1:${bindings[0].HostPort}`;
    }
    validateFixture(state);
    const output = await open(outputFile, 'wx');
    const {Client, HttpConnection} = await import('@elastic/elasticsearch');
    const {esConnectionOptions} = await import('../../build/indexer/helpers/es-connection.js');
    const clients = state.nodes.filter((n: any) => n.role === 'data').map((node: any) => ({node,
        client: new Client({node: node.url, ...esConnectionOptions(), maxRetries: 0, requestTimeout: 15_000,
            ...(transport === 'http' ? {Connection: HttpConnection, agent: {keepAlive: true, maxSockets: 32}} : {})})}));
    let active = clients[0];
    const prefix = `hyp-es955-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const owner = randomUUID();
    const names = {replicated: `${prefix}-replicated`, solo: `${prefix}-solo`, pressure: `${prefix}-pressure`,
        action: `${prefix}-action-v1-000001`};
    const created: string[] = [];
    let killed: any;
    const report: any = {schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', state, prefix, owner,
        fixtureManifestSha256: hash(manifestBytes),
        runtime: {node: process.version, bun: process.versions.bun ?? null, transport}, receipts: [], observations: [], cleanup: [],
        limits: ['Synthetic bounded workload, not full worker/master throughput or backpressure qualification',
            'Process SIGKILL on Docker volumes is not host power loss or hardware failure',
            'Explicit two-copy receipts require two successful copies, independently of active-shard preflight',
            'Static one-MiB pressure limit is solely an admission/recovery fixture, not a production setting']};
    const identify = async () => {
        const info = await active.client.info();
        assertIdentity(info, {clusterName: state.clusterName, clusterUuid: state.clusterUuid} as any);
        assert.equal(info.version.build_hash, expectedServerBuild); return info;
    };
    const owned = async (index?: string) => {
        await identify();
        for (const name of index ? [index] : created) assertOwner(await active.client.indices.getMapping({index: name}), name, owner);
    };
    const rawStats = async () => active.client.nodes.stats({metric: ['indexing_pressure', 'thread_pool', 'breaker', 'indices', 'jvm', 'process']});
    const wait = async (description: string, check: () => Promise<any>, ms = 45_000) => {
        const deadline = performance.now() + ms; let last: any;
        while (performance.now() < deadline) {
            try { const result = await check(); assert.ok(performance.now() < deadline, 'sample completed after deadline'); return result; }
            catch (error) { last = error; await delay(200); }
        }
        throw new Error(`${description}: ${last?.message}`);
    };
    const assertResource = (node: any) => {
        const inspected = JSON.parse(docker(['inspect', node.containerId]))[0];
        assertNodeOwnership(inspected, node, state.run);
        return inspected;
    };
    const bulk = async (index: string, docs: any[], copies = 2, extra: any = {}) => {
        await owned(index);
        const operations = docs.flatMap(d => [{index: {_index: index, _id: d.id}}, d.source]);
        const response = await active.client.bulk({operations, refresh: false, wait_for_active_shards: 'all', timeout: '5s', ...extra});
        report.receipts.push({index, docs, extra, response});
        assertDurableBulkAcknowledged(response, docs.map(d => ({index, id: d.id})), copies); return response;
    };
    const verify = async (index: string, docs: any[], preference?: string) => {
        await owned(index); await active.client.indices.refresh({index});
        const response: any = await active.client.search({index, query: {match_all: {}}, size: 2000,
            track_total_hits: true, preference});
        assert.equal(response.timed_out, false); assert.equal(response._shards.failed, 0);
        assert.equal(response.hits.total.value, docs.length); assert.equal(response.hits.total.relation, 'eq');
        const actual = new Map(response.hits.hits.map((h: any) => [h._id, h._source]));
        assert.equal(actual.size, docs.length);
        for (const doc of docs) assert.deepEqual(actual.get(doc.id), doc.source, `durable source mismatch: ${doc.id}`);
        return {index, count: docs.length, preference, exactSources: true, response};
    };
    const seed = Array.from({length: 120}, (_, i) => ({id: `seed-${i}`, source: {
        global_sequence: i + 1, block_num: i + 1, payload: `durable-${i}-${'d'.repeat(512)}`}}));
    try {
        report.server = await identify(); report.sourceHashes = {};
        report.clientVersion = JSON.parse(await readFile(new URL('../../node_modules/@elastic/elasticsearch/package.json', import.meta.url), 'utf8')).version;
        report.transportVersion = JSON.parse(await readFile(new URL('../../node_modules/@elastic/transport/package.json', import.meta.url), 'utf8')).version;
        assert.equal(report.clientVersion, '8.19.1'); assert.equal(report.transportVersion, '8.10.1');
        report.runtime.connection = active.client.connectionPool.connections[0].constructor.name;
        report.nodes = await active.client.nodes.info({metric: ['settings', 'jvm', 'process', 'http']});
        for (const file of ['scripts/qualification/es955-replicas.ts', 'scripts/qualification/es955-pressure.ts',
            'scripts/qualification/es955-broker.ts', 'src/indexer/helpers/elastic-routes.ts',
            'build/indexer/helpers/elastic-routes.js', 'build/indexer/helpers/es-connection.js', 'package-lock.json']) {
            report.sourceHashes[file] = hash(await readFile(new URL(`../../${file}`, import.meta.url)));
        }
        for (const entry of clients) assertResource(entry.node);
        const complete = await active.client.cluster.health({wait_for_nodes: '3', timeout: '5s'});
        assert.equal(complete.number_of_nodes, 3); assert.equal(complete.timed_out, false);
        const create = async (index: string, replicas: number, settings: any = {}) => {
            assert.equal(await active.client.indices.exists({index}), false);
            await identify();
            await active.client.indices.create({index, settings: {number_of_shards: 1, number_of_replicas: replicas,
                refresh_interval: '-1', 'translog.durability': 'request', ...settings},
                mappings: {_meta: {hyperion_es955_owner: owner}, properties: {global_sequence: {type: 'long'},
                    block_num: {type: 'long'}, payload: {type: 'keyword', index: false, doc_values: false},
                    act: {enabled: false}, '@timestamp': {type: 'date'}}}});
            created.push(index);
            const health = await active.client.cluster.health({index, wait_for_status: 'green', timeout: '20s'});
            assert.equal(health.timed_out, false);
        };
        await create(names.pressure, 1); await create(names.action, 1); await create(names.replicated, 1);
        report.pressure = await runPressureQualification({client: active.client, index: names.pressure, owner,
            assertOwned: () => owned(names.pressure), snapshot: rawStats});
        report.pressureVerification = await verify(names.pressure, report.pressure.expectedDocs);
        const {runBrokerQualification} = await import('./es955-broker.ts');
        report.broker = await runBrokerQualification({client: active.client, index: names.action, chain: prefix,
            brokerUrl: state.broker.url, assertOwned: () => owned(names.action)});
        report.brokerVerification = await verify(names.action, report.broker.expectedDocs);
        await bulk(names.replicated, seed);
        const shards: any = await active.client.cat.shards({index: names.replicated, format: 'json'});
        const primary = shards.find((s: any) => s.prirep === 'p' && s.state === 'STARTED');
        assert.ok(primary); killed = clients.find((entry: any) => entry.node.name === primary.node)?.node;
        assert.ok(killed, 'primary does not belong to an owned data node');
        const survivor = clients.find((entry: any) => entry.node.containerId !== killed.containerId)!;
        report.beforeCrash = {primary, shards, stats: await rawStats(), inspected: assertResource(killed)};
        await create(names.solo, 0, {'routing.allocation.require._name': killed.name});
        const flushBefore: any = await active.client.indices.stats({index: names.solo, metric: ['flush', 'translog'], level: 'shards'});
        await bulk(names.solo, seed, 1);
        const soloStats: any = await active.client.indices.stats({index: names.solo, metric: ['flush', 'translog'], level: 'shards'});
        const soloShard = soloStats.indices[names.solo].shards['0'][0];
        report.translogBefore = {node: soloShard.routing.node, ...soloShard.translog,
            flush_before: flushBefore.indices[names.solo].primaries.flush.total, flush_after: soloStats.indices[names.solo].primaries.flush.total,
            raw: soloStats};
        assert.ok(report.translogBefore.uncommitted_operations > 0);
        assert.equal(report.translogBefore.flush_after, report.translogBefore.flush_before);
        assertResource(killed); docker(['kill', '--signal', 'KILL', killed.containerId]);
        report.crash = {at: new Date().toISOString(), node: killed, signal: 'SIGKILL'}; active = survivor;
        report.promoted = await wait('replica promotion', async () => {
            await identify();
            const h = await active.client.cluster.health({index: names.replicated, timeout: '2s'});
            assert.equal(h.number_of_nodes, 2); assert.equal(h.active_primary_shards, 1);
            const current: any = await active.client.cat.shards({index: names.replicated, format: 'json'});
            const p = current.find((s: any) => s.prirep === 'p' && s.state === 'STARTED');
            assert.equal(p?.node, survivor.node.name); return {health: h, shards: current};
        });
        report.replicaSurvival = await verify(names.replicated, seed);
        const blocked = {id: 'all-copies-unavailable', source: {global_sequence: 8001, block_num: 8001, payload: 'must-not-write'}};
        await owned(names.replicated);
        const blockedResponse = await active.client.bulk({operations: [{index: {_index: names.replicated, _id: blocked.id}}, blocked.source],
            wait_for_active_shards: 'all', timeout: '1s', refresh: false});
        assert.equal(blockedResponse.errors, true); const blockedItem = blockedResponse.items[0].index!;
        assert.equal(blockedItem.status, 503); assert.equal(blockedItem.error?.type, 'unavailable_shards_exception');
        assert.equal((await active.client.get({index: names.replicated, id: blocked.id}, {ignore: [404]})).found, false);
        report.blockedAllCopies = {blocked, response: blockedResponse, absent: true};
        const degraded = {id: 'degraded-ack', source: {global_sequence: 8002, block_num: 8002, payload: 'single-copy-ack'}};
        const degradedResponse = await active.client.bulk({operations: [{index: {_index: names.replicated, _id: degraded.id}}, degraded.source],
            wait_for_active_shards: 1, timeout: '2s', refresh: false});
        assert.equal(degradedResponse.errors, false); assertReplicaReceipt(degradedResponse.items[0].index, 1);
        assert.throws(() => assertDurableBulkAcknowledged(degradedResponse, [{index: names.replicated, id: degraded.id}], 2));
        report.degradedAck = {degraded, response: degradedResponse, copyClass: 'one successful copy, not two-copy acceptance'};
        assertResource(killed); docker(['start', killed.containerId]);
        report.restart = {at: new Date().toISOString(), containerId: killed.containerId};
        await wait('three-node green recovery', async () => {
            const h = await active.client.cluster.health({index: created, wait_for_status: 'green', wait_for_nodes: '3', timeout: '2s'});
            assert.equal(h.timed_out, false); assert.equal(h.number_of_nodes, 3); assert.equal(h.status, 'green'); return h;
        }, 60_000);
        const recoveries: any = await active.client.indices.recovery({index: names.solo, detailed: true});
        const recovered = recoveries[names.solo].shards.find((s: any) => s.primary);
        const soloAfter: any = await active.client.indices.stats({index: names.solo, metric: ['translog'], level: 'shards'});
        assertTranslogReplay(report.translogBefore, {node: soloAfter.indices[names.solo].shards['0'][0].routing.node}, recovered);
        report.translogRecovery = {recovery: recoveries, verification: await verify(names.solo, seed)};
        const recoveredNodeInfo: any = await active.client.nodes.info();
        const copyVerifications: any[] = [];
        for (const [id, node] of Object.entries(recoveredNodeInfo.nodes) as [string, any][]) {
            if (state.nodes.some((entry: any) => entry.role === 'data' && entry.name === node.name)) {
                copyVerifications.push(await verify(names.replicated, [...seed, degraded], `_only_nodes:${id}`));
            }
        }
        assert.equal(copyVerifications.length, 2);
        report.afterRecovery = {copyVerifications, stats: await rawStats(),
            shardStats: await active.client.indices.stats({index: names.replicated, level: 'shards', metric: ['translog', 'flush', 'docs']})};
        report.status = 'passed';
    } catch (error: any) {
        report.status = 'failed'; report.error = {message: error.message, stack: error.stack};
        if (error.qualificationEvidence) report.failedComponentEvidence = error.qualificationEvidence;
    }
    finally {
        if (killed) {
            try { assertResource(killed); docker(['start', killed.containerId]); } catch (error: any) { report.restartCleanupError = error.message; report.status = 'failed'; }
        }
        for (const index of created.reverse()) {
            try { await owned(index); await active.client.indices.delete({index});
                assert.equal(await active.client.indices.exists({index}), false); report.cleanup.push({index, ok: true}); }
            catch (error: any) { report.cleanup.push({index, ok: false, error: error.message}); report.status = 'failed'; }
        }
        for (const entry of clients) await entry.client.close();
        report.completedAt = new Date().toISOString();
        await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close();
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [state, output, transport = 'default'] = process.argv.slice(2);
    const report = await runReplicaQualification(state, output, transport as 'http' | 'default');
    console.log(JSON.stringify({status: report.status, error: report.error, cleanup: report.cleanup}));
    if (report.status !== 'passed') process.exitCode = 1;
}
