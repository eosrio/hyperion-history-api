import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) throw new Error('Extension API imported the legacy addon');
    return next(specifier, context);
}});
const {loadChainProtocol} = await import('../../build/indexer/protocol/selection.js');
const {ProtocolAbiCoordinator} = await import('../../build/indexer/protocol/abi-coordinator.js');
const {ProtocolAbiFrontierStore} = await import('../../build/indexer/protocol/abi-frontier-store.js');
const {ProtocolAbiObservationStore, protocolAbiCaptureDigest} = await import('../../build/indexer/protocol/abi-observation-store.js');
const {ProtocolSourceBindingStore} = await import('../../build/indexer/protocol/source-bindings.js');
const {default: registerV1} = await import('../../build/api/routes/v1-history/get_actions/index.js');
const {default: registerV2} = await import('../../build/api/routes/v2-history/get_actions/index.js');
const {default: registerTransactionV1} = await import('../../build/api/routes/v1-history/get_transaction/index.js');
const {default: registerTransactionV2} = await import('../../build/api/routes/v2-history/get_transaction/index.js');
const {regroupActions} = await import('../../build/api/helpers/regroup-actions.js');
const profileId = process.env.HYPERION_WIRE_PROFILE;
const protocol = {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId};
const selected = await loadChainProtocol(protocol), codec = selected.provider.contractCodec;
const profile = {id: selected.id, profileId, components: selected.components};
const chain = 'api-proof-fixture', chainId = '1'.repeat(64), transactionId = 'a'.repeat(64);
const blockId = number => number.toString(16).padStart(64, '0');
const schemaJson = '{"version":"eosio::abi/1.1"}';
const memory = frontierMemoryClient(), store = new ProtocolAbiFrontierStore(memory.client, chain);
const bindings = new ProtocolSourceBindingStore(memory.client, chain), observations = new ProtocolAbiObservationStore(memory.client, chain);
const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
const coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'api-fixture-owner', bindings, observations, store});
await coordinator.start();
const session = 'api-fixture-reader'; let generation = (await coordinator.openSource(contextId, session)).generation;
const empty = () => ({schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []});
const input = (ordinal, globalSequence, account = 'alpha', name = 'record', rawHex = '07000000') => ({transactionId,
    actionOrdinal: ordinal, inputActionOrdinal: ordinal, receiver: account, account, name, rawHex, globalSequence, receiptAbiSequence: '0'});
async function append(number, facts, identity = number, parent = number - 1) {
    const source = {chainId, blockNum: number, blockId: blockId(identity), previousBlockId: number === 1 ? null : blockId(parent)};
    const capture = {kind: 'unattested-ship-result-sections-v1', schemaJson, blockHex: '00', tracesHex: '00', deltasHex: '00'};
    const captureSha256 = protocolAbiCaptureDigest(source, capture);
    const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: session,
        readerRole: 'live', assignmentId: null, source, captureSha256,
        frameSha256: createHash('sha256').update('independent-api-facts-' + identity).digest('hex'),
        head: {blockNum: number, blockId: source.blockId}, irreversible: {blockNum: 0, blockId: blockId(0)}})).id;
    const prepared = await observations.prepare({schemaVersion: 1, protocol: profile, source: {...source, inputSha256: captureSha256},
        capture, observation: {status: 'observed', facts}});
    await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: prepared.id, observationDigest: prepared.digest});
    const admitted = await coordinator.admit(selectionId, generation); assert.equal(admitted.status, 'accepted'); generation = admitted.generation;
    await coordinator.drain();
    return {source: {chainId, blockNum: number, blockId: source.blockId}, selectionId};
}
const definition = field => ({version: 'sysio::abi/1.3', types: [], structs: [{name: 'record', base: '', fields: [{name: field, type: 'uint32'}]}],
    actions: [{name: 'record', type: 'record', ricardian_contract: ''}], tables: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: []});
const oldAbi = Buffer.from(codec.encodeAbi(definition('value'))).toString('hex');
const newAbi = Buffer.from(codec.encodeAbi(definition('other'))).toString('hex');
assert.equal(oldAbi.length, newAbi.length); assert.notEqual(oldAbi, newAbi);
const initial = empty(); initial.finalStates = [{account: 'alpha', present: true, abiHex: oldAbi, deltaOrdinal: 0}]; await append(1, initial);
const facts = empty(); facts.actionInputs = [input(1, '9007199254740993'), input(2, '9007199254740994', 'sysio', 'setabi', 'fe'), input(3, '9007199254740995')];
facts.deployments = [{account: 'alpha', abiHex: newAbi, action: {transactionId, actionOrdinal: 2}, globalSequence: '9007199254740994', effect: 'native-before-receipt'}];
facts.finalStates = [{account: 'alpha', present: true, abiHex: newAbi, deltaOrdinal: 0}];
const bound = await append(2, facts);
const action = (occurrence = facts.actionInputs[0], data = {value: 7, enrichment: 'ignored'}) => ({
    global_sequence: Number(occurrence.globalSequence), block_num: 2, block_id: blockId(2), '@timestamp': '2026-10-20T00:00:00.000',
    trx_id: transactionId, action_ordinal: occurrence.actionOrdinal, creator_action_ordinal: 0,
    act: {account: occurrence.account, name: occurrence.name, authorization: [], data},
    receipts: [{receiver: occurrence.receiver, recv_sequence: 1, global_sequence: Number(occurrence.globalSequence), auth_sequence: []}],
    protocol: {schemaVersion: 1, source: structuredClone(bound.source), selectionId: bound.selectionId, input: structuredClone(occurrence)}});
const responseCache = new Map(); let current = action(), transactionCache = {}, searches = 0;
const complete = value => ({took: 1, timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
    hits: {total: {value: value.length, relation: 'eq'}, hits: value.map(_source => ({_source: structuredClone(_source)}))}});
async function createApp(ancestryBound) {
const app = Fastify({logger: false});
app.decorate('manager', {chain, conn: {chains: {[chain]: {chain_id: chainId}}}, readIndexset: () => chain + '-action-*',
    config: {settings: {protocol, es_replicas: 0, index_partition_size: 10000, index_version: 'v1',
        ...(ancestryBound ? {protocol_abi_coordination: {recovery_window_blocks: ancestryBound}} : {})},
        api: {enable_caching: true, cache_life: 60, limits: {get_actions: 10, get_trx_actions: 10}, query_timeout: '10s'}}});
app.decorate('elastic', {...memory.client, search: async query => {
    assert.equal(query.index, chain + '-action-*', 'API attempted an unversioned ABI/history lookup'); searches++; return complete([current]);
}});
app.decorate('redis', {get: async key => responseCache.get(key) ?? null,
    set: async (key, value) => {responseCache.set(key, value); return 'OK';}, hgetall: async () => transactionCache, ttl: async () => 60});
app.decorate('antelope', {chain: {get_info: async () => ({last_irreversible_block_num: {toNumber: () => 99}})},
    getAbi: async () => {throw new Error('API attempted a head ABI fallback');}});
app.decorate('allowedActionQueryParamSet', new Set());
await app.register(registerV1, {prefix: '/v1/history'}); await app.register(registerV2, {prefix: '/v2/history'});
await app.register(registerTransactionV1, {prefix: '/v1/history'}); await app.register(registerTransactionV2, {prefix: '/v2/history'}); await app.ready();
return app;
}
const app=await createApp();
const request = (hex_data = true) => app.inject({method: 'POST', url: '/v1/history/get_actions', payload: {account_name: 'alpha', hex_data}});
const v2 = () => app.inject({method: 'GET', url: '/v2/history/get_actions?hydrate=false'});
const transaction = version => app.inject(version === 1 ? {method: 'POST', url: '/v1/history/get_transaction', payload: {id: transactionId}}
    : {method: 'GET', url: '/v2/history/get_transaction?id=' + transactionId + '&hydrate=false'});
const writes = () => memory.calls.filter(call => ['createIndex', 'create', 'index'].includes(call.method)).length;
try {
    let before = writes();
    for (const [occurrence, data] of [[facts.actionInputs[0], {value: 7, enrichment: 'ignored'}], [facts.actionInputs[2], {other: 7}], [facts.actionInputs[0], {value: 7}]]) {
        responseCache.clear(); current = action(occurrence, data);
        const response = await request(); assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().actions[0].action_trace.act.hex_data, occurrence.rawHex);
        assert.equal(response.json().actions[0].action_trace.act.hex_encoder, selected.id);
        assert(!response.body.includes('_hyperion_protocol_abi')); assert(!response.body.includes('inputActionOrdinal'));
    }
    assert.equal(writes(), before, 'An API proof consumer wrote/repaired coordinator storage');
    const searchBefore = searches, cached = await request(); assert.equal(cached.statusCode, 200, cached.body); assert.equal(searches, searchBefore);
    assert([...responseCache.values()].some(value => value.includes('_hyperion_protocol_abi_v2')));
    // Tampered rendered JSON and exact original anchors/raw hashes cannot borrow a valid ABI.
    for (const mutate of [value => {value.act.data.value = 8;}, value => {value.protocol.input.rawHex = '08000000';},
        value => {value.protocol.input.globalSequence = String(Number(value.protocol.input.globalSequence));},
        value => {value.protocol.source.blockId = 'f'.repeat(64);}, value => {delete value.protocol;}]) {
        responseCache.clear(); current = action(); mutate(current);
        const response = await request(); assert.equal(response.statusCode, 503, response.body);
    }
    // Legacy response entries with decoded data and no proof sidecar miss and re-evaluate the source.
    responseCache.clear(); current = action(); await request();
    const entry = [...responseCache.entries()][0], unversioned = JSON.parse(entry[1]); delete unversioned._hyperion_protocol_abi_v2;
    responseCache.set(entry[0], JSON.stringify(unversioned)); delete current.protocol;
    const missing = await request(); assert.equal(missing.statusCode, 503, missing.body);
    // Incomplete and old unproved raw history stays readable, including response-cache hits.
    for (const metadata of [undefined, {...action().protocol, status: 'incomplete', input: {...facts.actionInputs[0], inputActionOrdinal: undefined}, error: {code: 'gap', message: 'retained input'}}]) {
        responseCache.clear(); current = action(facts.actionInputs[0], facts.actionInputs[0].rawHex); current.protocol = metadata;
        const raw = await request(false); assert.equal(raw.statusCode, 200, raw.body); assert.equal(raw.json().actions[0].action_trace.act.data, '07000000');
        const rawCached = await request(false); assert.equal(rawCached.statusCode, 200, rawCached.body);
        const encoded = await request(true); assert.equal(encoded.statusCode, 503, encoded.body);
    }
    // Both transaction Redis paths validate original occurrences before grouping or serving JSON.
    for (const version of [1, 2]) {
        responseCache.clear(); transactionCache = {one: JSON.stringify(action())};
        const response = await transaction(version); assert.equal(response.statusCode, 200, response.body);
        assert(!response.body.includes('inputActionOrdinal')); assert(!response.body.includes('_hyperion_protocol_abi'));
        responseCache.clear(); const bad = action(); bad.protocol.input.rawHex = '08000000'; transactionCache = {one: JSON.stringify(bad)};
        const refused = await transaction(version); assert.equal(refused.statusCode, 503, refused.body);
        responseCache.clear(); const raw = action(facts.actionInputs[0], facts.actionInputs[0].rawHex); delete raw.protocol;
        transactionCache = {one: JSON.stringify(raw)};
        const retained = await transaction(version); assert.equal(retained.statusCode, 200, retained.body);
    }
    transactionCache = {}; responseCache.clear(); current = action();
    assert.equal((await v2()).statusCode, 200);
    // A source revocation during asynchronous proof resolution cannot publish an otherwise valid value.
    responseCache.clear(); let revoked = false;
    memory.faults.beforeRead = async query => {if (!revoked && query.id.startsWith('h45abist1:')) {revoked = true; await coordinator.revokeSource(session);}};
    const interrupted = await request(); assert.equal(interrupted.statusCode, 503, interrupted.body); delete memory.faults.beforeRead;
    generation = (await coordinator.openSource(contextId, session)).generation;
    const emptyThird = await append(3, empty());
    await append(4,empty());
    const narrow=await createApp(1),wide=await createApp(4);
    try {
        responseCache.clear();current=action();
        const bounded=await narrow.inject({method:'POST',url:'/v1/history/get_actions',payload:{account_name:'alpha',hex_data:true}});
        assert.equal(bounded.statusCode,503,'API ignored the configured one-block ancestry bound: '+bounded.body);
        responseCache.clear();
        const retained=await wide.inject({method:'POST',url:'/v1/history/get_actions',payload:{account_name:'alpha',hex_data:true}});
        assert.equal(retained.statusCode,200,retained.body);
        assert.equal(retained.json().actions[0].action_trace.act.hex_data,'07000000');
    }finally{await narrow.close();await wide.close();responseCache.clear();}
    responseCache.clear(); current = action(); const primed = await request(); assert.equal(primed.statusCode, 200, primed.body);
    // A fresh canonical generation with a replacement block revokes cached old-branch output.
    await append(2, facts, 20, 1);
    const stale = await request(); assert.equal(stale.statusCode, 503, stale.body);
    for (const version of [1, 2]) {
        responseCache.clear(); transactionCache = {one: JSON.stringify(action())};
        const orphaned = await transaction(version); assert.equal(orphaned.statusCode, 503, orphaned.body);
    }
    transactionCache = {};
    responseCache.clear(); current.protocol = {...current.protocol, source: {...bound.source, blockId: blockId(20)}};
    const mismatch = await request(); assert.equal(mismatch.statusCode, 503, mismatch.body);
    // Infrastructure failures stay unavailable; API consumers cannot provision or repair them.
    responseCache.clear(); current = action();
    memory.faults.beforeRead = query => {if (query.index === store.controlIndex) throw new Error('Frontier unavailable');};
    const unavailable = await request(); assert.equal(unavailable.statusCode, 503, unavailable.body); delete memory.faults.beforeRead;
    // Different certified input origins stay distinct even when legacy digest grouping would merge them.
    const first = action(), later = action(facts.actionInputs[2], {other: 7});
    first.act_digest = later.act_digest = 'same'; later.creator_action_ordinal = first.action_ordinal;
    assert.equal(regroupActions([first, later]).length, 2);
    // Optional action roots produce derived null, distinct from retained raw bytes or a missing payload.
    const optionalDefinition = definition('value');
    optionalDefinition.types = [{new_type_name: 'nullable_record', type: 'record?'}];
    optionalDefinition.actions[0].type = 'nullable_record';
    const optionalAbi = Buffer.from(codec.encodeAbi(optionalDefinition)).toString('hex');
    const optionalValueAbi = codec.decodeAbi(Buffer.from(optionalAbi, 'hex'));
    assert.equal(Buffer.from(codec.encodeValue(optionalValueAbi, 'nullable_record', null)).toString('hex'), '00');
    assert.equal(codec.decodeValue(optionalValueAbi, 'nullable_record', Buffer.from('00', 'hex')), null);
    const optionalFacts = empty();
    optionalFacts.actionInputs = [input(1, '9007199254740996', 'sysio', 'setabi', 'fe'), input(2, '9007199254740997', 'alpha', 'record', '00')];
    optionalFacts.deployments = [{account: 'alpha', abiHex: optionalAbi, action: {transactionId, actionOrdinal: 1},
        globalSequence: '9007199254740996', effect: 'native-before-receipt'}];
    optionalFacts.finalStates = [{account: 'alpha', present: true, abiHex: optionalAbi, deltaOrdinal: 0}];
    const optionalBound = await append(3, optionalFacts, 3, 20);
    const nullable = action(optionalFacts.actionInputs[1], null);
    nullable.block_num = 3; nullable.block_id = blockId(3); nullable.protocol = {schemaVersion: 1, ...optionalBound, input: structuredClone(optionalFacts.actionInputs[1])};
    responseCache.clear(); current = nullable;
    const nullableEncoded = await request(); assert.equal(nullableEncoded.statusCode, 200, nullableEncoded.body);
    assert.equal(nullableEncoded.json().actions[0].action_trace.act.data, null);
    assert.equal(nullableEncoded.json().actions[0].action_trace.act.hex_data, '00');
    const nullableResponse = await v2(); assert.equal(nullableResponse.statusCode, 200, nullableResponse.body);
    assert.equal(nullableResponse.json().actions[0].act.data, null);
    await append(3, optionalFacts, 30, 20);
    const staleNull = await v2(); assert.equal(staleNull.statusCode, 503, 'Cached derived null bypassed a fork fence: ' + staleNull.body);
    const cachedNullEntry = [...responseCache.entries()].find(([, value]) => JSON.parse(value).actions?.[0]?.act?.data === null);
    const legacyNull = JSON.parse(cachedNullEntry[1]);
    legacyNull._hyperion_protocol_abi_v1 = {...legacyNull._hyperion_protocol_abi_v2, actions: []}; delete legacyNull._hyperion_protocol_abi_v2;
    responseCache.set(cachedNullEntry[0], JSON.stringify(legacyNull));
    const legacyCachedNull = await v2(); assert.equal(legacyCachedNull.statusCode, 503, legacyCachedNull.body);
    for (const version of [1, 2]) {
        responseCache.clear(); transactionCache = {one: JSON.stringify(nullable)};
        const orphanedNull = await transaction(version); assert.equal(orphanedNull.statusCode, 503, orphanedNull.body);
    }
    responseCache.clear(); transactionCache = {}; current = {...nullable, act: {...nullable.act, data: '00'}}; delete current.protocol;
    const rawOptional = await v2(); assert.equal(rawOptional.statusCode, 200, rawOptional.body); assert.equal(rawOptional.json().actions[0].act.data, '00');
    console.log(JSON.stringify({passed: true, profileId, certifiedInputEncoding: true, sameSizeAbi: true, rawHash: true,
        responseCache: true, transactionCache: true, forkRevalidation: true, nullableRoot: true, rawHistory: true, consumerWrites: false, syntheticConsensus: false}));
} finally {await app.close();}
