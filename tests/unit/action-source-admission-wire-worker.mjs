/** Actual emitted Wire provider/proof/worker path with synthetic source and controlled transports.
 * It does not execute a node, validate consensus, or qualify live ES/RabbitMQ/Redis. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

let nativeAddonResolutions = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Wire admission resolved the Antelope native addon');}
    return next(specifier, context);
}});
const previousDirectory = process.cwd(), previousSend = process.send;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-wire-action-admission-'));
const chain = 'wire-admission-fixture', chainId = '1'.repeat(64), blockId = number => number.toString(16).padStart(64, '0');
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
    sendToQueue(queue, payload, options, confirm) {
        this.sent.push({queue, payload: Buffer.from(payload), options: structuredClone(options)});
        queueMicrotask(() => confirm()); return true;
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
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/wire-host/receipts.json', import.meta.url)));
    const profileId = process.env.HYPERION_WIRE_PROFILE;
    assert(['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1'].includes(profileId));
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 1000, es_replicas: 0,
        protocol_abi_coordination: {recovery_window_blocks: 128}},
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
    const selected = await loadChainProtocol(config.settings.protocol);
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
    coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'wire-admission-controlled-owner', bindings, observations, store: frontier});
    await coordinator.start();
    reader.coordinatorRpc = new ProtocolAbiCoordinatorRpc((request, callback) => {
        const input = request.data;
        void (input.operation === 'open' ? coordinator.openSource(input.contextId, input.readerSessionId) : coordinator.admit(input.selectionId, input.generation))
            .then(result => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId, data: {ok: true, result}}))
            .catch(error => reader.onIpcMessage({event: 'protocol_abi_coordinator_reply', mId: request.mId,
                data: {ok: false, error: {code: 'controlled_coordinator', message: error.message}}}));
        callback(null);
    });
    await reader.onMessage(Buffer.from(JSON.stringify(fixture.handshake)));
    await reader.onMessage(Buffer.from(codec.encode('result', ['get_status_result_v0', {head: template[1].head,
        last_irreversible: {block_num: 0, block_id: blockId(0)}, trace_begin_block: 1, trace_end_block: 100,
        chain_state_begin_block: 1, chain_state_end_block: 100, chain_id: chainId}])));
    const abi = {version: 'sysio::abi/1.3', types: [], structs: [{name: 'record', base: '', fields: [{name: 'value', type: 'uint32'}]}],
        actions: [{name: 'record', type: 'record', ricardian_contract: ''}], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: []};
    const abiHex = Buffer.from(selected.provider.contractCodec.encodeAbi(abi)).toString('hex');
    const encode = (type, value) => Buffer.from(codec.encode(type, value)).toString('hex');
    const accountRow = {present: true, data: encode('account', ['account_v0', {name: 'hyp.replay', creation_date: '2025-01-01T00:00:00.000', abi: abiHex}])};
    const occurrence = (ordinal, sequence, {account = 'hyp.replay', receiver = account, creator = 0} = {}) => {
        const action = structuredClone(originalTrace.action_traces[0][1]);
        Object.assign(action, {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
            act: {account, name: 'record', authorization: [{actor: 'alice', permission: 'active'}], data: '07000000'},
            context_free: false, except: null, error_code: null});
        action.receipt[1] = {...action.receipt[1], receiver, global_sequence: sequence,
            recv_sequence: '9223372036854775808', auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}],
            code_sequence: 0xffffffff, abi_sequence: 0, act_digest: 'd'.repeat(64)};
        return ['action_trace_v1', action];
    };
    const transaction = (number, label, actions) => ['transaction_trace_v0', {...structuredClone(originalTrace),
        id: hash(`wire-admission-${number}-${label}`), status: 0, scheduled: false, failed_dtrx_trace: null,
        except: null, error_code: null, action_traces: actions}];
    const frame = (number, traces, rows = []) => {
        const block = {...structuredClone(originalBlock), previous: blockId(number - 1), transactions: []};
        return Buffer.from(codec.encode('result', [template[0], {...structuredClone(template[1]),
            this_block: {block_num: number, block_id: blockId(number)}, prev_block: {block_num: number - 1, block_id: blockId(number - 1)},
            last_irreversible: {block_num: 0, block_id: blockId(0)}, block: encode('signed_block', block),
            traces: encode('transaction_trace[]', traces), deltas: encode('table_delta[]', [['table_delta_v0', {name: 'account', rows}]])}]));
    };
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
        assert.equal(observation.observation.status, 'observed');
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
    const consume = async messages => pool.processMessages(messages);
    const assertOutput = async (admission, output, expectedEffects) => {
        const sealed = await admissionStore.journal.readManifest(admission.planId);
        assert.equal(sealed.manifest.fragments.flatMap(value => value.effects).length, expectedEffects);
        for (const sent of output) {
            assert.equal(sent.options.mandatory, true); assert.equal(sent.options.persistent, true);
            assert.equal(sent.options.headers[actionSourceAdmissionHeader], admission.id); assert.ok(sent.options.headers.action_fragment_id);
            const value = JSON.parse(sent.payload);
            assert.equal(sent.payload.toString(), actionHistoryImmutableJson(value));
            assert.deepEqual(value.act.data, {value: 7}); assert.equal(value.ds_error, undefined); assert.equal(value.protocol.status, undefined);
            assert.equal(typeof value.global_sequence, 'string');
            assert.ok(poolConsumer.streamed.some(stream => stream.payload.equals(sent.payload)));
            assert.ok(cache.some(entry => entry.values.get(value.global_sequence)?.equals(sent.payload)));
            const effect = sealed.manifest.fragments.flatMap(value => value.effects).find(effect => effect.globalSequence === value.global_sequence);
            assert.deepEqual(effect, fingerprintActionHistoryEffect(value));
        }
        return output.map(sent => JSON.parse(sent.payload));
    };

    // Seed ABI knowledge from actual provider-observed source account bytes, not an API or fake proof.
    const seed = await prepare(frame(1, [], [accountRow]));
    assert.equal(seed.messages.length, 0); assert.equal(await admissionStore.trySeal(seed.admission), true);
    const record = transaction(2, 'certified', [occurrence(1, '9007199254740993'), occurrence(2, '9007199254740994', {receiver: 'bob', creator: 1}),
        occurrence(3, '9223372036854775808', {creator: 1})]);
    const certified = await prepare(frame(2, [record])), before = poolPublisher.sent.length;
    assert.equal(certified.messages.length, 1);
    assert.deepEqual(certified.admission.inventory.transactions[0].groups.map(value => value.actionOrdinals), [[1, 2], [3]]);
    await consume(certified.messages);
    const documents = await assertOutput(certified.admission, poolPublisher.sent.slice(before), 2);
    assert.deepEqual(documents.map(value => value.global_sequence), ['9007199254740993', '9223372036854775808']);
    assert.deepEqual(documents.map(value => value.protocol.input.inputActionOrdinal), [1, 3]);
    assert.deepEqual(documents[0].receipts.map(value => value.global_sequence), ['9007199254740993', '9007199254740994']);
    assert.deepEqual(documents.map(value => value.receipts.length), [2, 1]);
    for (const document of documents) for (const receipt of document.receipts) {
        assert.equal(receipt.recv_sequence, '9223372036854775808'); assert.equal(receipt.auth_sequence[0].sequence, '18446744073709551615');
        assert.equal(receipt.code_sequence, 0xffffffff);
    }

    // This source is fully observed but the unseeded account has no certified ABI. Its raw fallback cannot fill an expected fragment.
    const absent = transaction(3, 'absent', [occurrence(1, '9223372036854775810', {account: 'missing.abi'}),
        occurrence(2, '9223372036854775811', {account: 'missing.abi', receiver: 'bob', creator: 1})]);
    const valid = transaction(3, 'unrelated', [occurrence(1, '9223372036854775812')]);
    const mixed = await prepare(frame(3, [absent, valid])), mixedStart = poolPublisher.sent.length, cacheStart = cache.length,
        streamStart = poolConsumer.streamed.length, ackStart = poolConsumer.acked.length;
    poolConsumer.onAck = delivery => {
        if (delivery === mixed.messages[0]) assert.equal(ids(memory, 'h45actionincomplete1:').length, 1, 'retain incomplete scope before original ACK');
    };
    await consume(mixed.messages); poolConsumer.onAck = undefined;
    assert.equal(poolConsumer.acked.length, ackStart + 2);
    assert.equal(poolPublisher.sent.length, mixedStart + 1); assert.equal(cache.length, cacheStart + 1); assert.equal(poolConsumer.streamed.length, streamStart + 1);
    const onlyValid = JSON.parse(poolPublisher.sent.at(-1).payload); assert.equal(onlyValid.trx_id, valid[1].id); assert.deepEqual(onlyValid.act.data, {value: 7});
    const fragments = ids(memory, 'h45actionfragment1:').map(id => retained(memory, admissionStore.journal.index, id));
    assert.equal(fragments.filter(fragment => fragment.planId === mixed.admission.planId && fragment.transactionId === absent[1].id).length, 0);
    assert.equal(fragments.filter(fragment => fragment.planId === mixed.admission.planId && fragment.transactionId === valid[1].id).length, 1);
    assert.equal(await admissionStore.trySeal(mixed.admission), false);
    const incomplete = await admissionStore.get(ids(memory, 'h45actionincomplete1:')[0]);
    assert.equal(incomplete.admissionId, mixed.admission.id); assert.equal(incomplete.traceOrdinal, 0);
    assert.ok(events.some(event => event.event === 'ds_error' && event.data?.account === 'missing.abi'));
    // A later unrelated source remains admissible even after the earlier block cannot seal.
    const later = await prepare(frame(4, [transaction(4, 'maximum', [occurrence(1, '18446744073709551615')])])), laterStart = poolPublisher.sent.length;
    await consume(later.messages); const maximum = await assertOutput(later.admission, poolPublisher.sent.slice(laterStart), 1);
    assert.equal(maximum[0].global_sequence, '18446744073709551615');
    assert.equal(await admissionStore.trySeal(mixed.admission), false); assert.equal(nativeAddonResolutions, 0);
    assert.equal(sourceFrames.length, 4);
    console.log(JSON.stringify({passed: true, profileId, fixture: 'emitted-wire-provider-controlled-transport', consensusValidation: false,
        liveTransportQualification: false, sourceDerivedMembership: true, certifiedOrigins: true, exactConfirmedBytes: true,
        rawFallbackIncomplete: true, unrelatedContinues: true, nativeAddonResolutions}));
} finally {
    reader?.coordinatorRpc?.cancel(); reader?.shipSession?.close?.();
    process.send = previousSend; process.chdir(previousDirectory); hooks.deregister();
    const ownedDirectory = resolve(directory); assert.equal(dirname(ownedDirectory), resolve(tmpdir()));
    assert.match(basename(ownedDirectory), /^hyperion-wire-action-admission-/); rmSync(ownedDirectory, {recursive: true, force: true});
}
