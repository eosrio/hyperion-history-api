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
import {createHash, randomUUID} from 'node:crypto';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-worker-original-'));
const chain = 'handoff-worker-original', chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', blockId = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const mode = process.argv[2] ?? 'lifecycle';
const managedProofCase = /^managed-original-(main|handoff)-(held|failed|cancelled)-(proof|open)$/.exec(mode);
const proofControl = managedProofCase && process.env.HYPERION_QUALIFICATION_PLAIN_PROOF !== 'true'
    ? {kind: managedProofCase[2], phase: managedProofCase[3]} : undefined;
let proofAttemptId, proofFreshWrite;
const managedOriginalMainHeldWrite = mode === 'managed-original-main-held-write';
const managedOriginalMainFailedWrite = mode === 'managed-original-main-failed-write';
const managedOriginalMainAckThrows = mode === 'managed-original-main-ack-throws';
const managedOriginalMainHeldOperation = mode === 'managed-original-main-held-operation';
const managedOriginalMainHeldEnd = mode === 'managed-original-main-held-end';
const managedOriginalMainFailedEnd = mode === 'managed-original-main-failed-end';
const managedOriginalMain = mode === 'managed-original-main' || managedOriginalMainHeldWrite
    || managedOriginalMainFailedWrite || managedOriginalMainAckThrows || managedOriginalMainHeldOperation
    || managedOriginalMainHeldEnd || managedOriginalMainFailedEnd || managedProofCase?.[1] === 'main',
    managedOriginalNoEffect = mode === 'managed-original-ds',
    managedOriginalContract = mode === 'managed-original-contract',
    managedOriginalHandoffHeldConfirm = mode === 'managed-original-handoff-held-confirm',
    managedOriginalHandoffFailedConfirm = mode === 'managed-original-handoff-failed-confirm',
    managedOriginalHandoffHeldDrain = mode === 'managed-original-handoff-held-drain',
    managedOriginalHandoffFailedDrain = mode === 'managed-original-handoff-failed-drain',
    managedOriginalHandoff = mode === 'managed-original-handoff' || managedOriginalHandoffHeldConfirm
        || managedOriginalHandoffFailedConfirm || managedOriginalHandoffHeldDrain || managedOriginalHandoffFailedDrain
        || managedProofCase?.[1] === 'handoff';
const managedOriginalDs = managedOriginalNoEffect || managedOriginalContract || managedOriginalHandoff;
const managedOriginal = managedOriginalMain || managedOriginalDs;
const events = [], sourceFrames = [], blockWrites = [], cache = [];
let reader, coordinator, managedClient, snapshotPath, draining = Promise.resolve();
let finishManaged, releaseManagedWrite, releaseManagedConfirm, releaseManagedDrain, releaseManagedOperation;
let releaseManagedProof;
const managedProofReleased = new Promise(resolve => {releaseManagedProof = resolve;});
let startManagedPeer;
const managedPeerStarted = new Promise(resolve => {startManagedPeer = resolve;});
const awaitManagedPeerStart = async () => {
    if (!managedProofCase || process.env.HYPERION_QUALIFICATION_PLAIN_PROOF !== 'true') return;
    previousSend.call(process, {event: 'qualification_peer_ready'});
    await managedPeerStarted;
};
const managedFinished = new Promise(resolve => {finishManaged = resolve;});
const managedWriteReleased = new Promise(resolve => {releaseManagedWrite = resolve;});
const managedConfirmReleased = new Promise(resolve => {releaseManagedConfirm = resolve;});
const managedDrainReleased = new Promise(resolve => {releaseManagedDrain = resolve;});
const managedOperationReleased = new Promise(resolve => {releaseManagedOperation = resolve;});
const heldManagedEnds = [];
let managedEndReleased = false, managedEndSendFailures = 0;
if (managedOriginal) process.on('message', message => {
    if (message?.event === 'qualification_done') finishManaged();
    if (message?.event === 'qualification_release_write') releaseManagedWrite();
    if (message?.event === 'qualification_release_confirm') releaseManagedConfirm();
    if (message?.event === 'qualification_release_drain') releaseManagedDrain();
    if (message?.event === 'qualification_release_operation') releaseManagedOperation();
    if (message?.event === 'qualification_release_proof') releaseManagedProof();
    if (message?.event === 'qualification_start_peer') startManagedPeer();
    if (message?.event === 'qualification_release_end') {
        managedEndReleased = true;
        for (const {event, callback} of heldManagedEnds.splice(0)) previousSend.call(process, event, callback);
    }
});
process.send = (event, callback) => {
    if (managedOriginal && event?.event === 'worker_attempt_request') {
        if (proofControl && event.payload?.operation === 'register') proofAttemptId = event.payload.attemptId;
        if (proofControl && event.payload?.operation === 'observe') proofFreshWrite = event.payload.write;
        if (event.payload?.operation === 'end' && managedOriginalMainHeldEnd && !managedEndReleased) {
            assert(heldManagedEnds.length < 3, 'original end hold must retain only the bounded request attempts');
            heldManagedEnds.push({event, callback});
            previousSend.call(process, {event: 'qualification_end_held', request: event});
            return true;
        }
        if (event.payload?.operation === 'end' && managedOriginalMainFailedEnd) {
            managedEndSendFailures++;
            assert(managedEndSendFailures <= 3);
            previousSend.call(process, {event: 'qualification_end_send_failed', request: event});
            queueMicrotask(() => callback?.(new Error('constructed original end send failure')));
            return true;
        }
        return previousSend.call(process, event, callback);
    }
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
    confirmCalls = 0;
    held;
    entered;
    automatic = true;
    writable = true;
    confirmError;
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options), confirm});
        if (!this.automatic) return this.writable;
        const complete = () => {this.confirmCalls++; confirm(this.confirmError);};
        if (this.held) {this.entered?.(); this.held.then(complete);}
        else queueMicrotask(complete); return this.writable;
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
        {publishAdmittedActionWithEvidence}, {WorkerAttemptClient}] = await Promise.all([
        import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
        import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
        import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
        import('../../build/indexer/protocol/abi-coordinator.js'), import('../../build/indexer/protocol/abi-coordinator-rpc.js'),
        import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
        import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/history/action-source-admission.js'),
        import('../../build/indexer/history/action-source-inventory.js'), import('../../build/indexer/history/action-history-manifest.js'),
        import('../../build/indexer/history/action-producer-epoch.js'), import('../../build/indexer/history/action-confirmed-publication.js'),
        import('../../build/indexer/protocol/worker-attempt-client.js')]);
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
        if (prototype === Main.prototype && managedOriginalMain || prototype === Pool.prototype && managedOriginalDs) {
            managedClient = new WorkerAttemptClient({mode: 'managed',
                role: managedOriginalMain ? 'deserializer' : 'ds_pool_worker', transport: process,
                timeoutMs: 1000, drainTimeoutMs: 5000, retries: 2});
            value.configureWorkerAttemptLifecycle(managedClient);
        } else if (prototype === Main.prototype || prototype === Pool.prototype)
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
    let proofReadHeld = false, proofReadSettled = false, proofProbe, proofProbeKind;
    let storageReads = 0, storageWrites = 0, cacheDispatches = 0;
    const proofEffects = () => ({
        publisherDispatches: (managedOriginalMain ? mainPublisher : poolPublisher).sent.length,
        streamDispatches: (managedOriginalMain ? mainConsumer : poolConsumer).streamed.length,
        cacheDispatches, historyDispatches: blockWrites.length, storageReadDispatches: storageReads,
        storageWriteDispatches: storageWrites
    });
    const proofError = new Error('constructed required retained proof read failure');
    if (proofControl) {
        for (const method of ['create', 'index']) {
            const original = memory.client[method].bind(memory.client);
            memory.client[method] = (...args) => {storageWrites++; return original(...args);};
        }
        const originalGet = memory.client.get.bind(memory.client);
        memory.client.get = async (request, options) => {
            storageReads++;
            let scope;
            // Diagnostic lookup must not itself block a transport dispatch made by a fenced caller.
            try {scope = currentProofConsumerScope();} catch {}
            const selected = !proofReadHeld && scope?.id === proofAttemptId && options?.signal
                && request.index === frontier.controlIndex && request.id === 'control'
                && (proofControl.phase === 'open' ? !proofFreshWrite : !!proofFreshWrite);
            if (selected) proofReadHeld = true;
            // Hold the actual transport's returned original bytes. The controlled transport ignores abort.
            const value = await originalGet(request, options);
            if (!selected) return value;
            // The controlled coordinator is independent work; settle its hint before taking effect baselines.
            await draining;
            const consumer = managedOriginalMain ? mainConsumer : poolConsumer;
            if (proofControl.kind === 'cancelled' && proofControl.phase === 'proof') {
                const view = managedOriginalMain ? main.activeProtocolAbiProofView : pool.activeActionAdmission.nativeView;
                assert(view, 'late cancellation retains its actually issued proof view');
                const reader = managedOriginalMain ? main.getProtocolAbiProofReader() : pool.getProtocolNativeReader();
                proofProbeKind = managedOriginalMain ? 'issued-abi-view' : 'issued-native-view';
                proofProbe = () => reader.revalidate(view);
            }
            scope.signal.addEventListener('abort', () => {
                previousSend.call(process, {
                    event: 'qualification_proof_fenced', scope: scope.snapshot(), originalAckCount: consumer.acked.length,
                    readSettled: proofReadSettled, readSignalAborted: options.signal.aborted, effects: proofEffects()
                });
                if (proofControl.kind === 'cancelled') void (async () => {
                    let accepted = false, code, ownsFence = false;
                    try {await proofProbe(); accepted = true;}
                    catch (error) {code = error.code; ownsFence = scope.ownsFenceError(error);}
                    previousSend.call(process, {event: 'qualification_proof_probe', kind: proofProbeKind,
                        accepted, code, ownsFence, readSettled: proofReadSettled, effects: proofEffects()});
                })();
            }, {once: true});
            previousSend.call(process, {event: 'qualification_proof_held', request, scope: scope.snapshot(),
                signalPassed: true, originalAckCount: consumer.acked.length, freshWrite: proofFreshWrite ?? null,
                effects: proofEffects()});
            try {
                await managedProofReleased;
                if (proofControl.kind === 'failed') throw proofError;
                return value;
            } finally {
                proofReadSettled = true;
                previousSend.call(process, {event: 'qualification_proof_settled', readSignalAborted: options.signal.aborted,
                    effects: proofEffects()});
            }
        };
        if (proofControl.phase === 'open') {
            const {ProtocolAbiProofReader} = await import('../../build/indexer/protocol/abi-proof.js');
            const originalWait = ProtocolAbiProofReader.prototype.waitForOpen;
            ProtocolAbiProofReader.prototype.waitForOpen = async function(...args) {
                const scope = currentProofConsumerScope();
                if (scope?.id === proofAttemptId) {
                    proofProbeKind = 'retained-open-helper';
                    proofProbe = scope.bindCallback(() => this.open(args[0], args[1]));
                }
                try {return await originalWait.apply(this, args);}
                catch (error) {
                    if (scope?.id === proofAttemptId) previousSend.call(process, {
                        event: 'qualification_proof_wait_rejected', code: error.code, readSettled: proofReadSettled
                    });
                    throw error;
                }
            };
        }
    }
    const attemptLifecycle = (value, role) => {
        if (!(managedOriginalMain && value === main || managedOriginalDs && value === pool)) controlledAttemptLifecycle(value, role);
        return value;
    };
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
                expire() {return this;}, async exec() {cacheDispatches++; cache.push(...writes); return [];}};
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
        attemptLifecycle(main, 'deserializer').captureActionAdmissionDelivery(delivery, mainConsumer);
        attemptLifecycle(main, 'deserializer').captureProtocolSourceDelivery(delivery, mainConsumer);
        if (managedOriginalMain && managedProofCase) await awaitManagedPeerStart();
        await parser.parseMessage(main, [delivery]); await draining;
        assert.equal(mainConsumer.acked.at(-1), delivery);
        const messages = mainPublisher.sent.slice(mainBefore).map(sent => {
            const delivery = message(sent);
            if (!managedOriginalDs || numberFrom(bytes) === (managedOriginalHandoff ? 33 : 36)) {
                attemptLifecycle(pool, 'ds_pool_worker').captureActionAdmissionDelivery(delivery, poolConsumer);
                attemptLifecycle(pool, 'ds_pool_worker').captureProtocolActionDelivery(delivery, poolConsumer);
            }
            return delivery;
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
            if (!managedOriginalDs) await assert.rejects(pool.getProtocolNativeReader().waitForOpen({chainId, blockNum: 1,
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
    const sourceAckChecks = [];
    const records = () => ids(memory, 'h45actionattempt1:').map(id => ({id, value: JSON.parse(retained(memory, admissionStore.index, id).payloadJson)}));
    const publishManagedSnapshot = async (role, admissionId, recordId, originalAckCount) => {
        assert(managedOriginal && (role === 'main' ? managedOriginalMain : managedOriginalDs));
        const snapshot = {documents: [...memory.documents], mappings: [...memory.mappings], settings: [...memory.settings],
            admissionId, recordId, originalAckCount};
        const bytes = Buffer.from(JSON.stringify(snapshot));
        snapshotPath = join(tmpdir(), `hyperion-managed-wire-${role}-${randomUUID()}.json`);
        writeFileSync(snapshotPath, bytes);
        previousSend.call(process, {event: 'qualification_fixture', path: snapshotPath,
            sha256: hash(bytes), bytes: bytes.length});
        let timer;
        try {await Promise.race([managedFinished, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Managed Wire qualification parent did not finish')), 20_000);
        })]);} finally {clearTimeout(timer);}
    };
    const publishProofFailure = async (role, processing, admissionId) => {
        let observedError;
        await assert.rejects(processing, error => {
            observedError = error;
            return proofControl.kind === 'failed' ? role === 'main' ? error === proofError
                : error.name === 'ProtocolNativeActionUnavailableError' && error.code === 'native_read_unavailable' && error.statusCode === 503
                : error.code === 'worker_attempt_fenced' || error.code === 'proof_cancelled' || error.code === 'native_cancelled';
        });
        assert(proofReadHeld && proofReadSettled);
        assert.equal((role === 'main' ? mainConsumer : poolConsumer).acked.length, 0);
        previousSend.call(process, {event: 'qualification_proof_failed', kind: proofControl.kind,
            originalAckCount: 0, freshWrite: proofFreshWrite ?? null,
            errorName: observedError.name, errorCode: observedError.code ?? null, statusCode: observedError.statusCode ?? null,
            effects: proofEffects()});
        await publishManagedSnapshot(role, admissionId ?? null, proofFreshWrite?.id ?? null, 0);
    };
    mainConsumer.onAck = () => {
        const rows = records();
        assert.equal(rows.length, 1, 'Original missing-trace source ACK requires its durable typed source observation');
        assert.equal(rows[0].value.disposition, 'source-unprocessable');
        assert.equal(rows[0].value.reason, 'source-traces-missing');
        assert.equal(rows[0].value.work.source.blockNum, 1);
        assert.equal(rows[0].value.work.transaction, null); assert.equal(rows[0].value.work.planId, null);
        assert.deepEqual(rows[0].value.output, {kind: 'unresolved'}); sourceAckChecks.push(rows[0]);
        if (managedOriginalMain) previousSend.call(process, {event: 'qualification_ack', recordId: rows[0].id});
        if (managedOriginalMainHeldOperation) {
            // A constructed retained consumer operation outlives the original callback and ACK.
            // Use the actual managed scope; no fixture snapshot may manufacture its drained end.
            const scope = currentProofConsumerScope(true);
            void scope.operation(async () => {
                previousSend.call(process, {event: 'qualification_operation_held', scope: scope.snapshot()});
                await managedOperationReleased;
                previousSend.call(process, {event: 'qualification_operation_released'});
            });
            scope.signal.addEventListener('abort', () => previousSend.call(process, {
                event: 'qualification_operation_fenced', scope: scope.snapshot(), originalAckCount: mainConsumer.acked.length
            }), {once: true});
        }
        if (managedOriginalMainAckThrows) throw new Error('constructed original ACK call failure');
    };
    if (managedOriginalMainHeldWrite) {
        let heldOnce = false;
        memory.faults.beforeWrite = async request => {
            if (heldOnce || request.index !== admissionStore.index || request.document?.kind !== 'manifest'
                || !request.document.bundle_id.startsWith('h45actionattempt1:')) return;
            heldOnce = true;
            assert.equal(mainConsumer.acked.length, 0);
            previousSend.call(process, {event: 'qualification_write_held', originalAckCount: mainConsumer.acked.length});
            await managedWriteReleased;
            assert.equal(mainConsumer.acked.length, 0);
            delete memory.faults.beforeWrite;
        };
    }
    let failedManagedWrites = 0;
    if (managedOriginalMainFailedWrite) memory.faults.beforeWrite = async request => {
        if (request.index === admissionStore.index && request.document?.kind === 'manifest'
            && request.document.bundle_id.startsWith('h45actionattempt1:')) {
            failedManagedWrites++;
            throw new Error('constructed managed disposition write failure');
        }
    };
    const genesisFrame = readFileSync(join(sourceDir, 'block-000001.bin'));
    if (managedOriginalMain && proofControl && proofControl.kind !== 'held') {
        const processing = prepare(genesisFrame);
        processing.catch(() => {});
        await publishProofFailure('main', processing, undefined);
    } else if (managedOriginalMainFailedWrite) {
        await assert.rejects(prepare(genesisFrame),
            /constructed managed disposition write failure/);
        assert.equal(failedManagedWrites, 1);
        assert.equal(mainConsumer.acked.length, 0);
        assert.equal(records().length, 0);
        delete memory.faults.beforeWrite;
        previousSend.call(process, {event: 'qualification_write_failed', originalAckCount: mainConsumer.acked.length,
            failedWrites: failedManagedWrites, retainedAttemptRecords: records().length,
            originalFrameSha256: hash(genesisFrame)});
        await managedFinished;
    } else if (managedOriginalMainFailedEnd) {
        await assert.rejects(prepare(genesisFrame), /constructed original end send failure/);
        assert.equal(sourceAckChecks.length, 1); assert.equal(mainConsumer.acked.length, 1);
        assert.equal(records().length, 1); assert.equal(managedEndSendFailures, 3);
        previousSend.call(process, {event: 'qualification_end_failed', originalAckCount: mainConsumer.acked.length,
            retainedAttemptRecords: records().length, failedEndSends: managedEndSendFailures,
            originalFrameSha256: hash(genesisFrame)});
        await managedFinished;
    } else if (managedOriginalMainAckThrows) {
        await assert.rejects(prepare(genesisFrame), /constructed original ACK call failure/);
        assert.equal(sourceAckChecks.length, 1);
        assert.equal(mainConsumer.acked.length, 0);
        await publishManagedSnapshot('main', sourceAckChecks[0].value.work.admissionId, sourceAckChecks[0].id, 0);
    } else {
    const genesis = await prepare(genesisFrame);
    if (managedOriginalMainHeldWrite) assert.equal(memory.faults.beforeWrite, undefined);
    assert.equal(sourceAckChecks.length, 1); assert.ok(genesis.admission.incomplete);
    assert.equal(sourceAckChecks[0].value.work.source.captureSha256, genesis.admission.source.captureSha256);
    mainConsumer.onAck = undefined;
    if (managedOriginalMain) {
        assert.equal(mainConsumer.acked.length, 1, 'original Wire MainDS ACK follows its retained disposition');
        await publishManagedSnapshot('main', genesis.admission.id, sourceAckChecks[0].id, mainConsumer.acked.length);
    } else {
    const lifecycle = ['original-genesis-no-invented-membership'];
    let managedHandoffId;
    const originalGenesisDelivery = mainConsumer.acked[0];
    const runSource = (source = originalGenesisDelivery) => {
        const delivery = {content: Buffer.from(source.content), properties: structuredClone(source.properties), fields: {deliveryTag: 1}};
        const consumer = new ControlledConsumer(), publisher = new ControlledPublisher();
        main.ch = consumer; main.cch = publisher; main.ch_ready = true; main.cch_ready = true;
        attemptLifecycle(main, 'deserializer').captureActionAdmissionDelivery(delivery, consumer);
        attemptLifecycle(main, 'deserializer').captureProtocolSourceDelivery(delivery, consumer);
        const pending = parser.parseMessage(main, [delivery]); pending.catch(() => {});
        return {delivery, consumer, publisher, pending};
    };
    const attemptManifest = request => request.index === admissionStore.index && request.document.kind === 'manifest'
        && request.document.bundle_id.startsWith('h45actionattempt1:');
    let unknownReceipts = 0;
    memory.faults.receipt = (receipt, request) => {
        if (!attemptManifest(request)) return receipt;
        unknownReceipts++; return {...receipt, _shards: {...receipt._shards, successful: 0}};
    };
    const unknownSource = runSource(); await assert.rejects(unknownSource.pending, /acknowledg|shard|copies|durab/i);
    assert.equal(unknownSource.consumer.acked.length, 0); assert.equal(unknownReceipts, 1);
    assert.equal((await admissionStore.readAttemptDisposition(sourceAckChecks[0].id)).id, sourceAckChecks[0].id);
    delete memory.faults.receipt;
    let freshSourceReceipts = 0;
    memory.faults.receipt = (receipt, request) => {if (attemptManifest(request)) freshSourceReceipts++; return receipt;};
    const repairedSource = runSource(); await repairedSource.pending;
    assert.equal(repairedSource.consumer.acked.length, 1); assert.equal(freshSourceReceipts, 1); delete memory.faults.receipt;
    lifecycle.push('source-primary-visible-unknown-no-ack-fresh-repair');
    const sourceIo = new ActionSourceInventoryError('constructed core attempt storage I/O');
    memory.faults.beforeWrite = async request => {if (attemptManifest(request)) throw sourceIo;};
    const failedSource = runSource(); await assert.rejects(failedSource.pending, error => error === sourceIo);
    assert.equal(failedSource.consumer.acked.length, 0); delete memory.faults.beforeWrite;
    lifecycle.push('generic-inventory-shaped-source-write-error-no-ack');
    for (const mutation of ['consumer', 'publisher', 'configuration', 'target']) {
        const held = gate(); let entered = false;
        memory.faults.beforeWrite = async request => {if (attemptManifest(request)) {entered = true; await held.held;}};
        const pendingSource = runSource(); await until(() => entered, `source attempt reaches held ${mutation} write`);
        assert.equal(pendingSource.consumer.acked.length, 0);
        const oldConsole = config.features.contract_console, oldUuid = memory.settings.get(targetName)['index.uuid'];
        if (mutation === 'consumer') main.ch = new ControlledConsumer();
        if (mutation === 'publisher') main.cch = new ControlledPublisher();
        if (mutation === 'configuration') config.features.contract_console = !oldConsole;
        if (mutation === 'target') memory.settings.get(targetName)['index.uuid'] = 'constructed-replacement';
        held.release(); await assert.rejects(pendingSource.pending, /owner|epoch|channel|stale|target/i);
        assert.equal(pendingSource.consumer.acked.length, 0);
        config.features.contract_console = oldConsole; memory.settings.get(targetName)['index.uuid'] = oldUuid; delete memory.faults.beforeWrite;
        lifecycle.push(`source-${mutation}-across-write-no-ack`);
    }
    main.ch = mainConsumer; main.cch = mainPublisher;
    const directOwner = {consumer: mainConsumer, publisher: mainPublisher, current: () => true};
    const sourceInput = {admissionId: genesis.admission.id, configuration: currentActionConfiguration(main), owner: directOwner};
    const [sourceEvidence] = await admissionStore.prepareSourceAttemptDispositions(sourceInput);
    for (const forged of [{}, JSON.parse(JSON.stringify(sourceEvidence)), await admissionStore.readAttemptDisposition(sourceAckChecks[0].id)])
        await assert.rejects(admissionStore.recordAttemptDisposition({owner: directOwner, evidence: forged}), /Unissued/);
    const foreignStore = new ActionSourceAdmissionStore(memory.client, chain);
    await assert.rejects(foreignStore.recordAttemptDisposition({owner: directOwner, evidence: sourceEvidence}), /foreign/);
    const foreignOwner = {...directOwner};
    await assert.rejects(admissionStore.recordAttemptDisposition({owner: foreignOwner, evidence: sourceEvidence}), /foreign/);
    const abortGate = gate(), abort = new AbortController(); let abortEntered = false;
    memory.faults.beforeWrite = async request => {if (attemptManifest(request)) {abortEntered = true; await abortGate.held;}};
    const aborted = admissionStore.recordAttemptDisposition({owner: directOwner, evidence: sourceEvidence}, abort.signal); aborted.catch(() => {});
    await until(() => abortEntered, 'actual attempt write is abortable'); const abortError = new Error('constructed attempt abort');
    abort.abort(abortError); abortGate.release(); await assert.rejects(aborted, error => error === abortError); delete memory.faults.beforeWrite;
    lifecycle.push('opaque-store-owner-read-and-abort-negatives');
    const fourGate = gate(); let fourEntered = 0;
    const oneFailure = new Error('constructed one-of-four attempt I/O');
    memory.faults.beforeWrite = async request => {if (attemptManifest(request)) {const ordinal = ++fourEntered; await fourGate.held; if (ordinal === 1) throw oneFailure;}};
    const four = Array.from({length: 4}, () => admissionStore.recordAttemptDisposition({owner: directOwner, evidence: sourceEvidence}));
    four.forEach(value => value.catch(() => {})); await until(() => fourEntered === 4, 'four top-level outcome leases reach their writes');
    let fifthRead = false; const fifth = {}; Object.defineProperty(fifth, 'owner', {get() {fifthRead = true; throw new Error('request read before operation lease');}});
    await assert.rejects(admissionStore.recordAttemptDisposition(fifth), /concurrent operation budget/); assert.equal(fifthRead, false);
    fourGate.release(); const fourResults = await Promise.allSettled(four); delete memory.faults.beforeWrite;
    assert.equal(fourResults.filter(value => value.status === 'fulfilled').length, 3);
    assert.deepEqual(fourResults.filter(value => value.status === 'rejected').map(value => value.reason), [oneFailure]);
    assert.equal((await admissionStore.recordAttemptDisposition({owner: directOwner, evidence: sourceEvidence})).id, sourceAckChecks[0].id);
    lifecycle.push('four-top-level-leases-fifth-before-read-failure-release');
    const attemptsBeforeQuarantine = records().length, capsulesBefore = ids(memory, 'h45srcq1:').length;
    const unboundGenesis = {content: Buffer.from(originalGenesisDelivery.content), properties: structuredClone(originalGenesisDelivery.properties)};
    delete unboundGenesis.properties.headers[protocolSourceSelectionHeader];
    const quarantined = runSource(unboundGenesis);
    quarantined.consumer.onAck = () => {
        assert.equal(ids(memory, 'h45srcq1:').length, capsulesBefore + 1);
        assert.equal(records().length, attemptsBeforeQuarantine, 'Pre-admission quarantine has no invented admission or typed terminal authority');
    };
    await quarantined.pending; assert.equal(quarantined.consumer.acked.length, 1);
    const capsuleIo = new Error('constructed pre-admission capsule write failure');
    memory.faults.beforeWrite = async request => {if (request.document.kind === 'manifest' && request.document.bundle_id.startsWith('h45srcq1:')) throw capsuleIo;};
    const failedCapsule = runSource(unboundGenesis); await assert.rejects(failedCapsule.pending, error => error === capsuleIo);
    assert.equal(failedCapsule.consumer.acked.length, 0); delete memory.faults.beforeWrite;
    main.ch = mainConsumer; main.cch = mainPublisher;
    lifecycle.push('pre-admission-quarantine-only-failed-write-no-ack');
    let prepared; const corruptionCalls = [], originalControls = new Map();
    const corruptContract = async action => {corruptionCalls.push(action.act.name); action.receipt[1].recv_sequence = 'not-a-sequence';};
    for (let number = 2; number <= 37; number++) {
        if (number === 36 && (mode === 'lifecycle' || managedOriginalContract))
            loader.handledActions.set('*', new Map([['setcode', corruptContract]]));
        if (number === 36 && (mode === 'no-effects' || managedOriginalNoEffect)) {
            filters.action_whitelist.add('sysio::setabi'); filters.action_blacklist.add('sysio::setabi');
        }
        if (number === 33 && mode === 'traces-disabled') {
            config.indexer.fetch_traces = false;
            mainConsumer.onAck = () => {
                const rows = records().filter(row => row.value.work.source.blockNum === 33);
                assert.equal(rows.length, 1); assert.equal(rows[0].value.work.stage, 'main-source');
                assert.equal(rows[0].value.disposition, 'operator-disabled'); assert.equal(rows[0].value.reason, 'traces-disabled');
                assert.equal(rows[0].value.work.transaction.expectedGroups, 1); assert.deepEqual(rows[0].value.output, {kind: 'unresolved'});
            };
        }
        if (number === 37) config.indexer.disable_indexing = true;
        let inputBytes = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin'));
        if (number === 2 && mode === 'empty-vector') {
            const constructed = codec.decode('result', inputBytes);
            constructed[1].traces = Buffer.from(codec.encode('transaction_trace[]', [])).toString('hex');
            inputBytes = Buffer.from(codec.encode('result', constructed));
            mainConsumer.onAck = () => {
                const rows = records().filter(row => row.value.work.source.blockNum === 2);
                assert.equal(rows.length, 1); assert.equal(rows[0].value.reason, 'empty-source-vector');
                assert.equal(rows[0].value.work.stage, 'main-source'); assert.equal(rows[0].value.work.transaction, null);
                assert(rows[0].value.work.planId); assert.deepEqual(rows[0].value.output, {kind: 'none-required'});
            };
        }
        prepared = await prepare(inputBytes);
        if (number === 33 && managedOriginalHandoff) {
            assert.equal(prepared.messages.length, 1);
            poolConsumer.onAck = delivery => {
                assert.equal(delivery, prepared.messages[0]);
                const handoffs = ids(memory, 'h45actionhandoff1:');
                assert.equal(handoffs.length, 1, 'original native publication must be durable before DS ACK');
                managedHandoffId = handoffs[0];
                previousSend.call(process, {event: 'qualification_ack', recordId: managedHandoffId});
            };
            if (managedOriginalHandoffHeldConfirm) {
                poolPublisher.held = managedConfirmReleased;
                poolPublisher.entered = () => previousSend.call(process, {event: 'qualification_confirm_held',
                    originalAckCount: poolConsumer.acked.length, retainedHandoffs: ids(memory, 'h45actionhandoff1:').length,
                    confirmCalls: poolPublisher.confirmCalls});
            }
            if (managedOriginalHandoffFailedConfirm)
                poolPublisher.confirmError = new Error('constructed original publication confirm failure');
            if (managedOriginalHandoffHeldDrain || managedOriginalHandoffFailedDrain) poolPublisher.writable = false;
            if (managedProofCase) await awaitManagedPeerStart();
            const processing = pool.processMessages(prepared.messages);
            processing.catch(() => {});
            if (proofControl && proofControl.kind !== 'held') {
                await publishProofFailure('ds', processing, prepared.admission.id);
                break;
            }
            if (managedOriginalHandoffHeldDrain) {
                await until(() => poolPublisher.sent.length === 1 && poolPublisher.confirmCalls === 1,
                    'original handoff receives confirm but still awaits publisher drain');
                previousSend.call(process, {event: 'qualification_drain_held',
                    originalAckCount: poolConsumer.acked.length, retainedHandoffs: ids(memory, 'h45actionhandoff1:').length,
                    confirmCalls: poolPublisher.confirmCalls});
                await managedDrainReleased;
                poolPublisher.emit('drain');
            }
            if (managedOriginalHandoffFailedDrain) {
                await until(() => poolPublisher.sent.length === 1 && poolPublisher.confirmCalls === 1,
                    'original handoff receives confirm before failed publisher drain');
                assert.equal(poolConsumer.acked.length, 0);
                assert.equal(ids(memory, 'h45actionhandoff1:').length, 0);
                poolPublisher.emit('close');
            }
            if (managedOriginalHandoffFailedConfirm || managedOriginalHandoffFailedDrain) {
                await assert.rejects(processing, managedOriginalHandoffFailedConfirm
                    ? /constructed original publication confirm failure/
                    : {code: 'worker_attempt_fenced'});
                assert.equal(poolPublisher.sent.length, 1);
                assert.equal(poolConsumer.acked.length, 0);
                assert.equal(ids(memory, 'h45actionhandoff1:').length, 0);
                previousSend.call(process, {event: 'qualification_publish_failed',
                    originalAckCount: poolConsumer.acked.length,
                    failedConfirms: managedOriginalHandoffFailedConfirm ? 1 : 0,
                    failedDrains: managedOriginalHandoffFailedDrain ? 1 : 0,
                    confirmCalls: poolPublisher.confirmCalls,
                    retainedHandoffs: 0, originalPayloadSha256: hash(prepared.messages[0].content)});
                await managedFinished;
                break;
            }
            await processing;
            assert.equal(poolPublisher.sent.length, 1);
            assert.equal(poolConsumer.acked.length, 1);
            poolConsumer.onAck = undefined;
            break;
        }
        if (number === 2 && mode === 'empty-vector') {
            assert.equal(prepared.admission.inventory.transactions.length, 0); assert.equal(prepared.messages.length, 0); break;
        }
        originalControls.set(number, prepared);
        if (number === 33 && mode === 'traces-disabled') {assert.equal(prepared.messages.length, 0); break;}
        if (number === 36 && (mode === 'no-effects' || managedOriginalNoEffect)) {
            assert.equal(prepared.messages.length, 1); assert.equal(prepared.messages[0].properties.headers.action_trace_ordinal, 1);
            const transaction = prepared.admission.inventory.transactions[1];
            assert.equal(transaction.transactionId, '140abb3d398f206518e117c02ccf1f1604b37b9fb55f7abed2034cf2fb374c66');
            assert.equal(transaction.disposition, 'no-effects'); assert(transaction.dispatch); assert.equal(transaction.groups.length, 0);
            poolConsumer.onAck = () => {
                const rows = records().filter(row => row.value.work.admissionId === prepared.admission.id);
                assert.equal(rows.length, 2);
                assert.equal(rows.filter(row => row.value.disposition === 'policy-excluded' && row.value.work.transaction.traceOrdinal === 0).length, 1);
                const ds = rows.find(row => row.value.work.stage === 'ds-transaction');
                assert(ds); assert.equal(ds.value.disposition, 'no-effects'); assert.equal(ds.value.work.transaction.traceOrdinal, 1);
                assert.equal(ds.value.work.transaction.expectedGroups, 0); assert.deepEqual(ds.value.output, {kind: 'none-required'});
                if (managedOriginalNoEffect) previousSend.call(process, {event: 'qualification_ack', recordId: ds.id});
            };
            await pool.processMessages(prepared.messages); assert.equal(poolPublisher.sent.length, 0);
            poolConsumer.onAck = undefined; break;
        }
        if (number === 36) {
            poolConsumer.onAck = () => {
                const rows = records().filter(row => row.value.work.admissionId === prepared.admission.id);
                assert.deepEqual(corruptionCalls, ['setcode'], 'constructed hook reached actual decoded original contract');
                assert.equal(rows.length, 1, 'Pure finalization failure requires a source-bound attempt record before ACK');
                assert.equal(rows[0].value.disposition, 'contract-output-incomplete');
                assert.equal(rows[0].value.reason, 'contract-finalization-invalid');
                assert.equal(rows[0].value.work.transaction.expectedGroups, 2);
                assert.deepEqual(rows[0].value.output, {kind: 'unresolved'});
                if (managedOriginalContract) previousSend.call(process, {event: 'qualification_ack', recordId: rows[0].id});
            };
            await pool.processMessages(prepared.messages.filter(value => value.properties.headers.action_trace_ordinal === 1));
            assert.equal(poolPublisher.sent.length, 0); loader.handledActions.clear(); poolConsumer.onAck = undefined;
            if (managedOriginalContract) break;
        }
    }
    if (managedOriginalDs && !managedOriginalHandoffFailedConfirm && !managedOriginalHandoffFailedDrain
        && !(proofControl && proofControl.kind !== 'held')) {
        const recordId = managedOriginalHandoff ? managedHandoffId : records().find(row =>
            row.value.work.admissionId === prepared.admission.id && row.value.work.stage === 'ds-transaction')?.id;
        assert(recordId); assert.equal(poolConsumer.acked.length, 1);
        await publishManagedSnapshot('ds', prepared.admission.id, recordId, poolConsumer.acked.length);
    }
    if (mode === 'lifecycle') {
    const disabled = prepared;
    poolConsumer.onAck = delivery => {
        const rows = records().filter(row => row.value.work.admissionId === disabled.admission.id);
        assert.equal(rows.length, 1, 'Original skipped DS ACK requires its durable operator-disabled observation');
        assert.equal(rows[0].value.work.stage, 'ds-transaction'); assert.equal(rows[0].value.reason, 'indexing-disabled');
        assert.equal(rows[0].value.work.transaction.expectedGroups, 1); assert.deepEqual(rows[0].value.output, {kind: 'unresolved'});
    };
    await pool.processMessages(disabled.messages);
    assert.equal(poolPublisher.sent.length, 0); assert.equal(poolConsumer.acked.length, 2);
    config.indexer.disable_indexing = false; poolConsumer.onAck = undefined;
    filters.action_blacklist.add('sysio::*');
    mainConsumer.onAck = () => {
        const rows = records().filter(row => row.value.work.source.blockNum === 38);
        assert.equal(rows.length, 1); assert.equal(rows[0].value.disposition, 'policy-excluded');
        assert.equal(rows[0].value.work.stage, 'main-source'); assert.equal(rows[0].value.work.transaction.traceOrdinal, 0);
        assert.deepEqual(rows[0].value.output, {kind: 'none-required'});
    };
    const excluded = await prepare(readFileSync(join(sourceDir, 'block-000038.bin')));
    assert.equal(excluded.messages.length, 0); filters.action_blacklist.clear(); mainConsumer.onAck = undefined;
    // Constructed arbitrary async hook failure over original bytes: no terminal contract cause is inferred.
    loader.handledActions.set('*', new Map([['onblock', async () => {throw new Error('constructed untyped hook I/O');}]]));
    const raw = await prepare(readFileSync(join(sourceDir, 'block-000039.bin')));
    poolConsumer.onAck = () => {
        const rows = records().filter(row => row.value.work.admissionId === raw.admission.id);
        assert.equal(rows.length, 1, 'Actual confirmed raw fallback must retain its typed handoff before ACK');
        assert.equal(rows[0].value.disposition, 'raw-incomplete-handoff'); assert.equal(rows[0].value.reason, 'raw-output-incomplete');
        assert.equal(rows[0].value.work.transaction.expectedGroups, 1); assert.equal(rows[0].value.output.effects.length, 1);
        assert.equal(rows[0].value.output.effects[0].status, 'incomplete');
    };
    await pool.processMessages(raw.messages.slice(0, 1)); loader.handledActions.clear(); poolConsumer.onAck = undefined;
    assert.equal(poolPublisher.sent.length, 1); assert.equal(poolConsumer.acked.length, 3);
    const rawOutput = JSON.parse(poolPublisher.sent[0].payload);
    assert.equal(rawOutput.protocol.schemaVersion, 2); assert.equal(rawOutput.protocol.status, 'incomplete'); assert.equal(rawOutput.ds_error, true);
    assert.equal(records().filter(row => row.value.disposition === 'contract-output-incomplete').length, 1);
    // Constructed compound source: original40 native root + a distinct inline setpriv sibling encoded under the actual certified ABI.
    // Fresh encoded bytes, normal observer/coordinator/inventory/grants. This is not an original or consensus block.
    const compoundHook = async () => {throw new Error('constructed untyped compound hook I/O');};
    loader.handledActions.set('*', new Map([['onblock', compoundHook]]));
    const compound = codec.decode('result', readFileSync(join(sourceDir, 'block-000040.bin')));
    const compoundTraces = codec.decode('transaction_trace[]', Buffer.from(compound[1].traces, 'hex'));
    const original36Traces = codec.decode('transaction_trace[]', Buffer.from(codec.decode('result', readFileSync(join(sourceDir, 'block-000036.bin')))[1].traces, 'hex'));
    const source36 = originalControls.get(36);
    const systemView = await pool.getProtocolProofReader().open({chainId, blockNum: 36, blockId: source36.admission.source.inventoryInput.source.blockId}, source36.sourceSelectionId);
    const systemState = await pool.getProtocolProofReader().action(systemView, source36.admission.inventory.transactions[1].groups[0].metadata.protocol.input);
    const systemAbi = selected.provider.contractCodec.decodeAbi(Buffer.from(systemState.state.abiHex, 'hex'));
    const setprivType = systemAbi.actions.find(row => String(row.name) === 'setpriv').type;
    const setprivValue = {account: 'sysio', is_priv: 1};
    const setprivHex = Buffer.from(selected.provider.contractCodec.encodeValue(systemAbi, setprivType, setprivValue)).toString('hex');
    const sibling = structuredClone(original36Traces[1][1].action_traces[0]);
    assert.equal(sibling[1].act.name, 'setcode'); sibling[1].act.name = 'setpriv'; sibling[1].act.data = setprivHex;
    sibling[1].receipt[1].act_digest = hash(codec.encode('action', sibling[1].act));
    sibling[1].action_ordinal = 2; sibling[1].creator_action_ordinal = 1;
    sibling[1].receipt[1].global_sequence = '1000001'; sibling[1].receipt[1].recv_sequence = '1000001';
    compoundTraces[0][1].action_traces.push(sibling);
    compound[1].traces = Buffer.from(codec.encode('transaction_trace[]', compoundTraces)).toString('hex');
    const compoundBytes = Buffer.from(codec.encode('result', compound));
    const compoundFacts = selected.provider.nativeActions.observe({schemaJson, block: Buffer.from(compound[1].block, 'hex'),
        traces: Buffer.from(compound[1].traces, 'hex')}, {chainId, blockNum: 40, blockId: compound[1].this_block.block_id, previousBlockId: compound[1].prev_block.block_id});
    assert.deepEqual(compoundFacts.decisions.filter(row => row.origin.transactionId === compoundTraces[0][1].id).map(row => row.kind), ['native', 'contract']);
    const mixed = await prepare(compoundBytes), mixedTx = mixed.admission.inventory.transactions[0];
    assert.equal(mixedTx.groups.length, 2); assert.equal(mixed.admission.source.frameHex, compoundBytes.toString('hex'));
    assert.equal(mixed.admission.source.inventoryInput.traces[0][1].action_traces.length, 2);
    const runPool = (source, ordinal = 0) => {
        const original = source.messages.find(value => value.properties.headers.action_trace_ordinal === ordinal);
        const delivery = {content: Buffer.from(original.content), properties: structuredClone(original.properties), fields: {deliveryTag: 1}};
        const consumer = new ControlledConsumer(), publisher = new ControlledPublisher();
        pool.ch = consumer; pool.cch = publisher; pool.ch_ready = true; pool.cch_ready = true;
        (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureActionAdmissionDelivery(delivery, consumer); (controlledAttemptLifecycle(pool, 'ds_pool_worker'), pool).captureProtocolActionDelivery(delivery, consumer);
        const pending = pool.processMessages([delivery]); pending.catch(() => {}); return {delivery, consumer, publisher, pending};
    };
    const mixedRows = () => records().filter(row => row.value.work.admissionId === mixed.admission.id);
    const partialMixed = runPool(mixed); partialMixed.publisher.automatic = false; partialMixed.publisher.writable = false;
    await until(() => partialMixed.publisher.sent.length === 1, 'first raw native group reaches real confirmation');
    partialMixed.publisher.sent[0].confirm(null); await ticks(); assert.equal(mixedRows().length, 0); assert.equal(partialMixed.consumer.acked.length, 0);
    partialMixed.publisher.emit('drain');
    await until(() => partialMixed.publisher.sent.length === 2, 'complete inline contract sibling reaches its own real confirmation');
    assert.equal(mixedRows().length, 0); assert.equal(partialMixed.consumer.acked.length, 0);
    assert.equal(JSON.parse(partialMixed.publisher.sent[0].payload).protocol.status, 'incomplete');
    assert.equal(JSON.parse(partialMixed.publisher.sent[1].payload).protocol.status, undefined);
    assert.equal(JSON.parse(partialMixed.publisher.sent[1].payload).protocol.schemaVersion, 1);
    assert.deepEqual(JSON.parse(partialMixed.publisher.sent[1].payload).act.data, setprivValue);
    partialMixed.publisher.sent[1].confirm(new Error('constructed mixed sibling NACK'));
    partialMixed.publisher.emit('drain'); // Negative confirm settles no ticket; original buffered bytes must also finish.
    await assert.rejects(partialMixed.pending, /mixed sibling NACK/); assert.equal(partialMixed.consumer.acked.length, 0); assert.equal(mixedRows().length, 0);
    const completeMixed = runPool(mixed);
    completeMixed.consumer.onAck = () => {
        const rows = mixedRows(); assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].value.output.effects.map(row => row.status), ['incomplete', 'complete']);
        assert.equal(rows[0].value.work.transaction.expectedGroups, 2);
        assert.deepEqual(rows[0].value.output.effects.map(row => row.payloadSha256), completeMixed.publisher.sent.map(row => hash(row.payload)));
    };
    await completeMixed.pending; assert.equal(completeMixed.consumer.acked.length, 1); assert.equal(completeMixed.publisher.sent.length, 2);
    assert.equal(ids(memory, 'h45actionhandoff1:').filter(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson).work.admissionId === mixed.admission.id).length, 0);
    lifecycle.push('constructed-compound-normal-provider-two-groups-partial-confirm-no-ack-full-ticket-raw-handoff');
    const mixedObserved = await admissionStore.readAttemptDisposition(mixedRows()[0].id);
    assert.equal(mixedObserved.observation.output.kind, 'raw-incomplete');
    const rawIo = new ActionSourceInventoryError('constructed raw disposition core I/O');
    const incompleteCount = ids(memory, 'h45actionincomplete1:').length;
    memory.faults.beforeWrite = async request => {if (attemptManifest(request)) throw rawIo;};
    const rawIoRun = runPool(mixed); await assert.rejects(rawIoRun.pending, error => error === rawIo);
    assert.equal(rawIoRun.consumer.acked.length, 0); assert.equal(ids(memory, 'h45actionincomplete1:').length, incompleteCount);
    delete memory.faults.beforeWrite;
    let rawUnknownReceipts = 0;
    memory.faults.receipt = (receipt, request) => {
        if (!attemptManifest(request)) return receipt;
        rawUnknownReceipts++; return {...receipt, _shards: {...receipt._shards, successful: 0}};
    };
    const rawUnknown = runPool(mixed); await assert.rejects(rawUnknown.pending, /acknowledg|shard|copies|durab/i);
    assert.equal(rawUnknown.consumer.acked.length, 0); assert.equal(rawUnknownReceipts, 1); assert.equal(mixedRows().length, 1);
    delete memory.faults.receipt;
    let rawFreshReceipts = 0;
    memory.faults.receipt = (receipt, request) => {if (attemptManifest(request)) rawFreshReceipts++; return receipt;};
    const rawRepair = runPool(mixed); await rawRepair.pending;
    assert.equal(rawRepair.consumer.acked.length, 1); assert.equal(rawFreshReceipts, 1); delete memory.faults.receipt;
    assert.notEqual(rawRepair.publisher.sent[0].options.messageId, completeMixed.publisher.sent[0].options.messageId);
    assert.equal(mixedRows()[0].id, mixedObserved.id);
    lifecycle.push('mixed-raw-core-io-and-primary-visible-unknown-no-ack-fresh-repair');
    for (const mutation of ['consumer', 'publisher', 'configuration', 'target']) {
        const held = gate(); let entered = false;
        memory.faults.beforeWrite = async request => {if (attemptManifest(request)) {entered = true; await held.held;}};
        const changed = runPool(mixed); await until(() => entered, `raw attempt reaches held ${mutation} write`);
        const oldConsole = config.features.contract_console, oldUuid = memory.settings.get(targetName)['index.uuid'];
        if (mutation === 'consumer') pool.ch = new ControlledConsumer();
        if (mutation === 'publisher') pool.cch = new ControlledPublisher();
        if (mutation === 'configuration') config.features.contract_console = !oldConsole;
        if (mutation === 'target') memory.settings.get(targetName)['index.uuid'] = 'constructed-target-swap';
        held.release(); await assert.rejects(changed.pending, /owner|epoch|channel|target/i); assert.equal(changed.consumer.acked.length, 0);
        config.features.contract_console = oldConsole; memory.settings.get(targetName)['index.uuid'] = oldUuid; delete memory.faults.beforeWrite;
        lifecycle.push(`mixed-raw-${mutation}-across-write-no-ack`);
    }
    const finalTargetGate = gate(); let finalWritten = false, finalTargetEntered = false;
    memory.faults.receipt = (receipt, request) => {if (attemptManifest(request)) finalWritten = true; return receipt;};
    memory.faults.settings = async (value, request) => {
        if (finalWritten && request.index === targetName && !finalTargetEntered) {finalTargetEntered = true; await finalTargetGate.held;}
        return {[request.index]: {settings: value}};
    };
    const finalConfig = runPool(mixed); await until(() => finalTargetEntered, 'final post-write target check is held');
    config.features.contract_console = true; finalTargetGate.release();
    await assert.rejects(finalConfig.pending, /epoch|owner/); assert.equal(finalConfig.consumer.acked.length, 0);
    config.features.contract_console = false; delete memory.faults.receipt; delete memory.faults.settings;
    lifecycle.push('mixed-raw-config-change-during-final-target-check-no-ack');
    const followingRaw = runPool(mixed); await followingRaw.pending; assert.equal(followingRaw.consumer.acked.length, 1);
    lifecycle.push('unrelated-following-owned-work-progress-after-isolated-failure');
    const ticketConsumer = new ControlledConsumer(), ticketPublisher = new ControlledPublisher();
    const ticketOwner = {consumer: ticketConsumer, publisher: ticketPublisher, current: () => true};
    const ticketInput = publications => ({owner: ticketOwner, admissionId: mixed.admission.id, traceOrdinal: 0,
        configuration: currentActionConfiguration(pool), dispatchPayload: mixed.messages[0].content, publications});
    const detachedTickets = [];
    for (let index = 0; index < completeMixed.publisher.sent.length; index++) {
        const sent = completeMixed.publisher.sent[index];
        detachedTickets.push(await publishAdmittedActionWithEvidence(ticketOwner, `${chain}:index_actions:${index === 0 ? 2 : 1}`,
            Buffer.from(sent.payload), {headers: structuredClone(sent.options.headers)}));
    }
    const directRawEvidence = await admissionStore.prepareRawIncompleteAttemptDisposition(ticketInput(detachedTickets));
    const directRaw = await admissionStore.recordAttemptDisposition({owner: ticketOwner, evidence: directRawEvidence});
    assert.equal(directRaw.id, mixedObserved.id); assert.deepEqual(directRaw.observation, mixedObserved.observation);
    for (const publications of [[], [{}], detachedTickets.slice(0, 1), detachedTickets.slice().reverse()])
        await assert.rejects(admissionStore.prepareRawIncompleteAttemptDisposition(ticketInput(publications)));
    let inspectedPayload = false;
    const overCount = ticketInput(Array(100001).fill(detachedTickets[0]));
    Object.defineProperty(overCount, 'dispatchPayload', {get() {inspectedPayload = true; throw new Error('dispatch inspected before count admission');}});
    await assert.rejects(admissionStore.prepareRawIncompleteAttemptDisposition(overCount), /vector/); assert.equal(inspectedPayload, false);
    const ticketBytes = completeMixed.publisher.sent[0].payload.length + Buffer.byteLength(actionHistoryImmutableJson(completeMixed.publisher.sent[0].options.headers));
    const repeats = Math.floor(128 * 1024 * 1024 / ticketBytes) + 1; assert(repeats < 100001);
    const overBytes = ticketInput(Array(repeats).fill(detachedTickets[0]));
    Object.defineProperty(overBytes, 'dispatchPayload', {get() {inspectedPayload = true; throw new Error('dispatch inspected before SUM admission');}});
    await assert.rejects(admissionStore.prepareRawIncompleteAttemptDisposition(overBytes), /aggregate/); assert.equal(inspectedPayload, false);
    const changedContract = JSON.parse(completeMixed.publisher.sent[1].payload); changedContract.act.data.changed_root = true;
    const changedTicket = await publishAdmittedActionWithEvidence(ticketOwner, `${chain}:index_actions:1`, Buffer.from(actionHistoryImmutableJson(changedContract)),
        {headers: structuredClone(completeMixed.publisher.sent[1].options.headers)});
    await assert.rejects(admissionStore.prepareRawIncompleteAttemptDisposition(ticketInput([detachedTickets[0], changedTicket])), /conflict|different|mismatch/);
    assert.deepEqual((await admissionStore.readAttemptDisposition(mixedObserved.id)).observation, mixedObserved.observation);
    lifecycle.push('raw-fresh-helper-route-retry-opaque-complete-group-count-sum-before-copies-root-conflict');
    const contractVariant = (number, rawHex = setprivHex, name = 'setpriv') => {
        const result = codec.decode('result', readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin')));
        const traces = codec.decode('transaction_trace[]', Buffer.from(result[1].traces, 'hex'));
        const added = structuredClone(original36Traces[1][1].action_traces[0]);
        added[1].action_ordinal = 2; added[1].creator_action_ordinal = 1;
        added[1].receipt[1].global_sequence = String(1000000 + number); added[1].receipt[1].recv_sequence = String(1000000 + number);
        if (rawHex !== undefined) added[1].act.data = rawHex;
        if (name !== undefined) added[1].act.name = name;
        added[1].receipt[1].act_digest = hash(codec.encode('action', added[1].act));
        traces[0][1].action_traces.push(added);
        let constructedSequence = 1000000 + number * 100;
        for (const transaction of traces) for (const occurrence of transaction[1].action_traces) {
            occurrence[1].receipt[1].global_sequence = String(constructedSequence);
            occurrence[1].receipt[1].recv_sequence = String(constructedSequence++);
        }
        result[1].traces = Buffer.from(codec.encode('transaction_trace[]', traces)).toString('hex');
        return Buffer.from(codec.encode('result', result));
    };
    // Constructed invalid contract bytes are observed as original input, never a forged proof or substituted decoder.
    const invalidContract = await prepare(contractVariant(41, '00', 'setpriv'));
    const invalidContractRun = runPool(invalidContract);
    invalidContractRun.consumer.onAck = () => {
        const rows = records().filter(row => row.value.work.admissionId === invalidContract.admission.id);
        assert.equal(rows.length, 1, JSON.stringify(events.filter(event => event.event === 'ds_error').slice(-4))); assert.equal(rows[0].value.reason, 'contract-abi-invalid');
        assert.equal(rows[0].value.work.transaction.expectedGroups, 2); assert.deepEqual(rows[0].value.output, {kind: 'unresolved'});
    };
    await invalidContractRun.pending; assert.equal(invalidContractRun.publisher.sent.length, 0); assert.equal(invalidContractRun.consumer.acked.length, 1);
    assert.equal(await admissionStore.trySeal(invalidContract.admission), false, 'a pure contract failure does not certify complete siblings');
    lifecycle.push('constructed-inline-invalid-abi-no-output-unresolved-siblings-before-ack');
    loader.handledActions.clear();
    loader.handledActions.set('*', new Map([['setpriv', async () => {throw new ActionSourceInventoryError('constructed async hook storage-shaped rejection');}]]));
    const unknownHook = await prepare(contractVariant(42));
    const unknownHookRun = runPool(unknownHook); await unknownHookRun.pending;
    assert.equal(unknownHookRun.consumer.acked.length, 1); assert.equal(unknownHookRun.publisher.sent.length, 0);
    assert.equal(records().filter(row => row.value.work.admissionId === unknownHook.admission.id).length, 0,
        'legacy schema1 untyped hook failure has only narrower diagnosis, never a typed contract cause');
    assert.equal(await admissionStore.trySeal(unknownHook.admission), false);
    lifecycle.push('constructed-schema1-async-hook-incomplete-no-terminal-cause-isolated-ack');
    loader.handledActions.clear();
    const unrelatedOriginal = runPool(originalControls.get(33)); await unrelatedOriginal.pending;
    assert.equal(unrelatedOriginal.consumer.acked.length, 1); assert(unrelatedOriginal.publisher.sent.length > 0);
    assert(ids(memory, 'h45actionhandoff1:').some(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson).work.admissionId === originalControls.get(33).admission.id));
    lifecycle.push('unrelated-original33-progress-after-schema1-incomplete');
    loader.handledActions.clear();
    loader.handledActions.set('*', new Map([['setcode', corruptContract]]));
    const rawLoader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(rawLoader, {handledActions: new Map([['*', new Map([['onblock', compoundHook]])]]), handledDeltas: new Map(), parser, plugins: []});
    const rawConsumer = new ControlledConsumer(), rawPublisher = new ControlledPublisher();
    const rawPool = worker(Pool.prototype, rawConsumer, rawPublisher);
    Object.assign(rawPool, {mLoader: rawLoader, protocolDeliveryOwners: new WeakMap(), poolAbiCache: new Map(), poolTypeCache: new Map(),
        protocolCacheViews: new Set(), temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, txCacheExpiration: 3600,
        allowStreaming: true, common: {attachActionExtras: Pool.prototype.attachActionExtras}, ioRedisClient: pool.ioRedisClient,
        pushToActionsQueue() {assert.fail('parallel owned raw worker bypassed confirmed publication');}});
    const rawOriginal = mixed.messages.find(value => value.properties.headers.action_trace_ordinal === 0);
    const rawDelivery = {content: Buffer.from(rawOriginal.content), properties: structuredClone(rawOriginal.properties), fields: {deliveryTag: 1}};
    (controlledAttemptLifecycle(rawPool, 'ds_pool_worker'), rawPool).captureActionAdmissionDelivery(rawDelivery, rawConsumer); (controlledAttemptLifecycle(rawPool, 'ds_pool_worker'), rawPool).captureProtocolActionDelivery(rawDelivery, rawConsumer);
    const revokeGate = gate(); let revocationEntered = 0;
    memory.faults.beforeWrite = async request => {if (attemptManifest(request)) {revocationEntered++; await revokeGate.held;}};
    const revokedContract = runPool(originalControls.get(36), 1);
    const revokedRaw = rawPool.processMessages([rawDelivery]); revokedRaw.catch(() => {});
    await until(() => revocationEntered === 2, 'actual contract-no-output AND raw-native workers hold their new disposition writes');
    assert.equal(pool.protocolTrace, undefined); assert(pool.activeActionAdmission.proofView);
    assert.equal(pool.protocolDeliveryNativeEntries.size, 0, 'contract-only failure needs retained original ABI proof');
    assert.equal(rawPool.protocolTrace, undefined); assert(rawPool.activeActionAdmission.handoff.entries.some(entry => entry.work?.native));
    assert.equal(rawPublisher.sent.length, 2); assert.equal(rawConsumer.acked.length, 0); assert.equal(revokedContract.consumer.acked.length, 0);
    await pool.getProtocolProofReader().revalidate(pool.activeActionAdmission.proofView);
    const originalNativeView = rawPool.activeActionAdmission.nativeView;
    await rawPool.getProtocolNativeReader().revalidate(originalNativeView);
    assert.equal(await coordinator.revokeSource(reader.sourceContext.readerSessionId), true);
    revokeGate.release();
    await assert.rejects(revokedContract.pending, error => error.statusCode === 503 && error.name === 'ProtocolAbiProofUnavailableError');
    await assert.rejects(revokedRaw, error => error.statusCode === 503 && error.name === 'ProtocolNativeActionUnavailableError');
    assert.equal(revokedContract.consumer.acked.length, 0); assert.equal(rawConsumer.acked.length, 0); delete memory.faults.beforeWrite;
    assert.equal(mixedRows().length, 1, 'visible typed observation is not renewed canonical/native authority');
    lifecycle.push('original-contract-proof-and-mixed-native-view-revoked-across-disposition-writes-no-ack');
    loader.handledActions.clear();
    }
    if (!managedOriginalDs) console.log(JSON.stringify({passed: true, originalBlocks: mode === 'no-effects' ? 36 : mode === 'traces-disabled' ? 33 : mode === 'empty-vector' ? 1 : 39, constructedBlocks: mode === 'lifecycle' ? 3 : mode === 'empty-vector' ? 1 : 0, mode, lifecycle, cases: ['original-missing-traces-write-before-ack', 'operator-disabled-write-before-ds-ack'], controlledBrokerStorage: true, fullWorkerQualification: false}));
    }
    }
    assert.equal(nativeAddonResolutions, 0);
} finally {
    managedClient?.dispose();
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    if (snapshotPath) {
        const ownedSnapshot = resolve(snapshotPath); assert.equal(dirname(ownedSnapshot), resolve(tmpdir()));
        assert.match(basename(ownedSnapshot), /^hyperion-managed-wire-(?:main|ds)-[0-9a-f-]+\.json$/);
        rmSync(ownedSnapshot, {force: true});
    }
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-attempt-worker-original-/); rmSync(ownedDirectory, {recursive: true, force: true});
    if (managedOriginal) process.disconnect();
}
