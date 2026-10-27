/** Native original worker roles; service/SHiP/RabbitMQ transports are explicit controls. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import async from 'async';
import {fixtureWorkerTransport} from './controlled-worker-service-transport.mjs';

const role = process.env.worker_role, allowed = ['continuous_reader', 'deserializer', 'ds_pool_worker'];
assert(allowed.includes(role));
assert.equal(process.env.HYPERION_QUALIFICATION_PLAIN_PROOF, 'false');
assert.equal(process.env.HYPERION_QUALIFICATION_PLAIN_HANDOFF, 'false');
assert(!process.versions.bun && [24, 26].includes(Number(process.versions.node.split('.')[0])));
const sourceFamily = process.env.QUALIFICATION_SOURCE_FAMILY ?? 'wire';
assert(['wire', 'antelope'].includes(sourceFamily));
let nativeAddonLoads = 0, nativeContractDecodes = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (sourceFamily === 'wire') assert(!specifier.includes('node-abieos'), 'Wire source must not load the Antelope addon');
    else {assert(!specifier.includes('hyperion-wire-plugin'), 'Antelope source must not load Wire');
        if (specifier === '@eosrio/node-abieos') nativeAddonLoads++;}
    return next(specifier, context);
}});
const config = JSON.parse(readFileSync(process.env.CONFIG_JSON)), chain = config.settings.chain;
const chainId = process.env.QUALIFICATION_CHAIN_ID;
const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader},
    {loadChainProtocol}, {WorkerAttemptClient}, {ProtocolSourceBindingStore}, {ProtocolAbiObservationStore},
    {ActionSourceAdmissionStore}, {ProtocolAbiCoordinatorRpc}, {LiveReaderCheckpoint}] = await Promise.all([
    import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
    import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
    import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
    import('../../build/indexer/protocol/worker-attempt-client.js'), import('../../build/indexer/protocol/source-bindings.js'),
    import('../../build/indexer/protocol/abi-observation-store.js'), import('../../build/indexer/history/action-source-admission.js'),
    import('../../build/indexer/protocol/abi-coordinator-rpc.js'), import('../../build/indexer/helpers/reader-progress.js')]);
const selected = await loadChainProtocol(config.settings.protocol, {sourceEvidence: true}), observedScopes = new WeakSet();
if (sourceFamily === 'antelope') {
    assert.equal(selected.id, 'antelope'); assert(nativeAddonLoads > 0);
    const decode = selected.decoder.binToJson;
    selected.decoder.binToJson = (...args) => {if (args[0] === 'counter' && args[1] === 'setvalue') nativeContractDecodes++; return decode(...args);};
}
let worker, managed, lastScope, storageDispatches = 0, cacheDispatches = 0, finished, ready = false;
const finish = new Promise(resolve => {finished = resolve;});
const effects = () => ({storageDispatches, nativeContractDecodes, publisherDispatches: worker?.cch.sent.length ?? 0,
    originalAcks: worker?.ch.acked.length ?? 0, cacheDispatches, streamDispatches: worker?.ch.streamed.length ?? 0,
    physicallyPendingTransport: transport.pendingCount()});
const transport = fixtureWorkerTransport(process, ({kind, scope}) => {
    if (kind === 'es') storageDispatches++;
    if (scope) lastScope = scope;
    if (!scope || observedScopes.has(scope) || role !== 'ds_pool_worker') return;
    observedScopes.add(scope);
    scope.signal.addEventListener('abort', () => {
        process.send({event: 'qualification_scope_fenced', scope: scope.snapshot(), effects: effects()});
        const nativeView = worker.activeActionAdmission?.nativeView, proofView = worker.activeActionAdmission?.proofView;
        const revalidate = nativeView ? () => worker.getProtocolNativeReader().revalidate(nativeView)
            : proofView ? () => worker.getProtocolProofReader().revalidate(proofView) : undefined;
        if (revalidate) void revalidate().then(
            () => process.send({event: 'qualification_post_fence_probe', accepted: true, effects: effects()}),
            error => process.send({event: 'qualification_post_fence_probe', accepted: false, code: error.code,
                ownsFence: scope.ownsFenceError(error), effects: effects()}));
    }, {once: true});
});
try {
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const cm = {config, filters}, parser = new Parser(cm), loader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(loader, {handledActions: new Map(), handledDeltas: new Map(), parser, plugins: []});
    const prototype = role === 'continuous_reader' ? Reader.prototype : role === 'deserializer' ? Main.prototype : Pool.prototype;
    worker = Object.create(prototype);
    Object.assign(worker, {loadedActionAbis: new Map(), chain, chainId, conf: config, configModule: cm, filters, mLoader: loader,
        protocol: selected.provider, protocolId: selected.id, protocolComponents: selected.components,
        protocolReady: Promise.resolve(), abieos: selected.decoder, client: transport.client,
        ch: new transport.Consumer(), cch: new transport.Publisher(), ch_ready: true, cch_ready: true,
        profiler: {start: () => () => {}}, actionAdmissionOwners: new WeakMap(), protocolDeliveryOwners: new WeakMap(),
        actionAdmissionStore: new ActionSourceAdmissionStore(transport.client, chain, 1),
        protocolSourceBindingStore: new ProtocolSourceBindingStore(transport.client, chain, 1),
        protocolAbiObservationStore: new ProtocolAbiObservationStore(transport.client, chain, 1)});
    Object.defineProperty(worker, 'actionSourceAdmissionEnabled', {value: true});
    if (role !== 'continuous_reader') {
        managed = new WorkerAttemptClient({mode: 'managed', role, transport: process, timeoutMs: 1000, drainTimeoutMs: 5000, retries: 2});
        worker.configureWorkerAttemptLifecycle(managed);
    }
    if (role === 'continuous_reader') {
        Object.assign(worker, {baseRequest: {max_messages_in_flight: 1, have_positions: [], irreversible_only: false,
            fetch_block: true, fetch_traces: true, fetch_deltas: true}, shipRev: 'v0', ship: {connected: true},
            socketGeneration: 1, activeIngressGeneration: 1,
            physicalIngressGeneration: 1, isLiveReader: true, local_block_num: 0, local_lib: 0, receivedFirstBlock: true,
            reversibleBlockMap: new Map(), forkedBlocks: new Map(), publications: new Map(), sourceProbes: new Set(),
            liveCheckpoint: new LiveReaderCheckpoint(1, '', 256),
            send(request) {process.send({event: 'qualification_ship_request', request});}, handleStatusResult() {}});
        worker.coordinatorRpc = new ProtocolAbiCoordinatorRpc();
        // The controlled source and the genuine probe share one FIFO. Credit/capacity is not qualified here.
        worker.blockReadingQueue = async.queue(async item => {
            if (item.kind === 'frame') return worker.onMessage(item.data);
            if (item.kind === 'qualification-revoke') return worker.revokeCoordinatorSource();
            return worker.processIncomingBlocks([item]);
        }, 1);
        worker.stageOneDistQueue = async.queue(async payload => new Promise(resolve => worker.distribute([payload], resolve)), 1);
    } else if (role === 'deserializer') Object.assign(worker, {
        local_block_count: 0, lastSelectedWorker: 0, dsPoolMap: {}, ds_pool_counters: {}, block_emit_idx: 1,
        preIndexingQueue: {push: async value => process.send({event: 'qualification_derived_dispatch', queue: value.queue})}
    });
    else Object.assign(worker, {poolAbiCache: new Map(), poolTypeCache: new Map(), protocolCacheViews: new Set(),
        temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, txCacheExpiration: 3600, allowStreaming: true,
        common: {attachActionExtras: Pool.prototype.attachActionExtras},
        pushToActionsQueue() {assert.fail('Admitted output bypassed its actual confirmed publisher');},
        ioRedisClient: {pipeline() {return {hset() {return this;}, expire() {return this;}, async exec() {cacheDispatches++; return [];}};}}});
    async function command(input) {
        if (input.operation === 'effects') return {effects: effects(), scope: lastScope?.snapshot() ?? null};
        if (input.operation === 'initialize') {
            if (role === 'continuous_reader') {
                await worker.onMessage(Buffer.from(input.schemaJson));
                await worker.blockReadingQueue.push({kind: 'frame', data: Buffer.from(input.statusHex, 'hex')});
                worker.requestBlocks(1);
                return {readerSessionId: worker.sourceContext.readerSessionId, coordinatorGeneration: worker.coordinatorSource.generation,
                    requestedStartBlock: worker.baseRequest.start_block_num};
            }
            await worker.initializeProtocolShip(input.schemaJson); return {};
        }
        if (input.operation === 'frame') {
            assert.equal(role, 'continuous_reader');
            await worker.blockReadingQueue.push({kind: 'frame', data: Buffer.from(input.frameHex, 'hex')});
            return {sourceContext: worker.sourceContext.id, readerSessionId: worker.sourceContext.readerSessionId,
                coordinatorGeneration: worker.coordinatorSource.generation};
        }
        if (input.operation === 'revoke') {
            assert.equal(role, 'continuous_reader');
            await worker.blockReadingQueue.push({kind: 'qualification-revoke'}); return {};
        }
        if (input.operation === 'reconnect') {
            assert.equal(role, 'continuous_reader');
            worker.physicalIngressGeneration++; worker.activeIngressGeneration = worker.physicalIngressGeneration;
            await worker.blockReadingQueue.push({kind: 'connected', generation: worker.physicalIngressGeneration});
            await worker.onMessage(Buffer.from(input.schemaJson));
            await worker.blockReadingQueue.push({kind: 'frame', data: Buffer.from(input.statusHex, 'hex')});
            worker.requestBlocks(1);
            return {readerSessionId: worker.sourceContext.readerSessionId, coordinatorGeneration: worker.coordinatorSource.generation,
                requestedStartBlock: worker.baseRequest.start_block_num};
        }
        if (input.operation === 'delivery') {
            assert.notEqual(role, 'continuous_reader');
            const message = {content: Buffer.from(input.delivery.payloadHex, 'hex'),
                properties: {headers: structuredClone(input.delivery.options.headers)}, fields: {deliveryTag: input.tag, redelivered: !!input.redelivered}};
            worker.captureActionAdmissionDelivery(message, worker.ch);
            if (role === 'deserializer') {
                worker.captureProtocolSourceDelivery(message, worker.ch);
                await parser.parseMessage(worker, [message]);
            } else {
                worker.captureProtocolActionDelivery(message, worker.ch);
                await worker.processMessages([message]);
            }
            return {effects: effects()};
        }
        assert.fail('Unknown controlled source command');
    }
    process.on('message', message => {
        if (message?.event === 'qualification_finish') finished();
        else if (message?.event === 'qualification_command') {
            void command(message.input).then(value => process.send({event: 'qualification_command_reply', id: message.id, ok: true, value}),
                error => process.send({event: 'qualification_command_reply', id: message.id, ok: false,
                    error: {name: error.name, code: error.code, message: error.message, statusCode: error.statusCode}}));
        } else if (ready && ['protocol_abi_coordinator_reply', 'protocol_source_probe_request'].includes(message?.event))
            worker.onIpcMessage(message);
    });
    ready = true;
    process.send({event: 'qualification_ready', sourceFamily, nativeAddonLoads, role, pid: process.pid, runtime: process.version,
        executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
        execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null});
    await finish;
    assert.equal(transport.pendingCount(), 0);
} finally {
    managed?.dispose(); worker?.shipSession?.close?.(); transport.close(); hooks.deregister(); process.disconnect();
}
