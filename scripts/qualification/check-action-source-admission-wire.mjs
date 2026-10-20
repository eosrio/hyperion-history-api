/** Owned ES/Rabbit source-admission and publication qualification; no sink or testnet authority. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Client} from '@elastic/elasticsearch';
import {connect} from 'amqplib';
import {validateFixture} from './es955-replicas.ts';
import {assertOwnedServices, assertResourceIsolation, assertEmptyProjection} from './contract-replay.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const profiles = ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1'];
const capturePath = 'node_modules/@eosrio/hyperion-wire-plugin/fixtures/codec/ship-capture.json';
const captureRevision = '7dede884e0150d36fa788e85a119e10653ade8ca';
const serverBuild = '48acba663b09e70b115dd879329141506c377890';
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const docker = args => execFileSync('docker', args, {encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trim();
async function bounded(work, label, ms = 30000) {
    let timer;
    try {return await Promise.race([work, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    })]);} finally {clearTimeout(timer);}
}
export function wireAdmissionNames(run, major) {
    assert.match(run, /^[a-f0-9]{12}$/); assert.ok([22, 24].includes(major), 'explicit supported Node 22/24 required');
    return ['6508', '7d', 'captured7d'].map(kind => ({kind, chain: `hyp-wire-admit-${run}-n${major}-${kind}`}));
}
export function validateWireAdmissionArguments(args) {
    assert.equal(args.length, 2, 'usage: node check-action-source-admission-wire.mjs OWNED_STATE NEW_OUTPUT');
    assert.ok(args.every(value => typeof value === 'string' && value.trim() && !value.startsWith('--')), 'invalid qualification argument');
    return {stateFile: resolve(args[0]), output: resolve(args[1])};
}
export function assertWireCapture(capture) {
    assert.equal(capture.schemaVersion, 1); assert.equal(capture.sourceRevision, captureRevision);
    assert.equal(capture.chainInfo?.chain_id, '0b99f90492dab673bcf7e2c9ed1cabab6019de897a90996f00d9717b84ed89d2');
    assert.equal(capture.blockNum, 6350); assert.equal(capture.contractDeployment, false);
    assert.equal(typeof capture.handshakeUtf8, 'string'); assert.equal(sha(capture.handshakeUtf8), capture.handshakeSha256);
    assert.equal(capture.handshakeSha256, '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
    assert.ok(Array.isArray(capture.vectors) && capture.vectors.length === 8);
    const read = id => {
        const vectors = capture.vectors.filter(value => value.id === id); assert.equal(vectors.length, 1);
        const value = vectors[0]; assert.equal(value.profileId, profiles[1]);
        assert.equal(value.oracle, 'captured-official-node-and-offline-clio');
        assert.equal(value.operation, 'decodeValue'); assert.equal(value.typeName, 'result');
        assert.match(value.hex, /^(?:[0-9a-f]{2})+$/); return value;
    };
    const status = read('captured-ship-status'), block = read('captured-ship-block-result');
    assert.equal(sha(Buffer.from(status.hex, 'hex')), 'e90c53cb3db3691e85bb3d28d00fa4771bc76afab10c93de1e788237321cb764');
    assert.equal(sha(Buffer.from(block.hex, 'hex')), '9f07a3c7e72cd03245fbeaeee8dc9ba2d97337bdd34bed963ba371c03b7b42fa');
    return {status, block};
}
function assertStateBeforeInspection(state) {
    assert.equal(state.schemaVersion, 1); assert.equal(state.status, 'ready'); validateFixture(state.core);
    assert.equal(state.run, state.core.run); assert.equal(state.network, state.core.network);
    for (const kind of ['spring', 'redis', 'mongo']) {
        assert.equal(state[kind]?.name, `${state.network}-${kind}`);
        assert.match(state[kind]?.containerId, /^[a-f0-9]{64}$/);
        assert.equal(state[kind]?.volume, `${state[kind].name}-data`);
    }
    assert.match(state.core.broker.containerId, /^[a-f0-9]{64}$/);
    const management = new URL(state.core.broker.managementUrl);
    assert.equal(management.protocol, 'http:'); assert.equal(management.hostname, '127.0.0.1');
    assert.ok(management.port && management.port !== '15672');
    assert.equal(management.pathname, '/'); assert.equal(management.search, ''); assert.equal(management.hash, '');
}
async function inspectOwnership(state) {
    assertStateBeforeInspection(state);
    const items = [...state.core.nodes, state.core.broker, state.spring, state.redis, state.mongo], inspections = {}, volumes = [], users = {};
    for (const item of items) inspections[item.name] = JSON.parse(docker(['inspect', item.containerId]))[0];
    assertOwnedServices(state, inspections);
    const network = JSON.parse(docker(['network', 'inspect', state.network]))[0];
    assert.equal(network.Driver, 'bridge'); assert.equal(network.Internal, false);
    for (const item of items) {
        volumes.push(JSON.parse(docker(['volume', 'inspect', item.volume]))[0]);
        users[item.volume] = docker(['ps', '-a', '--no-trunc', '--filter', `volume=${item.volume}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
    }
    assertResourceIsolation(state, network, volumes, users);
    for (const item of items) assert.equal(inspections[item.name].State.Running, true, 'owned service is not running');
    return {inspections, network, volumes, users};
}
export async function runWireAdmissionQualification(stateFile, outputDirectory) {
    const major = Number(process.versions.node.split('.')[0]), originalDirectory = process.cwd(), originalSend = process.send;
    const originalEnvironment = Object.fromEntries(['CONFIG_JSON', 'live_mode', 'worker_role'].map(key => [key, process.env[key]]));
    const stateBytes = await readFile(stateFile), state = JSON.parse(stateBytes), names = wireAdmissionNames(state.run, major);
    const captureBytes = await readFile(join(repo, capturePath)), captured = JSON.parse(captureBytes), capture = assertWireCapture(captured);
    assert.equal(sha(captureBytes), 'b5797ca6738c42bfe88ce1e91c3e7021511cc29ddd69a21a06f6bdf0abd5abc7', 'retained captured source file changed');
    const syntheticBytes = await readFile(join(repo, 'tests/unit/fixtures/wire-host/receipts.json')), synthetic = JSON.parse(syntheticBytes);
    const ownership = await inspectOwnership(state);
    const output = resolve(outputDirectory);
    await assert.rejects(stat(output), error => error.code === 'ENOENT', 'output must not already exist');
    const clients = [], channels = []; let connection, hooks, reader, coordinator, client;
    const report = {schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), fixtureRun: state.run,
        runtime: {node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch, versions: process.versions},
        stateSha256: sha(stateBytes), ownership, identities: {}, sourceHashes: {}, cases: [], timeline: [], amqpErrors: [], writes: [],
        limits: ['In-process production Reader/Parser/MainDS/DS methods with the internal admission gate enabled only on fixture instances.',
            'Actual owned Elasticsearch stores and coordinator, real Rabbit durable queues, persistent mandatory confirmed publication and original receipt ACKs.',
            'Constructed inputs qualify both source-pinned profiles; the unmodified 7d capture is reported separately and is expected to remain incomplete.',
            'IPC scheduling is bridged in-process; legacy block publication is observed only. Redis cache and streaming are disabled.',
            'No sink/indexer writes, canonical history, query readiness, consensus, crash/restart or Wire testnet release qualification.',
            'No resource deletion, node RPC or Docker mutation. Root-owned fixture cleanup is separate.']};
    let outputCreated = false, nativeAddonResolutions = 0;
    const timeline = (event, data = {}) => report.timeline.push({sequence: report.timeline.length, event, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...data});
    const started = performance.now();
    const observe = (resource, label) => {resource.on('error', error => report.amqpErrors.push({label, message: error.message})); return resource;};
    const management = async path => {
        const response = await fetch(state.core.broker.managementUrl + path, {headers: {Authorization: 'Basic ' + Buffer.from('qualifier:qualifier-test-only').toString('base64')}, signal: AbortSignal.timeout(5000)});
        assert.equal(response.status, 200, `Rabbit management ${path}`); return response.json();
    };
    const queueRows = async chain => {
        const rows = await management('/api/queues/%2F'); assert.ok(Array.isArray(rows));
        return rows.filter(row => row.name.startsWith(chain + ':'));
    };
    try {
        // All service identities and all deterministic namespaces are checked before any service mutation or result directory.
        for (const node of state.core.nodes) {
            const current = new Client({node: node.url, maxRetries: 0, requestTimeout: 5000}); clients.push(current);
            const info = await current.info();
            assert.equal(info.cluster_name, state.core.clusterName); assert.equal(info.cluster_uuid, state.core.clusterUuid);
            assert.equal(info.version.number, '9.5.5'); assert.equal(info.version.build_hash, serverBuild);
            report.identities[node.name] = info; if (!client && node.role === 'data') client = current;
        }
        const overview = await management('/api/overview'), nodes = await management('/api/nodes');
        const expectedRabbitNode = 'rabbit@' + ownership.inspections[state.core.broker.name].Config.Hostname;
        assert.equal(overview.node, expectedRabbitNode); assert.equal(nodes.length, 1); assert.equal(nodes[0].name, expectedRabbitNode); assert.equal(nodes[0].running, true);
        report.identities.rabbit = {overview, nodes};
        connection = observe(await bounded(connect(state.core.broker.url, {timeout: 5000}), 'AMQP connect', 7000), 'connection');
        assert.equal(connection.connection.serverProperties.product, 'RabbitMQ');
        assert.equal(connection.connection.serverProperties.version, overview.rabbitmq_version);
        report.identities.amqp = connection.connection.serverProperties;
        for (const {chain} of names) assertEmptyProjection(await client.indices.get({index: chain + '-*', allow_no_indices: true, ignore_unavailable: true}), await queueRows(chain));
        await mkdir(output); outputCreated = true; await mkdir(join(output, 'config'));
        await writeFile(join(output, 'owned-state.json'), stateBytes, {flag: 'wx'});
        await writeFile(join(output, 'captured-7d.json'), captureBytes, {flag: 'wx'});
        await writeFile(join(output, 'constructed-template.json'), syntheticBytes, {flag: 'wx'});
        report.runtime.executableSha256 = sha(await readFile(process.execPath));
        report.dockerVersion = JSON.parse(docker(['version', '--format', '{{json .}}']));
        for (const file of ['package.json', 'package-lock.json', '.bun-version', 'scripts/qualification/check-action-source-admission-wire.mjs',
            'scripts/qualification/contract-replay.ts', 'scripts/qualification/es955-replicas.ts', 'scripts/qualification/es955-workers.ts',
            'node_modules/@elastic/elasticsearch/package.json', 'node_modules/amqplib/package.json',
            'node_modules/@eosrio/hyperion-sdk/package.json', 'node_modules/@eosrio/hyperion-wire-plugin/package.json',
            'node_modules/@eosrio/hyperion-wire-plugin/dist/protocol-node-artifact.json', 'node_modules/@eosrio/hyperion-wire-plugin/dist/protocol-rust-artifact.json',
            ...['state-reader', 'deserializer', 'ds-pool', 'hyperionWorker'].flatMap(name => [`src/indexer/workers/${name}.ts`, `build/indexer/workers/${name}.js`]),
            ...['loader', 'parsers/3.2-parser', 'parsers/base-parser'].flatMap(name => [`src/indexer/modules/${name}.ts`, `build/indexer/modules/${name}.js`]),
            ...['action-source-inventory', 'action-source-admission', 'action-source-journal', 'action-history-manifest', 'action-producer-epoch', 'action-confirmed-publication']
                .flatMap(name => [`src/indexer/history/${name}.ts`, `build/indexer/history/${name}.js`]),
            ...['abi-coordinator', 'abi-coordinator-rpc', 'source-bindings', 'abi-observation-store', 'abi-frontier-store', 'abi-proof', 'immutable-bundle-store', 'selection']
                .flatMap(name => [`src/indexer/protocol/${name}.ts`, `build/indexer/protocol/${name}.js`])]) {
            const bytes = await readFile(join(repo, file)); report.sourceHashes[file] = sha(bytes);
        }
        report.inputHashes = {[capturePath]: sha(captureBytes), 'tests/unit/fixtures/wire-host/receipts.json': sha(syntheticBytes)};
        timeline('guards-complete');
        // Record actual server write receipts without replacing transport or inventing successful responses.
        for (const method of ['create', 'index']) {
            const actual = client[method].bind(client);
            client[method] = async (...args) => {
                const response = await actual(...args);
                if (names.some(value => args[0].index.startsWith(value.chain + '-'))) {
                    assert.equal(response._shards?.total, 2); assert.equal(response._shards.successful, 2); assert.equal(response._shards.failed, 0);
                    report.writes.push({method, index: response._index, id: response._id, result: response.result, shards: response._shards,
                        requestSha256: sha(canonical(args[0])), at: new Date().toISOString()});
                }
                return response;
            };
        }
        const {registerHooks} = await import('node:module');
        hooks = registerHooks({resolve(specifier, context, next) {
            if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire qualification resolved Antelope native codec');}
            return next(specifier, context);
        }});
        let modules;
        for (const [caseIndex, naming] of names.entries()) {
            const capturedCase = naming.kind === 'captured7d', profileId = caseIndex === 0 ? profiles[0] : profiles[1], chain = naming.chain;
            const chainId = capturedCase ? captured.chainInfo.chain_id : '1'.repeat(64);
            const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
                eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000000, es_replicas: 1,
                protocol_abi_coordination: {recovery_window_blocks: 128}},
                indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: false, disable_indexing: false, live_reader: true},
                features: {contract_console: false, failed_trx: false, streaming: {traces: false, deltas: false}},
                scaling: {ds_pool_size: 1, ds_queues: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 1},
                whitelists: {root_only: false, actions: [], deltas: []}, blacklists: {actions: [], deltas: []},
                api: {tx_cache_mode: 'batch', disable_tx_cache: true}, plugins: {}};
            await writeFile(join(output, 'chain.json'), JSON.stringify(config));
            await writeFile(join(output, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
            process.chdir(output); process.env.CONFIG_JSON = join(output, 'chain.json'); process.env.live_mode = 'true'; process.env.worker_role = 'continuous_reader';
            if (!modules) modules = await Promise.all([
                import('../../build/indexer/workers/state-reader.js'), import('../../build/indexer/workers/deserializer.js'),
                import('../../build/indexer/workers/ds-pool.js'), import('../../build/indexer/modules/parsers/3.2-parser.js'),
                import('../../build/indexer/modules/loader.js'), import('../../build/indexer/protocol/selection.js'),
                import('../../build/indexer/protocol/abi-coordinator.js'), import('../../build/indexer/protocol/abi-coordinator-rpc.js'),
                import('../../build/indexer/protocol/source-bindings.js'), import('../../build/indexer/protocol/abi-observation-store.js'),
                import('../../build/indexer/protocol/abi-frontier-store.js'), import('../../build/indexer/history/action-source-admission.js'),
                import('../../build/indexer/history/action-source-inventory.js'), import('../../build/indexer/history/action-history-manifest.js'),
                import('../../build/indexer/history/action-producer-epoch.js'), import('@eosrio/hyperion-wire-plugin'),
                import('../../build/indexer/protocol/immutable-bundle-store.js')]);
            const [{default: Reader}, {default: Main}, {default: Pool}, {default: Parser}, {HyperionModuleLoader}, {loadChainProtocol},
                {ProtocolAbiCoordinator}, {ProtocolAbiCoordinatorRpc}, {ProtocolSourceBindingStore, protocolSourceSelectionHeader},
                {ProtocolAbiObservationStore}, {ProtocolAbiFrontierStore}, {ActionSourceAdmissionStore, actionSourceIngressHeader, actionSourceAdmissionHeader},
                {deriveActionSourceInventory}, {actionHistoryImmutableJson, fingerprintActionHistoryEffect}, {currentActionPolicy}, wire, {ImmutableProtocolBundleStore}] = modules;
            const selected = await loadChainProtocol(config.settings.protocol), selectedProfile = {id: selected.id, profileId, components: selected.components};
            const handshake = capturedCase ? captured.handshakeUtf8 : JSON.stringify(synthetic.handshake);
            const codec = wire.createWireValueCodec(JSON.parse(handshake), wire.resolveCodecProfile(profileId));
            const originalCodec = wire.createWireValueCodec(synthetic.handshake, wire.resolveCodecProfile(synthetic.profileId));
            const template = originalCodec.decode('result', Buffer.from(synthetic.frameHex, 'hex'));
            const originalTrace = originalCodec.decode('transaction_trace[]', Buffer.from(template[1].traces, 'hex'))[0][1];
            const originalBlock = originalCodec.decode('signed_block', Buffer.from(template[1].block, 'hex'));
            const bindings = new ProtocolSourceBindingStore(client, chain, 1), observations = new ProtocolAbiObservationStore(client, chain, 1),
                frontier = new ProtocolAbiFrontierStore(client, chain, 1), store = new ActionSourceAdmissionStore(client, chain, 1);
            const journalRead = new ImmutableProtocolBundleStore(client, chain, 1, 'action-source-journal', 'history-source-journal-v1', undefined, {readOnly: true});
            const admissionRead = new ImmutableProtocolBundleStore(client, chain, 1, 'action-source-admission', 'history-source-admission-v1', undefined, {readOnly: true});
            const targetName = `${chain}-action-v1-000001`;
            const created = await client.indices.create({index: targetName, settings: {number_of_shards: 1, number_of_replicas: 1, 'translog.durability': 'request'}});
            assert.equal(created.acknowledged, true); assert.equal(created.shards_acknowledged, true);
            const targetSettings = await client.indices.getSettings({index: targetName, flat_settings: true});
            assert.deepEqual(Object.keys(targetSettings), [targetName]);
            const target = {name: targetName, uuid: targetSettings[targetName].settings['index.uuid']}; assert.ok(target.uuid);
            const caseReport = {kind: capturedCase ? 'unmodified-retained-native-capture' : 'constructed-source', chain, chainId, profileId,
                components: selected.components, target, sourceRevision: capturedCase ? captured.sourceRevision : null, status: 'running', blocks: [],
                publications: [], receipts: [], events: [], legacyBlockPublications: [], incomplete: [], queues: []}; report.cases.push(caseReport);
            const ownChannels = [];
            const channel = async (label, confirm = false) => {
                const value = observe(await (confirm ? connection.createConfirmChannel() : connection.createChannel()), `${chain}:${label}`);
                channels.push(value); ownChannels.push(value); return value;
            };
            const admin = await channel('admin'), mainConsumer = await channel('main-consumer'), poolConsumer = await channel('pool-consumer'), outputConsumer = await channel('receipt-consumer');
            const readerPublisher = await channel('reader-publisher', true), mainPublisher = await channel('main-publisher', true), poolPublisher = await channel('pool-publisher', true);
            const queues = [`${chain}:live_blocks`, `${chain}:ds_pool:1`, `${chain}:index_actions:1`];
            for (const name of queues) {
                const result = await admin.assertQueue(name, {durable: true, arguments: {'x-queue-version': 2}});
                assert.equal(result.messageCount, 0); assert.equal(result.consumerCount, 0);
            }
            const instrumentConsumer = (value, label) => {
                const actualAck = value.ack.bind(value);
                value.ack = message => {assert.equal(message.fields.redelivered, false); timeline('receipt-ack', {chain, label, deliveryTag: message.fields.deliveryTag,
                    bodySha256: sha(message.content), admissionId: message.properties.headers?.[actionSourceAdmissionHeader] ?? null,
                    traceOrdinal: message.properties.headers?.action_trace_ordinal ?? null});
                    caseReport.receipts.push({label, deliveryTag: message.fields.deliveryTag, bodySha256: sha(message.content), admissionId: message.properties.headers?.[actionSourceAdmissionHeader] ?? null});
                    return actualAck(message);};
            };
            instrumentConsumer(mainConsumer, 'main'); instrumentConsumer(poolConsumer, 'pool'); instrumentConsumer(outputConsumer, 'output');
            for (const [publisher, label] of [[readerPublisher, 'reader'], [mainPublisher, 'main'], [poolPublisher, 'pool']]) {
                const actualSend = publisher.sendToQueue.bind(publisher);
                publisher.sendToQueue = (queue, payload, options, callback) => {
                    assert.ok(queues.includes(queue), 'publication escaped owned queues'); assert.equal(options.persistent, true); assert.equal(options.mandatory, true);
                    const row = {label, queue, bodySha256: sha(payload), bodyHex: Buffer.from(payload).toString('hex'), headers: structuredClone(options.headers ?? {}),
                        persistent: options.persistent, mandatory: options.mandatory, confirmed: false}; caseReport.publications.push(row);
                    return actualSend(queue, payload, options, error => {if (!error) {row.confirmed = true; timeline('broker-confirm', {chain, label, bodySha256: row.bodySha256});} callback(error);});
                };
                publisher.on('return', () => assert.fail('owned mandatory publication was returned'));
            }
            const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()}, cm = {config, filters}, parser = new Parser(cm);
            const loader = Object.create(HyperionModuleLoader.prototype); Object.assign(loader, {handledActions: new Map(), handledDeltas: new Map(), parser, plugins: []});
            const worker = (prototype, consumer, publisher) => {
                const value = Object.create(prototype); Object.assign(value, {chain, chainId, conf: config, configModule: cm, filters, mLoader: loader,
                    protocol: selected.provider, protocolId: selected.id, protocolComponents: selected.components, protocolReady: Promise.resolve(),
                    abieos: selected.decoder, client, ch: consumer, cch: publisher, ch_ready: true, cch_ready: true,
                    profiler: {start: () => () => {}}, actionAdmissionOwners: new WeakMap(), actionAdmissionStore: store});
                Object.defineProperty(value, 'actionSourceAdmissionEnabled', {value: true}); return value;
            };
            reader = worker(Reader.prototype, admin, readerPublisher);
            const main = worker(Main.prototype, mainConsumer, mainPublisher), pool = worker(Pool.prototype, poolConsumer, poolPublisher);
            Object.assign(reader, {baseRequest: {}, shipRev: 0, socketGeneration: 0, activeIngressGeneration: 0, isLiveReader: true,
                local_block_num: 0, local_lib: 0, receivedFirstBlock: true, reversibleBlockMap: new Map(), forkedBlocks: new Map(), publications: new Map(),
                protocolSourceBindingStore: bindings, send() {}, handleStatusResult() {}});
            reader.stageOneDistQueue = {push: async payload => new Promise(done => reader.distribute([payload], done))};
            Object.assign(main, {local_block_count: 0, lastSelectedWorker: 0, dsPoolMap: {}, ds_pool_counters: {}, block_emit_idx: 1,
                protocolDeliveryOwners: new WeakMap(), protocolSourceBindingStore: bindings, protocolAbiObservationStore: observations,
                preIndexingQueue: {push: async payload => caseReport.legacyBlockPublications.push({sha256: sha(canonical(payload))})}});
            Object.assign(pool, {protocolDeliveryOwners: new WeakMap(), poolAbiCache: new Map(), poolTypeCache: new Map(), protocolCacheViews: new Set(),
                temp_ds_counter: 0, actionDsCounter: 0, act_emit_idx: 1, txCacheExpiration: 3600, allowStreaming: false,
                common: {attachActionExtras: Pool.prototype.attachActionExtras}, pushToActionsQueue() {assert.fail('unconfirmed legacy output bypass');}});
            const actualIncomplete = store.noteIncomplete.bind(store);
            store.noteIncomplete = async (...args) => {await actualIncomplete(...args); caseReport.incomplete.push({admissionId: args[0], traceOrdinal: args[1], message: args[2]});
                timeline('durable-incomplete', {chain, admissionId: args[0], traceOrdinal: args[1]});};
            coordinator = new ProtocolAbiCoordinator({chainId, profile: selectedProfile, ownerId: chain + '-owner', bindings, observations, store: frontier});
            await coordinator.start(); let draining = Promise.resolve();
            process.send = (event, callback) => {caseReport.events.push(event);
                if (event.event === 'protocol_abi_prepared') {draining = coordinator.drain(); void draining.catch(() => {});}
                callback?.(null); return true;};
            reader.coordinatorRpc = new ProtocolAbiCoordinatorRpc((request, callback) => {
                const input = request.data;
                void (input.operation === 'open' ? coordinator.openSource(input.contextId, input.readerSessionId) : coordinator.admit(input.selectionId, input.generation))
                    .then(result => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: true, result}}))
                    .catch(error => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: false, error: {code: 'qualification_coordinator', message: error.message}}}));
                callback(null);
            });
            const get = async (consumer, queue) => {
                const message = await consumer.get(queue, {noAck: false}); assert.ok(message, `expected broker delivery on ${queue}`);
                assert.equal(message.fields.routingKey, queue); assert.equal(message.fields.redelivered, false); assert.equal(message.properties.deliveryMode, 2); return message;
            };
            const searchBundles = async (index, prefix) => {
                await client.indices.refresh({index});
                const response = await client.search({index, size: 100, track_total_hits: true, allow_partial_search_results: false,
                    query: {bool: {filter: [{term: {kind: 'manifest'}}, {prefix: {bundle_id: prefix}}]}}});
                assert.equal(response.timed_out, false); assert.equal(response._shards.failed, 0); assert.equal(response._shards.successful, response._shards.total);
                assert.ok(response._shards.total > 0); assert.equal(response.hits.total.relation, 'eq');
                assert.equal(response.hits.total.value, response.hits.hits.length); assert.ok(response.hits.hits.length < 100);
                return response.hits.hits.map(hit => hit._source.bundle_id);
            };
            const prepare = async bytes => {
                const result = codec.decode('result', bytes)[1], blockNum = Number(result.this_block.block_num);
                timeline('reader-input', {chain, blockNum, sha256: sha(bytes)});
                assert.equal(await bounded(reader.onMessage(bytes), 'reader admission', 60000), 'block');
                await bounded(readerPublisher.waitForConfirms(), 'reader confirms');
                const raw = await get(mainConsumer, queues[0]); assert.ok(raw.content.equals(bytes));
                const ingress = await store.resolveIngress(raw.properties.headers[actionSourceIngressHeader]);
                assert.equal(ingress.frameHex, bytes.toString('hex')); assert.equal(ingress.schemaJson, handshake);
                main.captureActionAdmissionDelivery(raw, mainConsumer); main.captureProtocolSourceDelivery(raw, mainConsumer);
                await bounded(parser.parseMessage(main, [raw]), 'main source preparation', 60000); await bounded(draining, 'ABI frontier drain', 60000);
                await bounded(mainPublisher.waitForConfirms(), 'main fanout confirms');
                const messages = [];
                for (;;) {const message = await poolConsumer.get(queues[1], {noAck: false}); if (!message) break;
                    assert.equal(message.properties.deliveryMode, 2); pool.captureActionAdmissionDelivery(message, poolConsumer); pool.captureProtocolActionDelivery(message, poolConsumer); messages.push(message);}
                const sourceIds = await searchBundles(store.index, 'h45actionsource1:'); let admission;
                for (const id of sourceIds) {const found = await store.inspectSource(id, target); if (found.source.inventoryInput.source.blockNum === blockNum) {assert.equal(admission, undefined); admission = found;}}
                assert.ok(admission); assert.equal(admission.source.frameHex, bytes.toString('hex')); assert.equal(admission.source.inventoryInput.profileId, profileId);
                assert.deepEqual(admission.target, target);
                const selectionId = raw.properties.headers[protocolSourceSelectionHeader], link = await bindings.readObservationLink(selectionId), observation = await observations.read(link.observationId);
                const originalTraces = codec.decode('transaction_trace[]', Buffer.from(result.traces, 'hex'));
                if (admission.inventory) {
                    assert.equal(observation.observation.status, 'observed');
                    const expected = deriveActionSourceInventory({profileId, source: admission.source.inventoryInput.source, policy: currentActionPolicy(main),
                        traces: originalTraces, wireActionInputs: observation.observation.facts.actionInputs, sourceSelectionId: selectionId});
                    assert.deepEqual(admission.inventory, expected);
                    for (const message of messages) {
                        assert.equal(message.properties.headers[actionSourceAdmissionHeader], admission.id);
                        assert.equal(message.content.toString(), expected.transactions[message.properties.headers.action_trace_ordinal].dispatch.canonicalJson);
                    }
                    assert.equal(messages.length, expected.transactions.filter(value => value.disposition === 'process').length);
                } else {assert.ok(capturedCase, 'constructed case must have independent membership'); assert.ok(admission.incomplete);}
                const row = {blockNum, frameSha256: sha(bytes), originalTraceSha256: sha(actionHistoryImmutableJson(originalTraces)), admissionId: admission.id,
                    sourceId: admission.sourceId, planId: admission.planId, sourceIncomplete: admission.incomplete, captureSha256: admission.source.captureSha256,
                    producer: admission.source.producer, executableSha256: admission.source.executableSha256, ingressId: admission.source.ingressId,
                    inventory: admission.inventory ?? null, observationId: link.observationId, observationStatus: observation.observation.status, selectionId,
                    dispatched: messages.map(message => ({ordinal: message.properties.headers.action_trace_ordinal, sha256: sha(message.content)}))};
                caseReport.blocks.push(row); return {admission, messages, row};
            };
            const consume = async prepared => {
                const before = caseReport.publications.filter(row => row.label === 'pool').length;
                await bounded(pool.processMessages(prepared.messages), 'pool complete-transaction processing', 60000);
                await bounded(poolPublisher.waitForConfirms(), 'pool output confirms');
                const sent = caseReport.publications.filter(row => row.label === 'pool').slice(before), outputs = [];
                for (const publication of sent) {
                    const receipt = await get(outputConsumer, queues[2]); assert.equal(receipt.content.toString('hex'), publication.bodyHex);
                    assert.deepEqual(receipt.properties.headers, publication.headers); assert.equal(publication.confirmed, true);
                    const value = JSON.parse(receipt.content); assert.equal(receipt.content.toString(), actionHistoryImmutableJson(value));
                    assert.equal(receipt.properties.headers[actionSourceAdmissionHeader], prepared.admission.id);
                    assert.equal(typeof value.global_sequence, 'string');
                    if (prepared.admission.inventory) assert.ok(receipt.properties.headers.action_fragment_id);
                    else {assert.equal(receipt.properties.headers.action_fragment_id, undefined); assert.equal(value.ds_error, true); assert.equal(value.protocol.status, 'incomplete');}
                    outputs.push(value); outputConsumer.ack(receipt);
                }
                assert.equal(await outputConsumer.get(queues[2], {noAck: false}), false, 'unexpected extra action delivery');
                prepared.row.sealed = await store.trySeal(prepared.admission);
                prepared.row.outputs = outputs.map(value => ({sha256: sha(actionHistoryImmutableJson(value)),
                    effect: prepared.admission.inventory ? fingerprintActionHistoryEffect(value) : null, incomplete: value.protocol.status === 'incomplete'}));
                if (prepared.row.sealed) {
                    const sealed = await store.journal.readManifest(prepared.admission.planId);
                    assert.deepEqual(sealed.manifest.fragments.flatMap(value => value.effects), outputs.map(fingerprintActionHistoryEffect));
                    prepared.row.manifestSha256 = sha(actionHistoryImmutableJson(sealed.manifest));
                }
                return outputs;
            };
            await reader.onMessage(Buffer.from(handshake));
            const blockId = number => number.toString(16).padStart(64, '0'), encode = (type, value) => Buffer.from(codec.encode(type, value)).toString('hex');
            if (capturedCase) {
                assert.deepEqual(codec.decode('result', Buffer.from(capture.status.hex, 'hex')), capture.status.expected);
                assert.deepEqual(codec.decode('result', Buffer.from(capture.block.hex, 'hex')), capture.block.expected);
                await reader.onMessage(Buffer.from(capture.status.hex, 'hex'));
                const prepared = await prepare(Buffer.from(capture.block.hex, 'hex')), outputs = await consume(prepared);
                assert.equal(prepared.row.blockNum, captured.blockNum); assert.equal(prepared.row.sealed, false, 'unseeded captured onblock must not become certified');
                if (prepared.admission.inventory) assert.equal(outputs.length, 0, 'uncertified captured action must not fill its expected fragment');
                else assert.ok(outputs.every(value => value.protocol.status === 'incomplete' && value.ds_error === true));
                if (await client.indices.exists({index: store.journal.index}))
                    assert.deepEqual(await searchBundles(store.journal.index, 'h45actionfragment1:'), [], 'captured unknown ABI fabricated a source fragment');
                assert.ok(prepared.admission.incomplete || caseReport.incomplete.length, 'captured source lacks explicit incomplete association');
                caseReport.capture = {fileSha256: sha(captureBytes), handshakeSha256: captured.handshakeSha256, statusSha256: sha(Buffer.from(capture.status.hex, 'hex')),
                    frameSha256: sha(Buffer.from(capture.block.hex, 'hex')), originalBlock: captured.blockNum, contractDeployment: false,
                    expectedIncomplete: true, priorFrontierInvented: false, completeSourceCertificate: false};
            } else {
                await reader.onMessage(Buffer.from(codec.encode('result', ['get_status_result_v0', {head: template[1].head,
                    last_irreversible: {block_num: 0, block_id: blockId(0)}, trace_begin_block: 1, trace_end_block: 100,
                    chain_state_begin_block: 1, chain_state_end_block: 100, chain_id: chainId}])));
                const abi = {version: 'sysio::abi/1.3', types: [], structs: [{name: 'record', base: '', fields: [{name: 'value', type: 'uint32'}]}],
                    actions: [{name: 'record', type: 'record', ricardian_contract: ''}], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: []};
                const abiHex = Buffer.from(selected.provider.contractCodec.encodeAbi(abi)).toString('hex');
                const accountRow = {present: true, data: encode('account', ['account_v0', {name: 'hyp.replay', creation_date: '2025-01-01T00:00:00.000', abi: abiHex}])};
                const occurrence = (ordinal, sequence, {account = 'hyp.replay', receiver = account, creator = 0} = {}) => {
                    const action = structuredClone(originalTrace.action_traces[0][1]);
                    Object.assign(action, {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
                        act: {account, name: 'record', authorization: [{actor: 'alice', permission: 'active'}], data: '07000000'}, context_free: false, except: null, error_code: null});
                    action.receipt[1] = {...action.receipt[1], receiver, global_sequence: sequence, recv_sequence: '9223372036854775808',
                        auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}], code_sequence: 0xffffffff, abi_sequence: 0, act_digest: 'd'.repeat(64)};
                    return ['action_trace_v1', action];
                };
                const transaction = (number, label, actions) => ['transaction_trace_v0', {...structuredClone(originalTrace),
                    id: sha(`wire-owned-${number}-${label}`), status: 0, scheduled: false, failed_dtrx_trace: null, except: null, error_code: null, action_traces: actions}];
                const frame = (number, traces, rows = []) => Buffer.from(codec.encode('result', [template[0], {...structuredClone(template[1]),
                    this_block: {block_num: number, block_id: blockId(number)}, prev_block: {block_num: number - 1, block_id: blockId(number - 1)},
                    last_irreversible: {block_num: 0, block_id: blockId(0)}, block: encode('signed_block', {...structuredClone(originalBlock), previous: blockId(number - 1), transactions: []}),
                    traces: encode('transaction_trace[]', traces), deltas: encode('table_delta[]', [['table_delta_v0', {name: 'account', rows}]])}]));
                const seed = await prepare(frame(1, [], [accountRow])); assert.equal(seed.messages.length, 0); assert.equal(await store.trySeal(seed.admission), true); seed.row.sealed = true;
                const positive = await prepare(frame(2, [transaction(2, 'positive', [occurrence(1, '9007199254740993'),
                    occurrence(2, '9007199254740994', {receiver: 'bob', creator: 1}), occurrence(3, '9223372036854775808', {creator: 1})])]));
                assert.deepEqual(positive.admission.inventory.transactions[0].groups.map(value => value.actionOrdinals), [[1, 2], [3]]);
                const outputs = await consume(positive); assert.equal(positive.row.sealed, true);
                assert.deepEqual(outputs.map(value => value.global_sequence), ['9007199254740993', '9223372036854775808']);
                assert.deepEqual(outputs.map(value => value.protocol.input.inputActionOrdinal), [1, 3]); assert.deepEqual(outputs.map(value => value.receipts.length), [2, 1]);
                for (const value of outputs) {assert.deepEqual(value.act.data, {value: 7}); assert.equal(value.ds_error, undefined); assert.equal(value.protocol.status, undefined);
                    for (const receipt of value.receipts) {assert.equal(receipt.recv_sequence, '9223372036854775808'); assert.equal(receipt.auth_sequence[0].sequence, '18446744073709551615');}}
                const absent = transaction(3, 'absent', [occurrence(1, '9223372036854775810', {account: 'missing.abi'}),
                    occurrence(2, '9223372036854775811', {account: 'missing.abi', receiver: 'bob', creator: 1})]);
                const valid = transaction(3, 'unrelated', [occurrence(1, '9223372036854775812')]);
                const mixed = await prepare(frame(3, [absent, valid])), mixedOutputs = await consume(mixed);
                assert.equal(mixed.row.sealed, false); assert.equal(mixedOutputs.length, 1); assert.equal(mixedOutputs[0].trx_id, valid[1].id);
                assert.equal(caseReport.incomplete.length, 1); assert.equal(caseReport.incomplete[0].admissionId, mixed.admission.id); assert.equal(caseReport.incomplete[0].traceOrdinal, 0);
                const fragments = await searchBundles(store.journal.index, 'h45actionfragment1:');
                // Read actual immutable fragment contents to rule out a fabricated empty fragment.
                for (const id of fragments) {
                    const fragment = await journalRead.read(id);
                    assert.ok(fragment.planId !== mixed.admission.planId || fragment.transactionId !== absent[1].id, 'missing ABI produced a fragment');
                }
                mixed.row.actualFragmentCount = fragments.length;
                const later = await prepare(frame(4, [transaction(4, 'maximum', [occurrence(1, '18446744073709551615')])])), laterOutputs = await consume(later);
                assert.equal(later.row.sealed, true); assert.equal(laterOutputs[0].global_sequence, '18446744073709551615');
                assert.equal(await store.trySeal(mixed.admission), false);
                caseReport.sourceDerivedMembership = true; caseReport.certifiedOrigins = true; caseReport.absentAbiIncomplete = true; caseReport.unrelatedContinues = true;
            }
            await bounded(readerPublisher.waitForConfirms(), 'final reader confirms');
            assert.ok(caseReport.publications.every(value => value.confirmed));
            const incompleteEvents = report.timeline.filter(row => row.event === 'durable-incomplete' && row.chain === chain);
            for (const incomplete of incompleteEvents) {
                const ack = report.timeline.find(row => row.event === 'receipt-ack' && row.chain === chain && row.label === 'pool'
                    && row.admissionId === incomplete.admissionId && row.traceOrdinal === incomplete.traceOrdinal && row.sequence > incomplete.sequence);
                assert.ok(ack, 'durable incomplete state must precede original pool receipt ACK');
            }
            const incompleteIds = await searchBundles(store.index, 'h45actionincomplete1:');
            caseReport.durableIncompleteRecords = [];
            for (const id of incompleteIds) {
                const envelope = await admissionRead.read(id), value = JSON.parse(envelope.payloadJson);
                assert.equal(envelope.schemaVersion, 1); assert.equal(actionHistoryImmutableJson(value), envelope.payloadJson);
                assert.equal('h45actionincomplete1:' + sha(envelope.payloadJson), id);
                assert.ok(caseReport.incomplete.some(record => canonical({schemaVersion: 1, ...record}) === canonical(value)));
                caseReport.durableIncompleteRecords.push({id, record: value});
            }
            assert.equal(incompleteIds.length, caseReport.incomplete.length);
            for (const receipt of report.timeline.filter(row => row.event === 'receipt-ack' && row.chain === chain)) {
                const origin = receipt.label === 'main' ? 'reader' : receipt.label === 'pool' ? 'main' : 'pool';
                assert.ok(report.timeline.some(row => row.event === 'broker-confirm' && row.chain === chain && row.label === origin
                    && row.bodySha256 === receipt.bodySha256 && row.sequence < receipt.sequence), 'receipt ACK lacks earlier real publisher confirmation');
            }
            const empty = await client.search({index: targetName, size: 0, track_total_hits: true, allow_partial_search_results: false});
            assert.equal(empty.timed_out, false); assert.equal(empty._shards.failed, 0); assert.equal(empty._shards.successful, empty._shards.total);
            assert.equal(empty.hits.total.relation, 'eq'); assert.equal(empty.hits.total.value, 0); caseReport.targetRemainsEmpty = true;
            // RPCs on each original consumer channel are ordered after its ACK frames.
            await mainConsumer.checkQueue(queues[0]); await poolConsumer.checkQueue(queues[1]); await outputConsumer.checkQueue(queues[2]);
            for (const name of queues) {const q = await admin.checkQueue(name); assert.equal(q.messageCount, 0); assert.equal(q.consumerCount, 0); caseReport.queues.push(q);}
            caseReport.frontier = await coordinator.inspect();
            reader.coordinatorRpc.cancel(); reader.shipSession?.close?.(); clearTimeout(reader.confirmationDeadline);
            reader = undefined; coordinator = undefined;
            for (const value of ownChannels.reverse()) {await bounded(value.close(), 'case channel close', 5000); channels.splice(channels.indexOf(value), 1);}
            const rows = await queueRows(chain);
            assert.equal(rows.length, 3); assert.ok(rows.every(row => row.durable && row.consumers === 0));
            caseReport.status = 'passed'; timeline('case-complete', {chain});
        }
        assert.equal(nativeAddonResolutions, 0); assert.deepEqual(report.amqpErrors, []);
        assert.ok(report.writes.length > 0); report.nativeAddonResolutions = nativeAddonResolutions;
        report.status = 'passed'; report.finishedAt = new Date().toISOString();
    } catch (error) {report.status = 'failed'; report.error = {name: error.name, message: error.message, stack: error.stack}; throw error;}
    finally {
        reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.(); if (reader) clearTimeout(reader.confirmationDeadline);
        process.send = originalSend; process.chdir(originalDirectory); hooks?.deregister();
        for (const [key, value] of Object.entries(originalEnvironment)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
        for (const value of channels.reverse()) {try {await bounded(value.close(), 'channel close', 5000);} catch (error) {report.amqpErrors.push({label: 'close', message: error.message});}}
        if (connection) {try {await bounded(connection.close(), 'connection close', 5000);} catch (error) {report.amqpErrors.push({label: 'close', message: error.message});}}
        for (const value of clients) {try {await bounded(value.close(), 'ES close', 5000);} catch (error) {report.amqpErrors.push({label: 'es-close', message: error.message});}}
        if (report.amqpErrors.length && report.status === 'passed') report.status = 'failed';
        report.elapsedMs = Math.round(performance.now() - started);
        if (outputCreated) {
            const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
            await writeFile(join(output, 'report.json'), bytes, {flag: 'wx'});
            await writeFile(join(output, 'SHA256SUMS.json'), JSON.stringify({'report.json': sha(bytes), 'owned-state.json': sha(stateBytes),
                'captured-7d.json': sha(captureBytes), 'constructed-template.json': sha(syntheticBytes)}, null, 2) + '\n', {flag: 'wx'});
        }
    }
    assert.equal(report.status, 'passed', 'qualification or cleanup failed; inspect report.json');
    return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const {stateFile, output} = validateWireAdmissionArguments(process.argv.slice(2));
    await runWireAdmissionQualification(stateFile, output);
    console.log(JSON.stringify({status: 'passed', report: join(output, 'report.json')}));
}
