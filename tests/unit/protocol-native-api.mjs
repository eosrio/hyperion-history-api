import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {get as httpGet} from 'node:http';
import Fastify from 'fastify';
import {nativeApiWireSource} from './protocol-native-api-source.mjs';

registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) throw new Error('Native API imported the legacy addon');
    if (specifier === 'uWebSockets.js') return {url: 'data:text/javascript,export const App=()=>{};', shortCircuit: true};
    return next(specifier, context);
}});
const {ProtocolActionConsumer, protectProtocolAction, protocolResponseForCache,
    validateProtocolCachedResponse} = await import('../../build/api/helpers/protocol-abi.js');
const {streamPastCommon} = await import('../../build/api/helpers/functions.js');
const {SocketManager} = await import('../../build/api/socketManager.js');
const {regroupActions} = await import('../../build/api/helpers/regroup-actions.js');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
async function within(promise) {
    let timer; try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Native API control timed out')), 5000);})]);}
    finally {clearTimeout(timer);}
}
const complete = rows => ({took: 1, timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
    hits: {total: {value: rows.length, relation: 'eq'}, hits: rows.map(_source => ({_source: structuredClone(_source)}))}});
async function api(source, selected = source.selected) {
    const app = Fastify({logger: false}), cache = new Map();
    let rows = [], searchedRows = [], interceptor, searches = 0; const clearCalls = [], signals = [], errors = [];
    app.addHook('onError', async (_request, _reply, error) => {errors.push(error);});
    const proxy = {...source.client, async get(query, options) {
        if (query.index === source.nativeStore.index) signals.push(options?.signal);
        return interceptor ? interceptor(query, options, () => source.client.get(query, options)) : source.client.get(query, options);
    }, async search(query) {
        searches++;
        if (query.index === source.chain + '-block-*') {
            const row = rows[0], block = source.retained.get(row.block_num);
            return complete([{block_num: row.block_num, block_id: row.block_id, prev_id: block.source.previousBlockId,
                '@timestamp': row['@timestamp'], producer: row.producer}]);
        }
        assert.equal(query.index, source.chain + '-action-*');
        const result = complete(rows); searchedRows = result.hits.hits.map(hit => hit._source);
        if (query.scroll) result._scroll_id = 'native-api-owned-scroll'; return result;
    }, async clearScroll(query) {clearCalls.push(query.scroll_id); return {succeeded: true};}};
    app.decorate('manager', {chain: source.chain, conn: {chains: {[source.chain]: {chain_id: source.chainId}}},
        readIndexset: () => source.chain + '-action-*', config: {settings: {protocol: {provider: 'extension',
            package: '@eosrio/hyperion-wire-plugin', profileId: source.provider.profileId}, es_replicas: 0,
            index_partition_size: 10000, index_version: 'v1'}, api: {enable_caching: true, cache_life: 60,
                query_timeout: '10s', limits: {get_actions: 100, get_trx_actions: 100}, stream_scroll_batch: 100}}});
    app.decorate('elastic', proxy);
    app.decorate('redis', {get: async key => cache.get(key) ?? null, set: async (key, value) => {cache.set(key, value); return 'OK';},
        hgetall: async () => Object.fromEntries(rows.map(row => [row.global_sequence, JSON.stringify(row)])), ttl: async () => 60});
    app.decorate('antelope', {chain: {get_info: async () => ({last_irreversible_block_num: {valueOf: () => 999, toNumber: () => 999}})},
        getAbi: async () => {throw new Error('Native API attempted a head ABI lookup');}});
    app.decorate('allowedActionQueryParamSet', new Set());
    // Internal already-selected service orchestration, not installed native profile activation.
    app.decorate('protocolActionConsumer', new ProtocolActionConsumer(app, selected));
    for (const [path, prefix] of [['v1-history/get_actions', '/v1/history'], ['v2-history/get_actions', '/v2/history'],
        ['v1-history/get_transaction', '/v1/history'], ['v2-history/get_transaction', '/v2/history'], ['v1-trace/get_block', '/v1/trace']]) {
        const {default: register} = await import('../../build/api/routes/' + path + '/index.js'); await app.register(register, {prefix});
    }
    await app.ready();
    return {app, cache, clearCalls, signals, errors, setRows(value) {rows = structuredClone(value); cache.clear();},
        setInterceptor(value) {interceptor = value;}, get searches() {return searches;},
        get searchedRows() {return searchedRows;},
        async request(kind = 'v2') {
            const row = rows[0];
            const request = kind === 'v1' ? {method: 'POST', url: '/v1/history/get_actions', payload: {account_name: row.act.account, hex_data: true}}
                : kind === 'trx1' ? {method: 'POST', url: '/v1/history/get_transaction', payload: {id: row.trx_id}}
                    : kind === 'trx2' ? {method: 'GET', url: '/v2/history/get_transaction?id=' + row.trx_id + '&hydrate=false'}
                        : kind === 'trace' ? {method: 'POST', url: '/v1/trace/get_block', payload: {block_num: row.block_num}}
                            : {method: 'GET', url: '/v2/history/get_actions?hydrate=false'
                                + (kind === 'simple' ? '&simple=true' : kind === 'noBinary' ? '&noBinary=true' : '')};
            return app.inject(request);
        }};
}
class StreamSocket extends EventEmitter {
    connected = true; packets = [];
    constructor(id) {super(); this.id = id;}
    emit(event, ...args) {
        if (event === 'message') {if (this.connected) this.packets.push(args[0]); return true;}
        return super.emit(event, ...args);
    }
    timeout() {return {emitWithAck: async (_event, packet) => {this.packets.push(packet); return {status: true};}};}
    disconnect() {this.connected = false; this.emit('disconnect');}
}
function liveManager(app, row, sockets) {
    return Object.assign(Object.create(SocketManager.prototype), {server: app,
        io: {sockets: {sockets: new Map(sockets.map(socket => [socket.id, socket]))}},
        liveActionQueue: [], liveActionPendingBytes: 0, liveActionDraining: false, currentBlockNum: row.block_num,
        clientActionRequestMap: new Map(), clientDeltaRequestMap: new Map(), notifiedAccountClientMap: new Map(),
        actionContractMap: new Map([[row.act.account, new Map([[row.act.name,
            new Map(sockets.map(socket => [socket.id, new Map([['request-' + socket.id, {}]])]))]])]])});
}
const relay = (manager, row) => manager.routeActionTraceToClients({account: row.act.account, name: row.act.name,
    notified: [...new Set([...row.receipts.map(receipt => receipt.receiver), ...row.act.authorization.map(auth => auth.actor)])].join(','),
    message: JSON.stringify(row)});
const history = (app, socket, row, readUntil = row.block_num) => streamPastCommon(app, socket, 'native-history-request', {
    contract: row.act.account, action: row.act.name, start_from: row.block_num, read_until: readUntil}, 'action');
const source = await nativeApiWireSource(); let consumer;
const result = {passed: true, originalNative: [], schema1Compatibility: 'separate existing API runners', nativeActivation: false,
    fullWorkerQualification: false, transportQualification: false};
try {
    consumer = await api(source);
    for (const number of [33, 122, 397]) {
        await source.appendUntil(number); const row = await source.action(number); consumer.setRows([row]);
        const expected = source.expected.get(number).expectedValue;
        const writes = source.memory.calls.filter(call => ['create', 'createIndex', 'index'].includes(call.method)).length;
        for (const kind of ['v1', 'v2', 'trx1', 'trx2', 'trace', 'simple', 'noBinary']) {
            const response = await consumer.request(kind); assert.equal(response.statusCode, 200, kind + ': ' + response.body);
            const body = response.json();
            const data = kind === 'v1' ? body.actions[0].action_trace.act.data : kind === 'trx1' ? body.traces[0].act.data
                : kind === 'trace' ? body.transactions[0].actions[0].data : kind === 'simple' ? body.simple_actions[0].data : body.actions[0].act.data;
            assert.deepEqual(data, expected);
            if (kind === 'v1') {assert.equal(body.actions[0].action_trace.act.hex_data, row.protocol.input.rawHex); assert.equal(body.actions[0].action_trace.act.hex_encoder, source.selected.id);}
            assert(!response.body.includes('inputActionOrdinal')); assert(!response.body.includes('_hyperion_protocol_abi'));
            const cached = await consumer.request(kind); assert.equal(cached.statusCode, 200, cached.body);
        }
        assert.equal(source.memory.calls.filter(call => ['create', 'createIndex', 'index'].includes(call.method)).length, writes);
        result.originalNative.push(number);
    }
    const row = await source.action(397); consumer.setRows([row]);
    // Original Wire controls: a later awaited native encoder mutates an earlier PUBLIC ES action.
    // The real route/history controller must reject before cache/send; no Redis/checksum edits occur.
    const first = await source.action(396), second = row, targetValue = JSON.stringify(second.act.data);
    let poisoning = false, mutations = 0, mutating;
    const originalNative = source.provider.nativeActions;
    const mutatingSelection = {...source.selected, provider: {...source.provider, nativeActions: {...originalNative,
        encodeValue(kind, value) {
            if (poisoning && JSON.stringify(value) === targetValue && mutating?.searchedRows.length > 1) {
                mutating.searchedRows[0].act.data = {changedByAwaitedSibling: true}; mutations++;
            }
            return originalNative.encodeValue(kind, value);
        }}}};
    mutating = await api(source, mutatingSelection);
    try {
        mutating.setRows([first, second]); poisoning = true;
        const refused = await mutating.request(); assert.equal(refused.statusCode, 503, refused.body);
        assert.equal(mutating.cache.size, 0); assert(mutations > 0);
        poisoning = false; mutating.setRows([first, second]);
        assert.equal((await mutating.request()).statusCode, 200);
        const socket = new StreamSocket('awaited-sibling-history'); mutating.setRows([first, second]); poisoning = true;
        await assert.rejects(history(mutating.app, socket, first, second.block_num), {statusCode: 503, code: 'native_output_mismatch'});
        assert.equal(socket.packets.some(packet => packet.messages?.length), false);
        assert(mutating.clearCalls.includes('native-api-owned-scroll')); assert.equal(socket.listenerCount('disconnect'), 0);
        poisoning = false; mutating.setRows([second]); const siblingSocket = new StreamSocket('unaffected-history');
        await history(mutating.app, siblingSocket, second);
        assert.deepEqual(siblingSocket.packets.find(packet => packet.messages?.length).messages[0].act.data, second.act.data);
        result.responseFences = true; result.streamResponseFences = true;
    } finally {poisoning = false; await mutating.app.close();}
    consumer.setInterceptor((query, _options, next) => {if (query.id.startsWith('h45abist1:')) throw new Error('Deployed ABI storage is unavailable'); return next();});
    assert.equal((await consumer.request()).statusCode, 200, 'Native serving consulted deployed ABI state');
    consumer.setInterceptor(undefined);
    for (const mutate of [value => {value.act.data = {};}, value => {value.protocol.native.nativeKind = 'caller-selected';},
        value => {value.protocol.native.observationDigest = 'f'.repeat(64);}, value => {value.protocol.input.rawHex += '00';},
        value => {value.protocol.schemaVersion = 1;}, value => {value.protocol.kind = 'contract';},
        value => {value.protocol.schemaVersion = 99;}, value => {value.global_sequence = '1';},
        value => {value.receipts[0].recv_sequence = '18446744073709551615';}, value => {value.receipts.push(structuredClone(value.receipts[0]));},
        value => {value.act.authorization = [{actor: 'mallory', permission: 'active'}];}, value => {value.creator_action_ordinal = 99;},
        value => {value.act.hex_data = '00';}, value => {delete value.protocol;}]) {
        const changed = structuredClone(row); mutate(changed); consumer.setRows([changed]);
        const refused = await consumer.request(); assert.equal(refused.statusCode, 503, refused.body);
    }
    consumer.setRows([row]);
    consumer.setInterceptor((query, _options, next) => {if (query.index === source.nativeStore.index) throw Object.assign(new Error('Missing journal'), {meta: {statusCode: 404}}); return next();});
    assert.equal((await consumer.request()).statusCode, 503); consumer.setInterceptor(undefined);
    // Full metadata stripping cannot downgrade a marked origin, even if a synthetic contract codec accepts the same bytes.
    let abiCalls = 0;
    const ambiguous = {...source.selected, provider: {...source.provider, contractCodec: {
        decodeAbi() {abiCalls++; return {actions: [{name: row.act.name, type: 'ambiguous'}]};},
        decodeValue() {abiCalls++; return structuredClone(row.act.data);},
        encodeValue() {abiCalls++; return Buffer.from(row.protocol.input.rawHex, 'hex');}, encodeAbi() {throw new Error('Not used');}}}};
    const other = await api(source, ambiguous);
    try {
        const downgrade = structuredClone(row); downgrade.protocol = {schemaVersion: 1, source: downgrade.protocol.source,
            selectionId: downgrade.protocol.selectionId, input: downgrade.protocol.input}; other.setRows([downgrade]);
        const refused = await other.request(); assert.equal(refused.statusCode, 503, refused.body); assert.equal(abiCalls, 0);
    } finally {await other.app.close();}
    // Checked values and original envelopes are retained in the Redis capsule after public metadata is shaped away.
    consumer.setRows([row]); assert.equal((await consumer.request()).statusCode, 200);
    const cacheEntry = [...consumer.cache.entries()].find(([, raw]) => JSON.parse(raw)._hyperion_protocol_abi_v3);
    assert(cacheEntry); const cacheValue = JSON.parse(cacheEntry[1]); assert.equal(cacheValue._hyperion_protocol_abi_v3.schemaVersion, 2);
    cacheValue._hyperion_protocol_abi_v3.actions[0].value = {};
    consumer.cache.set(cacheEntry[0], JSON.stringify(cacheValue));
    const badCache = await consumer.request(); assert.equal(badCache.statusCode, 503, badCache.body);
    const refreshCapsuleHash = capsule => {capsule.proofSha256 = createHash('sha256').update(JSON.stringify([
        capsule.schemaVersion, capsule.bodySha256, capsule.actions, capsule.nodeResponse === true])).digest('hex');};
    // The ordinary integrity digest catches edits to entries, version, and node-response authority.
    // Recomputed digests below exercise semantic coverage; they are not claims of authenticated Redis storage.
    for (const mutate of [capsule => {capsule.actions = [];}, capsule => {capsule.nodeResponse = true;},
        capsule => {capsule.actions = []; refreshCapsuleHash(capsule);}, capsule => {
            const native = capsule.actions[0].metadata;
            capsule.actions = [{metadata: {schemaVersion: 1, source: native.source, selectionId: native.selectionId, input: native.input}}];
            refreshCapsuleHash(capsule);
        }, capsule => {capsule.actions[0].value = {}; refreshCapsuleHash(capsule);}, capsule => {
            capsule.actions[0].envelope.receipts[0].recv_sequence = '0'; refreshCapsuleHash(capsule);
        }]) {
        consumer.setRows([row]); assert.equal((await consumer.request()).statusCode, 200);
        const [key, raw] = [...consumer.cache.entries()].find(([, value]) => JSON.parse(value)._hyperion_protocol_abi_v3);
        const value = JSON.parse(raw); mutate(value._hyperion_protocol_abi_v3); consumer.cache.set(key, JSON.stringify(value));
        const refused = await consumer.request(); assert.equal(refused.statusCode, 503, refused.body);
    }
    // A downgraded old-format capsule misses and recomputes through current native authority.
    consumer.setRows([row]); assert.equal((await consumer.request()).statusCode, 200);
    const [oldKey, oldRaw] = [...consumer.cache.entries()].find(([, value]) => JSON.parse(value)._hyperion_protocol_abi_v3);
    const oldCapsule = JSON.parse(oldRaw); oldCapsule._hyperion_protocol_abi_v3.schemaVersion = 1;
    consumer.cache.set(oldKey, JSON.stringify(oldCapsule)); const beforeMiss = consumer.searches;
    const recomputed = await consumer.request(); assert.equal(recomputed.statusCode, 200, recomputed.body);
    assert(consumer.searches > beforeMiss); assert.deepEqual(recomputed.json().actions[0].act.data, row.act.data);
    consumer.setRows([row]); const requestScope = {}, sourceAction = structuredClone(row);
    await protectProtocolAction(consumer.app, requestScope, sourceAction);
    const detachedResponse = {actions: [sourceAction]}; delete sourceAction.protocol;
    const gate = deferred(), entered = deferred(); let once = true;
    consumer.setInterceptor(async (query, _options, next) => {const value = await next(); if (once && query.index === source.frontier.controlIndex) {once = false; entered.resolve(); await gate.promise;} return value;});
    const pendingCache = protocolResponseForCache(consumer.app, requestScope, 'get_actions', detachedResponse);
    await within(entered.promise); detachedResponse.actions[0].act.data = {late: 'changed source object'}; gate.resolve();
    const sealedCache = await pendingCache; consumer.setInterceptor(undefined);
    assert.deepEqual(sealedCache.actions[0].act.data, row.act.data);
    assert.equal(await validateProtocolCachedResponse(consumer.app, {}, 'get_actions', sealedCache), true);
    // A real HTTP connection close reaches the actual native journal read with its exact abort reason.
    consumer.setRows([row]); const httpGate = deferred(), httpEntered = deferred(), httpAborted = deferred(); let httpOnce = true, httpSignal;
    consumer.setInterceptor(async (query, options, next) => {if (httpOnce && query.index === source.nativeStore.index) {
        httpOnce = false; httpSignal = options.signal; httpSignal.addEventListener('abort', () => httpAborted.resolve(), {once: true});
        httpEntered.resolve(); await httpGate.promise;} return next();});
    const address = await consumer.app.listen({host: '127.0.0.1', port: 0});
    const httpRequest = httpGet(address + '/v2/history/get_actions?hydrate=false'); httpRequest.on('error', () => {});
    await within(httpEntered.promise); httpRequest.destroy(); await within(httpAborted.promise); httpGate.resolve();
    await within((async () => {while (!consumer.errors.includes(httpSignal.reason)) await new Promise(done => setTimeout(done, 5));})());
    assert(httpSignal.reason); assert.equal(consumer.cache.size, 0); consumer.setInterceptor(undefined);
    // Current Socket.IO controllers use the same native proof/value/envelope boundary.
    consumer.setRows([row]); const historical = new StreamSocket('history'), live = new StreamSocket('live');
    await history(consumer.app, historical, row); const historyPacket = historical.packets.find(packet => packet.messages?.length);
    assert.deepEqual(historyPacket.messages[0].act.data, row.act.data);
    assert.equal(historyPacket.messages[0].protocol, undefined); assert.equal(historical.listenerCount('disconnect'), 0);
    await relay(liveManager(consumer.app, row, [live]), row);
    assert.deepEqual(JSON.parse(live.packets[0].message).act.data, row.act.data); assert.equal(live.listenerCount('disconnect'), 0);
    // One cancelled historical consumer does not cancel a sibling or leak its scroll/listeners.
    const stopped = new StreamSocket('stopped-history'), sibling = new StreamSocket('sibling-history');
    const stopGate = deferred(), stopEntered = deferred(); let blocked = true, capturedSignal;
    consumer.setInterceptor(async (query, options, next) => {if (blocked && query.index === source.nativeStore.index) {
        blocked = false; capturedSignal = options.signal; stopEntered.resolve(); await stopGate.promise;} return next();});
    const stopping = history(consumer.app, stopped, row), stoppedOutcome = stopping.catch(error => error);
    await within(stopEntered.promise); stopped.disconnect(); assert(capturedSignal.aborted);
    await history(consumer.app, sibling, row); stopGate.resolve();
    assert.equal(await stoppedOutcome, capturedSignal.reason); consumer.setInterceptor(undefined);
    assert.deepEqual(sibling.packets.find(packet => packet.messages?.length).messages[0].act.data, row.act.data); assert.equal(stopped.listenerCount('disconnect'), 0);
    assert(consumer.clearCalls.includes('native-api-owned-scroll'));
    // Disconnecting one recipient of a live batch preserves the remaining recipient's native read.
    const gone = new StreamSocket('gone'), healthy = new StreamSocket('healthy'), liveGate = deferred(), liveEntered = deferred(); let liveOnce = true;
    consumer.setInterceptor(async (query, options, next) => {if (liveOnce && query.index === source.nativeStore.index) {
        liveOnce = false; capturedSignal = options.signal; liveEntered.resolve(); await liveGate.promise;} return next();});
    const livePending = relay(liveManager(consumer.app, row, [gone, healthy]), row); await within(liveEntered.promise);
    gone.disconnect(); assert.equal(capturedSignal.aborted, false); liveGate.resolve(); await livePending; consumer.setInterceptor(undefined);
    assert.equal(gone.packets.length, 0); assert.deepEqual(JSON.parse(healthy.packets[0].message).act.data, row.act.data);
    // A genuine canonical source revocation during a final native read cannot cache or emit the result.
    consumer.setRows([row]); let revoke = true;
    consumer.setInterceptor(async (query, _options, next) => {const value = await next(); if (revoke && query.index === source.nativeStore.index) {
        revoke = false; await source.coordinator.revokeSource('native-api-original-reader');} return value;});
    const revoked = await consumer.request(); assert.equal(revoked.statusCode, 503, revoked.body); assert.equal(consumer.cache.size, 0);
    consumer.setInterceptor(undefined); live.packets.length = 0;
    await relay(liveManager(consumer.app, row, [live]), row); assert.equal(live.packets[0].message, undefined); assert.equal(live.packets[0].error.statusCode, 503);
    const raw = structuredClone(row); raw.act.data = raw.protocol.input.rawHex; delete raw.protocol; consumer.setRows([raw]);
    const retainedRaw = await consumer.request(); assert.equal(retainedRaw.statusCode, 200, retainedRaw.body); assert.equal(retainedRaw.json().actions[0].act.data, raw.act.data);
    live.packets.length = 0; await relay(liveManager(consumer.app, raw, [live]), raw); assert.equal(JSON.parse(live.packets[0].message).act.data, raw.act.data);
    result.nativeValues = true; result.exactEnvelopes = true; result.cacheCapsules = true; result.ambiguousDowngrade = true;
    result.currentStreams = true; result.streamCancellation = true; result.sourceRevocation = true; result.rawHistory = true;
    assert(consumer.signals.some(signal => signal instanceof AbortSignal));
    assert(consumer.signals.filter(signal => signal !== undefined).every(signal => signal instanceof AbortSignal));
} finally {await consumer?.app.close(); await source.dispose();}
// An old unmarked canonical source cannot acquire native authority by storing a new-format label.
const legacySource = await nativeApiWireSource({nativeMarker: false}); let legacy;
try {
    await legacySource.appendUntil(2); const row = await legacySource.action(2); legacy = await api(legacySource); legacy.setRows([row]);
    const refused = await legacy.request(); assert.equal(refused.statusCode, 503, refused.body); result.unmarkedNativeRefused = true;
} finally {await legacy?.app.close(); await legacySource.dispose();}
assert.equal(regroupActions([{act_digest: 'same', action_ordinal: 1, creator_action_ordinal: 0, protocol: {schemaVersion: 2, kind: 'native',
    selectionId: 'source', input: {transactionId: 'transaction', inputActionOrdinal: 1}}},
    {act_digest: 'same', action_ordinal: 3, creator_action_ordinal: 1, protocol: {schemaVersion: 2, kind: 'native',
        selectionId: 'source', input: {transactionId: 'transaction', inputActionOrdinal: 3}}}]).length, 2);
console.log(JSON.stringify(result));
