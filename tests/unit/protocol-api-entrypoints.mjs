import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {MockAgent, getGlobalDispatcher, setGlobalDispatcher} from 'undici';
import {PrivateKey} from '@wharfkit/antelope';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) throw new Error('Extension API imported the legacy addon');
    // Exercise SocketManager routing methods without constructing a transport or Redis adapter.
    if (specifier === 'uWebSockets.js') return {url: 'data:text/javascript,export const App=()=>{};', shortCircuit: true};
    return next(specifier, context);
}});
const {loadChainProtocol} = await import('../../build/indexer/protocol/selection.js');
const {ProtocolAbiCoordinator} = await import('../../build/indexer/protocol/abi-coordinator.js');
const {ProtocolAbiFrontierStore} = await import('../../build/indexer/protocol/abi-frontier-store.js');
const {ProtocolAbiObservationStore, protocolAbiCaptureDigest} = await import('../../build/indexer/protocol/abi-observation-store.js');
const {ProtocolSourceBindingStore} = await import('../../build/indexer/protocol/source-bindings.js');
const {streamPastCommon} = await import('../../build/api/helpers/functions.js');
const {protectProtocolAction} = await import('../../build/api/helpers/protocol-abi.js');
const {SocketManager, maximumPendingLiveActions, maximumPendingLiveActionBytes} = await import('../../build/api/socketManager.js');
const profileId = process.env.HYPERION_WIRE_PROFILE, protocol = {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId};
const selected = await loadChainProtocol(protocol), codec = selected.provider.contractCodec;
async function standardHandlers() {
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-api-handlers-')), configPath = join(directory, 'chain.json');
    const previousConfig = process.env.CONFIG_JSON;
    writeFileSync(configPath, JSON.stringify({features: {index_transfer_memo: true}})); process.env.CONFIG_JSON = configPath;
    try {
        return Object.fromEntries(await Promise.all(['transfer', 'eosio-newaccount', 'eosio-buyram', 'eosio-updateauth'].map(async name =>
            [name, (await import(`../../build/indexer/modules/action_data/${name}.js`)).hyperionModule.handler])));
    } finally {
        if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
        unlinkSync(configPath); rmdirSync(directory);
    }
}
const handlers = await standardHandlers();
const profile = {id: selected.id, profileId, components: selected.components};
const chain = 'api-entrypoint-fixture', chainId = '1'.repeat(64), transactionId = 'a'.repeat(64), session = 'entrypoint-reader';
const blockId = value => value.toString(16).padStart(64, '0'), schemaJson = '{}';
const memory = frontierMemoryClient(), store = new ProtocolAbiFrontierStore(memory.client, chain);
const bindings = new ProtocolSourceBindingStore(memory.client, chain), observations = new ProtocolAbiObservationStore(memory.client, chain);
const contextId = (await bindings.prepareContext({schemaVersion: 1, chainId, protocol: profile, schemaJson})).id;
const coordinator = new ProtocolAbiCoordinator({chainId, profile, ownerId: 'entrypoint-owner', bindings, observations, store});
await coordinator.start(); let generation = (await coordinator.openSource(contextId, session)).generation;
const empty = () => ({schemaVersion: 1, actionInputs: [], deployments: [], finalStates: []});
async function append(number, facts, identity = number, parent = number - 1) {
    const source = {chainId, blockNum: number, blockId: blockId(identity), previousBlockId: number === 1 ? null : blockId(parent)};
    const capture = {kind: 'unattested-ship-result-sections-v1', schemaJson, blockHex: '00', tracesHex: '00', deltasHex: '00'};
    const captureSha256 = protocolAbiCaptureDigest(source, capture);
    const selectionId = (await bindings.prepareSelection({schemaVersion: 1, contextId, readerSessionId: session, readerRole: 'live', assignmentId: null,
        source, captureSha256, frameSha256: createHash('sha256').update('independent-entrypoint-' + identity).digest('hex'),
        head: {blockNum: number, blockId: source.blockId}, irreversible: {blockNum: 0, blockId: blockId(0)}})).id;
    const observed = await observations.prepare({schemaVersion: 1, protocol: profile, source: {...source, inputSha256: captureSha256}, capture,
        observation: {status: 'observed', facts}});
    await bindings.prepareObservationLink({schemaVersion: 1, selectionId, observationId: observed.id, observationDigest: observed.digest});
    const admitted = await coordinator.admit(selectionId, generation); assert.equal(admitted.status, 'accepted'); generation = admitted.generation;
    await coordinator.drain(); return {source: {chainId, blockNum: number, blockId: source.blockId}, selectionId};
}
// Portable facts test applicability; installed profile codecs test the actual ABI/value path.
const rootFields = [{name: 'account', type: 'name'}, {name: 'name', type: 'name'}, {name: 'authorization', type: 'permission[]'}];
const primitiveCases = [['boolroot', 'bool', false], ['numroot', 'uint32', 7], ['arrayroot', 'uint16[]', [1, 2]]];
const abi = {version: 'sysio::abi/1.3', types: [], structs: [{name: 'entry', base: '', fields: [
    {name: 'value', type: 'uint32'}, ...['creator', 'newact', 'account', 'to'].map(name => ({name, type: 'name'}))]},
    {name: 'permission', base: '', fields: [{name: 'actor', type: 'name'}, {name: 'permission', type: 'name'}]},
    {name: 'root_fields', base: '', fields: rootFields},
    {name: 'root_data_fields', base: '', fields: [...rootFields, {name: 'data', type: 'uint32'}]}],
    actions: [...['newaccount', 'transfer', 'timestamp'].map(name => ({name, type: 'entry', ricardian_contract: ''})),
        {name: 'plainroot', type: 'root_fields', ricardian_contract: ''}, {name: 'dataroot', type: 'root_data_fields', ricardian_contract: ''},
        ...primitiveCases.map(([name, type]) => ({name, type, ricardian_contract: ''}))], tables: [],
    ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: []};
const abiHex = Buffer.from(codec.encodeAbi(abi)).toString('hex'), value = {value: 7, creator: 'alice', newact: 'bob', account: 'bob', to: 'bob'};
const rawHex = Buffer.from(codec.encodeValue(abi, 'entry', value)).toString('hex');
const field = (name, type) => ({name, type}), authority = {threshold: 1, keys: [], accounts: [], waits: []};
const nativeAbi = {version: 'sysio::abi/1.3', types: [{new_type_name: 'optional_transfer', type: 'transfer?'}], structs: [
    {name: 'permission_level', base: '', fields: [field('actor', 'name'), field('permission', 'name')]},
    {name: 'key_weight', base: '', fields: [field('key', 'public_key'), field('weight', 'uint16')]},
    {name: 'permission_weight', base: '', fields: [field('permission', 'permission_level'), field('weight', 'uint16')]},
    {name: 'wait_weight', base: '', fields: [field('wait_sec', 'uint32'), field('weight', 'uint16')]},
    {name: 'authority', base: '', fields: [field('threshold', 'uint32'), field('keys', 'key_weight[]'), field('accounts', 'permission_weight[]'), field('waits', 'wait_weight[]')]},
    {name: 'transfer', base: '', fields: [field('from', 'name'), field('to', 'name'), field('quantity', 'asset'), field('memo', 'string')]},
    {name: 'newaccount', base: '', fields: [field('creator', 'name'), field('name', 'name'), field('owner', 'authority'), field('active', 'authority')]},
    {name: 'buyram', base: '', fields: [field('payer', 'name'), field('receiver', 'name'), field('quant', 'asset')]},
    {name: 'updateauth', base: '', fields: [field('account', 'name'), field('permission', 'name'), field('parent', 'name'), field('auth', 'authority')]}
], actions: ['transfer', 'newaccount', 'buyram', 'updateauth', 'opttransfer'].map(name => ({name,
    type: name === 'opttransfer' ? 'optional_transfer' : name, ricardian_contract: ''})), tables: [], ricardian_clauses: [],
    error_messages: [], abi_extensions: [], variants: []};
const transferValue = {from: 'alice', to: 'bob', quantity: '1.2500 SYS', memo: 'original memo'};
const nativeCases = [
    {name: 'transfer', data: transferValue, handler: 'transfer'},
    {name: 'newaccount', data: {creator: 'alice', name: 'bob', owner: authority, active: authority}, handler: 'eosio-newaccount'},
    {name: 'buyram', data: {payer: 'alice', receiver: 'bob', quant: '1.2500 SYS'}, handler: 'eosio-buyram'},
    {name: 'updateauth', data: {account: 'bob', permission: 'active', parent: 'owner', auth: authority}, handler: 'eosio-updateauth'},
    {name: 'opttransfer', type: 'optional_transfer', data: transferValue, handler: 'transfer'}];
const initial = empty(); initial.finalStates = [{account: 'alpha', present: true, abiHex, deltaOrdinal: 0},
    {account: 'native', present: true, abiHex: Buffer.from(codec.encodeAbi(nativeAbi)).toString('hex'), deltaOrdinal: 1}]; await append(1, initial);
const facts = empty(); facts.actionInputs = Array.from({length: 66}, (_, index) => index === 1 ? 'transfer' : 'newaccount').map((name, index) => ({transactionId, actionOrdinal: index + 1,
    inputActionOrdinal: index + 1, receiver: 'alpha', account: 'alpha', name, rawHex, globalSequence: String(101 + index), receiptAbiSequence: '0'}));
const rootValue = {account: 'bob', name: 'alice', authorization: [{actor: 'alice', permission: 'active'}]};
const rootCases = [['plainroot', 'root_fields', rootValue], ['dataroot', 'root_data_fields', {...rootValue, data: 7}]];
for (const [name, type, data] of [...rootCases, ...primitiveCases]) {
    const actionOrdinal = facts.actionInputs.length + 1;
    facts.actionInputs.push({transactionId, actionOrdinal, inputActionOrdinal: actionOrdinal, receiver: 'alpha', account: 'alpha', name,
        rawHex: Buffer.from(codec.encodeValue(abi, type, data)).toString('hex'), globalSequence: String(100 + actionOrdinal), receiptAbiSequence: '0'});
}
for (const {name, type, data} of nativeCases) {
    const actionOrdinal = facts.actionInputs.length + 1;
    facts.actionInputs.push({transactionId, actionOrdinal, inputActionOrdinal: actionOrdinal, receiver: 'native', account: 'native', name,
        rawHex: Buffer.from(codec.encodeValue(nativeAbi, type ?? name, data)).toString('hex'), globalSequence: String(100 + actionOrdinal), receiptAbiSequence: '0'});
}
const timestampIndex = facts.actionInputs.length, timestampOrdinal = timestampIndex + 1;
facts.actionInputs.push({transactionId, actionOrdinal: timestampOrdinal, inputActionOrdinal: timestampOrdinal, receiver: 'alpha', account: 'alpha',
    name: 'timestamp', rawHex, globalSequence: String(100 + timestampOrdinal), receiptAbiSequence: '0'});
const bound = await append(2, facts);
const action = (index = 0, raw = false) => ({block_num: 2, block_id: blockId(2), trx_id: transactionId, '@timestamp': '2026-10-20T00:00:00.000',
    global_sequence: facts.actionInputs[index].globalSequence, action_ordinal: index + 1, creator_action_ordinal: 0,
    act: {account: facts.actionInputs[index].account, name: facts.actionInputs[index].name, authorization: [{actor: 'alice', permission: 'active'}],
        data: raw ? facts.actionInputs[index].rawHex : structuredClone(value)},
    receipts: [{receiver: facts.actionInputs[index].receiver, global_sequence: facts.actionInputs[index].globalSequence, recv_sequence: '1', auth_sequence: []}],
    protocol: {schemaVersion: 1, source: structuredClone(bound.source), selectionId: bound.selectionId, input: structuredClone(facts.actionInputs[index])}});
let current = action(), streamRows = null, streamTotal, initialFault, nextFault, emptySearch = false, nodeKeys = false;
let searches = 0, cacheReads = 0, clearCalls = [];
const cache = new Map(), complete = rows => ({took: 1, timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
    hits: {total: {value: rows.length, relation: 'eq'}, hits: rows.map(_source => ({_source: structuredClone(_source)}))}});
const app = Fastify({logger: false});
let cancelledHttp;
app.addHook('onError', (_request, _reply, error, done) => {if (error.code === 'proof_cancelled') cancelledHttp?.resolve(); done();});
app.decorate('manager', {chain, conn: {chains: {[chain]: {chain_id: chainId}}}, readIndexset: () => chain + '-action-*', config: {
    settings: {protocol, es_replicas: 0, eosio_alias: 'alpha'}, api: {enable_caching: true, cache_life: 60, chain_api: 'http://chain-fixture',
        limits: {get_actions: 10, get_created_accounts: 10, get_key_accounts: 10}, stream_scroll_batch: 10}}});
app.decorate('elastic', {...memory.client, search: async query => {
    searches++;
    if (query.index === chain + '-block-*') return complete([{block_num: 2, block_id: blockId(2), prev_id: blockId(1), producer: 'alpha', '@timestamp': current['@timestamp']}]);
    assert.equal(query.index, chain + '-action-*');
    const result = complete(emptySearch ? [] : query.scroll ? streamRows ?? [current] : [current]);
    if (query.scroll) {
        assert.equal(query.track_total_hits, true); result._scroll_id = 'owned-entrypoint-scroll';
        if (streamTotal !== undefined) result.hits.total.value = streamTotal;
        initialFault?.(result);
    }
    if (query.aggs) {
        result.aggregations = {cpu_extended_stats: {count: 1}, net_extended_stats: {count: 1}, cpu_percentiles: {values: {'50.0': 1}}, net_percentiles: {values: {'50.0': 1}}};
    }
    return result;
}, scroll: async () => {
    const result = complete([current]); result._scroll_id = 'next-entrypoint-scroll'; result.hits.total.value = streamTotal;
    nextFault?.(result); return result;
}, clearScroll: async query => {clearCalls.push(query.scroll_id); return {succeeded: true};}});
app.decorate('redis', {get: async key => {cacheReads++; return cache.get(key) ?? null;}, set: async (key, data) => {cache.set(key, data); return 'OK';}});
app.decorate('antelope', {chain: {get_info: async () => ({last_irreversible_block_num: {toNumber: () => 99, valueOf: () => 99}})},
    getAbi: async () => {throw new Error('Head ABI fallback');}});
app.decorate('allowedActionQueryParamSet', new Set());
const registrations = [
    ['v1-trace/get_block', '/v1/trace'], ['v1-history/get_controlled_accounts', '/v1/history'],
    ['v2-history/get_created_accounts', '/v2/history'], ['v2-history/get_creator', '/v2/history'],
    ['v2-state/get_key_accounts', '/v2/state'], ['v2-stats/get_resource_usage', '/v2/stats'],
    ['v1-history/get_actions', '/v1/history'], ['v2-history/get_actions', '/v2/history']];
for (const [path, prefix] of registrations) {const {default: register} = await import(`../../build/api/routes/${path}/index.js`); await app.register(register, {prefix});}
await app.ready();
const mock = new MockAgent(), previousDispatcher = getGlobalDispatcher(); mock.disableNetConnect();
mock.get('http://chain-fixture').intercept({path: '/v1/chain/get_accounts_by_authorizers', method: 'POST'})
    .reply(() => ({statusCode: nodeKeys ? 200 : 404, data: nodeKeys ? {accounts: nodeKeys === 'empty' ? [] : [{account_name: 'bob'}]} : {}})).persist(); setGlobalDispatcher(mock);
const publicKey = PrivateKey.generate('K1').toPublic().toString();
const proofRoutes = [
    {method: 'POST', url: '/v1/trace/get_block', payload: {block_num: 2}},
    {method: 'GET', url: '/v2/history/get_created_accounts?account=alice'}];
const unsupported = [
    {method: 'POST', url: '/v1/history/get_controlled_accounts', payload: {controlling_account: 'alice'}},
    {method: 'GET', url: '/v2/history/get_creator?account=bob'},
    {method: 'GET', url: '/v2/stats/get_resource_usage?code=alpha&action=transfer&%40transfer.to=bob'}];
const keyRequest = {method: 'GET', url: '/v2/state/get_key_accounts?public_key=' + encodeURIComponent(publicKey)};
const statistics = {method: 'GET', url: '/v2/stats/get_resource_usage?code=alpha&action=transfer'};
const decodedRequests = [
    ...['transfer.to', '@transfer.to', 'act.data.to', 'data.to', 'plugin.rank'].map(field =>
        ({method: 'GET', url: '/v2/history/get_actions?hydrate=false&' + encodeURIComponent(field) + '=bob'})),
    ...['@transfer.to', 'act.data.to', 'data.to', 'plugin.rank'].map(field =>
        ({method: 'GET', url: '/v2/history/get_actions?sortedBy=' + encodeURIComponent(field + ':desc')})),
    ...[{'transfer.to': 'bob'}, {'@transfer.to': 'bob'}, {'act.data.to': 'bob'}, {'data.to': 'bob'},
        {act: {data: {to: 'bob'}}}, {transfer: {to: 'bob'}}, {data: {to: 'bob'}}].map(filter =>
        ({method: 'POST', url: '/v1/history/get_actions', payload: {account_name: 'alice', ...filter}}))];
const packets = [], historical = {id: 'history-client', connected: true, emit() {}, timeout() {return {emitWithAck: async (_event, payload) => {packets.push(payload); return {status: true};}};}};
const livePackets = [], client = {emit(_event, packet) {livePackets.push(packet);}};
const manager = Object.assign(Object.create(SocketManager.prototype), {server: app, io: {sockets: {sockets: new Map([['client', client]])}},
    liveActionQueue: [], liveActionPendingBytes: 0, liveActionDraining: false, currentBlockNum: 2,
    clientActionRequestMap: new Map(), clientDeltaRequestMap: new Map(),
    actionContractMap: new Map([['alpha', new Map([['newaccount', new Map([['client', new Map([['request', {}]])]])]])]]),
    notifiedAccountClientMap: new Map(), deltaCodeMap: new Map([['alpha', new Map([['records', new Map([['client', new Map([['delta-request', {}]])]])]])]]), payerClientMap: new Map()});
const history = () => streamPastCommon(app, historical, 'history-request', {contract: 'alpha', action: 'newaccount', start_from: 2, read_until: 2}, 'action');
const live = (input = current) => manager.routeActionTraceToClients({account: input.act.account, name: input.act.name,
    notified: input.receipts.map(receipt => receipt.receiver).concat(input.act.authorization.map(auth => auth.actor)).join(','), message: JSON.stringify(input)});
const metadataRequest = {method: 'GET', url: '/v2/history/get_actions?hydrate=false&act.name=newaccount&sortedBy=global_sequence:desc'};
const requestData = {contract: 'alpha', action: 'newaccount', start_from: 2, read_until: 2, ignore_live: true};
const deferred = () => {let resolve; const promise = new Promise(complete => {resolve = complete;}); return {promise, resolve};};
async function within(promise) {
    let timer;
    try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Fixture event did not arrive')), 1000);})]);}
    finally {clearTimeout(timer);}
}
try {
    // Derived-field membership cannot be inferred from returned hits, including a false empty page/cache.
    emptySearch = true;
    for (const request of [...unsupported, ...decodedRequests]) {
        cache.clear(); cache.set('poisoned-empty', JSON.stringify({actions: [], total: {value: 0, relation: 'eq'}, cached: true}));
        const before = {searches, cacheReads}, response = await app.inject(request);
        assert.equal(response.statusCode, 503, response.body); assert.equal(response.headers['retry-after'], '1');
        assert.equal(searches, before.searches); assert.equal(cacheReads, before.cacheReads);
    }
    // Even a matching stale @projection, or an omitted true transfer member, cannot produce a successful result.
    current = action(1); current['@transfer'] = {to: 'alice'}; current['@updateauth'] = {auth: {accounts: [{permission: {actor: 'alice'}}]}};
    for (const request of unsupported) assert.equal((await app.inject(request)).statusCode, 503);
    cache.clear(); const fallbackSearches = searches;
    const keyFallback = await app.inject(keyRequest); assert.equal(keyFallback.statusCode, 503, keyFallback.body); assert.equal(searches, fallbackSearches);
    nodeKeys = true; cache.clear(); const node = await app.inject(keyRequest); assert.equal(node.statusCode, 200, node.body);
    nodeKeys = false; const nodeCached = await app.inject(keyRequest); assert.equal(nodeCached.statusCode, 200, nodeCached.body);
    assert.deepEqual(nodeCached.json().account_names, ['bob']);
    nodeKeys = 'empty'; cache.clear(); const emptyNode = await app.inject(keyRequest); assert.equal(emptyNode.statusCode, 200, emptyNode.body);
    assert.deepEqual(emptyNode.json().account_names, []); nodeKeys = false;
    const emptyNodeCached = await app.inject(keyRequest); assert.equal(emptyNodeCached.statusCode, 200, emptyNodeCached.body);
    assert.deepEqual(emptyNodeCached.json().account_names, []);
    // Old key-account caches, including a zero-hit fallback, are recomputed rather than blessed as node results.
    for (const [key, data] of cache) {const value = JSON.parse(data); delete value._hyperion_protocol_abi_v3; cache.set(key, JSON.stringify(value));}
    assert.equal((await app.inject(keyRequest)).statusCode, 503);
    emptySearch = false; cache.clear(); current = action();
    for (const request of [metadataRequest, statistics]) {
        const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body);
    }
    // These are ordinary ABI root fields, not a legacy action wrapper. Preserve the whole root.
    for (let index = 0; index < rootCases.length; index++) {
        const [, , data] = rootCases[index]; cache.clear(); current = action(66 + index); current.act.data = structuredClone(data);
        const request = {method: 'GET', url: '/v2/history/get_actions?hydrate=false'};
        const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().actions[0].act.data, data);
        cache.clear(); delete current.protocol;
        const unproven = await app.inject(request); assert.equal(unproven.statusCode, 503, unproven.body);
    }
    // ABI roots may also be false, a number, or an array; v1 serialization must retain their JSON type.
    for (let index = 0; index < primitiveCases.length; index++) {
        const [, , data] = primitiveCases[index]; cache.clear(); current = action(68 + index); current.act.data = structuredClone(data);
        const request = {method: 'POST', url: '/v1/history/get_actions', payload: {account_name: 'alpha', hex_data: true}};
        const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json().actions[0].action_trace.act.data, data);
        assert.equal(response.json().actions[0].action_trace.act.hex_data, current.protocol.input.rawHex);
        const cached = await app.inject(request); assert.equal(cached.statusCode, 200, cached.body);
        assert.deepEqual(cached.json().actions[0].action_trace.act.data, data);
        cache.clear(); delete current.protocol;
        const unproven = await app.inject({...request, payload: {account_name: 'alpha', hex_data: false}});
        assert.equal(unproven.statusCode, 503, unproven.body);
    }
    // @timestamp is a native envelope field, including when the contract action is named timestamp.
    manager.actionContractMap.get('alpha').set('timestamp', new Map([['client', new Map([['timestamp-request', {}]])]]));
    for (const mode of ['raw', 'certified', 'missing']) {
        current = action(timestampIndex, mode === 'raw');
        if (mode !== 'certified') delete current.protocol;
        if (mode === 'missing') delete current.act.data;
        const timestamp = current['@timestamp'];
        for (const request of [
            {method: 'POST', url: '/v1/history/get_actions', payload: {account_name: 'alice', hex_data: false}},
            {method: 'GET', url: '/v2/history/get_actions?hydrate=false'},
            {method: 'GET', url: '/v2/history/get_actions?hydrate=false&simple=true'}]) {
            cache.clear();
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body);
                const result = response.json();
                assert.equal(request.method === 'POST' ? result.actions[0].block_time
                    : request.url.includes('simple=true') ? result.simple_actions[0].timestamp : result.actions[0]['@timestamp'], timestamp);
            }
        }
        packets.length = 0; await streamPastCommon(app, historical, 'timestamp', {contract: 'alpha', action: 'timestamp', start_from: 2, read_until: 2}, 'action');
        assert.equal(packets[0].messages[0]['@timestamp'], timestamp); assert.equal(packets[0].messages[0].timestamp, timestamp);
        livePackets.length = 0; await live(); assert.equal(JSON.parse(livePackets[0].message)['@timestamp'], timestamp);
    }
    const reservedTimestamp = action(timestampIndex); reservedTimestamp['@timestamp'] = {nativeField: 'reserved'};
    await protectProtocolAction(app, {}, reservedTimestamp);
    assert.deepEqual(reservedTimestamp['@timestamp'], {nativeField: 'reserved'}); assert.equal(reservedTimestamp.act.data.nativeField, undefined);
    manager.actionContractMap.get('alpha').delete('timestamp');
    // Execute the real standard handlers, including lossy/deleted roots and nested empty-array compaction.
    app.manager.config.settings.eosio_alias = 'native';
    manager.actionContractMap.set('native', new Map(nativeCases.map(({name}) => [name, new Map([['client', new Map([['native-request', {}]])]])])));
    for (let index = 0; index < nativeCases.length; index++) {
        const testCase = nativeCases[index]; current = action(71 + index); current.act.data = structuredClone(testCase.data);
        handlers[testCase.handler](current);
        if (testCase.name === 'opttransfer') {current['@opttransfer'] = current['@transfer']; delete current['@transfer'];}
        if (testCase.name.includes('transfer')) {
            assert.equal(current.act.data.from, undefined); assert.equal(current.act.data.memo, undefined);
            current['@' + testCase.name].to = 'mallory'; // An annotation cannot override a certified contract member.
        }
        if (testCase.name === 'newaccount') assert.equal(current.act.data.name, undefined);
        if (testCase.name === 'buyram') {assert.equal(current.act.data, undefined); assert.equal(current['@buyram'].quant, 1.25);}
        if (testCase.name === 'updateauth') assert.equal(current.act.data.auth.keys, undefined);
        for (const request of [proofRoutes[0], {method: 'GET', url: '/v2/history/get_actions?hydrate=false'},
            {method: 'POST', url: '/v1/history/get_actions', payload: {account_name: 'alice', hex_data: true}}]) {
            cache.clear(); const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body);
            const rendered = request.url.includes('/trace/') ? response.json().transactions[0].actions[0].data
                : request.method === 'POST' ? response.json().actions[0].action_trace.act.data : response.json().actions[0].act.data;
            for (const [key, value] of Object.entries(testCase.data)) assert.deepEqual(rendered[key], value);
        }
        if (testCase.name === 'newaccount') {
            cache.clear(); const response = await app.inject(proofRoutes[1]); assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json().accounts[0].name, 'bob');
        }
        packets.length = 0; await streamPastCommon(app, historical, 'compacted', {contract: 'native', action: testCase.name, start_from: 2, read_until: 2}, 'action');
        for (const [key, value] of Object.entries(testCase.data)) assert.deepEqual(packets[0].messages[0].act.data[key], value);
        livePackets.length = 0; await live(); assert(livePackets[0].message);
        for (const [key, value] of Object.entries(testCase.data)) assert.deepEqual(JSON.parse(livePackets[0].message).act.data[key], value);
        if (testCase.name.includes('transfer')) {
            cache.clear(); current.act.data.quantity = '2.0000 SYS'; const tampered = await app.inject(proofRoutes[0]);
            assert.equal(tampered.statusCode, 503, tampered.body);
        }
    }
    app.manager.config.settings.eosio_alias = 'alpha'; manager.actionContractMap.delete('native');
    for (const request of proofRoutes) {
        cache.clear(); current = action(); current['@newaccount'] = {newact: 'mallory'};
        const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body);
        assert(!response.body.includes('inputActionOrdinal')); assert(!response.body.includes('_hyperion_protocol'));
        assert(!response.body.includes('mallory'));
        if (request.method === 'GET') assert.equal(response.json().accounts[0].name, 'bob');
        const cached = await app.inject(request); assert.equal(cached.statusCode, 200, cached.body);
    }
    // Rejected stream predicates never register a live subscription or start history storage work.
    for (const field of ['@newaccount.newact', 'act.data.newact', 'data.newact', 'newact']) {
        const data = {...requestData, ignore_live: false, filters: [{field, operator: 'eq', value: 'bob'}]};
        const before = searches; let reply;
        await manager.processStreamRequest('action', historical, data, response => {reply = response;});
        assert.equal(reply.statusCode, 503); assert.equal(searches, before); assert.equal(manager.clientActionRequestMap.size, 0);
        await assert.rejects(streamPastCommon(app, historical, 'rejected', data, 'action'), error => error.statusCode === 503);
    }
    // Registration does not validate retained actions against an unrelated current node ABI.
    assert.equal((await manager.validateRequest(requestData, 'action')).status, 'OK');
    cache.clear(); current = action(); packets.length = 0; await history();
    assert.equal(packets.length, 1); assert.equal(packets[0].messages[0].act.data.value, 7); assert.equal(packets[0].messages[0].protocol, undefined);
    await live(); assert.equal(JSON.parse(livePackets.at(-1).message).act.data.value, 7); assert.equal(JSON.parse(livePackets.at(-1).message).protocol, undefined);
    // Native Antelope relays share the exact public contract, including retained safe numbers.
    const extensionProtocol = app.manager.config.settings.protocol;
    try {
        delete app.manager.config.settings.protocol;
        for (const sequence of [9, '9007199254740993', '18446744073709551615']) {
            const native = action(); delete native.protocol;
            native.global_sequence = sequence;
            native.receipts[0].global_sequence = sequence;
            native.receipts[0].recv_sequence = 0;
            native.code_sequence = 4294967295;
            native.act.data = {global_sequence: '0009', count: 7};
            livePackets.length = 0; await live(native);
            const emitted = JSON.parse(livePackets[0].message);
            assert.equal(emitted.global_sequence, String(sequence));
            assert.equal(emitted.receipts[0].recv_sequence, '0');
            assert.equal(emitted.code_sequence, 4294967295);
            assert.deepEqual(emitted.act.data, {global_sequence: '0009', count: 7});
        }
        const unsafe = action(); delete unsafe.protocol; unsafe.global_sequence = 9007199254740992;
        livePackets.length = 0; await live(unsafe);
        assert.equal(livePackets[0].message, undefined); assert.equal(livePackets[0].error.statusCode, 503);
    } finally {app.manager.config.settings.protocol = extensionProtocol; livePackets.length = 0;}
    // With no matching subscribers, the relay must not start any proof/storage operation.
    const subscriptions = manager.actionContractMap; manager.actionContractMap = new Map();
    const noTargetsReads = memory.calls.length; await live(); assert.equal(memory.calls.length, noTargetsReads); manager.actionContractMap = subscriptions;
    // Hold proof I/O, exceed the task budget, then prove accepted events retain arrival order.
    livePackets.length = 0; const entered = deferred(), release = deferred(); let held = false;
    memory.faults.beforeRead = async query => {if (!held && query.index === store.controlIndex) {held = true; entered.resolve(); await release.promise;}};
    const accepted = [live(action())]; await within(entered.promise);
    for (let index = 1; index < maximumPendingLiveActions; index++) accepted.push(live(action(index + 1)));
    await live(action(65)); assert.equal(manager.liveActionQueue.length, maximumPendingLiveActions);
    assert(manager.liveActionPendingBytes <= maximumPendingLiveActionBytes);
    assert.equal(livePackets.length, 1); assert.equal(livePackets[0].error.code, 'protocol_live_backlog'); assert.equal(livePackets[0].message, undefined);
    release.resolve(); await Promise.all(accepted); delete memory.faults.beforeRead;
    const delivered = livePackets.filter(packet => packet.message).map(packet => JSON.parse(packet.message).global_sequence);
    assert.deepEqual(delivered, ['101', ...Array.from({length: maximumPendingLiveActions - 1}, (_, index) => String(103 + index))]);
    assert.equal(manager.liveActionQueue.length, 0); assert.equal(manager.liveActionPendingBytes, 0);
    livePackets.length = 0; const byteReads = memory.calls.length;
    await live({...action(), padding: 'x'.repeat(maximumPendingLiveActionBytes)});
    assert.equal(livePackets[0].error.code, 'protocol_live_backlog'); assert.equal(memory.calls.length, byteReads);
    // Disconnect a real HTTP request while its proof storage read is held. No continuation may cache or read on release.
    cache.clear(); current = action(); cancelledHttp = deferred(); const proofEntered = deferred(), proofRelease = deferred(); let proofHeld = false;
    memory.faults.beforeRead = async query => {if (!proofHeld && query.index === store.controlIndex) {
        proofHeld = true; proofEntered.resolve(); await proofRelease.promise;
    }};
    const address = await app.listen({host: '127.0.0.1', port: 0}), body = JSON.stringify({account_name: 'alice', hex_data: true});
    const request = httpRequest(address + '/v1/history/get_actions', {method: 'POST',
        headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}});
    request.on('error', () => {}); request.end(body); await within(proofEntered.promise); request.destroy(); await within(cancelledHttp.promise);
    const readsAtCancellation = memory.calls.filter(call => call.method === 'get').length;
    proofRelease.resolve(); await new Promise(resolve => setTimeout(resolve, 20)); delete memory.faults.beforeRead;
    assert.equal(memory.calls.filter(call => call.method === 'get').length, readsAtCancellation); assert.equal(cache.size, 0);
    // Failed, timed-out and malformed initial/continuation pages always release their scroll context.
    for (const fault of [result => {result.timed_out = true;}, result => {result._shards.failed = 1; result._shards.successful = 0;},
        result => {delete result._shards;}, result => {result._shards = {failed: 0};},
        result => {result._shards.successful = 0;}]) {
        initialFault = fault; packets.length = 0; const before = clearCalls.length;
        await assert.rejects(history(), error => error.statusCode === 503); assert.equal(packets.length, 0); assert.equal(clearCalls.length, before + 1);
        initialFault = undefined; nextFault = fault; streamTotal = 2; packets.length = 0;
        await assert.rejects(history(), error => error.statusCode === 503); assert.equal(packets.length, 1); assert.equal(clearCalls.at(-1), 'next-entrypoint-scroll');
        nextFault = undefined; streamTotal = undefined;
    }
    app.manager.config.api.stream_scroll_limit = 1; streamTotal = 2; const limitClears = clearCalls.length;
    assert.equal((await history()).status, false); assert.equal(clearCalls.length, limitClears + 1);
    delete app.manager.config.api.stream_scroll_limit; streamTotal = undefined;
    // A generation change while an awaited per-action lookup is pending cannot publish a historical batch.
    let reconfigured = false;
    memory.faults.beforeRead = async query => {if (!reconfigured && query.id.startsWith('h45abist1:')) {
        reconfigured = true; await coordinator.revokeSource(session); generation = (await coordinator.openSource(contextId, session)).generation; await append(3, empty());
    }};
    packets.length = 0; const clearsBefore = clearCalls.length;
    await assert.rejects(history(), error => error.statusCode === 503); delete memory.faults.beforeRead;
    assert.equal(packets.length, 0); assert.equal(clearCalls.length, clearsBefore + 1);
    // Prime all final response caches, then replace their original source block.
    const primed = [];
    for (const request of proofRoutes) {
        cache.clear(); current = action();
        const response = await app.inject(request); assert.equal(response.statusCode, 200, response.body); primed.push(new Map(cache));
    }
    await append(2, facts, 20, 1);
    for (let index = 0; index < proofRoutes.length; index++) {
        cache.clear(); for (const [key, data] of primed[index]) cache.set(key, data); current = action();
        const stale = await app.inject(proofRoutes[index]); assert.equal(stale.statusCode, 503, stale.body);
        cache.clear(); const cold = await app.inject(proofRoutes[index]); assert.equal(cold.statusCode, 503, cold.body);
    }
    current = action(); packets.length = 0; await assert.rejects(history(), error => error.statusCode === 503); assert.equal(packets.length, 0);
    livePackets.length = 0; await live(); assert.equal(livePackets[0].error.statusCode, 503); assert.equal(livePackets[0].message, undefined);
    // Retained raw messages remain readable and never expose the internal proof capsule.
    current = action(0, true); current['@newaccount'] = {newact: 'unproven'}; packets.length = 0; await history();
    assert.equal(packets[0].messages[0].act.data, rawHex); assert.equal(packets[0].messages[0].protocol, undefined);
    livePackets.length = 0; await live(); assert.equal(JSON.parse(livePackets[0].message).act.data, rawHex); assert.equal(JSON.parse(livePackets[0].message).protocol, undefined);
    await assert.rejects(streamPastCommon(app, historical, 'delta', {code: 'alpha', table: 'records'}, 'delta'), error => error.statusCode === 503);
    livePackets.length = 0; await manager.routeDeltaToClients({code: 'alpha', table: 'records', payer: '', scope: '', message: '{}'});
    assert.equal(livePackets[0].error.statusCode, 503); assert.equal(livePackets[0].message, undefined);
    cache.clear(); assert.equal((await app.inject(metadataRequest)).statusCode, 200); assert.equal((await app.inject(statistics)).statusCode, 200);
    // The shared classifiers are an Antelope no-op; they do not remove legacy decoded-field queries.
    app.manager.config.settings.protocol = {provider: 'antelope'}; cache.clear(); emptySearch = true;
    assert.equal((await app.inject(decodedRequests[0])).statusCode, 200);
    assert.equal((await app.inject(decodedRequests.at(-1))).statusCode, 200);
    console.log(JSON.stringify({passed: true, profileId, proofRoutes: 2, gatedRoutes: 4, decodedRequests: decodedRequests.length,
        liveActionProof: true, historicalActionProof: true, boundedOrderedLive: true, shardCleanup: true, decodedMembershipUnavailable: true,
        nodeKeyCache: true, rootStruct: true, primitiveRoots: true, timestampAction: true, standardCompaction: true, httpCancellation: true,
        awaitFence: true, cacheFence: true, rawStreams: true, metadataHidden: true, unqualifiedRowsUnavailable: true, transportQualification: false}));
} finally {setGlobalDispatcher(previousDispatcher); await mock.close(); await app.close();}
