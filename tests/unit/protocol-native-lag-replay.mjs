/** #277 causal qualification using unchanged original Wire frames and actual emitted worker methods.
 * Normal installed native engineering profile; controlled broker/storage transport, no live-service qualification. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve, isAbsolute} from 'node:path';
import {Session} from 'node:inspector';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {proofMeasurementTransport} from './protocol-native-lag-transport.mjs';

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-native-worker-original-'));
// Current regression only. Historical diagnostic/default/measurement modes retain their original source scope.
const boundaryArgument = process.argv.find(value => value.startsWith('--queued-proof-boundary='));
const queuedDistance = boundaryArgument === undefined ? undefined : Number(boundaryArgument.split('=')[1]);
assert(queuedDistance === undefined || [256, 257].includes(queuedDistance));
const finalHead = queuedDistance === undefined ? 290 : 33 + queuedDistance;
const elasticsearchUrl = process.env.HYPERION_PROOF_ES_URL;
if (queuedDistance !== undefined) assert(!elasticsearchUrl && !process.argv.includes('--measure')
    && !process.argv.includes('--assert-pending-native-preserved') && !process.env.HYPERION_PROOF_CPU_PROFILE_DIR,
    'current queued regression uses only the controlled transport, without diagnostic measurement modes');
const chain = elasticsearchUrl ? process.env.HYPERION_PROOF_ES_CHAIN : 'native-worker-original';
assert.equal(typeof chain, 'string');
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d', blockId = number => number.toString(16).padStart(64, '0');
const repetitions = Number(process.env.HYPERION_PROOF_MEASURE_REPETITIONS ?? (elasticsearchUrl ? 5 : 3));
assert(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 20);
const cpuDirectory = process.env.HYPERION_PROOF_CPU_PROFILE_DIR;
if (cpuDirectory) {assert(isAbsolute(cpuDirectory)); assert(statSync(cpuDirectory).isDirectory());}
const hash = value => createHash('sha256').update(value).digest('hex');
const events = [], sourceFrames = [], blockWrites = [], cache = [];
const cpuProfiles = [];
const setupBegan = process.hrtime.bigint(), setupCpu = process.cpuUsage();
let reader, coordinator, transport, draining = Promise.resolve();
const attemptClients = [];
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
    observer;
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options)});
        this.observer?.('publication-start', queue, payload.length);
        const confirmed = () => {this.observer?.('publication-confirmed', queue, payload.length); confirm();};
        if (this.held) {this.entered?.(); this.held.then(confirmed);}
        else queueMicrotask(confirmed); return true;
    }
}
function message(sent) {return {content: Buffer.from(sent.payload), properties: {headers: structuredClone(sent.options.headers)}, fields: {deliveryTag: 1}};}
async function ticks() {for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));}
async function readCpuProfile(sourceHead) {
    if (!cpuDirectory) return async () => {};
    const session = new Session(); session.connect();
    const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', {interval: 1000});
    await post('Profiler.start');
    const startedMonotonicNs = process.hrtime.bigint().toString(), startedAtUtc = new Date().toISOString();
    return async () => {
        try {
            const {profile} = await post('Profiler.stop');
            const data = JSON.stringify(profile), path = join(cpuDirectory, `proof-read-head-${sourceHead}-pid-${process.pid}.cpuprofile`);
            writeFileSync(path, data, {flag: 'wx'});
            const record = {sourceHead, path, bytes: Buffer.byteLength(data), sha256: hash(data), startedMonotonicNs,
                endedMonotonicNs: process.hrtime.bigint().toString(), startedAtUtc, endedAtUtc: new Date().toISOString(),
                scope: 'stable-head public read/authorize/decode window only; excludes source preparation and fault controls; includes measurement overhead'};
            cpuProfiles.push(record); console.log(JSON.stringify({cpuProfile: record}));
        } finally {session.disconnect();}
    };
}
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
    assert.equal(manifest.profileId, 'wire-sysio-6508c9e8-engineering-v1');
    const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
    const fixture = {profileId, handshake: JSON.parse(schemaJson), frameHex: readFileSync(join(sourceDir, 'block-000033.bin')).toString('hex')};
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000, es_replicas: 0,
        },
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: false, disable_indexing: false, live_reader: true},
        features: {contract_console: false, failed_trx: false, streaming: {traces: true, deltas: false}},
        scaling: {ds_pool_size: 1, ds_queues: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 1},
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
    const installed = await loadChainProtocol(config.settings.protocol);
    assert.equal(installed.provider.nativeActions.interfaceVersion, 1);
    assert(installed.components.every(component => component.sourceRevision === '7167659e9c043cb3351074fcacb40200cc57f3a3'));
    const descriptor = JSON.parse(readFileSync(join(wireRoot, 'dist/protocol-provider.json')));
    for (const id of ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1']) {
        const profile = descriptor.profiles.find(profile => profile.id === id); assert(profile);
        assert.equal(Object.hasOwn(profile, 'nativeActions'), false);
    }
    const selected = installed;
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const codec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(profileId));
    const originalCodec = wire.createWireValueCodec(fixture.handshake, wire.resolveCodecProfile(fixture.profileId));
    const template = originalCodec.decode('result', Buffer.from(fixture.frameHex, 'hex'));
    const originalTrace = originalCodec.decode('transaction_trace[]', Buffer.from(template[1].traces, 'hex'))[0][1];
    const originalBlock = originalCodec.decode('signed_block', Buffer.from(template[1].block, 'hex'));
    const memory = transport = await proofMeasurementTransport({chain, url: elasticsearchUrl});
    const bindings = new ProtocolSourceBindingStore(memory.client, chain);
    const measurements = [], measurementEnabled = process.argv.includes('--measure');
    let measurement;
    const instrument = (method, operation) => async (...args) => {
        const active = measurement;
        if (!active) return operation(...args);
        const began = process.hrtime.bigint();
        let response, error;
        try {response = await operation(...args); return response;}
        catch (caught) {error = caught; throw caught;}
        finally {
            const elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
            const serializeBegan = process.hrtime.bigint();
            const source = response?._source;
            const rows = ['create', 'index'].includes(method) ? active.writes : active.reads;
            rows.push({method, index: args[0].index, id: args[0].id ?? null,
                bundleId: source?.bundle_id ?? null, kind: source?.kind ?? null,
                found: response?.found === true, failed: error !== undefined,
                requestJsonBytes: Buffer.byteLength(JSON.stringify(args[0])),
                responseJsonBytes: response === undefined ? 0 : Buffer.byteLength(JSON.stringify(response)),
                documentJsonBytes: source === undefined ? 0 : Buffer.byteLength(JSON.stringify(source)), elapsedMs});
            active.measurementSerializationMs += Number(process.hrtime.bigint() - serializeBegan) / 1e6;
        }
    };
    memory.client.get = instrument('get', memory.client.get.bind(memory.client));
    memory.client.indices.getMapping = instrument('getMapping', memory.client.indices.getMapping.bind(memory.client.indices));
    memory.client.indices.getSettings = instrument('getSettings', memory.client.indices.getSettings.bind(memory.client.indices));
    memory.client.create = instrument('create', memory.client.create.bind(memory.client));
    memory.client.index = instrument('index', memory.client.index.bind(memory.client));
    const measured = async (metadata, work) => {
        assert.equal(measurement, undefined, 'public calls must be measured sequentially at a quiescent source head');
        const active = {...metadata, reads: [], writes: [], measurementSerializationMs: 0,
            startedAtUtc: new Date().toISOString(), startedMonotonicNs: process.hrtime.bigint().toString()};
        const began = process.hrtime.bigint(), cpu = process.cpuUsage(), memoryBefore = process.memoryUsage();
        measurement = active;
        try {return await work();}
        catch (error) {active.errorCode = error?.code ?? error?.name ?? 'opaque'; throw error;}
        finally {
            measurement = undefined;
            active.elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
            active.endedAtUtc = new Date().toISOString(); active.endedMonotonicNs = process.hrtime.bigint().toString();
            active.cpu = process.cpuUsage(cpu); active.memoryBefore = memoryBefore; active.memoryAfter = process.memoryUsage();
            active.getCount = active.reads.filter(value => value.method === 'get').length;
            active.metadataGetCount = active.reads.filter(value => value.method !== 'get').length;
            active.allClientGetCount = active.reads.length;
            active.requestJsonBytes = active.reads.reduce((total, value) => total + value.requestJsonBytes, 0);
            active.responseJsonBytes = active.reads.reduce((total, value) => total + value.responseJsonBytes, 0);
            active.documentResponseJsonBytes = active.reads.filter(value => value.method === 'get').reduce((total, value) => total + value.responseJsonBytes, 0);
            active.metadataResponseJsonBytes = active.responseJsonBytes - active.documentResponseJsonBytes;
            active.writeCount = active.writes.length;
            active.writeRequestJsonBytes = active.writes.reduce((total, value) => total + value.requestJsonBytes, 0);
            active.writeResponseJsonBytes = active.writes.reduce((total, value) => total + value.responseJsonBytes, 0);
            const commits = active.reads.filter(value => value.bundleId?.startsWith('h45abicmt1:'));
            active.commitGetCount = commits.length;
            active.uniqueCommitBundleCount = new Set(commits.map(value => value.bundleId)).size;
            measurements.push(active);
            if (elasticsearchUrl) console.log(JSON.stringify({phaseMeasurement: active}));
        }
    };
    const observations = new ProtocolAbiObservationStore(memory.client, chain), frontier = new ProtocolAbiFrontierStore(memory.client, chain);
    const admissionStore = new ActionSourceAdmissionStore(memory.client, chain), targetName = `${chain}-action-v1-000001`;
    if (elasticsearchUrl) await memory.initializeTarget(targetName);
    else {
        memory.settings.set(targetName, {'index.uuid': 'owned-wire-admission-target'});
        memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    }
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    const cm = {config, filters}, parser = new Parser(cm), loader = Object.create(HyperionModuleLoader.prototype);
    Object.assign(loader, {handledActions: new Map(), handledDeltas: new Map(), parser, plugins: []});
    let fault;
    loader.handledActions.set('*', new Map([['onblock', async action => {
        if (fault === 'value') action.act.data.timestamp = 'invalid-retained-value';
        if (fault === 'metadata') action.protocol.native.nativeKind = 'caller-selected';
    }]]));
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
    let supervisor, describeEnd;
    const acceptedEnds = [];
    if (queuedDistance !== undefined) {
        const [{WorkerAttemptSupervisor, describeWorkerAttemptEnd}, {WorkerAttemptClient}] = await Promise.all([
            import('../../build/indexer/protocol/worker-attempt-supervisor.js'),
            import('../../build/indexer/protocol/worker-attempt-client.js')]);
        supervisor = new WorkerAttemptSupervisor({onEnd: end => acceptedEnds.push(end)});
        describeEnd = end => describeWorkerAttemptEnd(supervisor, end);
        for (const [worker, role] of [[main, 'deserializer'], [pool, 'ds_pool_worker']]) {
            // Same explicit controlled IPC seam as the supervisor tests; only production methods issue accepted ends.
            const physical = new EventEmitter(), child = new EventEmitter();
            physical.isConnected = () => true;
            physical.send = (message, callback) => {child.emit('message', structuredClone(message)); callback?.(null); return true;};
            child.send = (message, callback) => {physical.emit('message', structuredClone(message)); callback?.(null); return true;};
            supervisor.attach(physical, role);
            const client = new WorkerAttemptClient({mode: 'managed', role, transport: child});
            worker.configureWorkerAttemptLifecycle(client); attemptClients.push(client);
        }
    }
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
    const originalStatus = readFileSync(join(sourceDir, 'status.bin'));
    assert.equal(hash(originalStatus), '8806e481f5e310068eb5ff86506e5d39c1acee5444cd11326744d4fd8b1d8deb');
    await reader.onMessage(originalStatus);
    const prepare = async bytes => {
        const before = readerPublisher.sent.length, mainBefore = mainPublisher.sent.length;
        assert.equal(await reader.onMessage(bytes), 'block'); await ticks();
        assert.equal(readerPublisher.sent.length, before + 1);
        const raw = readerPublisher.sent.at(-1), delivery = message(raw);
        assert.equal(raw.options.mandatory, true); assert.equal(raw.options.persistent, true);
        assert.ok(raw.payload.equals(bytes)); assert.ok(raw.options.headers[actionSourceIngressHeader]);
        const retainedIngress = await admissionStore.resolveIngress(raw.options.headers[actionSourceIngressHeader]);
        assert.equal(retainedIngress.frameHex, bytes.toString('hex'));
        main.captureActionAdmissionDelivery(delivery, mainConsumer); main.captureProtocolSourceDelivery(delivery, mainConsumer);
        await parser.parseMessage(main, [delivery]); await draining;
        assert.equal(mainConsumer.acked.at(-1), delivery);
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
            if (queuedDistance === undefined) await assert.rejects(pool.getProtocolNativeReader().waitForOpen({chainId, blockNum: 1,
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

    assert.equal(config.settings.protocol_abi_coordination, undefined, 'the actual default 256 ancestry remains in force');
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json')));
    assert.equal(lock.packages['node_modules/@eosrio/hyperion-wire-plugin'].resolved,
        'git+ssh://git@github.com/eosrio/hyperion-wire-plugin.git#7167659e9c043cb3351074fcacb40200cc57f3a3');
    assert.equal(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved,
        'git+ssh://git@github.com/eosrio/hyperion-sdk.git#8d37e932df5e0e7d671c9682505de3dd55f0edb4');
    const began = process.hrtime.bigint();
    const stageTimings = {setup: {elapsedMs: Number(began - setupBegan) / 1e6, cpu: process.cpuUsage(setupCpu)}, sourcePreparation: []};
    let pending, control, rewindSelection, lastMeasuredNativeView, lastMeasuredNativeGrant;
    const controls = [], duplicateCommitReads = [];
    const original = expected.get(33), point = {chainId, blockNum: 33, blockId: original.blockId};
    for (let number = 1; number <= finalHead; number++) {
        const bytes = readFileSync(join(sourceDir, 'block-' + String(number).padStart(6, '0') + '.bin'));
        assert.equal(bytes.length, frameIndex.get(number).bytes); assert.equal(hash(bytes), frameIndex.get(number).sha256);
        const prepareBegan = process.hrtime.bigint(), prepareCpu = process.cpuUsage();
        const prepared = await prepare(bytes);
        stageTimings.sourcePreparation.push({blockNum: number, originalFrameBytes: bytes.length,
            elapsedMs: Number(process.hrtime.bigint() - prepareBegan) / 1e6, cpu: process.cpuUsage(prepareCpu)});
        if (number === 289) rewindSelection = prepared.sourceSelectionId;
        if (number === 33) {pending = prepared; assert.equal(pending.messages.length, 1);
            assert.deepEqual(bytes, readFileSync(join(originalDir, 'block-000033.bin')));}
        if (number === 34 && queuedDistance === undefined) {
            const proof = await pool.getProtocolProofReader().waitForOpen(point, pending.sourceSelectionId);
            const nativeReader = pool.getProtocolNativeReader(), view = await nativeReader.waitForOpen(point, pending.sourceSelectionId);
            const input = pending.admission.source.inventoryInput.wireActionInputs.find(value => value.globalSequence === original.globalSequence);
            const decision = await nativeReader.authorize(view, input); assert.equal(decision.kind, 'native');
            assert.deepEqual(await nativeReader.decodeValue(decision.grant), original.expectedValue);
            control = {head: number, distance: 1, exactOriginalNativeDecoded: true, proofSelectionId: proof.selectionId};
        }
        if (measurementEnabled && number === 122) {
            const before = poolPublisher.sent.length, ackBefore = poolConsumer.acked.length, broker = [];
            poolPublisher.observer = (event, queue, bytes) => broker.push({event, queue, bytes, monotonicNs: process.hrtime.bigint().toString()});
            poolConsumer.onAck = () => broker.push({event: 'consumer-ack', monotonicNs: process.hrtime.bigint().toString()});
            try {
                await measured({stage: 'control.dsProcessOriginal122', sourceHead: number}, () => pool.processMessages(prepared.messages));
            } finally {poolPublisher.observer = undefined; poolConsumer.onAck = undefined;}
            const published = poolPublisher.sent.slice(before); assert.equal(published.length, 1);
            const document = JSON.parse(published[0].payload);
            assert.deepEqual(document.act.data, expected.get(122).expectedValue);
            assert.equal(document.protocol.kind, 'native'); assert.equal(document.ds_error, undefined);
            assert.equal(published[0].options.persistent, true); assert.equal(published[0].options.mandatory, true);
            assert.equal(published[0].payload.toString(), actionHistoryImmutableJson(document));
            assert.equal(poolConsumer.acked.length - ackBefore, 1);
            assert.equal(await measured({stage: 'control.membershipSealOriginal122', sourceHead: number}, () => admissionStore.trySeal(prepared.admission)), true);
            const manifest = await admissionStore.journal.readManifest(prepared.admission.planId);
            assert.deepEqual(manifest.manifest.fragments.flatMap(fragment => fragment.effects), [fingerprintActionHistoryEffect(document)]);
            const confirmed = broker.find(row => row.event === 'publication-confirmed'), ack = broker.find(row => row.event === 'consumer-ack');
            assert(confirmed && ack && BigInt(confirmed.monotonicNs) <= BigInt(ack.monotonicNs));
            controls.push({kind: 'successful-original-native122-ds-publication-and-membership', publishedActions: 1,
                exactOracleValue: true, sealed: true, acknowledged: 1, brokerTransport: 'controlled-confirmed-channel', broker});
        }
        if (measurementEnabled && [34, 65, 265, 289].includes(number)) {
            const distance = number - point.blockNum;
            const stopProfile = await readCpuProfile(number);
            try {
            for (let repetition = 0; repetition < repetitions; repetition++) {
                const count = measurements.length;
                await measured({stage: 'abi.waitForOpen', sourceHead: number, distance, repetition}, () =>
                    pool.getProtocolProofReader().waitForOpen(point, pending.sourceSelectionId));
                const nativeReader = pool.getProtocolNativeReader();
                const view = await measured({stage: 'native.waitForOpen', sourceHead: number, distance, repetition}, () =>
                    nativeReader.waitForOpen(point, pending.sourceSelectionId));
                const input = pending.admission.source.inventoryInput.wireActionInputs.find(value => value.globalSequence === original.globalSequence);
                const decision = await measured({stage: 'native.authorize', sourceHead: number, distance, repetition}, () => nativeReader.authorize(view, input));
                assert.equal(decision.kind, 'native');
                const decoded = await measured({stage: 'native.decodeValue', sourceHead: number, distance, repetition}, () => nativeReader.decodeValue(decision.grant));
                assert.deepEqual(decoded, original.expectedValue);
                lastMeasuredNativeView = view; lastMeasuredNativeGrant = decision.grant;
                const [abi, native] = measurements.slice(count, count + 2);
                for (const metric of [abi, native]) {
                    assert.equal(metric.commitGetCount, 2 * (distance + 1));
                    assert.equal(metric.uniqueCommitBundleCount, distance + 1);
                }
                const first = new Set(abi.reads.filter(value => value.bundleId?.startsWith('h45abicmt1:')).map(value => value.index + '\0' + value.id));
                const duplicate = native.reads.filter(value => first.has(value.index + '\0' + value.id));
                assert.equal(duplicate.length, 2 * (distance + 1));
                duplicateCommitReads.push({sourceHead: number, distance, repetition, repeatedExactCommitDocuments: duplicate.length,
                    totalCommitGets: abi.commitGetCount + native.commitGetCount});
            }
            } finally {await stopProfile();}
            if (number === 34) {
                const nativeReader = pool.getProtocolNativeReader(), cancelled = new AbortController(), reason = {request: 'measurement-cancelled'};
                cancelled.abort(reason);
                await assert.rejects(measured({stage: 'guard.preCancelledNative', sourceHead: number, distance}, () =>
                    nativeReader.waitForOpen(point, pending.sourceSelectionId, {signal: cancelled.signal})), error => error === reason);
                assert.equal(measurements.at(-1).getCount, 0);
                let enter, release;
                const entered = new Promise(resolve => {enter = resolve;}), held = new Promise(resolve => {release = resolve;});
                let claimed = false;
                const holdRead = async request => {
                    if (!claimed && request.id.startsWith('h45abicmt1:')) {claimed = true; enter(); await held;}
                };
                if (elasticsearchUrl) memory.faults.afterRead = (_response, request) => holdRead(request);
                else memory.faults.beforeRead = holdRead;
                const controller = new AbortController(), exactReason = {request: 'native-cancelled-during-real-proof-read'};
                const waiting = measured({stage: 'guard.cancelInFlightNative', sourceHead: number, distance}, async () => {
                    try {return await nativeReader.waitForOpen(point, pending.sourceSelectionId, {signal: controller.signal});}
                    finally {release(); await ticks();}
                }).catch(error => error);
                await entered; controller.abort(exactReason);
                assert.equal(await waiting, exactReason);
                delete memory.faults.beforeRead; delete memory.faults.afterRead;
                controls.push({kind: 'real-native-wait-cancellation', sourceHead: number, exactReason: true, preCancelledGets: 0,
                    fault: elasticsearchUrl ? 'hold an actual Elasticsearch response before consumption; no socket-cancellation claim' : 'hold the controlled immutable transport read'});
                let corruptReads = 0;
                memory.faults.read = (response, request) => {
                    if (request.id.startsWith('h45natobs1:') && response._source.kind === 'manifest') {
                        corruptReads++; return {...response, _source: {...response._source, byte_length: 64 * 1024 * 1024 + 1}};
                    }
                    return response;
                };
                await assert.rejects(measured({stage: 'guard.nativeRetainedSize', sourceHead: number, distance}, () =>
                    nativeReader.waitForOpen(point, pending.sourceSelectionId)), {code: 'native_retained_invalid'});
                delete memory.faults.read;
                assert.equal(corruptReads, 1);
                assert(Object.isFrozen(await nativeReader.waitForOpen(point, pending.sourceSelectionId)));
                controls.push({kind: 'real-native-reader-oversized-manifest-rejected', sourceHead: number,
                    fault: 'controlled-transport-only; original retained documents unchanged', corruptReads, restoredSiblingOpen: true});
            }
        }
    }
    const current = await frontier.readControl(); assert.equal(current.value.head.blockNum, finalHead);
    assert(pending.messages.every(message => !poolConsumer.acked.includes(message)), 'the genuine original action must still be queued');
    if (queuedDistance !== undefined) {
        const delivery = pending.messages[0], originalPayload = Buffer.from(delivery.content), originalHeaders = structuredClone(delivery.properties.headers);
        assert.equal(hash(originalPayload), '52ff71eac764d107780fca90bfda9dc60808402adc5e760db91a12443d12365c');
        assert.equal(typeof original.globalSequence, 'string');
        assert(pending.admission.source.inventoryInput.wireActionInputs.some(input => input.globalSequence === original.globalSequence
            && input.rawHex === original.rawHex && input.actionOrdinal === original.actionOrdinal && input.transactionId === original.transactionId));
        const originalEnds = () => acceptedEnds.map(describeEnd).filter(end => end.role === 'ds_pool_worker'
            && end.binding.admissionId === pending.admission.id);
        assert.equal(originalEnds().length, 0);
        const broker = [], before = poolPublisher.sent.length, ackBefore = poolConsumer.acked.length;
        poolPublisher.observer = event => broker.push(event);
        poolConsumer.onAck = message => {assert.equal(message, delivery); broker.push('consumer-ack');};
        let release, entered;
        const held = new Promise(yes => {release = yes;}), confirming = new Promise(yes => {entered = yes;});
        poolPublisher.held = held; poolPublisher.entered = entered;
        const processing = pool.processMessages(pending.messages);
        if (queuedDistance === 256) {
            try {
                await Promise.race([confirming, processing.then(() => assert.fail('original publication must await its confirm'))]);
                assert.equal(poolConsumer.acked.length, ackBefore);
                assert.equal(originalEnds().length, 0, 'held original operation has no accepted end');
                await assert.rejects(admissionStore.journal.readManifest(pending.admission.planId), {code: 'missing', recordKind: 'seal'});
            } finally {release();}
        }
        await processing;
        const output = poolPublisher.sent.slice(before), sealed = await admissionStore.trySeal(pending.admission);
        const incomplete = ids(memory, 'h45actionincomplete1:').map(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson))
            .filter(value => value.admissionId === pending.admission.id);
        assert(delivery.content.equals(originalPayload)); assert.deepEqual(delivery.properties.headers, originalHeaders);
        assert.equal(poolConsumer.acked.length - ackBefore, 1);
        const ends = originalEnds(); assert.equal(ends.length, 1);
        const end = ends[0];
        assert.throws(() => describeEnd({...end}), /Unissued/, 'copied end metadata is not a supervisor-issued capability');
        assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'returned'); assert.equal(end.acknowledgementAttempted, true);
        assert.equal(end.descriptor.payloadSha256, hash(originalPayload)); assert.equal(end.descriptor.kind, 'ds-delivery');
        assert.equal(end.binding.selectionId, pending.sourceSelectionId); assert.equal(end.binding.planId, pending.admission.planId);
        assert.equal(end.binding.blockNum, 33); assert.equal(end.binding.blockId, original.blockId); assert.equal(end.binding.traceOrdinal, 0);
        if (queuedDistance === 256) {
            assert.equal(output.length, 1); assert.equal(sealed, true); assert.equal(incomplete.length, 0);
            const document = JSON.parse(output[0].payload);
            assert.deepEqual(document.act.data, original.expectedValue); assert.equal(document.protocol.kind, 'native');
            assert.equal(typeof document.global_sequence, 'string'); assert.equal(document.global_sequence, original.globalSequence);
            assert.equal(document.protocol.selectionId, pending.sourceSelectionId);
            assert.equal(document.protocol.input.rawHex, original.rawHex); assert.equal(document.protocol.native.nativeKind, original.nativeKind);
            assert.equal(document.ds_error, undefined); assert.equal(output[0].payload.toString(), actionHistoryImmutableJson(document));
            assert.equal(output[0].options.persistent, true); assert.equal(output[0].options.mandatory, true);
            const manifest = await admissionStore.journal.readManifest(pending.admission.planId);
            assert.deepEqual(manifest.manifest.fragments.flatMap(fragment => fragment.effects), [fingerprintActionHistoryEffect(document)]);
            assert.deepEqual(broker, ['publication-start', 'publication-confirmed', 'consumer-ack']);
            assert.equal(end.freshWrites.filter(write => write.kind === 'confirmed-handoff').length, 1);
        } else {
            assert.equal(output.length, 0); assert.equal(sealed, false); assert.equal(incomplete.length, 1);
            assert(events.some(value => value.event === 'ds_error' && value.data?.type === 'protocol_action_incomplete'
                && value.data.message.includes('outside verified ancestry')));
            assert.deepEqual(broker, ['consumer-ack']);
            assert.equal(end.freshWrites.filter(write => write.classification === 'confirmed-handoff').length, 0);
        }
        console.log(JSON.stringify({scenario: 'current-queued-native-proof-boundary', passed: true, runtime: process.version,
            sourceHead: finalHead, sourceDistance: queuedDistance, queuedBlock: 33, defaultAncestryBlocks: 256,
            originalArchiveSha256: extracted.archiveSha256, originalPendingFrameSha256: frameIndex.get(33).sha256,
            originalPayloadSha256: hash(originalPayload), originalSelectionId: pending.sourceSelectionId, originalGlobalSequence: original.globalSequence,
            publishedActions: output.length, sealed, retainedIncomplete: incomplete.length,
            consumerAcknowledgments: poolConsumer.acked.length - ackBefore, acceptedOriginalEnd: true, originalEnd: end,
            controlledBrokerStorage: true, controlledLifecycleTransport: true, brokerSettlement: 'unknown',
            recoveredPersistedAssociation: false,
            fullWorkerQualification: false, productionPerformanceQualified: false}));
    } else {
    const nativeReader = pool.getProtocolNativeReader();
    await assert.rejects(nativeReader.waitForOpen(point, pending.sourceSelectionId), {code: 'ancestry_unavailable'});
    assert.deepEqual(await selected.provider.nativeActions.decodeValue(original.nativeKind, Buffer.from(original.rawHex, 'hex')), original.expectedValue,
        'the source/value codec remains correct while canonical membership expires');
    const before = poolPublisher.sent.length, ackBefore = poolConsumer.acked.length;
    const consumeBegan = process.hrtime.bigint(), consumeCpu = process.cpuUsage();
    await measured({stage: 'control.dsExpiredOriginal33', sourceHead: 290, distance: 257}, () => pool.processMessages(pending.messages));
    stageTimings.consumerExpiry = {elapsedMs: Number(process.hrtime.bigint() - consumeBegan) / 1e6, cpu: process.cpuUsage(consumeCpu)};
    const output = poolPublisher.sent.slice(before);
    const incompleteIds = ids(memory, 'h45actionincomplete1:');
    const incomplete = incompleteIds.map(id => JSON.parse(retained(memory, admissionStore.index, id).payloadJson));
    const matchingIncomplete = incomplete.filter(value => value.admissionId === pending.admission.id);
    const failures = events.filter(value => value.event === 'ds_error' && value.data?.type === 'protocol_action_incomplete');
    const sealed = await measured({stage: 'control.membershipSealExpired33', sourceHead: 290, distance: 257}, () => admissionStore.trySeal(pending.admission));
    for (const metric of measurements) {
        assert.equal(metric.getCount, metric.reads.filter(value => value.method === 'get').length);
        assert.equal(metric.allClientGetCount, metric.reads.length);
    }
    if (measurementEnabled) {
        // A genuine issued grant may survive monotone progress; it must still be revoked by a real recovery generation.
        assert.deepEqual(await nativeReader.decodeValue(lastMeasuredNativeGrant), original.expectedValue);
        const prior = await coordinator.inspect();
        const admission = await coordinator.admit(rewindSelection, prior.generation);
        assert.equal(admission.status, 'accepted');
        const recovering = await coordinator.inspect();
        assert.notEqual(recovering.generation, prior.generation); assert.equal(recovering.head.blockNum, 288);
        const input = pending.admission.source.inventoryInput.wireActionInputs.find(value => value.globalSequence === original.globalSequence);
        await assert.rejects(nativeReader.authorize(lastMeasuredNativeView, input), {code: 'authority_changed'});
        await assert.rejects(nativeReader.decodeValue(lastMeasuredNativeGrant), {code: 'authority_changed'});
        await coordinator.drain();
        assert.equal((await coordinator.inspect()).head.blockNum, 289);
        assert(Object.isFrozen(await nativeReader.waitForOpen(point, pending.sourceSelectionId)));
        controls.push({kind: 'actual-coordinator-recovery-generation-invalidates-issued-native-authority',
            orchestration: 'controlled rewind/replay of unchanged original selection289 after290; not a captured network fork',
            originalHead: 290, recoveredParent: 288, replayedHead: 289, staleViewRejected: true,
            staleGrantRejected: true, monotoneAdvanceRetainedOriginalGrant: true, newCanonicalOpenAfterReplay: true});
    }
    const report = {scenario: 'genuine-pending-native-source-expires', runtime: process.version,
        host: {platform: process.platform, arch: process.arch}, sourceHead: 290, queuedBlock: 33, sourceDistance: 257,
        defaultAncestryBlocks: 256, originalArchiveSha256: extracted.archiveSha256, originalBlocks: 290,
        originalPendingFrameSha256: frameIndex.get(33).sha256, profileId, components: selected.components,
        normalInstalledNativeSelection: true, syntheticSourceFrames: false, control,
        codecStillDecodesExactOriginal: true, publishedActions: output.length,
        consumerAcknowledgments: poolConsumer.acked.length - ackBefore, sealed, incomplete: matchingIncomplete, failures,
        measurements, duplicateCommitReads, controls, stageTimings, repetitions, cpuProfiles,
        transport: {kind: memory.kind, serverVersion: memory.serverVersion ?? null, serverBuildHash: memory.serverBuildHash ?? null,
            clusterUuid: memory.clusterUuid ?? null, ownedIndices: memory.ownedIndices ?? [], cleanup: 'real ES indices retained for root-owned evidence and cleanup'},
        measurementLimits: {storageTransport: elasticsearchUrl ? 'actual pinned Elasticsearch client and 9.5.5 server' : 'in-memory immutable/CAS transport, not Elasticsearch HTTP',
            byteCounts: 'JSON UTF-8 request/response objects, excluding HTTP framing, compression and network',
            elapsedCpu: 'includes measurement serialization overhead; not production or per-function CPU attribution',
            syntheticSourceFrames: false, faultControls: 'explicitly injected transport faults, not captured chain behavior'},
        elapsedMs: Number(process.hrtime.bigint() - began) / 1e6,
        controlledBrokerStorage: !elasticsearchUrl, controlledBrokerTransport: true, realElasticsearchStore: Boolean(elasticsearchUrl),
        fullWorkerQualification: false, productionPerformanceQualified: false};
    console.log(JSON.stringify(report));
    if (process.argv.includes('--assert-pending-native-preserved')) {
        assert.equal(output.length, 1, 'Genuine pending native action must survive ordinary canonical-source progress without becoming permanently incomplete');
        assert.equal(sealed, true, 'Every genuine original action must retain a complete source membership seal');
    } else {
        assert.equal(output.length, 0); assert.equal(sealed, false);
        assert.equal(matchingIncomplete.length, 1); assert(failures.some(value => value.data.message.includes('outside verified ancestry')));
        assert.equal(poolConsumer.acked.length - ackBefore, 1);
    }
    }
} finally {
    for (const client of attemptClients) client.dispose();
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    await transport?.close();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-native-worker-original-/); rmSync(ownedDirectory, {recursive: true, force: true});
}
