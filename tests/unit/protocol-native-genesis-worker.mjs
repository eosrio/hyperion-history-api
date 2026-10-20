import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {PROJECTION_CAPABILITIES} from '@eosrio/hyperion-sdk/projection';

// This child exercises native emitted code. Importing the legacy Antelope addon on Wire is a failure.
registerHooks({resolve(specifier, context, next) {if (specifier.includes('node-abieos')) throw new Error('Wire imported the legacy addon'); return next(specifier, context);}});
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), zero = '0'.repeat(64);
const original = readFileSync(new URL('./fixtures/wire-native-genesis/ship-preflight-20261020.json', import.meta.url));
assert.equal(hash(original), 'b8edf652dd0ad265917bf0111ca48789ec7a3f1976f2113783202cc3dd38acb4');
const fixture = JSON.parse(original), chainId = fixture.chainId, capture = fixture.messages.find(message => message.kind === 'block1');
const schemaJson = Buffer.from(fixture.schema.base64, 'base64').toString('utf8');
assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
const frame = Buffer.from(capture.response.base64, 'base64'); assert.equal(hash(frame), capture.response.sha256);
const forwardOriginal = readFileSync(new URL('./fixtures/wire-native-genesis/receipt-forward-2-4-20261020.json', import.meta.url));
assert.equal(hash(forwardOriginal), '38d75b7a1ba28e3abd77512854f963e7723631d6837df73bd7aeff656cc8a450');
const forward = JSON.parse(forwardOriginal);
assert.equal(forward.chainId, chainId); assert.equal(forward.schema.base64, fixture.schema.base64);
const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hyperion-native-genesis-'));
const originalSend = process.send, originalRole = process.env.worker_role, workers = [];
let coordinator, coordinatorFailure, parsedAck = 0;
const events = [], published = [];
try {
    const chain = 'native-genesis-fixture';
    const config = {settings: {chain, parser: '3.2', protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: fixture.profileId},
        eosio_alias: 'sysio', system_contract: 'sysio', index_version: 'v1', index_partition_size: 10000, ds_profiling: false, es_replicas: 0},
        indexer: {fetch_block: true, fetch_traces: true, fetch_deltas: true, process_deltas: true, disable_indexing: false, max_inline: 1},
        features: {index_all_deltas: true, index_deltas: true, index_deltas_deletions: true, streaming: {deltas: false, traces: false}, tables: {}, failed_trx: false},
        scaling: {ds_pool_size: 1, routing_mode: 'round_robin', indexing_queues: 1, ad_idx_queues: 1, dyn_idx_queues: 1, batch_size: 100},
        prefetch: {read: 1, block: 1, index: 1}, plugins: {}, whitelists: {root_only: false, actions: [], deltas: []}, api: {tx_cache_mode: 'batch'}};
    mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({amqp: {protocol: 'http'}, elasticsearch: {host: '127.0.0.1:1', user: '', pass: ''},
        chains: {[chain]: {chain_id: chainId, http: 'http://127.0.0.1:1', ship: 'ws://127.0.0.1:1'}}, redis: {host: '127.0.0.1', port: 1}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.worker_role = 'deserializer';
    process.send = event => {events.push(event); if (event.event === 'protocol_abi_prepared') coordinator.drain().catch(error => {coordinatorFailure = error;}); return true;};
    const {HyperionWorker, protocolSourceCapture} = await import('../../build/indexer/workers/hyperionWorker.js');
    HyperionWorker.prototype.connectAMQP = async function () {}; HyperionWorker.prototype.onConnect = function () {};
    const {default: MainDS} = await import('../../build/indexer/workers/deserializer.js');
    const {default: Reader} = await import('../../build/indexer/workers/state-reader.js');
    const {ProtocolAbiCoordinator} = await import('../../build/indexer/protocol/abi-coordinator.js');
    const {ProtocolAbiFrontierStore} = await import('../../build/indexer/protocol/abi-frontier-store.js');
    const {ProtocolAbiObservationStore} = await import('../../build/indexer/protocol/abi-observation-store.js');
    const {ProtocolSourceBindingStore, protocolSourceSelectionHeader} = await import('../../build/indexer/protocol/source-bindings.js');
    const {ProtocolAbiProofReader} = await import('../../build/indexer/protocol/abi-proof.js');
    const {DeclarativeProjectionRuntime} = await import('../../build/indexer/projection/runtime.js');
    const main = new MainDS(); workers.push(main); await main.protocolReady; await main.initializeProtocolShip(schemaJson);
    assert.equal(typeof main.protocol.verifyNativeGenesis, 'function', 'Installed Wire package must implement the portable hook');
    const deadline = Date.now() + 3000; while (!main.mLoader.parser) {assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));}
    const memory = frontierMemoryClient(), store = new ProtocolAbiFrontierStore(memory.client, chain);
    const bindings = new ProtocolSourceBindingStore(memory.client, chain), observations = new ProtocolAbiObservationStore(memory.client, chain);
    main.client = memory.client; main.protocolSourceBindingStore = bindings; main.protocolAbiObservationStore = observations;
    main.preIndexingQueue = {push: async value => published.push(value)};
    main.ch_ready = true; main.ch = {ack() {parsedAck++;}, nack() {throw new Error('Unexpected source nack');},
        sendToQueue(queue, content, options) {published.push({queue, content, options}); return true;}};
    const profile = {id: main.protocolId, profileId: main.protocol.profileId, components: main.protocolComponents};
    const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
    coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'native-genesis-master', bindings, observations, store,
        verifyNativeGenesis: main.protocol.verifyNativeGenesis.bind(main.protocol)});
    await coordinator.start(); const {generation} = await coordinator.openSource(contextId, 'verified-source-fixture');
    const res = main.decodeShipResult(frame)[1], retained = protocolSourceCapture(chainId, res, schemaJson);
    assert.equal(retained.source.blockNum, 1); assert.equal(retained.source.previousBlockId, null); assert.equal(retained.capture.tracesHex, null);
    const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'verified-source-fixture', readerRole: 'live',
        assignmentId: null, source: retained.source, frameSha256: hash(frame), captureSha256: retained.captureSha256,
        head: {blockNum: Number(res.head.block_num), blockId: res.head.block_id.toString()},
        irreversible: {blockNum: Number(res.last_irreversible.block_num), blockId: res.last_irreversible.block_id.toString()}})).id;
    assert.equal((await coordinator.admit(selectionId, generation)).status, 'accepted');
    const delivery = {content: frame, properties: {headers: {[protocolSourceSelectionHeader]: selectionId}}};
    main.captureProtocolSourceDelivery(delivery, main.ch);
    await main.mLoader.parser.parseMessage(main, [delivery]); if (coordinatorFailure) throw coordinatorFailure;
    assert.equal(parsedAck, 1); assert.equal(res.prev_block, null, 'Retained source was rewritten');
    const control = await coordinator.inspect(); assert.equal(control.head.blockNum, 1); assert.equal(control.head.coverageStart, 1);
    const link = await bindings.readObservationLink(selectionId), record = await observations.read(link.observationId);
    assert.equal(record.observation.status, 'native-genesis'); assert.equal(record.source.previousBlockId, null);
    assert.deepEqual(record.capture, retained.capture); assert.equal(record.source.inputSha256, retained.captureSha256);
    const sysio = await store.readAccount(control.head.stateRootId, 'sysio');
    assert.equal(hash(Buffer.from(sysio.abiHex, 'hex')), 'a57bc540b5c9d585cb20db92fff94e007c8dc3233c6e5bad3251c2701318e3d9');
    for (const [account, deltaOrdinal] of [['sysio.null', 1], ['sysio.prods', 2]]) {
        assert.deepEqual(Object.fromEntries(Object.entries(await store.readAccount(control.head.stateRootId, account)).filter(([key]) => ['account', 'present', 'abiHex'].includes(key))),
            {account, present: true, abiHex: ''});
        assert.equal((await store.readAccount(control.head.stateRootId, account)).source.deltaOrdinal, deltaOrdinal);
    }
    const light = published.filter(value => value.queue?.includes(':index_blocks:')).map(value => JSON.parse(value.content));
    assert.equal(light.length, 1); assert.equal(light[0].prev_id, zero); assert.equal(light[0].block_id, retained.source.blockId);
    const proofReader = new ProtocolAbiProofReader({chainId, profile, store});
    const proof = await proofReader.open(retained.source, selectionId), nativeFrame = await proofReader.nativeGenesisFrame(proof);
    assert.deepEqual(nativeFrame, {chainId, block: {blockNum: 1, blockId: retained.source.blockId, previousBlockId: zero}, changes: []});
    const definition = {schemaVersion: 1, id: 'inventory', mappingRevision: 'a'.repeat(64),
        source: {contract: 'items', table: 'inventory', abiDeployment: 'future-deployment', abiSha256: 'b'.repeat(64)},
        fields: [{name: 'owner', path: ['owner'], type: 'string'}], initialization: {kind: 'genesis'}};
    const binding = {chainId, backendId: 'reference', projectionId: definition.id, mappingRevision: definition.mappingRevision,
        abiDeployment: definition.source.abiDeployment, abiSha256: definition.source.abiSha256, generation: 'fixture-instance'};
    let checkpoint = {blockNum: 0, blockId: zero}; const applied = [];
    const adapter = {capabilities: {interfaceVersion: 1, supported: [...PROJECTION_CAPABILITIES]},
        async initialize() {return {binding, checkpoint};}, async open() {return {binding, checkpoint};},
        async apply(request) {assert.deepEqual({...request.previous}, checkpoint, 'Adapter cannot skip or replace completed source blocks');
            applied.push(request); checkpoint = {blockNum: request.block.blockNum, blockId: request.block.blockId};
            return {status: 'applied', view: {binding, checkpoint}};}, async markIncomplete() {throw new Error('Unexpected incomplete projection');},
        async query(view) {return {view, rows: []};}};
    const runtime = await DeclarativeProjectionRuntime.create({adapter, definition, binding, genesis: checkpoint});
    await runtime.process(nativeFrame); assert.deepEqual({...applied[0].previous}, {blockNum: 0, blockId: zero}); assert.deepEqual(applied[0].mutations, []);
    assert.deepEqual(checkpoint, {blockNum: 1, blockId: retained.source.blockId});
    let parent = retained.source.blockId;
    for (const source of forward.messages.filter(message => message.kind === 'block')) {
        const nextFrame = Buffer.from(source.response.base64, 'base64'); assert.equal(hash(nextFrame), source.response.sha256);
        const result = main.decodeShipResult(nextFrame)[1], next = protocolSourceCapture(chainId, result, schemaJson);
        assert.equal(next.source.blockNum, checkpoint.blockNum + 1); assert.equal(next.source.previousBlockId, parent);
        const nextSelection = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: 'verified-source-fixture', readerRole: 'live',
            assignmentId: null, source: next.source, frameSha256: hash(nextFrame), captureSha256: next.captureSha256,
            head: {blockNum: Number(result.head.block_num), blockId: result.head.block_id.toString()},
            irreversible: {blockNum: Number(result.last_irreversible.block_num), blockId: result.last_irreversible.block_id.toString()}})).id;
        assert.equal((await coordinator.admit(nextSelection, generation)).status, 'accepted');
        const nextDelivery = {content: nextFrame, properties: {headers: {[protocolSourceSelectionHeader]: nextSelection}}};
        main.captureProtocolSourceDelivery(nextDelivery, main.ch); await main.mLoader.parser.parseMessage(main, [nextDelivery]);
        if (coordinatorFailure) throw coordinatorFailure;
        const nextLink = await bindings.readObservationLink(nextSelection), observed = await observations.read(nextLink.observationId);
        assert.equal(observed.observation.status, 'observed'); assert.equal(observed.observation.facts.actionInputs.length, 1);
        const nextView = await proofReader.open(next.source, nextSelection);
        assert.equal(nextView.bindings.length, 1);
        const state = await proofReader.action(nextView, observed.observation.facts.actionInputs[0]);
        assert.equal(hash(Buffer.from(state.state.abiHex, 'hex')), 'a57bc540b5c9d585cb20db92fff94e007c8dc3233c6e5bad3251c2701318e3d9');
        await assert.rejects(proofReader.nativeGenesisFrame(nextView), {code: 'native_genesis_unavailable'});
        // Actual fully decoded delta vectors have no application table/index stream. This is
        // source evidence; the empty header transaction list is deliberately insufficient.
        const deltas = main.decodeShipValue('table_delta[]', result.deltas);
        assert(deltas.length > 0);
        for (const [, delta] of deltas) assert(!['contract_row', 'contract_row_kv', 'contract_index_kv'].includes(delta.name));
        const nextProjection = {chainId, block: {blockNum: next.source.blockNum, blockId: next.source.blockId, previousBlockId: parent}, changes: []};
        await proofReader.revalidate(nextView); await runtime.process(nextProjection);
        parent = next.source.blockId;
    }
    assert.equal(checkpoint.blockNum, 4); assert.equal(parsedAck, 4); assert.equal((await coordinator.inspect()).head.coverageStart, 1);
    await assert.rejects(runtime.process({chainId, block: {blockNum: 6, blockId: '6'.repeat(64), previousBlockId: '5'.repeat(64)}, changes: []}));
    assert.equal(checkpoint.blockNum, 4);
    // Production reader methods: the one native gap may be fetched; later gaps stay strict.
    const reader = Object.assign(Object.create(Reader.prototype), {conf: config, baseRequest: {fetch_block: true, fetch_deltas: true},
        protocol: main.protocol, shipInitStatus: {trace_begin_block: 2, chain_state_begin_block: 1, chain_state_end_block: 5}});
    assert.equal(reader.sourceRangeAvailable(1), true); assert.equal(reader.sourceRangeAvailable(2), true);
    reader.shipInitStatus.trace_begin_block = 3; assert.equal(reader.sourceRangeAvailable(1), false); assert.equal(reader.sourceRangeAvailable(2), false);
    reader.shipInitStatus.trace_begin_block = 2; reader.baseRequest.fetch_block = false; assert.equal(reader.sourceRangeAvailable(1), false);
    reader.baseRequest.fetch_block = true; reader.protocol = {...main.protocol, verifyNativeGenesis: undefined}; assert.equal(reader.sourceRangeAvailable(1), false);
    reader.protocol = main.protocol; const ranges = [], failures = [];
    Object.assign(reader, {allowRequests: true, publications: new Map(), requestBlockRange(first, last) {ranges.push([first, last]);},
        failSourceRecovery(reason) {failures.push(reason);}});
    reader.newRange({first_block: 1, last_block: 2}); assert.deepEqual(ranges, [[1, 2]]); assert.deepEqual(failures, []);
    reader.shipInitStatus.trace_begin_block = 3; reader.newRange({first_block: 2, last_block: 3});
    assert.equal(ranges.length, 1); assert.equal(failures.length, 1);
    await coordinator.revokeSource('verified-source-fixture');
    await assert.rejects(proofReader.nativeGenesisFrame(proof), {code: 'authority_unavailable'});
    console.log(JSON.stringify({passed: true, originalCapture: true, nativeGenesis: true, parserAckAfterDurability: true,
        checkpoint: checkpoint.blockNum, fullWorkerQualification: false, brokerDatabaseTransport: 'in-memory', publicActionGate: false}));
} finally {
    for (const worker of workers) {worker.shipSession?.close?.(); worker.profiler?.stopReporting();}
    process.send = originalSend; if (originalRole === undefined) delete process.env.worker_role; else process.env.worker_role = originalRole;
    process.chdir(previous); rmSync(directory, {recursive: true, force: true});
}
