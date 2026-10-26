import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';
/** Original Wire frames through emitted reader/MainDS/DS/admission and the normal installed native provider.
 * Public admission remains disabled. This fixture explicitly enables its existing engineering seam;
 * broker confirms, cache and ES transports are controlled. No live-service or consensus qualification. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-handoff-worker-original-'));
const chain = 'handoff-worker-original', chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', blockId = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const events = [], sourceFrames = [], blockWrites = [], cache = [];
let reader, coordinator, draining = Promise.resolve();
process.send = (event, callback) => {
    events.push(event);
    if (event.event === 'protocol_abi_prepared') draining = coordinator.drain();
    callback?.(null); return true;
};
class ControlledConsumer extends EventEmitter {
    acked = [];
    streamed = [];
    onAck;
    ack(message) {this.onAck?.(message); this.acked.push(message);}
    publish(_exchange, queue, payload, options) {this.streamed.push({queue, payload: Buffer.from(payload), options: structuredClone(options)}); return true;}
}
class ControlledPublisher extends EventEmitter {
    sent = [];
    held;
    entered;
    automatic = true;
    writable = true;
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options), confirm});
        if (!this.automatic) return this.writable;
        if (this.held) {this.entered?.(); this.held.then(() => confirm());}
        else queueMicrotask(() => confirm()); return this.writable;
    }
}
function message(sent) {return {content: Buffer.from(sent.payload), properties: {headers: structuredClone(sent.options.headers)}, fields: {deliveryTag: 1}};}
async function ticks() {for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));}
function gate() {let release; const held = new Promise(resolve => {release = resolve;}); return {held, release};}
async function until(test, label) {const deadline = Date.now() + 5000; while (!test()) {assert(Date.now() < deadline, label); await ticks();}}
function ids(memory, prefix) {
    return [...memory.documents.values()].map(value => value.document)
        .filter(value => value.kind === 'manifest' && value.bundle_id.startsWith(prefix)).map(value => value.bundle_id);
}
function retained(memory, index, id) {
    const manifest = memory.documents.get(memory.key(index, id)).document;
    return JSON.parse(Buffer.concat(manifest.chunk_ids.map(chunk =>
        Buffer.from(memory.documents.get(memory.key(index, chunk)).document.payload, 'base64'))).toString());
}
try {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const sourceFixture = join(repo, 'tests/fixtures/portable-state-worker');
    assert.equal(hash(readFileSync(join(sourceFixture, 'source-1-1480-20261020.tar.gz'))), '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const extraction = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [join(sourceFixture, 'prepare.py'), join(directory, 'capture')],
        {encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024});
    assert.equal(extraction.status, 0, extraction.stderr);
    const extracted = JSON.parse(extraction.stdout);
    assert.equal(extracted.files, 1488); assert.equal(extracted.bytes, 27982958); assert.equal(extracted.selectedBlocks, 1480);
    assert.equal(hash(readFileSync(extracted.plan)), extracted.planSha256);
    assert.equal(extracted.archiveSha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const sourceDir = join(directory, 'capture/source'), schemaJson = readFileSync(join(sourceDir, 'schema.json'), 'utf8');
    assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    const receipt = JSON.parse(readFileSync(join(sourceDir, 'receipt.json'))), frameIndex = new Map(receipt.frames.map(row => [row.blockNum, row]));
    assert.equal(receipt.chainId, chainId); assert.equal(receipt.complete, true);
    const wireRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
    const originalDir = join(wireRoot, 'fixtures/codec/native-onblock-6508-20261022');
    const manifest = JSON.parse(readFileSync(join(originalDir, 'manifest.json')));
    for (const member of manifest.members) {const bytes = readFileSync(join(originalDir, member.path)); assert.equal(bytes.length, member.bytes); assert.equal(hash(bytes), member.sha256);}
    const expected = new Map(JSON.parse(readFileSync(join(originalDir, 'expected.json'))).map(row => [row.blockNum, row]));
    const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
    const fixture = {profileId, handshake: JSON.parse(schemaJson), frameHex: readFileSync(join(sourceDir, 'block-000033.bin')).toString('hex')};
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000, es_replicas: 0,
        protocol_abi_coordination: {recovery_window_blocks: 256}},
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: false, disable_indexing: false, live_reader: true},
        features: {contract_console: false, failed_trx: false, streaming: {traces: true, deltas: false}},
        scaling: {ds_pool_size: 1, ds_queues: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 2},
        whitelists: {root_only: false, actions: [], deltas: []}, blacklists: {actions: [], deltas: []},
        api: {tx_cache_mode: 'batch', disable_tx_cache: false}, plugins: {}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.live_mode = 'true'; process.env.worker_role = 'continuous_reader';
    const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader}, {loadChainProtocol},
        {ProtocolAbiCoordinator}, {ProtocolAbiCoordinatorRpc}, {ProtocolSourceBindingStore, protocolSourceSelectionHeader},
        {ProtocolAbiObservationStore}, {ProtocolAbiFrontierStore}, {ActionSourceAdmissionStore, actionSourceIngressHeader, actionSourceAdmissionHeader},
        {deriveActionSourceInventory, ActionSourceInventoryError}, {actionHistoryImmutableJson, fingerprintActionHistoryEffect}, {currentActionPolicy, currentActionConfiguration},
        {publishAdmittedActionWithEvidence}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
        import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/protocol/abi-coordinator.js'), import('../../build/indexer/protocol/abi-coordinator-rpc.js'),
        import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/history/action-source-inventory.js'), import('../../build/indexer/history/action-history-manifest.js'),
        import('../../build/indexer/history/action-producer-epoch.js'), import('../../build/indexer/history/action-confirmed-publication.js')]);
    const installed = await loadChainProtocol(config.settings.protocol);
    assert.ok(installed.provider.nativeActions, 'select the installed native provider normally');
    assert(installed.components.every(component => component.sourceRevision === '7167659e9c043cb3351074fcacb40200cc57f3a3'));
    const selected = installed;
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const codec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(profileId));
    const template = codec.decode('result', Buffer.from(fixture.frameHex, 'hex'));
    const memory = frontierMemoryClient(), bindings = new ProtocolSourceBindingStore(memory.client, chain);
    const observations = new ProtocolAbiObservationStore(memory.client, chain), frontier = new ProtocolAbiFrontierStore(memory.client, chain);
    const admissionStore = new ActionSourceAdmissionStore(memory.client, chain), targetName = `${chain}-action-v1-000001`;
    memory.settings.set(targetName, {'index.uuid': 'owned-wire-admission-target'});
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const cm = {config, filters}, parser = new Parser(cm), loader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(loader, {handledActions: new Map(), handledDeltas: new Map(), parser, plugins: []});
    const readerConsumer = new ControlledConsumer(), mainConsumer = new ControlledConsumer(), poolConsumer = new ControlledConsumer();
    const readerPublisher = new ControlledPublisher(), mainPublisher = new ControlledPublisher(), poolPublisher = new ControlledPublisher();
    const worker = (prototype, consumer, publisher) => {
        const value = Object.create(prototype);
        if (prototype === Main.prototype || prototype === Pool.prototype)
            controlledAttemptLifecycle(value, prototype === Pool.prototype ? 'ds_pool_worker' : 'deserializer');
        Object.assign(value, {chain, chainId, conf: config, configModule: cm, filters, mLoader: loader,
            protocol: selected.provider, protocolId: selected.id, protocolComponents: selected.components,
            protocolReady: Promise.resolve(), abieos: selected.decoder, client: memory.client,
            ch: consumer, cch: publisher, ch_ready: true, cch_ready: true, profiler: {start: () => () => {}},
            actionAdmissionOwners: new WeakMap(), actionAdmissionStore: admissionStore});
        Object.defineProperty(value, 'actionSourceAdmissionEnabled', {value: true});
        return value;
    };
    reader = worker(Reader.prototype, readerConsumer, readerPublisher);
    const main = worker(Main.prototype, mainConsumer, mainPublisher), pool = worker(Pool.prototype, poolConsumer, poolPublisher);
    Object.assign(reader, {baseRequest: {}, shipRev: 0, socketGeneration: 0, activeIngressGeneration: 0,
        isLiveReader: true, local_block_num: 0, local_lib: 0, receivedFirstBlock: true,
        reversibleBlockMap: new Map(), forkedBlocks: new Map(), publications: new Map(),
        protocolSourceBindingStore: bindings, send() {}, handleStatusResult() {}});
    reader.stageOneDistQueue = {push: async payload => {
        sourceFrames.push(payload); return new Promise(resolve => reader.distribute([payload], resolve));
    }};
    Object.assign(main, {local_block_count: 0, lastSelectedWorker: 0, dsPoolMap: {}, ds_pool_counters: {}, block_emit_idx: 1,
        protocolDeliveryOwners: new WeakMap(), protocolSourceBindingStore: bindings, protocolAbiObservationStore: observations,
        preIndexingQueue: {push: async payload => blockWrites.push(payload)}});
    Object.assign(pool, {protocolDeliveryOwners: new WeakMap(), poolAbiCache: new Map(), poolTypeCache: new Map(),
        protocolCacheViews: new Set(), temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, txCacheExpiration: 3600,
        allowStreaming: true, common: {attachActionExtras: Pool.prototype.attachActionExtras},
        pushToActionsQueue() {assert.fail('Wire admitted output bypassed its confirmed publisher');},
        ioRedisClient: {pipeline() {
            const writes = [];
            return {hset(key, values) {writes.push({key, values: new Map([...values].map(([key, value]) => [key, Buffer.from(value)]))}); return this;},
                expire() {return this;}, async exec() {cache.push(...writes); return [];}};
        }}});
    const profile = {id: selected.id, profileId, components: selected.components};
    coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'native-worker-original-owner', bindings, observations, store: frontier,
        verifyNativeGenesis: selected.provider.verifyNativeGenesis.bind(selected.provider), nativeActionInterfaceVersion: 1});
    await coordinator.start();
    reader.coordinatorRpc = new ProtocolAbiCoordinatorRpc((request, callback) => {
        const input = request.data;
        void (input.operation === 'open' ? coordinator.openSource(input.contextId, input.readerSessionId) : coordinator.admit(input.selectionId, input.generation))
            .then(result => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: true, result}}))
            .catch(error => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId,
                data: {ok: false, error: {code: 'controlled_coordinator', message: error.message}}}));
        callback(null);
    });
    await reader.onMessage(Buffer.from(schemaJson));
    await reader.onMessage(Buffer.from(codec.encode('result', ['get_status_result_v0', {head: template[1].head,
        last_irreversible: {block_num: 0, block_id: blockId(0)}, trace_begin_block: 1, trace_end_block: 2401,
        chain_state_begin_block: 1, chain_state_end_block: 2401, chain_id: chainId}])));
    const prepare = async bytes => {
        const before = readerPublisher.sent.length, mainBefore = mainPublisher.sent.length;
        assert.equal(await reader.onMessage(bytes), 'block'); await ticks();
        assert.equal(readerPublisher.sent.length, before + 1);
        const raw = readerPublisher.sent.at(-1), delivery = message(raw);
        assert.equal(raw.options.mandatory, true); assert.equal(raw.options.persistent, true);
        assert.ok(raw.payload.equals(bytes)); assert.ok(raw.options.headers[actionSourceIngressHeader]);
        const retainedIngress = await admissionStore.resolveIngress(raw.options.headers[actionSourceIngressHeader]);
        assert.equal(retainedIngress.frameHex, bytes.toString('hex'));
        (controlledAttemptLifecycle(main, 'deserializer'), main).captureActionAdmissionDelivery(delivery, mainConsumer); (controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(delivery, mainConsumer);
        await parser.parseMessage(main, [delivery]); await draining;
        assert.equal(mainConsumer.acked.at(-1), delivery);
        const messages = mainPublisher.sent.slice(mainBefore).map(sent => {
            const delivery = message(sent); (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureActionAdmissionDelivery(delivery, poolConsumer);
            (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureProtocolActionDelivery(delivery, poolConsumer); return delivery;
        });
        const admissionId = messages[0]?.properties.headers[actionSourceAdmissionHeader];
        // Empty-block links contain no source body; resolve the bounded set by actual retained source association.
        let admission;
        for (const id of admissionId ? [admissionId] : ids(memory, 'h45actionadmission1:')) {
            const value = await admissionStore.resolve(id);
            if (value.source.inventoryInput.source.blockNum === numberFrom(bytes)) {admission = value; break;}
        }
        assert.ok(admission, 'source admission is discoverable after prepare');
        const sourceSelectionId = raw.options.headers[protocolSourceSelectionHeader];
        const link = await bindings.readObservationLink(sourceSelectionId), observation = await observations.read(link.observationId);
        assert.equal(observation.observation.status, numberFrom(bytes) === 1 ? 'native-genesis' : 'observed', JSON.stringify(observation.observation));
        if (numberFrom(bytes) === 1) {
            // Original genesis omits traces. Retain that missing-input boundary, never manufacture an empty vector.
            assert.ok(admission.incomplete); assert.equal(messages.length, 0);
            assert.equal(ids(memory, 'h45actionhandoff1:').length, 0, 'missing original genesis traces cannot be a successful handoff');
            await assert.rejects(pool.getProtocolNativeReader().waitForOpen({chainId, blockNum: 1,
                blockId: admission.source.inventoryInput.source.blockId}, sourceSelectionId), {code: 'native_source_incomplete'});
            return {admission, messages, sourceSelectionId};
        }
        const originalTraces = codec.decode('transaction_trace[]', Buffer.from(codec.decode('result', bytes)[1].traces, 'hex'));
        const expected = deriveActionSourceInventory({profileId, source: admission.source.inventoryInput.source,
            policy: currentActionPolicy(main), traces: originalTraces, wireActionInputs: observation.observation.facts.actionInputs, sourceSelectionId});
        assert.deepEqual(admission.inventory, expected);
        for (const delivery of messages) {
            const transaction = expected.transactions[delivery.properties.headers.action_trace_ordinal];
            assert.equal(delivery.content.toString(), transaction.dispatch.canonicalJson);
        }
        return {admission, messages, sourceSelectionId};
    };
    const numberFrom = bytes => Number(codec.decode('result', bytes)[1].this_block.block_num);
    let prepared;
    for (let number = 1; number <= 33; number++) {
        const bytes = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin'));
        assert.equal(bytes.length, frameIndex.get(number).bytes); assert.equal(hash(bytes), frameIndex.get(number).sha256);
        prepared = await prepare(bytes);
    }
    assert.equal(prepared.messages.length, 1);
    const before = poolPublisher.sent.length;
    poolConsumer.onAck = delivery => {
        assert.equal(delivery, prepared.messages[0]);
        const sent = poolPublisher.sent.at(-1), native = JSON.parse(sent.payload);
        assert.equal(native.protocol.schemaVersion, 2); assert.equal(native.protocol.kind, 'native');
        assert.equal(native.protocol.status, undefined); assert.equal(native.ds_error, undefined);
        assert.deepEqual(native.act.data, expected.get(33).expectedValue);
        assert.equal(native.protocol.input.rawHex, expected.get(33).rawHex);
        assert.equal(sent.payload.toString(), actionHistoryImmutableJson(native));
        assert.equal(sent.options.mandatory, true); assert.equal(sent.options.persistent, true);
        assert.equal(ids(memory, 'h45actionhandoff1:').length, 1,
            'Original DS input ACK requires its confirmed, durable source-work handoff outcome');
    };
    const ordering = [], writeGate = gate(); let writeEntered = false;
    poolPublisher.automatic = false; poolPublisher.writable = false;
    memory.faults.beforeWrite = async request => {
        if (request.document.kind === 'manifest' && request.document.bundle_id.startsWith('h45actionhandoff1:')) {
            ordering.push('outcome-write'); writeEntered = true; await writeGate.held;
        }
    };
    memory.faults.receipt = (result, request) => {
        if (request.document.kind === 'manifest' && request.document.bundle_id.startsWith('h45actionhandoff1:')) ordering.push('outcome-receipt');
        return result;
    };
    const originalOnAck = poolConsumer.onAck;
    poolConsumer.onAck = delivery => {ordering.push('source-ack'); originalOnAck(delivery);};
    const consuming = pool.processMessages(prepared.messages); consuming.catch(() => {});
    await until(() => poolPublisher.sent.length === before + 1, 'original native output reaches the actual publisher');
    assert.equal(writeEntered, false); assert.equal(poolConsumer.acked.length, 0);
    poolPublisher.sent.at(-1).confirm(null); ordering.push('confirm'); await ticks();
    assert.equal(writeEntered, false, 'confirm without required drain cannot produce a handoff');
    assert.equal(poolConsumer.acked.length, 0); assert.equal(ids(memory, 'h45actionhandoff1:').length, 0);
    poolPublisher.emit('drain'); ordering.push('drain');
    await until(() => writeEntered, 'confirmed and drained work attempts its real immutable manifest');
    assert.equal(poolConsumer.acked.length, 0, 'held outcome storage cannot ACK source work');
    assert.equal(ids(memory, 'h45actionhandoff1:').length, 0);
    writeGate.release(); await consuming;
    delete memory.faults.beforeWrite; delete memory.faults.receipt;
    assert.deepEqual(ordering, ['confirm', 'drain', 'outcome-write', 'outcome-receipt', 'source-ack']);
    assert.equal(poolConsumer.acked.at(-1), prepared.messages[0]);
    assert.equal(poolPublisher.sent.length, before + 1);
    const output = poolPublisher.sent.at(-1), document = JSON.parse(output.payload);
    assert.equal(output.options.mandatory, true); assert.equal(output.options.persistent, true);
    assert.deepEqual(document.act.data, expected.get(33).expectedValue);
    assert.equal(output.payload.toString(), actionHistoryImmutableJson(document));
    const native33 = prepared, nativeOutput = output;
    const observed = await admissionStore.readConfirmedHandoff(native33.admission.id, 0, native33.messages[0].content);
    assert.equal(observed.outcome.work.source.blockNum, 33);
    assert.equal(observed.outcome.work.sourceSelectionId, native33.sourceSelectionId);
    assert.equal(observed.outcome.effects[0].payloadSha256, hash(nativeOutput.payload));
    assert.equal(observed.outcome.effects[0].headersSha256, hash(actionHistoryImmutableJson(nativeOutput.options.headers)));
    const configuration = currentActionConfiguration(pool), directOwner = pool.actionPublicationOwner(native33.messages[0]);
    poolPublisher.automatic = true; poolPublisher.writable = true;
    const issue = async (owner = directOwner, queue = `${chain}:index_actions:2`, payload = nativeOutput.payload, headers = nativeOutput.options.headers) =>
        publishAdmittedActionWithEvidence(owner, queue, Buffer.from(payload), {headers: structuredClone(headers)});
    const handoffInput = publications => ({admissionId: native33.admission.id, traceOrdinal: 0,
        dispatchPayload: native33.messages[0].content, configuration, owner: directOwner, publications});
    const originalMessageId = nativeOutput.options.messageId;
    const retryTicket = await issue(), retryMessageId = poolPublisher.sent.at(-1).options.messageId;
    const retried = await admissionStore.recordConfirmedHandoff(handoffInput([retryTicket]));
    assert.equal(retried.id, observed.id); assert.deepEqual(retried.outcome, observed.outcome);
    assert.notEqual(retryMessageId, originalMessageId); assert.notEqual(poolPublisher.sent.at(-1).queue, nativeOutput.queue);
    for (const forged of [{}, JSON.parse(JSON.stringify(retryTicket))])
        await assert.rejects(admissionStore.recordConfirmedHandoff(handoffInput([forged])), /Unissued/);
    const rawTicket = await issue(directOwner, `${chain}:ds_pool:1`, native33.messages[0].content, native33.messages[0].properties.headers);
    await assert.rejects(admissionStore.recordConfirmedHandoff(handoffInput([rawTicket])), /configured action routing/);
    for (const suffix of ['0', '01', '3', '4294967296']) {
        const ticket = await issue(directOwner, `${chain}:index_actions:${suffix}`);
        await assert.rejects(admissionStore.recordConfirmedHandoff(handoffInput([ticket])), /configured action routing/);
    }
    const wrongFragment = await issue(directOwner, undefined, undefined, {...nativeOutput.options.headers, action_fragment_id: 'h45actionfragment1:' + '0'.repeat(64)});
    await assert.rejects(admissionStore.recordConfirmedHandoff(handoffInput([wrongFragment])), /headers/);
    const changed = {...JSON.parse(nativeOutput.payload), constructed_control: 'changed-output-root'};
    const changedTicket = await issue(directOwner, undefined, Buffer.from(actionHistoryImmutableJson(changed)));
    await assert.rejects(admissionStore.recordConfirmedHandoff(handoffInput([changedTicket])), /conflict|different|mismatch/);
    assert.deepEqual((await admissionStore.readConfirmedHandoff(native33.admission.id, 0, native33.messages[0].content)).outcome, observed.outcome);
    const lifecycle = ['confirm-drain-write-ack', 'fresh-ticket-round-robin-retry', 'opaque-and-routing-negatives', 'changed-root-conflict'];
    const original = new Map([[33, native33]]);
    for (let number = 34; number <= 36; number++) {
        const bytes = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin'));
        assert.equal(hash(bytes), frameIndex.get(number).sha256); original.set(number, await prepare(bytes));
    }
    const contract = original.get(36), contractTransaction = contract.admission.inventory.transactions.find(value => value.traceOrdinal === 1);
    assert.equal(contractTransaction.transactionId, '140abb3d398f206518e117c02ccf1f1604b37b9fb55f7abed2034cf2fb374c66');
    assert.deepEqual(contractTransaction.groups.map(value => [value.metadata.act.account, value.metadata.act.name, value.metadata.global_sequence]),
        [['sysio', 'setcode', '45'], ['sysio', 'setabi', '46']]);
    const physical = (admissionId, traceOrdinal) => ids(memory, 'h45actionhandoff1:').map(id => {
        const envelope = retained(memory, admissionStore.index, id);
        return {id, outcome: JSON.parse(envelope.payloadJson)};
    }).filter(value => value.outcome.work.admissionId === admissionId && value.outcome.work.traceOrdinal === traceOrdinal);
    const run = (source, traceOrdinal = 0, onAck) => {
        const originalMessage = source.messages.find(value => value.properties.headers.action_trace_ordinal === traceOrdinal);
        assert.ok(originalMessage, 'an original dispatched transaction is required');
        const delivery = {content: Buffer.from(originalMessage.content), properties: structuredClone(originalMessage.properties), fields: {deliveryTag: 1}};
        const consumer = new ControlledConsumer(), publisher = new ControlledPublisher();
        pool.ch = consumer; pool.cch = publisher; pool.ch_ready = true; pool.cch_ready = true;
        (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureActionAdmissionDelivery(delivery, consumer); (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureProtocolActionDelivery(delivery, consumer);
        consumer.onAck = current => {assert.equal(current, delivery); onAck?.(current);};
        const pending = pool.processMessages([delivery]); pending.catch(() => {});
        return {delivery, consumer, publisher, pending};
    };
    const finalManifest = request => request.index === admissionStore.index && request.document.kind === 'manifest'
        && request.document.bundle_id.startsWith('h45actionhandoff1:');
    let partial = 0;
    memory.faults.receipt = (receipt, request) => {
        if (!finalManifest(request)) return receipt;
        partial++; return {...receipt, _shards: {...receipt._shards, successful: 0}};
    };
    const unknown = run(original.get(34)); await assert.rejects(unknown.pending, /acknowledg|shard|copies|durab/i);
    assert.equal(unknown.consumer.acked.length, 0); assert.equal(partial, 1);
    assert.equal(unknown.publisher.sent.length, 1); assert.equal(physical(original.get(34).admission.id, 0).length, 1);
    const seenUnknown = await admissionStore.readConfirmedHandoff(original.get(34).admission.id, 0, unknown.delivery.content);
    assert.equal(seenUnknown.id, physical(original.get(34).admission.id, 0)[0].id);
    delete memory.faults.receipt;
    let freshReceipts = 0;
    memory.faults.receipt = (receipt, request) => {if (finalManifest(request)) freshReceipts++; return receipt;};
    const repair = run(original.get(34)); await repair.pending;
    assert.equal(repair.consumer.acked.length, 1); assert.equal(freshReceipts, 1);
    assert.notEqual(repair.publisher.sent[0].options.messageId, unknown.publisher.sent[0].options.messageId);
    assert.notEqual(repair.publisher.sent[0].queue, unknown.publisher.sent[0].queue);
    assert.equal((await admissionStore.readConfirmedHandoff(original.get(34).admission.id, 0, repair.delivery.content)).id, seenUnknown.id);
    delete memory.faults.receipt; lifecycle.push('unknown-primary-visible-no-ack-fresh-repair');
    const incompleteBefore = ids(memory, 'h45actionincomplete1:').length;
    const injected = new ActionSourceInventoryError('constructed final outcome I/O failure');
    memory.faults.beforeWrite = async request => {if (finalManifest(request)) throw injected;};
    const failed = run(original.get(35)); await assert.rejects(failed.pending, error => error === injected);
    assert.equal(failed.consumer.acked.length, 0); assert.equal(physical(original.get(35).admission.id, 0).length, 0);
    assert.equal(ids(memory, 'h45actionincomplete1:').length, incompleteBefore, 'storage failure escapes contract-incomplete classification');
    delete memory.faults.beforeWrite;
    const unrelated = run(native33); await unrelated.pending; assert.equal(unrelated.consumer.acked.length, 1);
    lifecycle.push('final-io-error-bypasses-contract-catch-unrelated-progress');
    const partialRun = run(contract, 1); partialRun.publisher.automatic = false;
    await until(() => partialRun.publisher.sent.length === 1, 'first original contract effect reaches confirmation');
    partialRun.publisher.sent[0].confirm(null);
    await until(() => partialRun.publisher.sent.length === 2, 'second original contract effect reaches confirmation');
    assert.equal(partialRun.consumer.acked.length, 0); assert.equal(physical(contract.admission.id, 1).length, 0);
    for (const sent of partialRun.publisher.sent) {
        const value = JSON.parse(sent.payload); assert.equal(value.protocol.schemaVersion, 1);
        assert.equal(value.protocol.status, undefined); assert.equal(value.ds_error, undefined);
        assert.equal(sent.options.mandatory, true); assert.equal(sent.options.persistent, true);
    }
    assert.deepEqual(partialRun.publisher.sent.map(value => JSON.parse(value.payload).global_sequence), ['45', '46']);
    partialRun.publisher.sent[1].confirm(new Error('constructed second-confirm NACK'));
    await assert.rejects(partialRun.pending, /second-confirm NACK/);
    assert.equal(partialRun.consumer.acked.length, 0); assert.equal(physical(contract.admission.id, 1).length, 0);
    lifecycle.push('original-two-effect-partial-confirm-no-outcome');
    for (const mutation of ['consumer', 'publisher', 'configuration', 'target']) {
        const held = gate(); let entered = false;
        memory.faults.beforeWrite = async request => {if (finalManifest(request)) {entered = true; await held.held;}};
        const current = run(original.get(35));
        await until(() => entered, `outcome persistence reaches held ${mutation} boundary`);
        assert.equal(current.consumer.acked.length, 0);
        const previousConsole = config.features.contract_console, previousTarget = memory.settings.get(targetName)['index.uuid'];
        if (mutation === 'consumer') pool.ch = new ControlledConsumer();
        if (mutation === 'publisher') pool.cch = new ControlledPublisher();
        if (mutation === 'configuration') config.features.contract_console = !previousConsole;
        if (mutation === 'target') memory.settings.get(targetName)['index.uuid'] = 'constructed-replacement-target';
        held.release(); await assert.rejects(current.pending, /owner|channel|epoch|target/i);
        assert.equal(current.consumer.acked.length, 0);
        assert.equal(physical(original.get(35).admission.id, 0).length, 1,
            'a visible record does not bypass the final original authority fences');
        config.features.contract_console = previousConsole; memory.settings.get(targetName)['index.uuid'] = previousTarget;
        delete memory.faults.beforeWrite; lifecycle.push(`${mutation}-change-across-outcome-write-no-ack`);
    }
    const finalCheck = gate(); let written = false, targetChecks = 0, finalCheckEntered = false;
    memory.faults.receipt = (receipt, request) => {if (finalManifest(request)) written = true; return receipt;};
    memory.faults.settings = async (value, request) => {
        if (written && request.index === targetName && ++targetChecks === 2) {finalCheckEntered = true; await finalCheck.held;}
        return {[request.index]: {settings: value}};
    };
    const changedDuringFinalCheck = run(native33);
    await until(() => finalCheckEntered, 'last post-write target check awaits its actual index settings');
    config.features.contract_console = true; finalCheck.release();
    await assert.rejects(changedDuringFinalCheck.pending, /epoch/); assert.equal(changedDuringFinalCheck.consumer.acked.length, 0);
    config.features.contract_console = false; delete memory.faults.settings; delete memory.faults.receipt;
    lifecycle.push('configuration-change-during-last-target-check-no-ack');
    const directConsumer = new ControlledConsumer(), directPublisher = new ControlledPublisher();
    const originalPredicate = () => true, snapshotOwner = {consumer: directConsumer, publisher: directPublisher, current: originalPredicate};
    const directInput = tickets => ({admissionId: native33.admission.id, traceOrdinal: 0, dispatchPayload: native33.messages[0].content,
        configuration, owner: snapshotOwner, publications: tickets});
    directPublisher.automatic = false;
    const callerPayload = Buffer.from(nativeOutput.payload), callerHeaders = structuredClone(nativeOutput.options.headers);
    const callerOptions = {headers: callerHeaders, persistent: false, mandatory: false, messageId: 'constructed-caller-id'};
    const snapshotPending = publishAdmittedActionWithEvidence(snapshotOwner, `${chain}:index_actions:2`, callerPayload, callerOptions);
    callerPayload.fill(0); callerHeaders.block_num = 999; callerOptions.headers = {block_num: 999}; callerOptions.messageId = 'changed-caller-id';
    const actualSent = directPublisher.sent.at(-1); actualSent.confirm(null); const snapshotTicket = await snapshotPending;
    const snapshotRecord = await admissionStore.recordConfirmedHandoff(directInput([snapshotTicket]));
    assert.equal(snapshotRecord.id, observed.id); assert.deepEqual(snapshotRecord.outcome, observed.outcome);
    assert.equal(snapshotRecord.outcome.effects[0].payloadSha256, hash(actualSent.payload));
    assert.equal(snapshotRecord.outcome.effects[0].headersSha256, hash(actionHistoryImmutableJson(actualSent.options.headers)));
    directPublisher.automatic = true; lifecycle.push('original-caller-mutation-retains-sent-outcome-hashes');
    let payloadInspected = false;
    const overCount = {...directInput([]), publications: new Array(100001)};
    Object.defineProperty(overCount, 'dispatchPayload', {get() {payloadInspected = true; throw new Error('dispatch copied before vector admission');}});
    await assert.rejects(admissionStore.recordConfirmedHandoff(overCount), /vector/); assert.equal(payloadInspected, false);
    const maximum = 128 * 1024 * 1024, each = actualSent.payload.length + Buffer.byteLength(actionHistoryImmutableJson(actualSent.options.headers));
    const repeatedCount = Math.floor(maximum / each) + 1; assert(repeatedCount <= 100000);
    const overBytes = {...directInput([]), publications: Array(repeatedCount).fill(snapshotTicket)};
    Object.defineProperty(overBytes, 'dispatchPayload', {get() {payloadInspected = true; throw new Error('dispatch copied before aggregate admission');}});
    await assert.rejects(admissionStore.recordConfirmedHandoff(overBytes), /aggregate/); assert.equal(payloadInspected, false);
    lifecycle.push('record-count-and-sum-before-copies');
    const canceledGate = gate(), controller = new AbortController(), canceled = new Error('constructed outcome cancellation'); let cancellationEntered = false;
    memory.faults.beforeWrite = async request => {if (finalManifest(request)) {cancellationEntered = true; await canceledGate.held;}};
    const canceledWrite = admissionStore.recordConfirmedHandoff(directInput([snapshotTicket]), controller.signal); canceledWrite.catch(() => {});
    await until(() => cancellationEntered, 'direct persistence cancellation awaits the real immutable write');
    controller.abort(canceled); canceledGate.release(); await assert.rejects(canceledWrite, error => error === canceled);
    delete memory.faults.beforeWrite; lifecycle.push('abort-across-outcome-write-rejects');
    const concurrentGate = gate(); let concurrentEntered = 0;
    const concurrencyFailure = new Error('constructed one-of-four storage failure');
    memory.faults.beforeWrite = async request => {
        if (!finalManifest(request)) return;
        const sequence = ++concurrentEntered; await concurrentGate.held;
        if (sequence === 1) throw concurrencyFailure;
    };
    const concurrentTickets = [];
    for (let index = 0; index < 5; index++) concurrentTickets.push(await publishAdmittedActionWithEvidence(snapshotOwner,
        `${chain}:index_actions:${index % 2 + 1}`, Buffer.from(nativeOutput.payload), {headers: structuredClone(nativeOutput.options.headers)}));
    const operations = concurrentTickets.slice(0, 4).map(ticket => admissionStore.recordConfirmedHandoff(directInput([ticket])));
    operations.forEach(pending => pending.catch(() => {}));
    await until(() => concurrentEntered === 4, 'four actual outcome operations hold their top-level leases');
    let fifthInspected = false; const fifth = {};
    Object.defineProperty(fifth, 'publications', {get() {fifthInspected = true; throw new Error('fifth request inspected before budget admission');}});
    await assert.rejects(admissionStore.recordConfirmedHandoff(fifth), /concurrent operation budget/); assert.equal(fifthInspected, false);
    concurrentGate.release(); const completed = await Promise.allSettled(operations);
    assert.equal(completed.filter(value => value.status === 'fulfilled').length, 3);
    assert.deepEqual(completed.filter(value => value.status === 'rejected').map(value => value.reason), [concurrencyFailure]);
    delete memory.faults.beforeWrite;
    assert.equal((await admissionStore.recordConfirmedHandoff(directInput([concurrentTickets[4]]))).id, observed.id);
    lifecycle.push('four-operation-leases-fifth-refusal-failure-release');
    const nextOriginal = async number => {
        const bytes = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin'));
        assert.equal(hash(bytes), frameIndex.get(number).sha256); return prepare(bytes);
    };
    config.indexer.disable_indexing = true;
    const disabled = await nextOriginal(37); assert.equal(disabled.messages.length, 1);
    const disabledRun = run(disabled); await disabledRun.pending;
    assert.equal(disabledRun.publisher.sent.length, 0); assert.equal(disabledRun.consumer.acked.length, 1);
    assert.equal(physical(disabled.admission.id, 0).length, 0);
    const disabledBytes = [...cache.at(-1).values.values()][0], disabledDocument = JSON.parse(disabledBytes);
    assert.equal(disabledDocument.block_num, 37); assert.equal(disabledDocument.protocol.status, undefined);
    const disabledPrepared = await admissionStore.prepareTransaction(disabled.admission, 0, disabled.messages[0].content, [disabledDocument]);
    const disabledOwner = pool.actionPublicationOwner(disabledRun.delivery);
    const disabledTicket = await publishAdmittedActionWithEvidence(disabledOwner, `${chain}:index_actions:1`, disabledBytes,
        {headers: {block_num: 37, [actionSourceAdmissionHeader]: disabled.admission.id, action_fragment_id: disabledPrepared.fragmentId}});
    await assert.rejects(admissionStore.recordConfirmedHandoff({admissionId: disabled.admission.id, traceOrdinal: 0,
        dispatchPayload: disabled.messages[0].content, configuration: currentActionConfiguration(pool), owner: disabledOwner,
        publications: [disabledTicket]}), /configuration\/routing authority/);
    assert.equal(physical(disabled.admission.id, 0).length, 0); config.indexer.disable_indexing = false;
    lifecycle.push('operator-disabled-indexing-no-success-outcome');
    filters.action_blacklist.add('sysio::*');
    const excluded = await nextOriginal(38); assert.equal(excluded.messages.length, 0);
    assert(excluded.admission.inventory.transactions.every(value => value.disposition === 'excluded' && value.groups.length === 0));
    assert.equal(physical(excluded.admission.id, 0).length, 0); filters.action_blacklist.clear();
    lifecycle.push('operator-excluded-original-work-no-success-outcome');
    // Constructed contract-hook failure, genuine original source and normal installed provider.
    loader.handledActions.set('*', new Map([['onblock', async () => {throw new Error('constructed contract-hook failure');}]]));
    const contractFailure = await nextOriginal(39);
    const incompleteRun = run(contractFailure); await incompleteRun.pending;
    assert.equal(incompleteRun.consumer.acked.length, 1); assert.equal(physical(contractFailure.admission.id, 0).length, 0);
    assert.equal(incompleteRun.publisher.sent.length, 1);
    const incompleteOutput = JSON.parse(incompleteRun.publisher.sent[0].payload);
    assert.equal(incompleteOutput.protocol.status, 'incomplete'); assert.equal(incompleteOutput.ds_error, true);
    assert.equal(incompleteOutput.protocol.error.code, 'native_output_incomplete');
    const incompleteOwner = pool.actionPublicationOwner(incompleteRun.delivery), incompleteSent = incompleteRun.publisher.sent[0];
    const incompleteTicket = await publishAdmittedActionWithEvidence(incompleteOwner, incompleteSent.queue,
        Buffer.from(incompleteSent.payload), {headers: structuredClone(incompleteSent.options.headers)});
    await assert.rejects(admissionStore.recordConfirmedHandoff({admissionId: contractFailure.admission.id, traceOrdinal: 0,
        dispatchPayload: contractFailure.messages[0].content, configuration: currentActionConfiguration(pool), owner: incompleteOwner,
        publications: [incompleteTicket]}), /Incomplete/);
    assert.equal(physical(contractFailure.admission.id, 0).length, 0); loader.handledActions.clear();
    const following = run(native33); await following.pending; assert.equal(following.consumer.acked.length, 1);
    lifecycle.push('constructed-contract-hook-incomplete-isolated-no-success-outcome');
    const revokeGate = gate(); let revocationEntered = false;
    memory.faults.beforeWrite = async request => {if (finalManifest(request)) {revocationEntered = true; await revokeGate.held;}};
    const revokedContract = run(contract, 1);
    await until(() => revocationEntered, 'original contract outcome write awaits while its proof authority is still live');
    assert.equal(pool.protocolTrace, undefined, 'processTraces already cleared its transient proof before the new await');
    assert.equal(pool.protocolDeliveryNativeEntries.size, 0, 'this original contract work has no native fallback proof fence');
    assert.deepEqual(revokedContract.publisher.sent.map(value => JSON.parse(value.payload).protocol.schemaVersion), [1, 1]);
    const retainedViews = pool.activeActionAdmission.handoff.entries.map(value => value.work.view);
    assert.equal(retainedViews.length, 2); assert(retainedViews.every(Boolean));
    for (const view of retainedViews) await pool.getProtocolProofReader().revalidate(view);
    assert.equal(await coordinator.revokeSource(reader.sourceContext.readerSessionId), true);
    revokeGate.release(); await assert.rejects(revokedContract.pending, error => error.statusCode === 503);
    assert.equal(revokedContract.consumer.acked.length, 0); assert.equal(physical(contract.admission.id, 1).length, 1);
    delete memory.faults.beforeWrite; lifecycle.push('original-contract-proof-revoked-across-outcome-write-no-ack');
    assert.equal(nativeAddonResolutions, 0);
    console.log(JSON.stringify({passed: true, originalBlocks: 39, lifecycleCases: lifecycle, normalInstalledNativeProvider: true,
        originalArchiveSha256: manifest.originalArchiveSha256, outcomeBeforeOriginalAck: true, confirmDrainWriteAckOrder: ordering,
        controlledBrokerStorage: true, fullWorkerQualification: false}));
} finally {
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-handoff-worker-original-/); rmSync(ownedDirectory, {recursive: true, force: true});
}
