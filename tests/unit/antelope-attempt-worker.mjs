/** Native emitted Antelope callbacks. ES, RabbitMQ and ABI lookup transports are controlled.
 * All retained-store, source, proof, fresh-write and attempt validators are production implementations.
 */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerHooks} from 'node:module';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';

const mode = process.argv[2], managedMain = mode !== 'handoff';
assert(['handoff', 'empty', 'missing'].includes(mode));
assert.equal(process.env.HYPERION_QUALIFICATION_PLAIN_PROOF, 'false');
assert.equal(process.env.HYPERION_QUALIFICATION_PLAIN_HANDOFF, 'false');
assert(!process.versions.bun && [24, 26].includes(Number(process.versions.node.split('.')[0])));
const fixtureBytes = readFileSync(new URL('../fixtures/antelope-worker/source.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const schemaBytes = readFileSync(new URL('../fixtures/antelope-worker/ship.abi.json', import.meta.url));
assert.equal(hash(schemaBytes), fixture.upstream.extractedAbiSha256);
assert.equal(hash(readFileSync(new URL('../fixtures/antelope-worker/generate.mjs', import.meta.url))), fixture.generator.sourceSha256);
assert.equal(hash(Buffer.from(fixture.contract.abiHex, 'hex')), fixture.contract.abiSha256);
const frame = Buffer.from(fixture.frames[mode].hex, 'hex');
assert.equal(frame.length, fixture.frames[mode].bytes); assert.equal(hash(frame), fixture.frames[mode].sha256);
let addonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    assert(!specifier.includes('hyperion-wire-plugin'), 'Builtin Antelope must not load Wire code');
    if (specifier.includes('node-abieos')) addonResolutions++;
    return next(specifier, context);
}});
class Consumer extends EventEmitter {
    acked = []; streamed = [];
    ack(message) {this.onAck?.(message); this.acked.push(message);}
    publish(exchange, queue, payload, options) {this.streamed.push({exchange, queue, payload: Buffer.from(payload), options}); return true;}
}
class Publisher extends EventEmitter {
    sent = [];
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options)});
        queueMicrotask(() => confirm()); return true;
    }
}
const message = sent => ({content: Buffer.from(sent.payload), properties: {headers: structuredClone(sent.options.headers)},
    fields: {deliveryTag: 1, redelivered: false}});
const chain = 'antelope-attempt-original', chainId = fixture.source.chainId;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-antelope-attempt-config-')), previousDirectory = process.cwd();
const previousConfig = process.env.CONFIG_JSON, previousRole = process.env.worker_role, previousLive = process.env.live_mode;
let managed, reader, main, snapshotPath, finish;
const finished = new Promise(resolve => {finish = resolve;});
process.on('message', value => {if (value?.event === 'qualification_done') finish();});
const config = {settings: {chain, eosio_alias: 'eosio', parser: '3.2', debug: false, index_version: 'v1',
    index_partition_size: 1000, es_replicas: 1}, indexer: {fetch_block: true, fetch_traces: true, process_deltas: false,
    disable_indexing: false, max_inline: 0, live_reader: false},
    features: {contract_console: false, failed_trx: false, streaming: {traces: true}},
    scaling: {routing_mode: 'round_robin', ds_pool_size: 1, ds_queues: 1, ad_idx_queues: 1, indexing_queues: 1},
    api: {tx_cache_mode: 'batch', disable_tx_cache: false}, whitelists: {actions: [], deltas: [], root_only: false},
    blacklists: {actions: [], deltas: []}, plugins: {}};
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    process.env.worker_role = managedMain ? 'deserializer' : 'ds_pool_worker';
    process.env.live_mode = 'false';
    const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader},
        {loadChainProtocol}, {ActionSourceAdmissionStore, actionSourceAdmissionHeader},
        {WorkerAttemptClient}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
        import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/history/action-source-admission.js'), import('../../build/indexer/protocol/worker-attempt-client.js')]);
    const selected = await loadChainProtocol(undefined);
    assert.equal(selected.id, 'antelope'); assert.equal(selected.provider.profileId, fixture.profileId);
    assert.equal(selected.provider.abiObservations, undefined); assert(addonResolutions > 0);
    const nativeCalls = [], originalDecode = selected.decoder.binToJson.bind(selected.decoder);
    selected.decoder.binToJson = (contract, type, bytes) => {
        nativeCalls.push({contract, type, sha256: hash(bytes)}); return originalDecode(contract, type, bytes);
    };
    const memory = frontierMemoryClient(1), store = new ActionSourceAdmissionStore(memory.client, chain, 1);
    const targetName = chain + '-action-v1-000001', targetUuid = 'owned-antelope-worker-target';
    memory.settings.set(targetName, {'index.uuid': targetUuid});
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const abiReads = [];
    memory.client.search = async request => {
        assert.equal(request.index, chain + '-abi-*', 'Only constructed historical ABI lookup is permitted');
        assert.deepEqual(request.query.bool.must, [{term: {account: fixture.contract.account}},
            {range: {block: {lte: fixture.source.blockNum}}}]);
        abiReads.push(structuredClone(request));
        return {hits: {hits: [{_source: {account: fixture.contract.account, block: fixture.contract.abiDeployment.blockNum,
            block_id: fixture.contract.abiDeployment.blockId, abi_hex: fixture.contract.abiHex,
            actions: ['setvalue'], tables: []}}]}};
    };
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const cm = {config, filters}, parser = new Parser(cm), loader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(loader, {handledActions: new Map(), handledDeltas: new Map(), parser, plugins: []});
    const receipts = [], recordIds = prefix => [...memory.documents.values()].map(x => x.document)
        .filter(x => x.kind === 'manifest' && x.bundle_id.startsWith(prefix)).map(x => x.bundle_id);
    memory.faults.receipt = (receipt, request) => {
        if (request.document.kind === 'manifest' && /^(h45actionattempt1:|h45actionhandoff1:)/.test(request.id)) {
            assert.equal(request.wait_for_active_shards, 'all');
            assert.deepEqual(receipt._shards, {total: 2, successful: 2, failed: 0});
            receipts.push({id: request.id, shards: receipt._shards});
            process.send({event: 'qualification_write_receipt', id: request.id, shards: receipt._shards});
        }
        return receipt;
    };
    function worker(prototype, role) {
        const value = Object.create(prototype), consumer = new Consumer(), publisher = new Publisher();
        Object.assign(value, {chain, chainId, conf: config, configModule: cm, filters, mLoader: loader,
            protocol: selected.provider, protocolId: selected.id, protocolComponents: selected.components,
            protocolReady: Promise.resolve(), abieos: selected.decoder, client: memory.client,
            ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, profiler: {start: () => () => {}},
            actionAdmissionOwners: new WeakMap(), actionAdmissionStore: store});
        Object.defineProperty(value, 'actionSourceAdmissionEnabled', {value: true});
        if (role) {
            if ((role === 'deserializer') === managedMain) {
                managed = new WorkerAttemptClient({mode: 'managed', role, transport: process, timeoutMs: 1000, drainTimeoutMs: 5000, retries: 2});
                value.configureWorkerAttemptLifecycle(managed);
                consumer.onAck = () => process.send({event: 'qualification_ack', role});
            } else controlledAttemptLifecycle(value, role);
        }
        return value;
    }
    reader = worker(Reader.prototype);
    main = worker(Main.prototype, 'deserializer');
    const pool = worker(Pool.prototype, 'ds_pool_worker'), cache = [], blockWrites = [];
    Object.assign(reader, {baseRequest: {}, shipRev: 0, socketGeneration: 0, activeIngressGeneration: 0,
        isLiveReader: false, local_block_num: 11, local_distributed_count: 0, receivedFirstBlock: true,
        future_block: 0, currentIdx: 1, range_size: 1, publications: new Map(), send() {}, handleStatusResult() {}});
    reader.stageOneDistQueue = {push: async payload => new Promise(resolve => reader.distribute([payload], resolve))};
    Object.assign(main, {local_block_count: 0, lastSelectedWorker: 0, dsPoolMap: {}, ds_pool_counters: {}, block_emit_idx: 1,
        preIndexingQueue: {push: async payload => blockWrites.push(payload)}});
    Object.assign(pool, {poolAbiCache: new Map(), poolTypeCache: new Map(), loadedActionAbis: new Map(), failedAbiMap: new Map(),
        protocolCacheViews: new Set(), contractUsage: {}, temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1,
        txCacheExpiration: 3600, allowStreaming: true,
        common: {deserializeActionAtBlockNative: Pool.prototype.deserializeActionAtBlockNative, attachActionExtras: Pool.prototype.attachActionExtras},
        pushToActionsQueue() {assert.fail('Original admitted Antelope action bypassed the confirmed publisher');},
        ioRedisClient: {pipeline() {const writes = []; return {hset(key, values) {writes.push({key, values: [...values]}); return this;},
            expire() {return this;}, async exec() {cache.push(...writes); return [];}};}}});
    const schemaJson = schemaBytes.toString();
    await reader.initializeProtocolShip(schemaJson);
    await reader.processFirstABI(schemaBytes);
    await main.initializeProtocolShip(schemaJson);
    const status = Buffer.from(fixture.status.hex, 'hex');
    assert.equal(hash(status), fixture.status.sha256); assert.equal(status.length, fixture.status.bytes);
    await reader.onMessage(status);
    assert.equal(await reader.onMessage(frame), 'block');
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(reader.cch.sent.length, 1); assert(reader.cch.sent[0].payload.equals(frame));
    const sourceMessage = message(reader.cch.sent[0]);
    main.captureActionAdmissionDelivery(sourceMessage, main.ch);
    await parser.parseMessage(main, [sourceMessage]);
    assert.equal(main.ch.acked.length, 1);
    if (mode === 'handoff') {
        assert.equal(main.cch.sent.length, 1); const incoming = message(main.cch.sent[0]);
        pool.captureActionAdmissionDelivery(incoming, pool.ch);
        await pool.processMessages([incoming]);
        assert.equal(pool.ch.acked.length, 1); assert.equal(pool.cch.sent.length, 1);
        assert.equal(abiReads.length, 1);
        const emitted = JSON.parse(pool.cch.sent[0].payload.toString());
        process.send({event: 'qualification_output', emitted});
        const output = Array.isArray(emitted) ? emitted[0] : emitted;
        assert.equal(output.act.account, fixture.expected.account);
        assert.equal(output.act.name, fixture.expected.name);
        assert.deepEqual(output.act.data, fixture.expected.data);
        assert.deepEqual(output.act.authorization, fixture.expected.authorization);
        assert.equal(output.global_sequence, fixture.expected.globalSequence);
        assert.equal(output.receipts[0].recv_sequence, fixture.expected.receiverSequence);
        assert.equal(output.receipts[0].receiver, fixture.expected.receiver);
        assert.deepEqual(output.receipts[0].auth_sequence, [{account: 'alice', sequence: fixture.expected.authSequence}]);
        assert.equal(output.code_sequence, fixture.expected.codeSequence);
        assert.equal(output.abi_sequence, fixture.expected.abiSequence);
        assert.equal(output.return_value.toLowerCase(), fixture.expected.returnValue);
        assert.equal(output.trx_id, fixture.source.transactionId);
        assert.equal(output.block_num, fixture.source.blockNum);
        assert.equal(output.block_id, fixture.source.blockId);
    } else {
        assert.equal(main.cch.sent.length, 0); assert.equal(abiReads.length, 0);
    }
    assert(nativeCalls.some(x => x.type === 'signed_block'));
    if (mode !== 'missing') assert(nativeCalls.some(x => x.type === 'transaction_trace[]'));
    if (mode === 'handoff') assert(nativeCalls.some(x => x.contract === fixture.contract.account && x.type === 'setvalue'
        && x.sha256 === hash(Buffer.from(fixture.contract.actionHex, 'hex'))));
    const prefix = mode === 'handoff' ? 'h45actionhandoff1:' : 'h45actionattempt1:';
    const ids = recordIds(prefix); assert.equal(ids.length, 1); assert.equal(receipts.length, 1);
    const admissionId = mode === 'handoff' ? main.cch.sent[0].options.headers[actionSourceAdmissionHeader]
        : recordIds('h45actionadmission1:')[0];
    const admission = await store.resolve(admissionId);
    assert.equal(admission.source.frameHex, frame.toString('hex')); assert.equal(admission.source.inventoryInput.profileId, fixture.profileId);
    assert.equal(admission.source.inventoryInput.source.blockId, fixture.source.blockId);
    assert.equal(admission.source.producer.protocolId, 'antelope');
    const snapshot = {chain, mode, config, targetName, targetUuid, admissionId, recordId: ids[0],
        fixtureSha256: hash(fixtureBytes), frameSha256: hash(frame), nativeCalls, abiReads, addonResolutions,
        producer: admission.source.producer, executableSha256: admission.source.executableSha256,
        runtime: {node: process.version, executableSha256: hash(readFileSync(process.execPath))},
        publishers: {reader: reader.cch.sent, main: main.cch.sent, pool: pool.cch.sent},
        documents: [...memory.documents], mappings: [...memory.mappings], settings: [...memory.settings], sequences: [...memory.sequences]};
    snapshotPath = join(tmpdir(), 'hyperion-antelope-attempt-' + randomUUID() + '.json');
    const bytes = Buffer.from(JSON.stringify(snapshot)); writeFileSync(snapshotPath, bytes, {flag: 'wx'});
    process.send({event: 'qualification_fixture', path: snapshotPath, bytes: bytes.length, sha256: hash(bytes)});
    await finished;
} finally {
    managed?.dispose(); reader?.shipSession?.close?.(); main?.shipSession?.close?.(); hooks.deregister();
    process.chdir(previousDirectory);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    if (previousRole === undefined) delete process.env.worker_role; else process.env.worker_role = previousRole;
    if (previousLive === undefined) delete process.env.live_mode; else process.env.live_mode = previousLive;
    rmSync(directory, {recursive: true, force: true});
    if (snapshotPath) rmSync(snapshotPath, {force: true});
    process.disconnect?.();
}
