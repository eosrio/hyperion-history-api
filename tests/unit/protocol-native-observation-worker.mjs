import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {validateProtocolNativeActions} from '@eosrio/hyperion-sdk/protocol';

registerHooks({resolve(specifier, context, next) {if (specifier.includes('node-abieos')) throw new Error('Wire imported legacy addon'); return next(specifier, context);}});
const hash = data => createHash('sha256').update(data).digest('hex');
const wireRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
const originals = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');
const manifest = JSON.parse(readFileSync(join(originals, 'manifest.json')));
for (const member of manifest.members) {
    const bytes = readFileSync(join(originals, member.path));
    assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);
}
const schemaJson = readFileSync(resolve(originals, manifest.schema.path), 'utf8');
assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
const expectedBytes = readFileSync(join(originals, 'expected.json'));
assert.equal(hash(expectedBytes), 'f2d022f14e493f2297034dd8e7e1846d1504f19bbf1278afee8cd30a955b9720');
const expected = JSON.parse(expectedBytes), first = readFileSync(join(originals, 'block-000033.bin'));
assert.equal(hash(first), '6d1755e9aa718dd4d0dd120a6bb7706881a0809bd2ef9fdef4efee93d1c172a3');
const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hyperion-native-journal-'));
const originalSend = process.send, originalExit = process.exit, originalRole = process.env.worker_role;
const workers = [], publications = [], events = [], nativeCalls = [], ackSnapshots = [], routed = [];
let ack = 0;
try {
    const chain = 'native-observation-fixture', chainId = manifest.chainId;
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: manifest.profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 10000, ds_profiling: false, es_replicas: 0},
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: true, disable_indexing: false, max_inline: 1},
        features: {index_all_deltas: true, index_deltas: true, index_deltas_deletions: true, streaming: {deltas: false, traces: false}, tables: {}, failed_trx: false},
        scaling: {ds_pool_size: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 1, dyn_idx_queues: 1, batch_size: 100},
        prefetch: {read: 1, block: 1, index: 1}, plugins: {}, whitelists: {root_only: false, actions: [], deltas: []}, api: {tx_cache_mode: 'batch'}};
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({amqp: {protocol: 'http'}, elasticsearch: {host: '127.0.0.1:1', user: '', pass: ''},
        chains: {[chain]: {chain_id: chainId, http: 'http://127.0.0.1:1', ship: 'ws://127.0.0.1:1'}}, redis: {host: '127.0.0.1', port: 1}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.worker_role = 'deserializer';
    process.send = event => {events.push(event); return true;};
    const {HyperionWorker, ProtocolSourceCodecError} = await import('../../build/indexer/workers/hyperionWorker.js');
    HyperionWorker.prototype.connectAMQP = async function () {}; HyperionWorker.prototype.onConnect = function () {};
    const {default: MainDS} = await import('../../build/indexer/workers/deserializer.js');
    const {default: Reader} = await import('../../build/indexer/workers/state-reader.js');
    const {ProtocolSourceBindingStore, protocolSourceSelectionHeader} = await import('../../build/indexer/protocol/source-bindings.js');
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const profile = wire.resolveCodecProfile(manifest.profileId), codec = wire.createWireValueCodec(JSON.parse(schemaJson), profile);
    const realNative = validateProtocolNativeActions(wire.createWireNativeActions(profile), {interfaceVersion: 1});
    assert.equal(realNative.valid, true);
    const memory = frontierMemoryClient(), bindings = new ProtocolSourceBindingStore(memory.client, chain);
    const main = new MainDS(); workers.push(main); await main.protocolReady; await main.initializeProtocolShip(schemaJson);
    assert.equal(main.protocol.nativeActions, undefined, 'Installed profile must remain inactive');
    const deadline = Date.now() + 3000; while (!main.mLoader.parser) {assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 5));}
    main.client = memory.client; main.protocolSourceBindingStore = bindings;
    const instrumented = validateProtocolNativeActions({...realNative.nativeActions,
        observe(input, source) {nativeCalls.push({source: {...source}, block: hash(input.block), traces: hash(input.traces)});
            return realNative.nativeActions.observe(input, source);}}, {interfaceVersion: 1});
    assert.equal(instrumented.valid, true);
    // Internal engineering injection only, after the real loader has refused to advertise support.
    main.protocol = {...main.protocol, nativeActions: instrumented.nativeActions};
    main.preIndexingQueue = {push: async value => routed.push(value)}; main.ch_ready = true;
    main.ch = {ack(message) {ack++; ackSnapshots.push({selectionId: message.properties.headers[protocolSourceSelectionHeader],
        nativeManifests: [...memory.documents.values()].filter(x => x.document.kind === 'manifest' && x.document.bundle_id.startsWith('h45natobs1:')).length,
        nativeLinks: [...memory.documents.values()].filter(x => x.document.kind === 'manifest' && x.document.bundle_id.startsWith('h45srcnat1:')).length});},
        nack() {throw new Error('Unexpected nack');}, sendToQueue(queue, content, options) {routed.push({queue, content, options}); return true;}};
    const reader = new Reader(); workers.push(reader); await reader.protocolReady;
    reader.client = memory.client; reader.protocolSourceBindingStore = bindings; reader.confirmRange = undefined; reader.receivedFirstBlock = true;
    reader.ship = {connected: true, send() {}, close() {}};
    const publisher = {sendToQueue(queue, content, options, confirm) {publications.push({content, properties: options}); confirm(null); return true;}};
    reader.cch = publisher; reader.cch_ready = true;
    reader.stageOneDistQueue = {push: async payload => new Promise(r => reader.recursiveDistribute([payload], publisher, r))};
    await reader.processFirstABI(Buffer.from(schemaJson));
    const template = main.decodeShipResult(first);
    await reader.onMessage(Buffer.from(codec.encode('result', ['get_status_result_v0', {head: template[1].head,
        last_irreversible: template[1].last_irreversible, trace_begin_block: 2, trace_end_block: 1481,
        chain_state_begin_block: 1, chain_state_end_block: 1481, chain_id: chainId}])));
    const publish = async content => {
        reader.local_block_num = Number(reader.decodeShipResult(content)[1].this_block.block_num) - 1;
        const count = publications.length; await reader.onMessage(content); assert.equal(publications.length, count + 1);
        return {...publications.at(-1), fields: {deliveryTag: publications.length}};
    };
    const consume = async content => {
        const message = await publish(content); (controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(message, main.ch);
        await main.mLoader.parser.parseMessage(main, [message]); return message;
    };
    const originalBytes = Buffer.from(first);
    const message = await consume(first);
    assert.deepEqual(first, originalBytes);
    assert.equal(nativeCalls.length, 1, 'Native observation must run on original source before ACK');
    assert.equal(ack, 1); assert.equal(ackSnapshots[0].nativeManifests, 1); assert.equal(ackSnapshots[0].nativeLinks, 1);
    const {ProtocolNativeObservationStore} = await import('../../build/indexer/protocol/native-observation-store.js');
    const cold = new ProtocolNativeObservationStore(memory.client, chain, 0, undefined, {readOnly: true});
    const read = message => cold.readSelection(message.properties.headers[protocolSourceSelectionHeader]);
    const stored = await read(message);
    assert.equal(stored.record.observation.status, 'observed');
    assert.deepEqual(stored.record.observation.facts.decisions[0], {kind: 'native', nativeKind: expected[0].nativeKind,
        origin: {transactionId: expected[0].transactionId, actionOrdinal: 1, rawSha256: expected[0].rawSha256}});
    assert.equal(stored.record.inventory.inputCount, 1); assert.equal(stored.record.inventory.firstReceiverCount, 1);
    for (const row of expected.slice(1)) {
        // Both frames remain byte-identical; the last one is excluded by the real root-only filter.
        main.conf.whitelists.root_only = row.blockNum === 397;
        main.conf.whitelists.actions = ['unrelated::action']; main.filters.action_whitelist = new Set(['unrelated::action']);
        routed.length = 0;
        const bytes = readFileSync(join(originals, `block-${String(row.blockNum).padStart(6, '0')}.bin`));
        const next = await read(await consume(bytes));
        assert.equal(next.record.observation.status, 'observed');
        assert.equal(next.record.source.blockId, row.blockId);
        assert.deepEqual(next.record.observation.facts.decisions[0], {kind: 'native', nativeKind: row.nativeKind,
            origin: {transactionId: row.transactionId, actionOrdinal: row.actionOrdinal, rawSha256: row.rawSha256}});
        if (row.blockNum === 397) assert(!routed.some(value => value.queue?.includes('ds_pool')));
    }
    main.conf.whitelists.root_only = false; main.conf.whitelists.actions = []; main.filters.action_whitelist = new Set();
    const originalAbi = main.protocol.observeBlockAbi, originalNative = main.protocol.nativeActions;
    const capability = observe => {
        const checked = validateProtocolNativeActions({...realNative.nativeActions, observe}, {interfaceVersion: 1});
        assert.equal(checked.valid, true); main.protocol = {...main.protocol, nativeActions: checked.nativeActions};
    };
    // Derived fault frames use distinct delta sections, never relabelled as unchanged source captures.
    const deltaByTag = new Map();
    const frame = (tag, changes = {}) => {
        const sections = {...changes};
        for (const key of ['block', 'traces', 'deltas']) if (ArrayBuffer.isView(sections[key])) sections[key] = Buffer.from(sections[key]).toString('hex');
        if (!deltaByTag.has(tag)) deltaByTag.set(tag, Buffer.from(codec.encode('table_delta[]',
            Array.from({length: deltaByTag.size + 1}, () => ['table_delta_v0', {name: 'account', rows: []}]))).toString('hex'));
        return Buffer.from(codec.encode('result', [template[0], {...structuredClone(template[1]),
            deltas: deltaByTag.get(tag), ...sections}]));
    };
    const incomplete = async (tag, observe, changes = {}) => {
        capability(observe);
        const value = await read(await consume(frame(tag, changes)));
        assert.equal(value.record.observation.status, 'incomplete'); return value;
    };
    for (const [tag, modify] of [
        ['omitted', facts => ({...facts, decisions: []})],
        ['invented', facts => ({...facts, decisions: facts.decisions.map(row => ({...row, origin: {...row.origin, transactionId: 'f'.repeat(64)}}))})],
        ['wrongraw', facts => ({...facts, decisions: facts.decisions.map(row => ({...row, origin: {...row.origin, rawSha256: '0'.repeat(64)}}))})],
        ['duplicate', facts => ({...facts, decisions: [...facts.decisions, facts.decisions[0]]})],
    ]) {
        const value = await incomplete(tag, (input, source) => modify(realNative.nativeActions.observe(input, source)));
        assert.equal(value.record.inventory.firstReceiverCount, 1);
        assert.equal(value.abiObservation.observation.status, 'observed', JSON.stringify(value.abiObservation.observation));
    }
    let getters = 0;
    await incomplete('accessor', () => Object.defineProperty({schemaVersion: 1}, 'decisions', {enumerable: true, get() {getters++; return [];}}));
    assert.equal(getters, 0);
    const thrown = await incomplete('provider_throw', () => {throw new Error('Native schema unsupported');});
    assert.match(thrown.record.observation.error.message, /Native schema unsupported/);
    const opaqueError = await incomplete('opaque_error', () => {throw Object.create(null);});
    assert.equal(opaqueError.record.observation.error.code, 'protocol_native_observation_incomplete');
    let messageGetters = 0, coercions = 0;
    const errorGetter = Object.defineProperty({}, 'message', {get() {messageGetters++; throw new Error('Error message getter executed');}});
    await incomplete('error_message_getter', () => {throw errorGetter;}); assert.equal(messageGetters, 0);
    const coercionError = {message: {[Symbol.toPrimitive]() {coercions++; throw new Error('Error coercion executed');}}};
    await incomplete('error_message_coercion', () => {throw coercionError;}); assert.equal(coercions, 0);
    const revokedError = Proxy.revocable({}, {}); revokedError.revoke();
    await incomplete('revoked_error', () => {throw revokedError.proxy;});
    const textError = await incomplete('text_error', () => {throw 'Native text failure';});
    assert.equal(textError.record.observation.error.message, 'Native text failure');
    const mutation = await incomplete('mutation', (input, source) => {const facts = realNative.nativeActions.observe(input, source); input.traces[0] ^= 1; return facts;});
    assert.match(mutation.record.observation.error.message, /mutated its source bytes/);

    main.protocol = {...main.protocol, nativeActions: originalNative};
    main.protocol.observeBlockAbi = () => {throw new Error('Independent ABI extraction failure');};
    const independent = await read(await consume(frame('abi_failure')));
    assert.equal(independent.abiObservation.observation.status, 'incomplete');
    assert.equal(independent.record.observation.status, 'observed');
    assert.equal(independent.record.observation.facts.decisions[0].nativeKind, expected[0].nativeKind);
    main.protocol.observeBlockAbi = originalAbi;

    let absentCalls = 0;
    capability(() => {absentCalls++; throw new Error('Absent traces must not invoke observer');});
    const absent = await read(await consume(frame('absent', {traces: null})));
    assert.equal(absent.record.observation.error.code, 'native_source_traces_absent');
    assert.equal(absent.record.inventory, null); assert.equal(absentCalls, 0);
    const genesis = JSON.parse(readFileSync(new URL('./fixtures/wire-native-genesis/ship-preflight-20261020.json', import.meta.url)));
    const genesisFrame = Buffer.from(genesis.messages.find(row => row.kind === 'block1').response.base64, 'base64');
    const genesisStored = await read(await consume(genesisFrame));
    assert.equal(genesisStored.record.observation.error.code, 'native_source_traces_absent');
    assert.equal(genesisStored.record.inventory, null); assert.equal(absentCalls, 0);
    assert.equal(genesisStored.abiObservation.observation.status, 'native-genesis');
    const empty = Buffer.from(codec.encode('transaction_trace[]', []));
    main.protocol = {...main.protocol, nativeActions: originalNative};
    const realEmpty = await read(await consume(frame('empty_real', {traces: empty})));
    assert.equal(realEmpty.record.inventory.inputCount, 0); assert.equal(realEmpty.record.observation.status, 'incomplete');
    capability(() => ({schemaVersion: 1, decisions: []}));
    const provedEmpty = await read(await consume(frame('empty_engineering', {traces: empty})));
    assert.equal(provedEmpty.record.inventory.firstReceiverCount, 0); assert.equal(provedEmpty.record.observation.status, 'observed');

    const {deriveProtocolActionInputs} = await import('../../build/indexer/history/action-source-inventory.js');
    const mixed = main.decodeShipValue('transaction_trace[]', template[1].traces);
    const action = structuredClone(mixed[0][1].action_traces[0]);
    Object.assign(action[1], {action_ordinal: 2, creator_action_ordinal: 1, receiver: 'other'});
    Object.assign(action[1].act, {account: 'other', name: 'act', data: '07000000', authorization: [{actor: 'other', permission: 'active'}]});
    Object.assign(action[1].receipt[1], {receiver: 'other', global_sequence: '42', recv_sequence: '1'});
    mixed[0][1].action_traces.push(action);
    capability(input => ({schemaVersion: 1, decisions: deriveProtocolActionInputs(codec.decode('transaction_trace[]', input.traces))
        .filter(row => row.inputActionOrdinal === row.actionOrdinal && row.receiver === row.account)
        .map((row, index) => ({origin: {transactionId: row.transactionId, actionOrdinal: row.actionOrdinal, rawSha256: hash(Buffer.from(row.rawHex, 'hex'))},
            ...(index === 0 ? {kind: 'incomplete', error: {code: 'unsupported_native_schema', message: 'Engineering per-origin failure'}} : {kind: 'contract'})}))}));
    routed.length = 0;
    const mixedStored = await read(await consume(frame('mixed', {traces: Buffer.from(codec.encode('transaction_trace[]', mixed))})));
    assert.equal(mixedStored.record.observation.status, 'observed');
    assert.deepEqual(mixedStored.record.observation.facts.decisions.map(row => row.kind), ['incomplete', 'contract']);
    assert.equal(mixedStored.record.inventory.inputCount, 2);
    const groups = routed.map(row => JSON.parse(row.content)).filter(row => Array.isArray(row.action_traces));
    assert(groups.length > 0); assert(groups.every(row => row.action_traces.length === 1), 'Control must exercise actual max-inline truncation');
    main.protocol = {...main.protocol, nativeActions: originalNative};

    const originalDecode = main.decodeShipValue;
    main.decodeShipValue = function (type, bytes) {
        if (type === 'table_delta[]') throw new ProtocolSourceCodecError(type, new Error('Engineering delta codec failure'));
        return originalDecode.call(this, type, bytes);
    };
    const codecFailure = await read(await consume(frame('delta_codec_failure')));
    assert.equal(codecFailure.abiObservation.observation.status, 'incomplete');
    assert.equal(codecFailure.record.observation.status, 'observed', 'ABI codec failure must not prevent independent native PREPARE');
    main.decodeShipValue = originalDecode;
    process.send = event => {if (event.event === 'protocol_abi_prepared') throw new Error('Dropped advisory IPC'); events.push(event); return true;};
    assert.equal((await read(await consume(frame('dropped_ipc')))).record.observation.status, 'observed');
    process.send = event => {events.push(event); return true;};

    const nativeIndex = `${chain}-protocol-native-actions-v1`;
    const clearFaults = () => {for (const key of Object.keys(memory.faults)) delete memory.faults[key];};
    for (const phase of ['observation-chunk', 'observation-manifest', 'link-chunk', 'link-manifest', 'readback']) {
        const bytes = frame(`crash_${phase.replaceAll('-', '_')}`), before = ack;
        const failure = new Error(`Native crash at ${phase}`); let linkWritten = false;
        memory.faults.beforeWrite = request => {
            if (request.index !== nativeIndex) return;
            const target = request.document.bundle_id.startsWith('h45natobs1:') ? 'observation' : 'link';
            if (`${target}-${request.document.kind}` === phase) throw failure;
        };
        memory.faults.receipt = (receipt, request) => {
            if (request.index === nativeIndex && request.document.bundle_id.startsWith('h45srcnat1:') && request.document.kind === 'manifest') linkWritten = true;
            return receipt;
        };
        memory.faults.beforeRead = request => {if (phase === 'readback' && linkWritten && request.index === nativeIndex) throw failure;};
        await assert.rejects(consume(bytes), error => error === failure); assert.equal(ack, before);
        clearFaults(); const recovered = await read(await consume(bytes));
        assert.equal(recovered.record.observation.status, 'observed'); assert.equal(ack, before + 1);
        await consume(bytes); assert.equal(ack, before + 2);
    }
    const partialFrame = frame('partial_receipt'), partialBefore = ack;
    memory.faults.receipt = (receipt, request) => request.index === nativeIndex
        ? {...receipt, _shards: {...receipt._shards, successful: 0}} : receipt;
    await assert.rejects(consume(partialFrame), /durable write receipt/); assert.equal(ack, partialBefore);
    await assert.rejects(consume(partialFrame), /durable write receipt/); assert.equal(ack, partialBefore, 'GET must not rescue a partial copy receipt');
    clearFaults(); await consume(partialFrame); assert.equal(ack, partialBefore + 1);
    assert(memory.calls.some(call => call.method === 'index' && call.request.index === nativeIndex && call.request.if_seq_no !== undefined));
    const unknownFrame = frame('unknown_outcome'), unknownBefore = ack, unknownError = new Error('Native write outcome unknown');
    memory.faults.receipt = (receipt, request) => {if (request.index === nativeIndex) throw unknownError; return receipt;};
    await assert.rejects(consume(unknownFrame), error => error === unknownError); assert.equal(ack, unknownBefore);
    clearFaults(); await consume(unknownFrame); assert.equal(ack, unknownBefore + 1);
    const conflictFrame = frame('conflicting_labels');
    await consume(conflictFrame); const conflictBefore = ack;
    capability(() => {throw new Error('Different labels for identical source');});
    await assert.rejects(consume(conflictFrame), /Immutable.*conflict/); assert.equal(ack, conflictBefore);
    main.protocol = {...main.protocol, nativeActions: originalNative};

    const staleFrame = frame('replaced_channel'), staleMessage = await publish(staleFrame), staleBefore = ack;
    const oldChannel = main.ch; (controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(staleMessage, oldChannel);
    let release, enter; const entered = new Promise(r => {enter = r;}), held = new Promise(r => {release = r;});
    memory.faults.beforeWrite = async request => {if (request.index === nativeIndex && request.document.bundle_id.startsWith('h45natobs1:')) {enter(); await held;}};
    const pending = main.mLoader.parser.parseMessage(main, [staleMessage]);
    await entered;
    const replacementTags = [];
    main.ch = {...oldChannel, ack(message) {replacementTags.push(message.fields.deliveryTag); oldChannel.ack(message);}};
    release(); await assert.rejects(pending, /source channel changed during PREPARE/);
    assert.equal(ack, staleBefore); assert.deepEqual(replacementTags, []); clearFaults();
    const fresh = await consume(staleFrame);
    assert.equal(ack, staleBefore + 1); assert.deepEqual(replacementTags, [fresh.fields.deliveryTag]);
    assert.notEqual(fresh.fields.deliveryTag, staleMessage.fields.deliveryTag);

    // The actual constructor-created cargo kills queued obsolete deliveries on
    // a native durability failure; supervised replacement receives fresh tags.
    const settlements = [];
    const createWorker = async label => {
        const worker = new MainDS(); workers.push(worker); await worker.protocolReady; await worker.initializeProtocolShip(schemaJson);
        const deadline = Date.now() + 3000; while (!worker.mLoader.parser) {assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 5));}
        worker.client = memory.client; worker.protocolSourceBindingStore = bindings;
        worker.protocol = {...worker.protocol, nativeActions: originalNative};
        worker.preIndexingQueue = {push: async () => {}}; worker.ch_ready = true;
        worker.ch = {ack(message) {assert(worker.ch_ready); settlements.push(`${label}:${message.fields.deliveryTag}`);},
            nackAll() {throw new Error('Cargo must not reuse obsolete delivery tags');}, sendToQueue() {return true;}};
        return worker;
    };
    memory.faults.beforeWrite = request => {
        if (request.index === nativeIndex && request.document.kind === 'manifest' && request.document.bundle_id.startsWith('h45natobs1:'))
            throw new Error('Transient native durable manifest failure');
    };
    const failedWorker = await createWorker('obsolete'), cargoA = await publish(frame('cargo_a')), cargoB = await publish(frame('cargo_b'));
    (controlledAttemptLifecycle(failedWorker, 'deserializer'), failedWorker).captureProtocolSourceDelivery(cargoA, failedWorker.ch); (controlledAttemptLifecycle(failedWorker, 'deserializer'), failedWorker).captureProtocolSourceDelivery(cargoB, failedWorker.ch);
    let requestedExit;
    process.exit = code => {requestedExit = code;};
    void failedWorker.consumerQueue.push(cargoA).catch(() => {}); void failedWorker.consumerQueue.push(cargoB).catch(() => {});
    const restartDeadline = Date.now() + 3000;
    while (requestedExit === undefined) {assert(Date.now() < restartDeadline); await new Promise(r => setTimeout(r, 5));}
    process.exit = originalExit;
    assert.equal(requestedExit, 1); assert.equal(failedWorker.ch_ready, false);
    assert.equal(failedWorker.consumerQueue.length(), 0); assert.deepEqual(settlements, []);
    clearFaults(); const replacement = await createWorker('replacement');
    const newA = {...cargoA, fields: {deliveryTag: 10001}}, newB = {...cargoB, fields: {deliveryTag: 10002}};
    (controlledAttemptLifecycle(replacement, 'deserializer'), replacement).captureProtocolSourceDelivery(newA, replacement.ch); (controlledAttemptLifecycle(replacement, 'deserializer'), replacement).captureProtocolSourceDelivery(newB, replacement.ch);
    await Promise.all([replacement.consumerQueue.push(newA), replacement.consumerQueue.push(newB)]);
    assert.deepEqual(settlements, ['replacement:10001', 'replacement:10002']);
    for (const message of [newA, newB]) assert.equal((await read(message)).record.observation.status, 'observed');
    console.log(JSON.stringify({passed: true, originalSourceBlocks: [33, 122, 397], journalBeforeAck: true, nativeActivation: false,
        extractionIsolation: true, crashes: 5, partialCopyRetry: true, unknownOutcomeRetry: true, originalChannelFence: true,
        cargoRestart: true, transport: 'in-memory', fullWorkerQualification: false}));
} finally {
    for (const worker of workers) {worker.shipSession?.close?.(); worker.profiler?.stopReporting();}
    process.send = originalSend; process.exit = originalExit;
    if (originalRole === undefined) delete process.env.worker_role; else process.env.worker_role = originalRole;
    process.chdir(previous); assert.equal(dirname(directory), tmpdir()); rmSync(directory, {recursive: true, force: true});
}
