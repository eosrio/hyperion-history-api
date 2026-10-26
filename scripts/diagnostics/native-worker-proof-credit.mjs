/** Diagnostic only: a genuine pending DS message expires under a healthy advancing canonical source.
 * Actual emitted workers and installed native provider; controlled broker/ES transports, no services.
 * Default exits RED when pending valid native output becomes incomplete. --observe-expiry records the symptom.
 * This is an engineering admission seam, not public/default activation or live runtime qualification. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {frontierMemoryClient} from '../../tests/unit/protocol-frontier-memory.mjs';

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-native-worker-credit-'));
const chain = 'native-worker-credit', chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', blockId = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const events = [], sourceFrames = [], blockWrites = [], cache = [], shipRequests = [], monitorSignals = [];
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
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options)});
        if (this.held) {this.entered?.(); this.held.then(() => confirm());}
        else queueMicrotask(() => confirm()); return true;
    }
}
function message(sent) {return {content: Buffer.from(sent.payload), properties: {headers: structuredClone(sent.options.headers)}, fields: {deliveryTag: 1}};}
async function ticks() {for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));}
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
    const originalProfileId = manifest.profileId;
    assert.equal(originalProfileId, 'wire-sysio-6508c9e8-engineering-v1');
    const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
    const fixture = {profileId, handshake: JSON.parse(schemaJson), frameHex: readFileSync(join(sourceDir, 'block-000033.bin')).toString('hex')};
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000, es_replicas: 0,
        protocol_abi_coordination: {recovery_window_blocks: 256}},
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: false, disable_indexing: false, live_reader: true},
        features: {contract_console: false, failed_trx: false, streaming: {traces: true, deltas: false}},
        scaling: {ds_pool_size: 1, ds_queues: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 1,
            max_queue_limit: 64, block_queue_limit: 64, resume_trigger: 8, max_autoscale: 0},
        whitelists: {root_only: false, actions: [], deltas: []}, blacklists: {actions: [], deltas: []},
        api: {tx_cache_mode: 'batch', disable_tx_cache: false}, plugins: {}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.live_mode = 'true'; process.env.worker_role = 'continuous_reader';
    const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader}, {loadChainProtocol},
        {ProtocolAbiCoordinator}, {ProtocolAbiCoordinatorRpc}, {ProtocolSourceBindingStore, protocolSourceSelectionHeader},
        {ProtocolAbiObservationStore}, {ProtocolAbiFrontierStore}, {ActionSourceAdmissionStore, actionSourceIngressHeader, actionSourceAdmissionHeader},
        {deriveActionSourceInventory}, {actionHistoryImmutableJson, fingerprintActionHistoryEffect}, {currentActionPolicy}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
        import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/protocol/abi-coordinator.js'), import('../../build/indexer/protocol/abi-coordinator-rpc.js'),
        import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/history/action-source-inventory.js'), import('../../build/indexer/history/action-history-manifest.js'),
        import('../../build/indexer/history/action-producer-epoch.js')]);
    const [{HyperionMaster}, {HyperionQueueMonitor}] = await Promise.all([
        import('../../build/indexer/modules/master.js'), import('../../build/indexer/modules/queueMonitor.js')]);
    const installed = await loadChainProtocol(config.settings.protocol);
    assert.ok(installed.provider.nativeActions, 'installed native profile must expose its own native capability');
    assert(installed.components.every(component => component.sourceRevision === '7167659e9c043cb3351074fcacb40200cc57f3a3'));
    const descriptor = JSON.parse(readFileSync(join(wireRoot, 'dist/protocol-provider.json')));
    for (const id of ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1']) {
        const profile = descriptor.profiles.find(profile => profile.id === id); assert(profile);
        assert.equal(Object.hasOwn(profile, 'nativeActions'), false);
    }
    const selected = installed; // No provider injection, native decision substitution, or manufactured observations.
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const codec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(profileId));
    const originalCodec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(fixture.profileId));
    const template = originalCodec.decode('result', Buffer.from(fixture.frameHex, 'hex'));
    const originalTrace = originalCodec.decode('transaction_trace[]', Buffer.from(template[1].traces, 'hex'))[0][1];
    const originalBlock = originalCodec.decode('signed_block', Buffer.from(template[1].block, 'hex'));
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
    Object.assign(reader, {baseRequest: {}, shipRev: 0, socketGeneration: 1, activeIngressGeneration: 1, physicalIngressGeneration: 1, allowRequests: true,
        isLiveReader: true, local_block_num: 0, local_lib: 0, receivedFirstBlock: true,
        reversibleBlockMap: new Map(), forkedBlocks: new Map(), publications: new Map(),
        protocolSourceBindingStore: bindings, ship: {send(bytes) {shipRequests.push(codec.decode('request', bytes));}}, handleStatusResult() {}});
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
    // Same 64-message queue budgets as the owned full-worker qualifier; management totals are controlled.
    const bulkReader = Object.assign(Object.create(Reader.prototype), {allowRequests: true});
    const master = Object.assign(Object.create(HyperionMaster.prototype), {chain, conf: config,
        workerMap: [{worker_role: 'reader', wref: {send(value) {monitorSignals.push({role: 'reader', value}); bulkReader.onIpcMessage(value);}}},
            {worker_role: 'continuous_reader', wref: {send(value) {monitorSignals.push({role: 'continuous_reader', value}); reader.onIpcMessage(value);}}},
            {worker_role: 'ds_pool_worker', local_id: 1}],
        manager: {async checkQueueSize(queue) {assert.equal(queue, chain + ':ds_pool:1'); return mainPublisher.sent.length - poolConsumer.acked.length;}}});
    const monitor = new HyperionQueueMonitor(master);
    let firstMonitorPause;
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
        const creditsBefore = shipRequests.length;
        assert.equal(await reader.processIncomingBlocks([{kind: 'frame', generation: 1, data: bytes}]), true); await ticks();
        assert.equal(shipRequests.length, creditsBefore + 1);
        assert.deepEqual(shipRequests.at(-1), ['get_blocks_ack_request_v0', {num_messages: 1}]);
        assert.equal(readerPublisher.sent.length, before + 1);
        const raw = readerPublisher.sent.at(-1), delivery = message(raw);
        assert.equal(raw.options.mandatory, true); assert.equal(raw.options.persistent, true);
        assert.ok(raw.payload.equals(bytes)); assert.ok(raw.options.headers[actionSourceIngressHeader]);
        const retainedIngress = await admissionStore.resolveIngress(raw.options.headers[actionSourceIngressHeader]);
        assert.equal(retainedIngress.frameHex, bytes.toString('hex'));
        main.captureActionAdmissionDelivery(delivery, mainConsumer); main.captureProtocolSourceDelivery(delivery, mainConsumer);
        await parser.parseMessage(main, [delivery]); await draining;
        assert.equal(mainConsumer.acked.at(-1), delivery);
        await monitor.checkQueues({}, 1000000);
        if (monitorSignals.length && !firstMonitorPause) firstMonitorPause = {head: numberFrom(bytes), queuedMessages: mainPublisher.sent.length - poolConsumer.acked.length,
            deliveredToRoles: monitorSignals.map(value => value.role), bulkAllowsRequests: bulkReader.allowRequests, liveAllowsRequests: reader.allowRequests};
        const messages = mainPublisher.sent.slice(mainBefore).map(sent => {
            const delivery = message(sent); pool.captureActionAdmissionDelivery(delivery, poolConsumer);
            pool.captureProtocolActionDelivery(delivery, poolConsumer); return delivery;
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
    const started = performance.now();
    let held, genesis, boundary, issuedAbiView, issuedNativeView;
    for (let number = 1; number <= 290; number++) {
        const bytes = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin'));
        assert.equal(bytes.length, frameIndex.get(number).bytes); assert.equal(hash(bytes), frameIndex.get(number).sha256);
        const prepared = await prepare(bytes);
        if (number > 1 && number < 33) await pool.processMessages(prepared.messages);
        if (number === 1) genesis = {planId: prepared.admission.planId, incomplete: prepared.admission.incomplete, dsMessages: prepared.messages.length};
        if (number === 33) {
            held = prepared;
            assert.equal(held.messages.length, 1, 'original block 33 must yield its genuine native transaction');
            assert.equal(poolConsumer.acked.includes(held.messages[0]), false, 'held DS work must remain unacknowledged');
            assert.deepEqual(bytes, readFileSync(join(originalDir, 'block-000033.bin')));
        }
        if (number === 289) {
            const position = held.admission.source.inventoryInput.source;
            const view = await pool.getProtocolProofReader().open(position, held.sourceSelectionId);
            const native = await pool.getProtocolNativeReader().open(position, held.sourceSelectionId);
            assert.equal(view.source.blockNum, 33);
            const input = held.admission.source.inventoryInput.wireActionInputs.find(value => value.account === 'sysio' && value.name === 'onblock');
            assert.ok(input); const authorization = await pool.getProtocolNativeReader().authorize(native, input);
            assert.equal(authorization.kind, 'native');
            assert.deepEqual(await pool.getProtocolNativeReader().decodeValue(authorization.grant), expected.get(33).expectedValue);
            issuedAbiView = view; issuedNativeView = native;
            boundary = {head: number, source: 33, distance: number - 33, abiOpen: true, nativeOpen: true};
        }
    }
    const source = held.admission.source.inventoryInput.source;
    let expired;
    try {await pool.getProtocolProofReader().open(source, held.sourceSelectionId);}
    catch (error) {expired = {code: error.code, message: error.message, statusCode: error.statusCode};}
    assert.deepEqual(expired, {code: 'ancestry_unavailable', message: 'Requested ABI source is outside verified ancestry', statusCode: 503});
    // Existing issued capabilities remain current under monotone advancement; fresh opens enforce the bound.
    // Measure this existing distinction only. Do not substitute these views into the DS processing path.
    await pool.getProtocolProofReader().revalidate(issuedAbiView);
    await pool.getProtocolNativeReader().revalidate(issuedNativeView);
    await assert.rejects(pool.getProtocolProofReader().asReadOnly().revalidate(issuedAbiView), {code: 'invalid_proof'});
    await assert.rejects(pool.getProtocolNativeReader().revalidate(structuredClone(issuedNativeView)), {code: 'native_invalid_view'});
    const canceled = new AbortController(); canceled.abort();
    await assert.rejects(pool.getProtocolProofReader().revalidate(issuedAbiView, {signal: canceled.signal}), {code: 'proof_cancelled'});
    let durableIncompleteBeforeAck = false;
    poolConsumer.onAck = () => {
        const notes = ids(memory, 'h45actionincomplete1:').map(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson));
        durableIncompleteBeforeAck = notes.some(note => note.admissionId === held.admission.id && note.traceOrdinal === 0);
    };
    const beforePublications = poolPublisher.sent.length, beforeAck = poolConsumer.acked.length;
    const dispatchSha256 = hash(held.messages[0].content);
    const processStarted = performance.now();
    await pool.processMessages(held.messages);
    const processMilliseconds = performance.now() - processStarted;
    assert.equal(hash(held.messages[0].content), dispatchSha256, 'queued original dispatch changed');
    assert.equal(poolConsumer.acked.length, beforeAck + 1, 'actual incomplete path must retain its durable-before-ACK behavior');
    const sourceAck = mainConsumer.acked.find(message => message.properties.headers[protocolSourceSelectionHeader] === held.sourceSelectionId);
    assert.ok(sourceAck, 'producer source ACK must already have happened before held DS work');
    const raw = poolPublisher.sent.slice(beforePublications).map(entry => JSON.parse(entry.payload));
    const errors = events.filter(event => event.event === 'ds_error' && event.data?.type === 'protocol_action_incomplete').map(event => event.data);
    if (process.argv.includes('--observe-expiry')) {
        assert.equal(raw.length, 0, 'incomplete original Wire membership must not publish a falsely complete fragment');
        assert.equal(errors.length, 1); assert.equal(errors[0].blockNum, 33); assert.equal(errors[0].message, expired.message);
        assert.equal(durableIncompleteBeforeAck, true);
    }
    let sealedManifest, sealError;
    try {sealedManifest = await admissionStore.journal.readManifest(held.admission.planId);}
    catch (error) {sealError = {code: error.code, message: error.message};}
    const incompleteNotes = ids(memory, 'h45actionincomplete1:');
    if (process.argv.includes('--observe-expiry')) assert.ok(incompleteNotes.length >= 1);
    // Existing opaque capabilities are still revoked by a source-generation change; no view survives a fork/restart fence.
    await coordinator.revokeSource(reader.sourceContext.readerSessionId);
    await assert.rejects(pool.getProtocolProofReader().revalidate(issuedAbiView), {code: 'authority_unavailable'});
    await assert.rejects(pool.getProtocolNativeReader().revalidate(issuedNativeView), {code: 'authority_unavailable'});
    const result = {diagnostic: 'pending-native-worker-proof-expiry', sourceArchiveSha256: extracted.archiveSha256,
        originalProfileId, installedProfileId: profileId, sourceDerivedMembership: true, providerInjected: false,
        publicAdmissionEnabled: false, engineeringAdmissionFixture: true, controlledBrokerStorage: true,
        liveQualification: false, originalInput: {source, selectionId: held.sourceSelectionId, admissionId: held.admission.id,
            planId: held.admission.planId, dispatchSha256}, boundary,
        expiry: {head: 290, distance: 257, error: expired, earlierIssuedAbiRevalidated: true, earlierIssuedNativeRevalidated: true,
            transferredViewRejected: true, serializedNativeViewRejected: true, canceledRevalidationRejected: true, revokedViewsRejected: true},
        genuineGenesis: genesis,
        readerCredit: {firstMonitorPause, shipAckRequests: shipRequests.filter(value => value[0] === 'get_blocks_ack_request_v0').length,
            bulkAllowsRequests: bulkReader.allowRequests, liveAllowsRequests: reader.allowRequests,
            configuredMaxMessages: config.scaling.max_queue_limit, configuredResumeMessages: config.scaling.resume_trigger,
            fakeManagementTotals: true, actualMonitorAndRoleDispatch: true, actualOrderedIngressAndShipEncoding: true},
        actualDs: {acknowledged: poolConsumer.acked.length - beforeAck, publications: raw.length,
            error: errors[0],
            sourceAckBeforeDs: Boolean(sourceAck), sealed: Boolean(sealedManifest), sealError,
            incompleteNotes, durableIncompleteBeforeAck, processMilliseconds},
        sourceAcks: mainConsumer.acked.length, publishedDsMessages: mainPublisher.sent.length,
        pendingDsMessages: mainPublisher.sent.length - poolConsumer.acked.length,
        earlierDsAcknowledged: beforeAck, oldestUnresolvedBlock: 33,
        elapsedMilliseconds: performance.now() - started, nativeAddonResolutions};
    console.log(JSON.stringify(result));
    assert.equal(nativeAddonResolutions, 0);
    if (!process.argv.includes('--observe-expiry')) {
        assert.ok(sealedManifest, 'valid pending block-33 DS input lost canonical proof coverage at source head 290; it must remain processable and seal');
        assert.equal(raw.length, 1, 'valid pending native input must produce its original complete output');
        assert.equal(raw[0].ds_error, undefined); assert.equal(raw[0].protocol.schemaVersion, 2);
        assert.deepEqual(raw[0].act.data, expected.get(33).expectedValue);
    }
} finally {
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-native-worker-credit-/); rmSync(ownedDirectory, {recursive: true, force: true});
}
