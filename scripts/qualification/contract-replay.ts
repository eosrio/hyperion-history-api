import assert from 'node:assert/strict';
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {mkdir, open, readFile, readdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Client} from '@elastic/elasticsearch';
import {ABI, Serializer} from '@wharfkit/antelope';
import {Redis} from 'ioredis';
import {validateFixture, assertNodeOwnership} from './es955-replicas.ts';
import {assertOwnedBinding, assertSuccessfulWorkerShutdown} from './es955-workers.ts';
import {actionAbi, canonical, captureFixture, contractAccount, contractWasm, digest, genesisChainId, serveFixture} from './contract-fixture.ts';
import {startBulkLedger, summarizeBulkLedger} from './replay-bulk-ledger.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const docker = (args: string[]) => execFileSync('docker', args, {encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trim();
const expectedImages: Record<string, string> = {
    spring: 'igorls/spring-nodeos@sha256:13130dbeeaf519209d8aec8b79edfa14ee3e1de958f461506b63569a91714c5a',
    redis: 'redis@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241',
    mongo: 'mongo@sha256:4968f22d0c6c10ef29952f3e807f62872ba22b3312f25803564fbfc08255efc2'};
export function assertOwnedServices(state: any, inspections: Record<string, any>) {
    assert.equal(state.schemaVersion, 1); assert.equal(state.status, 'ready'); validateFixture(state.core);
    assert.equal(state.run, state.core.run); assert.equal(state.network, state.core.network);
    for (const node of state.core.nodes) { assertNodeOwnership(inspections[node.name], node, state.run); assertOwnedBinding(inspections[node.name], '9200/tcp', node.url); }
    for (const kind of ['spring', 'redis', 'mongo']) {
        const item = state[kind]; const inspected = inspections[item.name]; assert.equal(state[kind + 'Image'], expectedImages[kind]);
        assert.equal(item.name, `${state.network}-${kind}`); assert.equal(item.volume, item.name + '-data');
        assert.match(item.containerId, /^[a-f0-9]{64}$/); assert.equal(inspected.Id, item.containerId); assert.equal(inspected.Name, '/' + item.name);
        assert.equal(inspected.Config.Image, expectedImages[kind]); assert.equal(inspected.Config.Labels['io.eosrio.run'], state.run);
        assert.equal(inspected.Config.Labels['io.eosrio.qualifier'], 'es198-workers');
        const volumes = inspected.Mounts.filter((mount: any) => mount.Type === 'volume');
        assert.equal(volumes.length, 1); assert.equal(volumes[0].Name, item.volume);
        if (kind === 'spring') { assertOwnedBinding(inspected, '8888/tcp', item.httpUrl); assertOwnedBinding(inspected, '8080/tcp', item.shipUrl); }
        else assertOwnedBinding(inspected, kind === 'redis' ? '6379/tcp' : '27017/tcp', item.url);
    }
    const broker = state.core.broker; const inspected = inspections[broker.name];
    assert.equal(inspected.Id, broker.containerId); assert.equal(inspected.Name, '/' + broker.name);
    assert.equal(inspected.Config.Image, 'rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef');
    assert.equal(inspected.Config.Labels['io.eosrio.run'], state.run); assert.equal(inspected.Config.Labels['io.eosrio.qualifier'], 'es198-replicas');
    assertOwnedBinding(inspected, '5672/tcp', broker.url); assertOwnedBinding(inspected, '15672/tcp', broker.managementUrl);
}
export function assertActionOutputs(hits: any[], expected: any[]) {
    assert.equal(hits.length, expected.length, 'action output coverage differs');
    for (const [i, expectation] of expected.entries()) {
        const hit = hits[i]; const actual = hit._source;
        assert.equal(hit._id, String(expectation.globalSequence)); assert.equal(actual.global_sequence, expectation.globalSequence);
        assert.equal(actual.trx_id, expectation.trxId); assert.equal(actual.block_num, expectation.block); assert.equal(actual.block_id, expectation.blockId);
        assert.equal(actual.act.account, contractAccount); assert.equal(actual.act.name, 'record');
        assert.equal(actual.ds_error, undefined); assert.deepEqual(actual.act.authorization, [{actor: contractAccount, permission: 'active'}]);
        assert.ok(['string', 'number'].includes(typeof actual.act.data.sequence));
        assert.deepEqual({...actual.act.data, sequence: Number(actual.act.data.sequence)}, expectation.data, 'decoded action data differs');
    }
}
export function assertBlockOutputs(hits: any[], expected: {blockNum: number; id: string; previous: string}[]) {
    assert.equal(hits.length, expected.length, 'block output coverage differs');
    for (const [index, block] of expected.entries()) {
        assert.equal(hits[index]._id, String(block.blockNum)); assert.equal(hits[index]._source.block_num, block.blockNum);
        assert.equal(hits[index]._source.block_id, block.id); assert.equal(hits[index]._source.prev_id, block.previous);
    }
}
export function assertEmptyProjection(indices: Record<string, unknown>, queues: any[]) {
    assert.deepEqual(Object.keys(indices), [], 'refusing existing projection'); assert.deepEqual(queues, [], 'refusing existing projection queues');
}
export function assertContractAbsent(status: number, body: any) {
    assert.equal(status, 400, 'contract account must be absent on the pinned Spring fixture');
    assert.equal(body.error?.name, 'account_query_exception'); assert.equal(body.error?.code, 3060002);
    assert.ok(body.error.details?.some((detail: any) => typeof detail.message === 'string' &&
        detail.message.startsWith('unable to retrieve account info (unknown key (') &&
        /\(0 hyp\.replay\)\)$/.test(detail.message.trim())), 'account absence was not established');
}
export function assertResourceIsolation(state: any, network: any, volumes: any[], users: Record<string, string[]>) {
    const containers = [...state.core.nodes, state.core.broker, state.spring, state.redis, state.mongo];
    assert.equal(network.Name, state.network); assert.equal(network.Labels?.['io.eosrio.run'], state.run);
    assert.equal(network.Labels?.['io.eosrio.qualifier'], 'es198-replicas');
    assert.deepEqual(Object.keys(network.Containers).sort(), containers.map(item => item.containerId).sort(), 'unexpected network consumer');
    assert.equal(volumes.length, containers.length);
    for (const item of containers) {
        const volume = volumes.find(volume => volume.Name === item.volume); assert.ok(volume, 'missing owned volume');
        assert.equal(volume.Labels?.['io.eosrio.run'], state.run);
        assert.equal(volume.Labels?.['io.eosrio.qualifier'], [state.spring, state.redis, state.mongo].includes(item) ? 'es198-workers' : 'es198-replicas');
        assert.deepEqual(users[item.volume], [item.containerId], 'unexpected volume consumer');
    }
}
export async function runContractReplay(stateFile: string, outputDirectory: string) {
    const stateBytes = await readFile(stateFile); const state = JSON.parse(stateBytes.toString());
    // Inspect all immutable identities before any chain mutation, worker launch or result directory.
    const inspections: Record<string, any> = {};
    for (const item of [...state.core.nodes, state.core.broker, state.spring, state.redis, state.mongo])
        inspections[item.name] = JSON.parse(docker(['inspect', item.containerId]))[0];
    assertOwnedServices(state, inspections);
    const network = JSON.parse(docker(['network', 'inspect', state.network]))[0]; const volumes: any[] = []; const users: Record<string, string[]> = {};
    for (const item of [...state.core.nodes, state.core.broker, state.spring, state.redis, state.mongo]) {
        volumes.push(JSON.parse(docker(['volume', 'inspect', item.volume]))[0]);
        users[item.volume] = docker(['ps', '-a', '--no-trunc', '--filter', `volume=${item.volume}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
    }
    assertResourceIsolation(state, network, volumes, users);
    const output = resolve(outputDirectory); await mkdir(output); await mkdir(join(output, 'observer'));
    const report: any = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), fixtureRun: state.run,
        stateSha256: digest(stateBytes), runtime: {node: process.version, platform: process.platform, arch: process.arch},
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim(), sourceHashes: {},
        limits: ['Known-genesis no-op contract; no historical mainnet ABI or contract-compute qualification.',
            'Verified captured ABI history is bootstrapped into a new isolated ABI index before replay.',
            'Finite reader/deserializer/pool/indexer correctness run, not sustained throughput or automatic ABI discovery.',
            'No reset, purge or deletion is exposed; exact fixture cleanup is a separate ownership-checked command.'],
        cleanup: [], rpcRequests: [], replayErrors: []};
    const reportHandle = await open(join(output, 'report.json'), 'wx');
    let master: ChildProcess | undefined; let replay: Awaited<ReturnType<typeof serveFixture>> | undefined;
    let bulkLedger: Awaited<ReturnType<typeof startBulkLedger>> | undefined;
    let proxy: ReturnType<typeof createServer> | undefined; let redis: Redis | undefined;
    const client = new Client({node: state.core.nodes[0].url, maxRetries: 0, requestTimeout: 15000});
    const chain = `hyp-replay-${state.run}`; report.chain = chain;
    const auth = 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64');
    const json = async (url: string, body: any = {}) => {
        const response = await fetch(url, {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(5000)});
        assert.ok(response.ok, `chain HTTP ${response.status}`); return response.json() as Promise<any>;
    };
    const queues = async () => {
        const response = await fetch(state.core.broker.managementUrl + '/api/queues/%2F', {headers: {Authorization: auth}, signal: AbortSignal.timeout(5000)});
        assert.ok(response.ok); return (await response.json() as any[]).filter(row => row.name.startsWith(chain + ':'))
            .map(row => ({name: row.name, ready: row.messages_ready, unacked: row.messages_unacknowledged, messages: row.messages, consumers: row.consumers}));
    };
    const events = async () => {
        const rows: any[] = []; for (const file of (await readdir(join(output, 'observer'))).filter(file => file.endsWith('.jsonl'))) {
            for (const line of (await readFile(join(output, 'observer', file), 'utf8')).split('\n')) if (line.trim()) rows.push(JSON.parse(line));
        } return rows;
    };
    const wait = async (label: string, check: () => Promise<any>, milliseconds = 60000) => {
        const deadline = performance.now() + milliseconds; let last: unknown;
        while (performance.now() < deadline) {
            if (master && master.exitCode !== null) throw new Error(`master exited ${master.exitCode}`);
            if (report.replayErrors.length) throw new Error(report.replayErrors.join('\n'));
            try { const value = await check(); if (value) return value; } catch (error) { last = error; } await sleep(250);
        } throw new Error(`${label}: ${String(last ?? 'deadline exceeded')}`);
    };
    try {
        report.inspections = inspections; report.resourceIsolation = {network, volumes, users};
        report.runtime.executable = process.execPath; report.runtime.executableSha256 = digest(await readFile(process.execPath)); report.runtime.versions = process.versions;
        report.dockerVersion = JSON.parse(docker(['version', '--format', '{{json .}}']));
        for (const file of ['package-lock.json', 'package.json', 'AGENTS.md', 'scripts/qualification/contract-fixture.ts',
            'scripts/qualification/contract-replay.ts', 'scripts/qualification/es955-worker-observer.mjs',
            'scripts/qualification/replay-bulk-ledger.ts',
            'scripts/qualification/fixture/contract-replay.wat', '.bun-version',
            'src/indexer/helpers/reader-progress.ts', 'src/interfaces/hyperionWorkerDef.ts', 'src/interfaces/hyperionConfig.ts',
            'src/indexer/workers/hyperionWorker.ts', 'build/indexer/helpers/reader-progress.js', 'build/indexer/workers/hyperionWorker.js',
            'src/indexer/workers/state-reader.ts', 'src/indexer/workers/deserializer.ts', 'src/indexer/workers/ds-pool.ts',
            'src/indexer/workers/indexer.ts', 'src/indexer/modules/master.ts', 'src/indexer/modules/parsers/3.2-parser.ts',
            'src/indexer/modules/parsers/base-parser.ts', 'src/indexer/helpers/elastic-routes.ts',
            'build/indexer/launcher.js', 'build/indexer/workers/state-reader.js', 'build/indexer/workers/deserializer.js',
            'build/indexer/workers/ds-pool.js', 'build/indexer/workers/indexer.js', 'build/indexer/modules/master.js',
            'build/indexer/modules/parsers/3.2-parser.js', 'build/indexer/modules/parsers/base-parser.js', 'build/indexer/helpers/elastic-routes.js',
            'node_modules/@eosrio/node-abieos/package.json', 'node_modules/@wharfkit/antelope/package.json',
            'node_modules/@elastic/elasticsearch/package.json', 'node_modules/amqplib/package.json', 'node_modules/uWebSockets.js/package.json',
            `node_modules/@eosrio/node-abieos/dist/abieos-${process.platform}-${process.arch}.node`,
            `node_modules/uWebSockets.js/uws_${process.platform}_${process.arch}_${process.versions.modules}.node`]) {
            const bytes = await readFile(join(repo, file)); report.sourceHashes[file] = digest(bytes);
            const path = join(output, 'sources', file); await mkdir(dirname(path), {recursive: true}); await writeFile(path, bytes, {flag: 'wx'});
        }
        const info = await client.info(); report.server = info;
        assert.equal(info.cluster_name, state.core.clusterName); assert.equal(info.cluster_uuid, state.core.clusterUuid); assert.equal(info.version.number, '9.5.5');
        // HEAD wildcard can return 200 for an empty expansion. Read actual metadata instead.
        assertEmptyProjection(await client.indices.get({index: chain + '-*', allow_no_indices: true, ignore_unavailable: true}), await queues());
        const chainInfo = await json(state.spring.httpUrl + '/v1/chain/get_info'); assert.equal(chainInfo.chain_id, state.spring.chainId);
        const genesis = await readFile(join(repo, 'tests/e2e/nodeos/genesis.json')); assert.equal(digest(genesis), state.spring.genesisSha256);
        assert.equal(genesisChainId(genesis), chainInfo.chain_id, 'node is not the exact known genesis');
        const accountResponse = await fetch(state.spring.httpUrl + '/v1/chain/get_account', {method: 'POST', body: JSON.stringify({account_name: contractAccount}), signal: AbortSignal.timeout(5000)});
        const accountError: any = await accountResponse.json(); report.accountPreflight = {status: accountResponse.status, body: accountError};
        assertContractAbsent(accountResponse.status, accountError);
        await writeFile(join(output, 'contract.wasm'), contractWasm, {flag: 'wx'}); assert.equal(WebAssembly.validate(contractWasm), true);
        const cleos = (args: string[], parse = true): any => {
            const result = docker(['exec', state.spring.containerId, 'cleos', '-u', 'http://127.0.0.1:8888', ...args]);
            return parse ? JSON.parse(result) : undefined;
        };
        // Only the public Antelope genesis development key is used, on the owned disposable chain.
        cleos(['wallet', 'create', '--name', 'hyp-replay', '--to-console'], false);
        cleos(['wallet', 'import', '--name', 'hyp-replay', '--private-key', '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3'], false);
        const publicKey = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
        report.createAccount = cleos(['create', 'account', 'eosio', contractAccount, publicKey, publicKey, '-j']);
        const remoteDirectory = '/tmp/hyp-replay-' + state.run; docker(['exec', state.spring.containerId, 'mkdir', remoteDirectory]);
        docker(['cp', join(output, 'contract.wasm'), `${state.spring.containerId}:${remoteDirectory}/contract.wasm`]);
        report.setCode = cleos(['set', 'code', contractAccount, remoteDirectory + '/contract.wasm', '-j']);
        const abiHistory: any[] = []; const expected: any[] = [];
        for (const revision of [1, 2] as const) {
            const abi = actionAbi(revision); const bytes = Buffer.from(JSON.stringify(abi, null, 2) + '\n'); const file = `contract-v${revision}.abi`;
            await writeFile(join(output, file), bytes, {flag: 'wx'}); docker(['cp', join(output, file), `${state.spring.containerId}:${remoteDirectory}/${file}`]);
            const receipt = cleos(['set', 'abi', contractAccount, remoteDirectory + '/' + file, '-j']);
            const abiHex = Buffer.from(Serializer.encode({object: ABI.from(abi)}).array).toString('hex');
            const block = receipt.processed.block_num; abiHistory.push({account: contractAccount, revision, block,
                trxId: receipt.transaction_id, abiHex, sha256: digest(Buffer.from(abiHex, 'hex'))});
            await wait('ABI deployment separate block', async () => (await json(state.spring.httpUrl + '/v1/chain/get_info')).head_block_num > block);
            for (let index = 0; index < 6; index++) {
                const data = {sequence: expected.length + 1, ...(revision === 2 ? {revision: 2} : {}), memo: `replay-v${revision}-${index}`};
                const action = cleos(['push', 'action', contractAccount, 'record', JSON.stringify(data), '-p', contractAccount + '@active', '-j']);
                assert.equal(action.processed.receipt.status, 'executed'); expected.push({revision, data, trxId: action.transaction_id, block: action.processed.block_num});
            }
            await wait('actions separate from next ABI deployment', async () => (await json(state.spring.httpUrl + '/v1/chain/get_info')).head_block_num > expected.at(-1).block);
        }
        const end = expected.at(-1).block + 2;
        await wait('captured range irreversible', async () => (await json(state.spring.httpUrl + '/v1/chain/get_info')).last_irreversible_block_num >= end, 120000);
        const fixture = await captureFixture(state.spring.shipUrl, join(output, 'fixture'), end, {schemaVersion: 1,
            origin: 'known-genesis', complete: true, chainId: state.spring.chainId, genesisSha256: digest(genesis),
            range: {start: 1, end}, flags: {fetch_block: true, fetch_traces: true, fetch_deltas: true}, expected, abiHistory}, genesis);
        const replayRecords = fixture.records.filter(record => record.blockNum >= fixture.replayStart);
        report.fixture = {manifestSha256: digest(await readFile(join(output, 'fixture/manifest.json'))), blocks: fixture.records.length,
            replayRange: {start: fixture.replayStart, end}, replayBlocks: replayRecords.length,
            actions: fixture.actions, abiHistory: fixture.manifest.abiHistory};
        // Bootstrap only ABI deployments independently proven in captured account deltas, never current RPC ABIs.
        const abiIndex = `${chain}-abi-v1`; await client.indices.create({index: abiIndex, mappings: {properties: {account: {type: 'keyword'}, block: {type: 'long'}}}, settings: {number_of_replicas: 1}});
        for (const entry of abiHistory) await client.index({index: abiIndex, id: entry.block + contractAccount, refresh: 'wait_for', document: {
            account: contractAccount, block: entry.block, abi_hex: entry.abiHex, abi: JSON.stringify(actionAbi(entry.revision)), actions: ['record'], tables: []}});
        replay = await serveFixture(fixture, report.replayErrors); report.replayUrl = replay.url;
        await mkdir(join(output, 'bulk')); bulkLedger = await startBulkLedger(state.core.nodes[0].url, join(output, 'bulk'), report.replayErrors);
        report.bulkReceipts = bulkLedger.receipts;
        proxy = createServer(async (request, response) => {
            try {
                const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1024 * 1024); chunks.push(Buffer.from(chunk)); }
                const body = Buffer.concat(chunks); const requested: any = body.length ? JSON.parse(body.toString()) : {};
                const denied = ['/v1/chain/get_abi', '/v1/chain/get_raw_abi', '/v1/chain/get_raw_code_and_abi'].includes(request.url ?? '') && requested.account_name === contractAccount;
                report.rpcRequests.push({path: request.url, account: requested.account_name, denied});
                if (denied) { response.writeHead(503); response.end(JSON.stringify({error: 'current contract ABI disabled in fixture'})); return; }
                const upstream = await fetch(state.spring.httpUrl + request.url, {method: request.method, body: body.length ? body : undefined,
                    headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(5000)});
                response.writeHead(upstream.status, {'content-type': 'application/json'}); response.end(Buffer.from(await upstream.arrayBuffer()));
            } catch (error) { report.replayErrors.push(String(error)); response.writeHead(500); response.end(); }
        }); proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
        const rpcUrl = `http://127.0.0.1:${(proxy.address() as any).port}`;
        await mkdir(join(output, 'config/chains'), {recursive: true}); await writeFile(join(output, 'package.json'), await readFile(join(repo, 'package.json')), {flag: 'wx'});
        const control = createServer(); control.listen(0, '127.0.0.1'); await once(control, 'listening'); const controlPort = (control.address() as any).port;
        await new Promise<void>(done => control.close(() => done()));
        const redisUrl = new URL(state.redis.url); const mongo = new URL(state.mongo.url);
        const connections = {elasticsearch: {protocol: 'http', host: new URL(state.core.nodes[0].url).host, ingest_nodes: [new URL(bulkLedger.url).host], user: '', pass: ''},
            amqp: {protocol: 'http', host: new URL(state.core.broker.url).host, api: new URL(state.core.broker.managementUrl).host, user: 'qualifier', pass: 'qualifier-test-only', vhost: '/', frameMax: '0x10000'},
            redis: {host: redisUrl.hostname, port: Number(redisUrl.port)}, mongodb: {enabled: false, host: mongo.hostname, port: Number(mongo.port), database_prefix: chain, user: '', pass: ''},
            chains: {[chain]: {chain_id: state.spring.chainId, http: rpcUrl, ship: [{label: 'verified-capture', url: replay.url}], control_port: controlPort}}, alerts: {enabled: false}};
        const config = {api: {enabled: false, disable_tx_cache: true}, indexer: {enabled: true, start_on: fixture.replayStart, stop_on: end + 1, rewrite: false,
            purge_queues: false, live_reader: false, live_only_mode: false, abi_scan_mode: false, fetch_block: true, fetch_traces: true,
            fetch_deltas: true, process_deltas: true, disable_reading: false, disable_indexing: false},
            settings: {chain, parser: '3.2', index_version: 'v1', index_partition_size: 10000000, es_replicas: 1, auto_stop: 0,
                auto_mode_switch: false, ds_profiling: true, rate_monitoring: true, bp_monitoring: false, max_ws_payload_mb: 16, use_global_agent: false, debug: false},
            scaling: {readers: 1, ds_queues: 1, ds_threads: 1, ds_pool_size: 1, indexing_queues: 1, ad_idx_queues: 1, dyn_idx_queues: 1,
                max_autoscale: 0, batch_size: end + 1, resume_trigger: 16, auto_scale_trigger: 1000000, max_queue_limit: 64, block_queue_limit: 64, polling_interval: 500, routing_mode: 'round_robin'},
            prefetch: {read: 8, block: 8, index: 32}, features: {streaming: {enable: false, traces: false, deltas: false},
                tables: {proposals: false, accounts: false, voters: false, permissions: false, user_resources: false}, contract_state: {enabled: false, contracts: {}},
                index_deltas: false, index_all_deltas: false, deferred_trx: false, failed_trx: false, resource_limits: false, resource_usage: false},
            blacklists: {actions: [], deltas: []}, whitelists: {actions: [`${contractAccount}::*`], deltas: [], max_depth: 10, root_only: false}, plugins: {}, hub: {enabled: false}, alerts: {enabled: false}};
        await writeFile(join(output, 'config/connections.json'), JSON.stringify(connections, null, 2) + '\n', {flag: 'wx'});
        const configFile = join(output, 'config/chain.json'); await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', {flag: 'wx'});
        report.config = config; report.connections = connections;
        const stdout = await open(join(output, 'master.stdout.log'), 'wx'); const stderr = await open(join(output, 'master.stderr.log'), 'wx');
        master = spawn(process.execPath, ['--import', pathToFileURL(join(repo, 'scripts/qualification/es955-worker-observer.mjs')).href, join(repo, 'build/indexer/launcher.js')],
            {cwd: output, env: {...process.env, CONFIG_JSON: configFile, CHAIN_NAME: chain, ES198_OBSERVER_DIR: join(output, 'observer'), ES198_CPU_PROFILE: '0'}, stdio: ['ignore', stdout.fd, stderr.fd, 'ipc']});
        master.on('error', error => report.replayErrors.push(String(error))); await stdout.close(); await stderr.close(); report.masterPid = master.pid;
        const all = async (index: string, field: string, query: any = {match_all: {}}) => {
            const result: any = await client.search({index, size: 20000, query, sort: [{[field]: 'asc'}], track_total_hits: true, allow_partial_search_results: false});
            assert.equal(result.timed_out, false); assert.equal(result._shards.failed, 0); assert.equal(result.hits.total.relation, 'eq'); assert.equal(result.hits.total.value, result.hits.hits.length); return result.hits.hits;
        };
        await wait('finite verified output and queue drain', async () => {
            await client.indices.refresh({index: chain + '-*'}); const blocks = await all(chain + '-block-*', 'block_num');
            assertBlockOutputs(blocks, replayRecords); const actions = await all(chain + '-action-*', 'global_sequence');
            assertActionOutputs(actions, fixture.actions); const queueState = await queues();
            assert.ok(queueState.length > 0); assert.ok(queueState.every(queue => queue.ready === 0 && queue.unacked === 0 && queue.messages === 0));
            report.finalQueues = queueState; report.finalBlocks = blocks; report.finalActions = actions; return true;
        }, 180000);
        const outputAbis = await all(chain + '-abi-*', 'block', {term: {account: contractAccount}});
        assert.equal(outputAbis.length, 2); for (const [index, hit] of outputAbis.entries()) {
            assert.equal(hit._source.block, abiHistory[index].block); assert.equal(hit._source.abi_hex, abiHistory[index].abiHex);
        } report.finalAbiHistory = outputAbis;
        report.requests = replay.requests; assert.ok(replay.requests.some(request => request.type === 'get_blocks_request_v0'));
        const rows = await events(); const readerCompletion = rows.filter(row => row.kind === 'ipc_receive' && row.event === 'completed' && row.role === 'reader');
        assert.equal(readerCompletion.length, 1, 'finite reader completion evidence missing'); report.readerCompletion = readerCompletion;
        const readBlocks = rows.filter(row => row.kind === 'ipc_send' && row.event === 'read_block' && row.role === 'reader').map(row => row.message.block_num);
        assert.deepEqual(readBlocks.sort((left, right) => left - right), replayRecords.map(record => record.blockNum), 'reader confirm coverage differs');
        redis = new Redis(state.redis.url, {connectTimeout: 5000, maxRetriesPerRequest: 1});
        report.lastIndexedBeforeShutdown = await redis.get(chain + '::last_indexed_block');
        report.durableCopies = [];
        for (const node of state.core.nodes.filter((entry: any) => entry.role === 'data')) {
            const copy = new Client({node: node.url, maxRetries: 0, requestTimeout: 15000});
            try {
                const identity: any = await copy.nodes.info({node_id: '_local'}); const nodeId = Object.keys(identity.nodes)[0];
                for (const [index, field, expected, check] of [[chain + '-block-*', 'block_num', replayRecords, assertBlockOutputs],
                    [chain + '-action-*', 'global_sequence', fixture.actions, assertActionOutputs]] as const) {
                    const result: any = await copy.search({index, size: 20000, sort: [{[field]: 'asc'}], track_total_hits: true,
                        preference: `_only_nodes:${nodeId}`, allow_partial_search_results: false});
                    assert.equal(result.timed_out, false); assert.equal(result._shards.failed, 0); check(result.hits.hits, expected as any);
                    report.durableCopies.push({node: nodeId, index, count: result.hits.hits.length, sha256: digest(canonical(result.hits.hits))});
                }
            } finally { await copy.close(); }
        }
        assert.equal(report.durableCopies.length, 4);
        report.indexSettings = await client.indices.getSettings({index: chain + '-*', include_defaults: true});
        for (const entry of Object.values(report.indexSettings) as any[]) {
            assert.equal(entry.settings.index.number_of_replicas, '1');
            assert.equal(entry.settings.index.translog?.durability ?? entry.defaults.index.translog.durability, 'request');
        }
        report.outputSha256 = {actions: digest(canonical(report.finalActions)), blocks: digest(canonical(report.finalBlocks))};
        bulkLedger.assertIdle(); report.bulkAccounting = summarizeBulkLedger(bulkLedger.receipts);
        report.rpcFallbackAttempts = report.rpcRequests.filter((request: any) => request.denied); assert.deepEqual(report.rpcFallbackAttempts, []);
        report.status = 'passed';
    } catch (error: any) { report.status = 'failed'; report.error = {message: error.message, stack: error.stack}; }
    finally {
        if (master) {
            try {
                if (master.exitCode === null && master.connected) master.send?.({event: 'qualifier_shutdown'});
                if (master.exitCode === null) await Promise.race([once(master, 'exit'), sleep(10000)]);
                const rows = await events(); report.masterExit = {code: master.exitCode, signal: master.signalCode};
                report.shutdown = assertSuccessfulWorkerShutdown(rows, report.masterPid, master.exitCode, master.signalCode);
                report.lastIndexedRedis = redis ? await redis.get(chain + '::last_indexed_block') : null;
                report.cleanup.push({name: 'workers', ok: true});
            } catch (error) { report.cleanup.push({name: 'workers', ok: false, error: String(error)}); report.status = 'failed'; }
            if (master.exitCode === null) master.kill();
        }
        try { await replay?.close(); } catch (error) { report.status = 'failed'; report.cleanup.push({name: 'replay', error: String(error)}); }
        if (bulkLedger) {
            try { bulkLedger.assertIdle(); } catch (error) { report.status = 'failed'; report.cleanup.push({name: 'bulk-ledger-idle', error: String(error)}); }
            try { await bulkLedger.close(); } catch (error) { report.status = 'failed'; report.cleanup.push({name: 'bulk-ledger-close', error: String(error)}); }
        }
        if (proxy) { proxy.closeAllConnections(); await new Promise<void>(done => proxy!.close(() => done())); }
        try { if (redis) await redis.quit(); await client.close(); } catch (error) { report.status = 'failed'; report.cleanup.push({name: 'clients', error: String(error)}); }
        if (report.replayErrors.length) report.status = 'failed'; report.completedAt = new Date().toISOString();
        await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n'); await reportHandle.close();
    } return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [state, output] = process.argv.slice(2); assert.ok(state && output, 'usage: node contract-replay.ts STATE_FILE NEW_OUTPUT_DIRECTORY');
    const report = await runContractReplay(state, output); console.log(JSON.stringify({status: report.status, error: report.error,
        capturedBlocks: report.fixture?.blocks, replayedBlocks: report.fixture?.replayBlocks, actions: report.fixture?.actions.length}));
    if (report.status !== 'passed') process.exitCode = 1;
}
