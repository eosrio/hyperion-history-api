import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {mkdir, open, readFile, readdir, writeFile} from 'node:fs/promises';
import {createServer, request} from 'node:http';
import {createServer as createTcpServer} from 'node:net';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Client} from '@elastic/elasticsearch';
import {connect} from 'amqplib';
import {validateFixture, assertNodeOwnership} from './es955-replicas.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const docker = (args: string[]) => execFileSync('docker', args, {encoding: 'utf8', timeout: 30_000}).trim();
async function bounded<T>(operation: Promise<T>, label: string, ms = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    })]); } finally { clearTimeout(timer!); }
}
const canonical = (value: any): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

export function assertPausedRange(pause: any, pending: any, rows: any[], releasedAt: number) {
    assert.equal(pause.event, 'pause'); assert.equal(pause.role, 'reader');
    assert.equal(pending.event, 'new_range'); assert.equal(pending.role, 'reader');
    assert.ok(pending.at > pause.at && pending.at < releasedAt);
    assert.ok(!rows.some(row => row.kind === 'ship_range_request' && row.role === 'reader' &&
        row.at >= pending.at && row.at < releasedAt), 'reader requested another range while paused');
}

export function loadDocument(sequence: number, marker: string) {
    assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
    return {'@timestamp': '2026-10-19T00:00:00.000Z', global_sequence: sequence, block_num: 1,
        act: {account: 'qualifier', name: 'load', authorization: [], data: {sequence, marker, payload: 'q'.repeat(512)}},
        notified: [], action_ordinal: 1, creator_action_ordinal: 0};
}

export function assertOwnedBinding(inspected: any, port: string, url: string) {
    const binding = inspected.NetworkSettings?.Ports?.[port]; const parsed = new URL(url);
    assert.equal(binding?.length, 1); assert.equal(binding[0].HostIp, '127.0.0.1');
    assert.equal(parsed.hostname, binding[0].HostIp); assert.equal(parsed.port, binding[0].HostPort, 'endpoint is not the owned published port');
}

export function assertSortedPage(response: any, ceiling: number, marker: string, minimumHits = 0, expectedTop?: number) {
    assert.equal(response.timed_out, false); assert.equal(response._shards.failed, 0);
    assert.ok(response.hits.hits.length >= minimumHits, 'query omitted known-visible documents');
    let previous = Infinity;
    for (const [offset, hit] of response.hits.hits.entries()) {
        const sequence = hit._source.global_sequence;
        assert.ok(Number.isSafeInteger(sequence) && sequence <= ceiling && sequence < previous);
        if (expectedTop !== undefined) assert.equal(sequence, expectedTop - offset, 'stable sorted page omitted an expected ID');
        assert.equal(hit._id, String(sequence)); assert.deepEqual(hit._source, loadDocument(sequence, marker));
        previous = sequence;
    }
}

async function freePort(): Promise<number> {
    const server = createTcpServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as any).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

export async function runWorkerQualification(stateFile: string, outputDirectory: string, seconds = 300, rate = 400, profile = true) {
    assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 900);
    assert.ok(Number.isInteger(rate) && rate >= 40 && rate <= 2000 && rate % 20 === 0);
    const stateBytes = await readFile(stateFile); const state = JSON.parse(stateBytes.toString());
    assert.equal(state.status, 'ready'); validateFixture(state.core);
    assert.equal(state.run, state.core.run); assert.equal(state.network, state.core.network);
    for (const node of state.core.nodes) {
        const inspected = JSON.parse(docker(['inspect', node.containerId]))[0];
        assertNodeOwnership(inspected, node, state.run); assertOwnedBinding(inspected, '9200/tcp', node.url);
    }
    for (const kind of ['redis', 'spring', 'mongo']) {
        const item = state[kind]; const inspected = JSON.parse(docker(['inspect', item.containerId]))[0];
        assert.equal(inspected.Name, '/' + item.name); assert.equal(inspected.Config.Image, state[kind + 'Image']);
        assert.equal(inspected.Config.Labels['io.eosrio.run'], state.run);
        assert.equal(inspected.Config.Labels['io.eosrio.qualifier'], 'es198-workers');
        assert.ok(inspected.Mounts.some((m: any) => m.Type === 'volume' && m.Name === item.volume));
        if (kind === 'spring') {
            assertOwnedBinding(inspected, '8888/tcp', item.httpUrl); assertOwnedBinding(inspected, '8080/tcp', item.shipUrl);
        } else assertOwnedBinding(inspected, kind === 'mongo' ? '27017/tcp' : '6379/tcp', item.url);
    }
    const brokerInspect = JSON.parse(docker(['inspect', state.core.broker.containerId]))[0];
    assert.equal(brokerInspect.Config.Labels['io.eosrio.run'], state.run);
    assert.equal(brokerInspect.Config.Image, state.core.rabbitImage);
    assertOwnedBinding(brokerInspect, '5672/tcp', state.core.broker.url);
    assertOwnedBinding(brokerInspect, '15672/tcp', state.core.broker.managementUrl);
    const endpoint = (url: string, protocol: string) => {
        const parsed = new URL(url); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.protocol, protocol);
        assert.ok(parsed.port); return parsed;
    };
    const target = endpoint(state.core.nodes[0].url, 'http:');
    const management = endpoint(state.core.broker.managementUrl, 'http:');
    endpoint(state.spring.httpUrl, 'http:'); endpoint(state.spring.shipUrl, 'ws:');
    endpoint(state.redis.url, 'redis:'); endpoint(state.mongo.url, 'mongodb:');
    endpoint(state.core.broker.url, 'amqp:');
    const outputDir = resolve(outputDirectory); await mkdir(outputDir); await mkdir(join(outputDir, 'observer'));
    const reportFile = await open(join(outputDir, 'report.json'), 'wx');
    const report: any = {schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', state,
        fixtureManifestSha256: sha(stateBytes), runtime: {node: process.version, bun: process.versions.bun ?? null},
        seconds, rate, profile, windows: [], snapshots: [], queries: [], bulks: [], faults: [], cleanup: [], sourceHashes: {},
        limits: ['Dense actions enter the real indexing queue; they do not measure SHIP action decoding.',
            'Actual genesis blocks traverse the production master, readers, deserializers and indexers.',
            'Controlled bulk-response gating is a sink stall, not proof of native ES saturation.',
            'Observer/proxy overhead and other host workloads preclude a runtime speed ranking.']};
    let master: ChildProcess | undefined; let broker: any; let publisher: any; let producerTask: Promise<void> | undefined;
    let client: Client | undefined; let proxy: ReturnType<typeof createServer> | undefined;
    let publishing = false; let stopping = false; let producerError: any; let readerError: any;
    let queryTask: Promise<void> | undefined; let queryEnabled = false; let visibleFloor = 0; let expectedTop: number | undefined;
    let held = false; const releaseWaiters = new Set<() => void>();
    let sequence = 0; let confirmed = 0; const marker = randomUUID();
    const chain = `hyp-es955-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const actionIndex = `${chain}-action-v1-000001`; const actionQueue = `${chain}:index_actions:1`;
    report.chain = chain; report.marker = marker; report.actionIndex = actionIndex;
    const auth = 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64');
    const httpJson = async (url: string) => {
        const response = await fetch(url, {headers: {Authorization: auth}, signal: AbortSignal.timeout(5000)});
        assert.ok(response.ok, `HTTP ${response.status}: ${url}`); return response.json() as Promise<any>;
    };
    const identity = async () => {
        const info = await client!.info(); assert.equal(info.cluster_uuid, state.core.clusterUuid);
        assert.equal(info.cluster_name, state.core.clusterName); assert.equal(info.version.number, '9.5.5'); return info;
    };
    const events = async () => {
        const files = (await readdir(join(outputDir, 'observer'))).filter(name => name.endsWith('.jsonl'));
        const rows: any[] = [];
        for (const file of files) {
            const text = await readFile(join(outputDir, 'observer', file), 'utf8');
            for (const line of text.split('\n')) if (line.trim()) { try { rows.push(JSON.parse(line)); } catch {} }
        }
        return rows;
    };
    const wait = async (label: string, check: () => Promise<any>, timeout = 30_000) => {
        const deadline = performance.now() + timeout; let error: any;
        while (performance.now() < deadline) {
            if (master && master.exitCode !== null) throw new Error(`master exited ${master.exitCode}`);
            try { const value = await check(); if (value && performance.now() <= deadline) return value; } catch (e) { error = e; }
            await sleep(250);
        }
        throw new Error(`${label}: ${error?.message ?? 'deadline exceeded'}`);
    };
    const queues = async () => {
        const rows: any[] = await httpJson(management.href + 'api/queues/%2F');
        return rows.filter(row => row.name.startsWith(chain + ':')).map(row => ({name: row.name,
            messages: row.messages, ready: row.messages_ready, unacked: row.messages_unacknowledged, consumers: row.consumers}));
    };
    try {
        for (const file of ['scripts/qualification/es955-workers.ts', 'scripts/qualification/es955-worker-observer.mjs',
            'scripts/qualification/es955-worker-fixture.ps1', 'src/indexer/modules/queueMonitor.ts',
            'src/indexer/modules/master.ts', 'src/indexer/modules/loader.ts', 'src/indexer/workers/hyperionWorker.ts',
            'src/indexer/workers/state-reader.ts', 'src/indexer/workers/indexer.ts',
            'src/indexer/helpers/elastic-routes.ts', 'build/indexer/launcher.js', 'build/indexer/modules/master.js',
            'build/indexer/modules/queueMonitor.js', 'build/indexer/modules/loader.js', 'build/indexer/workers/hyperionWorker.js',
            'build/indexer/workers/state-reader.js', 'build/indexer/workers/indexer.js',
            'build/indexer/helpers/elastic-routes.js', 'package-lock.json']) {
            const bytes = await readFile(join(repo, file)); report.sourceHashes[file] = sha(bytes);
            const destination = join(outputDir, 'sources', file); await mkdir(dirname(destination), {recursive: true});
            await writeFile(destination, bytes, {flag: 'wx'});
        }
        client = new Client({node: target.href, maxRetries: 0, requestTimeout: 15_000}); report.server = await identity();
        const chainInfo = await httpJson(state.spring.httpUrl + '/v1/chain/get_info');
        assert.equal(chainInfo.chain_id, state.spring.chainId); report.initialChain = chainInfo;
        report.initialStats = await client.nodes.stats({metric: ['indices', 'indexing_pressure', 'thread_pool', 'breaker', 'jvm', 'process', 'fs']});
        proxy = createServer(async (incoming, outgoing) => {
            const begin = performance.now(); const chunks: Buffer[] = [];
            try {
                for await (const chunk of incoming) { chunks.push(Buffer.from(chunk)); assert.ok(chunks.reduce((n, b) => n + b.length, 0) <= 3 * 1024 * 1024); }
                const body = Buffer.concat(chunks); const bulk = incoming.url?.split('?')[0].endsWith('/_bulk');
                const ids = bulk ? body.toString().trim().split('\n').filter((_line, i) => i % 2 === 0).map(line => {
                    const item = JSON.parse(line); const operation: any = Object.values(item)[0];
                    return {index: operation._index ?? decodeURIComponent(incoming.url!.split('/')[1]), id: String(operation._id)};
                }) : [];
                if (bulk && held) await new Promise<void>(resolve => releaseWaiters.add(resolve));
                const headers = {...incoming.headers, host: target.host};
                const remote = request(new URL(incoming.url!, target), {method: incoming.method, headers}, response => {
                    outgoing.writeHead(response.statusCode!, response.headers); const result: Buffer[] = [];
                    response.on('data', chunk => { result.push(Buffer.from(chunk)); outgoing.write(chunk); });
                    response.on('end', () => {
                        outgoing.end();
                        if (bulk) {
                            let receipt: any; try { receipt = JSON.parse(Buffer.concat(result).toString()); } catch {}
                            report.bulks.push({at: Date.now(), wallMs: performance.now() - begin, requestBytes: body.length,
                                ids, status: response.statusCode, took: receipt?.took, errors: receipt?.errors,
                                items: receipt?.items?.map((item: any) => { const value: any = Object.values(item)[0];
                                    return {id: value._id, index: value._index, status: value.status, shards: value._shards, error: value.error}; })});
                        }
                    });
                });
                remote.on('error', error => { report.proxyErrors ??= []; report.proxyErrors.push(String(error)); outgoing.destroy(error); });
                remote.setTimeout(20_000, () => remote.destroy(new Error('bounded upstream timeout'))); remote.end(body);
            } catch (error: any) { report.proxyErrors ??= []; report.proxyErrors.push(String(error)); outgoing.destroy(error); }
        });
        proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
        const proxyPort = (proxy.address() as any).port; const controlPort = await freePort();
        report.proxy = {url: `http://127.0.0.1:${proxyPort}`, mode: 'forward every request, optionally hold bulk responses'};
        await mkdir(join(outputDir, 'config'));
        await mkdir(join(outputDir, 'config', 'chains'));
        await writeFile(join(outputDir, 'package.json'), await readFile(join(repo, 'package.json')), {flag: 'wx'});
        const redis = new URL(state.redis.url); const mongo = new URL(state.mongo.url);
        const connections = {elasticsearch: {protocol: 'http', host: target.host, ingest_nodes: [`127.0.0.1:${proxyPort}`], user: '', pass: ''},
            amqp: {protocol: 'http', host: new URL(state.core.broker.url).host, api: management.host,
                user: 'qualifier', pass: 'qualifier-test-only', vhost: '/', frameMax: '0x10000'},
            redis: {host: redis.hostname, port: Number(redis.port)},
            mongodb: {enabled: false, host: mongo.hostname, port: Number(mongo.port), user: '', pass: '', database_prefix: chain},
            chains: {[chain]: {chain_id: state.spring.chainId, http: state.spring.httpUrl, ship: [{label: 'owned', url: state.spring.shipUrl}],
                control_port: controlPort}}, alerts: {enabled: false}};
        const config = {api: {enabled: false, disable_tx_cache: true},
            indexer: {enabled: true, start_on: 1, stop_on: chainInfo.head_block_num + 10000, rewrite: false, purge_queues: false, live_reader: true,
                live_only_mode: false, abi_scan_mode: false, fetch_block: true, fetch_traces: false, fetch_deltas: false,
                process_deltas: false, disable_reading: false, disable_indexing: false},
            settings: {chain, parser: '3.2', index_version: 'v1', index_partition_size: 10000000, es_replicas: 1,
                auto_stop: 0, auto_mode_switch: false, ds_profiling: true, rate_monitoring: true, bp_monitoring: false,
                max_ws_payload_mb: 16, use_global_agent: false, debug: false},
            scaling: {readers: 1, ds_queues: 1, ds_threads: 1, ds_pool_size: 1, indexing_queues: 1, ad_idx_queues: 1,
                dyn_idx_queues: 1, max_autoscale: 0, batch_size: 8, resume_trigger: 16, auto_scale_trigger: 1000000,
                max_queue_limit: 64, block_queue_limit: 64, polling_interval: 500, routing_mode: 'round_robin'},
            prefetch: {read: 8, block: 8, index: 32},
            features: {streaming: {enable: false, traces: false, deltas: false}, tables: {proposals: false, accounts: false,
                voters: false, permissions: false, user_resources: false}, contract_state: {enabled: false, contracts: {}},
                index_deltas: false, index_all_deltas: false, deferred_trx: false, failed_trx: false, resource_limits: false, resource_usage: false},
            blacklists: {actions: [], deltas: []}, whitelists: {actions: [], deltas: [], max_depth: 10, root_only: false},
            plugins: {}, hub: {enabled: false}, alerts: {enabled: false}};
        await writeFile(join(outputDir, 'config', 'connections.json'), JSON.stringify(connections, null, 2) + '\n');
        const configFile = join(outputDir, 'config', 'chain.json'); await writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
        report.config = config; report.connections = connections;
        const stdout = await open(join(outputDir, 'master.stdout.log'), 'wx'); const stderr = await open(join(outputDir, 'master.stderr.log'), 'wx');
        master = spawn(process.execPath, ['--import', pathToFileURL(join(repo, 'scripts/qualification/es955-worker-observer.mjs')).href,
            join(repo, 'build/indexer/launcher.js')], {cwd: outputDir, env: {...process.env, CONFIG_JSON: configFile,
            CHAIN_NAME: chain, ES198_OBSERVER_DIR: join(outputDir, 'observer'), ES198_CPU_PROFILE: profile ? '1' : '0',
            ES198_PROFILE_MAX_MS: '900000'},
            stdio: ['ignore', stdout.fd, stderr.fd, 'ipc']});
        master.on('error', error => { report.masterProcessErrors ??= []; report.masterProcessErrors.push(String(error)); });
        await stdout.close(); await stderr.close(); report.masterPid = master.pid;
        const control = `http://127.0.0.1:${controlPort}`;
        report.workers = await wait('production workers ready', async () => {
            const workers: any[] = await httpJson(control + '/get_workers');
            assert.ok(workers.some(w => w.worker_role === 'reader')); assert.ok(workers.some(w => w.worker_role === 'continuous_reader'));
            const q = await queues(); assert.ok(q.some(row => row.name === actionQueue && row.consumers === 1));
            const blocks = await client!.count({index: `${chain}-block-*`}); assert.ok(blocks.count > 0); return workers;
        }, 120_000);
        const connecting = connect(state.core.broker.url, {timeout: 10000});
        connecting.then(connection => { if (stopping) (connection as any).connection.stream.destroy(); }).catch(() => {});
        broker = await bounded(connecting, 'AMQP connect'); publisher = await bounded(broker.createConfirmChannel(), 'publisher creation');
        assert.equal((await bounded<any>(publisher.checkQueue(actionQueue), 'action queue check')).consumerCount, 1);
        producerTask = (async () => {
            while (!stopping) {
                if (!publishing) { await sleep(25); continue; }
                const start = performance.now();
                for (let i = 0; i < 20; i++) {
                    assert.ok(sequence < 300000, 'bounded document budget exceeded');
                    const body = Buffer.from(JSON.stringify(loadDocument(++sequence, marker)));
                    if (!publisher.sendToQueue(actionQueue, body, {persistent: true}))
                        await once(publisher, 'drain', {signal: AbortSignal.timeout(10000)});
                }
                await bounded(publisher.waitForConfirms(), 'publisher confirms'); confirmed = sequence;
                await sleep(Math.max(0, 20 / rate * 1000 - (performance.now() - start)));
            }
        })().catch(error => { producerError = error; });
        queryTask = (async () => {
            while (!stopping) {
                const start = performance.now(); const ceiling = confirmed;
                if (queryEnabled && ceiling) {
                    const response = await client!.search({index: actionIndex, query: {range: {global_sequence: {lte: ceiling}}},
                        size: 50, sort: [{global_sequence: 'desc'}], allow_partial_search_results: false});
                    assertSortedPage(response, ceiling, marker, Math.min(50, visibleFloor), expectedTop);
                    report.queries.push({at: Date.now(), wallMs: performance.now() - start, took: response.took, count: response.hits.hits.length});
                }
                await sleep(100);
            }
        })().catch(error => { readerError = error; });
        let sampling = false;
        const snapshot = async () => {
            const stats = await client!.nodes.stats({metric: ['indices', 'indexing_pressure', 'thread_pool', 'breaker', 'jvm', 'process', 'fs']});
            assert.deepEqual(stats._nodes, {total: 3, successful: 3, failed: 0});
            assert.equal(Object.keys(stats.nodes).length, 3); return stats;
        };
        const sample = async () => {
            if (sampling) return; sampling = true;
            try { report.snapshots.push({at: Date.now(), confirmed, queues: await queues(), stats: await snapshot()}); }
            finally { sampling = false; }
        };
        const window = async (name: string, duration: number, publish: boolean) => {
            const begin = performance.now(); const startedAt = Date.now(); const from = confirmed; publishing = publish;
            const samples = report.snapshots.length; const queries = report.queries.length; const bulks = report.bulks.length;
            while (performance.now() - begin < duration) {
                if (producerError) throw producerError;
                if (readerError) throw readerError;
                assert.equal(master!.exitCode, null); await sample(); await sleep(1000);
            }
            const row = {name, startedAt, elapsedMs: performance.now() - begin, confirmedFrom: from, confirmedTo: confirmed,
                snapshots: report.snapshots.length - samples, queries: report.queries.length - queries, bulks: report.bulks.length - bulks};
            report.windows.push(row);
            if (name !== 'warmup') {
                const useful = name === 'read' ? report.queries.slice(queries) : report.bulks.slice(bulks).filter(bulk =>
                    bulk.items?.some((item: any) => item.index === actionIndex && [200, 201].includes(item.status)));
                const occupiedSeconds = new Set(useful.map((item: any) => Math.floor((item.at - startedAt) / 1000))).size;
                assert.ok(occupiedSeconds >= Math.floor(duration / 1000 * 0.8), `${name} did not sustain useful work`);
                if (publish) assert.ok(confirmed - from >= rate * duration / 1000 * 0.7, `${name} offered-load floor not reached`);
                else assert.equal(confirmed, from, 'read-only phase still published actions');
            }
        };
        await window('warmup', 10000, true);
        report.warmupHealth = await client.cluster.health({index: actionIndex, wait_for_status: 'green', timeout: '20s'});
        assert.equal(report.warmupHealth.timed_out, false); assert.equal(report.warmupHealth.status, 'green');
        for (const mode of ['write', 'read', 'mixed']) {
            if (mode === 'read') {
                publishing = false;
                await wait('producer quiescence', async () => sequence === confirmed);
                await wait('verified read-only baseline', async () => {
                    assert.equal((await queues()).find(q => q.name === actionQueue)?.messages, 0);
                    await client!.indices.refresh({index: actionIndex});
                    assert.equal((await client!.count({index: actionIndex})).count, confirmed); return true;
                }, 120000);
                visibleFloor = confirmed; expectedTop = confirmed;
            } else expectedTop = undefined;
            queryEnabled = mode !== 'write';
            await window(mode, seconds / 3 * 1000, mode !== 'read');
        }
        for (let wave = 0; wave < 3; wave++) {
            publishing = false;
            await wait('pre-fault drain and actual reader resumed', async () => {
                await sample(); const current = await queues();
                assert.ok(current.every(queue => queue.messages < config.scaling.resume_trigger));
                const transitions = (await events()).filter(row => row.kind === 'ipc_send' && row.role === 'reader' &&
                    ['pause', 'resume'].includes(row.event)).sort((a, b) => a.at - b.at);
                assert.notEqual(transitions.at(-1)?.event, 'pause'); return true;
            }, 120000);
            const at = Date.now(); const from = confirmed; held = true; publishing = true;
            const fault: any = {wave, at, from}; report.faults.push(fault);
            try {
                fault.paused = await wait('actual reader pause IPC', async () => {
                    await sample(); const rows = await events();
                    return rows.find(row => row.kind === 'ipc_send' && row.at >= at && row.event === 'pause' && row.role === 'reader');
                }, 25000);
                fault.pendingRange = await wait('next backfill range while paused', async () => {
                    const rows = await events(); return rows.find(row => row.kind === 'ipc_send' && row.at > fault.paused.at &&
                        row.event === 'new_range' && row.role === 'reader');
                }, 15000);
                await sleep(1500); await sample();
                const rows = await events();
                fault.liveProgress = rows.filter(row => row.kind === 'ipc_receive' && row.at > fault.paused.at && row.event === 'read_block' && row.live === true).length;
                assert.ok(fault.liveProgress > 0, 'live reader did not progress during backfill pause');
                fault.heldRequests = releaseWaiters.size; assert.ok(releaseWaiters.size > 0);
                fault.queuesAtRelease = await queues();
            } finally {
                held = false; for (const release of releaseWaiters) release(); releaseWaiters.clear();
                publishing = false; fault.releasedAt = Date.now();
            }
            assertPausedRange(fault.paused, fault.pendingRange, await events(), fault.releasedAt);
            fault.resumed = await wait('actual resume IPC after drain', async () => {
                await sample(); const rows = await events();
                return rows.find(row => row.kind === 'ipc_send' && row.at >= fault.releasedAt && row.event === 'resume' && row.role === 'reader');
            }, 30000);
            fault.resumedRequest = await wait('pending range requested after resume', async () => {
                const rows = await events(); const range = fault.pendingRange.message?.range ?? fault.pendingRange.range;
                return rows.find(row => row.kind === 'ship_range_request' && row.role === 'reader' &&
                    row.at >= fault.resumed.at && row.first_block === range.first_block && row.last_block === range.last_block);
            }, 10000);
            fault.afterDrain = await queues(); fault.to = confirmed;
        }
        publishing = false; await sleep(100); stopping = true; await producerTask; await queryTask;
        if (producerError) throw producerError;
        if (readerError) throw readerError;
        report.confirmedDocuments = confirmed;
        assert.equal(sequence, confirmed); assert.ok(confirmed > rate * seconds / 2);
        await wait('all confirmed actions durably indexed', async () => {
            await client!.indices.refresh({index: actionIndex}); const count = await client!.count({index: actionIndex});
            assert.equal(count.count, confirmed); const q = (await queues()).find(q => q.name === actionQueue);
            assert.equal(q?.messages, 0); return true;
        }, 45000);
        const nodes: any = await client.nodes.info(); report.finalCopies = [];
        for (const [id, node] of Object.entries(nodes.nodes) as [string, any][]) {
            if (!state.core.nodes.some((entry: any) => entry.role === 'data' && entry.name === node.name)) continue;
            let after: any; let next = 1; const digest = createHash('sha256');
            do {
                const response: any = await client.search({index: actionIndex, size: 1000, sort: [{global_sequence: 'asc'}],
                    query: {match_all: {}}, search_after: after, track_total_hits: true, preference: `_only_nodes:${id}`,
                    allow_partial_search_results: false});
                assert.equal(response.timed_out, false); assert.equal(response._shards.failed, 0); assert.equal(response.hits.total.value, confirmed);
                assert.equal(response._shards.total, 4); assert.equal(response._shards.successful, 4);
                assert.ok(response.hits.hits.length || next === confirmed + 1);
                for (const hit of response.hits.hits) {
                    assert.equal(hit._id, String(next)); assert.deepEqual(hit._source, loadDocument(next, marker));
                    digest.update(canonical(hit._source) + '\n'); next++;
                }
                after = response.hits.hits.at(-1)?.sort;
            } while (next <= confirmed);
            report.finalCopies.push({node: id, count: next - 1, exactSources: true, sha256: digest.digest('hex')});
        }
        assert.equal(report.finalCopies.length, 2); assert.equal(report.finalCopies[0].sha256, report.finalCopies[1].sha256);
        report.recoveryObservations = []; let recoveredSamples = 0;
        await wait('three complete idle-accounting observations', async () => {
            const stats = await snapshot(); const at = Date.now(); report.recoveryObservations.push({at, stats});
            const idle = Object.values(stats.nodes).every((node: any) =>
                node.indexing_pressure.memory.current.all_in_bytes === 0 && node.indices.search.open_contexts === 0 &&
                node.indices.search.query_current === 0 && node.indices.search.fetch_current === 0 &&
                node.thread_pool.write.active === 0 && node.thread_pool.write.queue === 0 &&
                node.thread_pool.write_coordination.active === 0 && node.thread_pool.write_coordination.queue === 0);
            recoveredSamples = idle ? recoveredSamples + 1 : 0; return recoveredSamples >= 3;
        }, 15000);
        const recoveryCompletedAt = report.recoveryObservations.at(-1).at;
        report.finalStats = await client.nodes.stats({metric: ['indices', 'indexing_pressure', 'thread_pool', 'breaker', 'jvm', 'process', 'fs']});
        report.finalQueues = await queues(); report.finalMapping = await client.indices.get({index: actionIndex});
        master.send!({event: 'qualifier_flush'});
        report.observerEvents = await wait('all worker profiles flushed', async () => {
            const rows = await events(); const starts = rows.filter(row => row.kind === 'start');
            assert.ok(starts.length >= report.workers.length + 1);
            for (const start of starts) {
                const flush = rows.find(row => row.pid === start.pid && row.kind === 'flush');
                assert.ok(flush?.success && flush.reason === 'qualifier_flush' &&
                    flush.profileState === (profile ? 'saved' : 'disabled'), `profile incomplete: ${start.pid}`);
                assert.ok(flush.at >= recoveryCompletedAt, 'worker observations ended before recovery');
            }
            assert.ok(!rows.some(row => row.kind === 'observer_error')); return rows;
        }, 15000);
        report.status = 'passed';
    } catch (error: any) { report.status = 'failed'; report.error = {message: error.message, stack: error.stack}; }
    finally {
        held = false; for (const release of releaseWaiters) release(); releaseWaiters.clear(); stopping = true;
        for (const task of [producerTask, queryTask]) if (task) await Promise.race([task, sleep(5000)]);
        if (master) {
            try {
                if (master.connected) master.send?.({event: 'qualifier_shutdown'});
                if (master.exitCode === null) await Promise.race([once(master, 'exit'), sleep(10000)]);
            }
            catch (error) { report.cleanup.push({process: 'master IPC', error: String(error)}); }
            if (master.exitCode === null) master.kill();
            try {
                const rows = await events(); report.shutdownEvents = rows.filter(row => ['shutdown', 'exit'].includes(row.kind));
                const shutdown = rows.find(row => row.kind === 'shutdown' && row.pid === report.masterPid);
                assert.ok(shutdown?.success, 'full-worker shutdown did not complete cleanly');
                assert.ok(rows.filter(row => row.kind === 'start').every(start =>
                    rows.some(row => row.kind === 'exit' && row.pid === start.pid)), 'owned worker exit evidence missing');
                report.cleanup.push({name: 'workers', ok: true, shutdown});
            } catch (error) { report.cleanup.push({name: 'workers', ok: false, error: String(error)}); report.status = 'failed'; }
        }
        for (const [name, item] of [['publisher', publisher], ['broker', broker], ['client', client]] as const) {
            try { if (item) await bounded((item as any).close(), `${name} close`, 5000); report.cleanup.push({name, ok: true}); }
            catch (error) {
                broker?.connection?.stream?.destroy();
                report.cleanup.push({name, ok: false, error: String(error)}); report.status = 'failed';
            }
        }
        if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
        report.completedAt = new Date().toISOString(); await reportFile.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportFile.close();
    }
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [state, output, seconds = '300', rate = '400', mode = 'profile'] = process.argv.slice(2);
    assert.ok(['profile', 'control'].includes(mode));
    const report = await runWorkerQualification(state, output, Number(seconds), Number(rate), mode === 'profile');
    console.log(JSON.stringify({status: report.status, error: report.error, confirmed: report.confirmedDocuments}));
    if (report.status !== 'passed') process.exitCode = 1;
}
