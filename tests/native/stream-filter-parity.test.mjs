import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {SocketManager} from '../../build/api/socketManager.js';
import {streamPastCommon} from '../../build/api/helpers/functions.js';
import {checkMetaFilter} from '../../build/indexer/helpers/common_functions.js';

process.env.CONFIG_JSON = fileURLToPath(new URL('./fixtures/stream-config.json', import.meta.url));

const sources = [
    {doc_id: 'a', block_num: 1, code: 'eosio.token', table: 'accounts', scope: 'alice',
        payer: 'owner', '@timestamp': '2026-10-23T00:00:00Z', data: {flag: true, count: 1, label: ''}},
    {doc_id: 'b', block_num: 2, code: 'eosio.token', table: 'accounts', scope: 'bob',
        payer: 'owner', '@timestamp': '2026-10-23T00:00:01Z', data: {flag: false, count: 0, label: ''}},
    {doc_id: 'c', block_num: 3, code: 'eosio.token', table: 'accounts', scope: 'bob',
        payer: 'owner', '@timestamp': '2026-10-23T00:00:02Z', data: {flag: true, count: 0, label: 'x'}}
];

function fieldValue(source, field) {
    const read = (value, path) => {
        if (Array.isArray(value)) return value.flatMap(item => read(item, path));
        if (!path.length) return value;
        return read(value?.[path[0]], path.slice(1));
    };
    return read(source, field.split('.'));
}

function matches(source, query) {
    if (query.term) return Object.entries(query.term).every(([field, value]) => {
        const actual = fieldValue(source, field);
        return Array.isArray(actual) ? actual.includes(value) : actual === value;
    });
    if (query.range) return Object.entries(query.range).every(([field, bounds]) => {
        const actual = fieldValue(source, field);
        return (bounds.gte === undefined || actual >= bounds.gte)
            && (bounds.lte === undefined || actual <= bounds.lte);
    });
    if (query.bool) {
        const must = query.bool.must ?? [], should = query.bool.should ?? [];
        return must.every(item => matches(source, item))
            && (query.bool.minimum_should_match ? should.filter(item => matches(source, item)).length
                >= query.bool.minimum_should_match : true);
    }
    throw new Error(`Unsupported fixture query: ${JSON.stringify(query)}`);
}

function makeSocket() {
    const packets = [];
    return {id: 'client-a', connected: true, packets,
        emit(event, packet) {packets.push({event, packet}); return true;},
        timeout() {return {emitWithAck: async (event, packet) => {
            packets.push({event, packet});
            return {status: true};
        }}}};
}

function makeServer() {
    const searches = [], cleared = [];
    const fastify = {manager: {chain: 'fixture', config: {api: {stream_scroll_batch: 100,
        stream_scroll_limit: -1}, settings: {protocol: {provider: 'legacy'}}}},
    elastic: {search: async query => {
        searches.push(query);
        const hits = sources.filter(source => matches(source, query.query))
            .map(source => ({_source: structuredClone(source)}));
        return {_scroll_id: 'scroll-a', hits: {total: {value: hits.length, relation: 'eq'}, hits}};
    }, scroll: async () => {throw new Error('Unexpected second page');},
    clearScroll: async value => {cleared.push(value.scroll_id);}}};
    return {fastify, searches, cleared};
}

function makeManager(fastify, socket) {
    const manager = Object.create(SocketManager.prototype);
    Object.assign(manager, {server: fastify, io: {sockets: {sockets: new Map([[socket.id, socket]])}},
        clientDeltaRequestMap: new Map(), clientActionRequestMap: new Map(),
        deltaCodeMap: new Map(), actionContractMap: new Map(), payerClientMap: new Map(),
        notifiedAccountClientMap: new Map()});
    return manager;
}

async function compareDelta(filter_op, filters) {
    const {fastify, searches, cleared} = makeServer();
    const socket = makeSocket(), manager = makeManager(fastify, socket);
    const request = {code: 'eosio.token', table: 'accounts', scope: '', payer: '',
        start_from: 1, read_until: 10, filter_op, filters};
    const result = await streamPastCommon(fastify, socket, 'request-a', request, 'delta');
    assert.equal(result.status, true);
    const history = socket.packets.filter(item => item.packet?.mode === 'history')
        .flatMap(item => item.packet.messages ?? []).map(item => item.doc_id);
    manager.attachDeltaRequests(request, socket.id, 'request-a');
    for (const source of sources) await manager.routeDeltaToClients({code: source.code,
        table: source.table, scope: source.scope, payer: source.payer,
        message: JSON.stringify(source)});
    const live = socket.packets.filter(item => item.packet?.mode === 'live'
        && item.packet.targets?.includes('request-a'))
        .map(item => JSON.parse(item.packet.message).doc_id);
    assert.deepEqual(cleared, ['scroll-a']);
    return {history, live, query: searches[0]};
}

test('false, zero, and empty strings are exact filter values', () => {
    const source = {data: {flag: false, count: 0, label: ''}};
    for (const [field, value] of [['flag', false], ['count', 0], ['label', '']])
        assert.equal(checkMetaFilter({field, value}, source, 'delta'), true);
    assert.equal(checkMetaFilter({field: 'missing', value: false}, source, 'delta'), false);
});

test('mixed indexed/postfilter OR returns the same records from history and live', async () => {
    const result = await compareDelta('or', [
        {field: 'scope', value: 'alice'}, {field: 'flag', value: false}
    ]);
    assert.deepEqual(result.history, ['a', 'b']);
    assert.deepEqual(result.live, ['a', 'b']);
});

test('all-postfilter OR does not create an empty Elasticsearch should group', async () => {
    const result = await compareDelta('or', [
        {field: 'flag', value: false}, {field: 'count', value: 0}
    ]);
    assert.deepEqual(result.history, ['b', 'c']);
    assert.deepEqual(result.live, ['b', 'c']);
});

test('mixed AND retains an indexed scope restriction and checks every filter', async () => {
    const result = await compareDelta('and', [
        {field: 'scope', value: 'alice'}, {field: 'count', value: 1}
    ]);
    assert.deepEqual(result.history, ['a']);
    assert.deepEqual(result.live, ['a']);
    assert.ok(result.query.query.bool.must.some(item => item.term?.scope === 'alice'));
});

test('timestamp alias still matches history after delta response shaping', async () => {
    const result = await compareDelta('and', [
        {field: '@timestamp', value: '2026-10-23T00:00:01Z'}
    ]);
    assert.deepEqual(result.history, ['b']);
    assert.deepEqual(result.live, ['b']);
});

test('action ABI field aliases resolve from decoded data when the alias is absent', () => {
    assert.equal(checkMetaFilter({field: '@transfer.from', value: 'alice'},
        {act: {name: 'transfer', data: {from: 'alice'}}}, 'action'), true);
});

test('selector validation accepts routed wildcards and optional or numeric scopes', async () => {
    const {fastify} = makeServer(), socket = makeSocket();
    const manager = makeManager(fastify, socket);
    fastify.manager.config.settings.protocol.provider = 'extension';
    const action = {contract: 'eosio.token', action: '*', account: 'alice',
        start_from: 0, read_until: 0};
    const delta = {code: 'eosio.token', table: '*', scope: '', payer: '',
        start_from: 0, read_until: 0};
    for (const request of [action, {...action, account: ''}])
        assert.equal((await manager.validateRequest(request, 'action')).status, 'OK');
    for (const request of [delta, {...delta, scope: '18446744073709551615'},
        {...delta, scope: undefined}])
        assert.equal((await manager.validateRequest(request, 'delta')).status, 'OK');
    for (const request of [{...action, contract: '*'}, {...action, action: ''},
        {...action, account: '*'}, {...action, contract: 'UPPERCASE'}])
        assert.equal((await manager.validateRequest(request, 'action')).status, 'ERROR');
    for (const request of [{...delta, code: '*'}, {...delta, scope: '*'},
        {...delta, table: 'UPPERCASE'}])
        assert.equal((await manager.validateRequest(request, 'delta')).status, 'ERROR');
});

test('legacy ABI lookup accepts wildcard action and table but checks exact names', async () => {
    const {fastify} = makeServer(), socket = makeSocket();
    const manager = makeManager(fastify, socket);
    fastify.antelope = {getAbi: async () => ({abi: {version: 'eosio::abi/1.2',
        types: [], structs: [], actions: [{name: 'transfer', type: 'transfer', ricardian_contract: ''}],
        tables: [{name: 'accounts', index_type: 'i64', key_names: [], key_types: [], type: 'account'}],
        ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: []}})};
    const action = {contract: 'eosio.token', action: '*', account: '', start_from: 0, read_until: 0};
    const delta = {code: 'eosio.token', table: '*', scope: '', payer: '', start_from: 0, read_until: 0};
    assert.equal((await manager.validateRequest(action, 'action')).status, 'OK');
    assert.equal((await manager.validateRequest(delta, 'delta')).status, 'OK');
    assert.equal((await manager.validateRequest({...action, action: 'issue'}, 'action')).status, 'ERROR');
    assert.equal((await manager.validateRequest({...delta, table: 'stat'}, 'delta')).status, 'ERROR');
});

test('scope mismatch does not route a delta even when the event scope is empty', async () => {
    const {fastify} = makeServer(), socket = makeSocket(), manager = makeManager(fastify, socket);
    manager.attachDeltaRequests({code: 'eosio.token', table: '*', scope: 'alice', payer: '',
        start_from: 0, read_until: 0}, socket.id, 'scoped');
    await manager.routeDeltaToClients({code: 'eosio.token', table: 'accounts', scope: '',
        payer: 'owner', message: JSON.stringify(sources[0])});
    assert.equal(socket.packets.filter(item => item.packet?.mode === 'live').length, 0);
    await manager.routeDeltaToClients({code: 'eosio.token', table: 'stat', scope: 'alice',
        payer: 'owner', message: JSON.stringify({...sources[0], table: 'stat'})});
    assert.deepEqual(socket.packets.filter(item => item.packet?.mode === 'live')
        .flatMap(item => item.packet.targets), ['scoped']);
});

test('combined contract/action/account history query includes authorization actors', async () => {
    const {fastify, searches} = makeServer(), socket = makeSocket();
    fastify.elastic.search = async query => {searches.push(query); return {_scroll_id: 'empty',
        timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
        hits: {total: {value: 0, relation: 'eq'}, hits: []}};};
    const result = await streamPastCommon(fastify, socket, 'action', {
        contract: 'eosio.token', action: 'transfer', account: 'bob', start_from: 1,
        read_until: 10}, 'action');
    assert.equal(result.status, true);
    const must = searches[0].query.bool.must;
    assert.ok(must.some(item => item.term?.['act.account'] === 'eosio.token'));
    assert.ok(must.some(item => item.term?.['act.name'] === 'transfer'));
    const account = must.find(item => item.bool?.should?.some(part => part.term?.notified === 'bob'));
    assert.ok(account);
    assert.ok(account.bool.should.some(part => part.term?.['act.authorization.actor'] === 'bob'));
    assert.equal(account.bool.minimum_should_match, 1);
});

test('combined account and decoded action filters select the same history and live records', async () => {
    const actions = [
        {doc_id: 'actor', block_num: 1, notified: 'alice',
            act: {account: 'eosio.token', name: 'transfer', authorization: [{actor: 'bob'}], data: {}},
            receipts: [{receiver: 'alice'}], '@transfer': {amount: 0}},
        {doc_id: 'receiver', block_num: 2, notified: 'bob',
            act: {account: 'eosio.token', name: 'transfer', authorization: [{actor: 'carol'}],
                data: {amount: 1}}, receipts: [{receiver: 'bob'}]}
    ];
    const {fastify, cleared} = makeServer(), socket = makeSocket(), manager = makeManager(fastify, socket);
    fastify.elastic.search = async query => {
        const hits = actions.filter(source => matches(source, query.query))
            .map(source => ({_source: structuredClone(source)}));
        return {_scroll_id: 'actions', timed_out: false,
            _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
            hits: {total: {value: hits.length, relation: 'eq'}, hits}};
    };
    const request = {contract: 'eosio.token', action: '*', account: 'bob',
        start_from: 1, read_until: 10, filter_op: 'or', filters: [
            {field: '@transfer.amount', value: 0},
            {field: 'act.authorization.actor', value: 'carol'}]};
    const result = await streamPastCommon(fastify, socket, 'actions', request, 'action');
    assert.equal(result.status, true);
    const history = socket.packets.filter(item => item.packet?.mode === 'history')
        .flatMap(item => item.packet.messages ?? []).map(item => item.doc_id);
    manager.attachActionRequests(request, socket.id, 'actions');
    for (const source of actions) await manager.routeActionTraceToClients({
        account: source.act.account, name: source.act.name,
        notified: [source.act.authorization[0].actor, source.receipts[0].receiver].join(','),
        message: JSON.stringify(source)});
    const live = socket.packets.filter(item => item.packet?.mode === 'live'
        && item.packet.targets?.includes('actions'))
        .map(item => JSON.parse(item.packet.message).doc_id);
    assert.deepEqual(history, ['actor', 'receiver']);
    assert.deepEqual(live, history);
    assert.deepEqual(cleared, ['actions']);
});
