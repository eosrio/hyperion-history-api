import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {SocketManager} from '../../build/api/socketManager.js';
import {streamPastCommon} from '../../build/api/helpers/functions.js';

process.env.CONFIG_JSON = fileURLToPath(new URL('./fixtures/stream-config.json', import.meta.url));
const originalWorkingDirectory = process.cwd();
process.chdir(fileURLToPath(new URL('./fixtures/router-env/', import.meta.url)));
const {default: WSRouter} = await import('../../build/indexer/workers/ws-router.js');
process.chdir(originalWorkingDirectory);

const request = () => ({code: 'eosio.token', table: 'accounts', scope: 'alice', payer: '',
    start_from: 1, read_until: 2, ignore_live: true});
const actionRequest = () => ({contract: '', action: '', account: 'alice', start_from: 0,
    read_until: 0, replayOnReconnect: false});

function fixture(search) {
    const cleared = [];
    const fastify = {manager: {chain: 'fixture', config: {api: {stream_scroll_batch: 1,
        stream_scroll_limit: -1}, settings: {protocol: {provider: 'legacy'}}}},
    elastic: {search, scroll: async () => {throw new Error('unexpected second scroll page');},
        clearScroll: async value => {cleared.push(value.scroll_id);}}};
    return {fastify, cleared};
}

function firstPage() {
    return {_scroll_id: 'scroll-a', hits: {total: {value: 2, relation: 'eq'}, hits: [{_source: {
        block_num: 1, code: 'eosio.token', table: 'accounts', scope: 'alice', payer: '',
        '@timestamp': '2026-10-23T00:00:00Z', data: {balance: '1.0000 SYS'}}}]}};
}

function fakeSocket(id = 'client-a') {
    const handlers = new Map(), sent = [];
    return {id, connected: true, handshake: {headers: {}}, handlers, sent,
        on(event, handler) {handlers.set(event, handler); return this;},
        emit(event, ...args) {sent.push({event, args}); return true;},
        trigger(event, ...args) {assert.ok(handlers.has(event), `${event} is registered`);
            return handlers.get(event)(...args);},
        timeout() {return {emitWithAck: async () => ({status: true})};}};
}

function managerFor(fastify, socket) {
    const manager = Object.create(SocketManager.prototype);
    Object.assign(manager, {server: fastify, io: {sockets: {sockets: new Map([[socket.id, socket]])}},
        chainId: 'fixture-id', currentBlockNum: 2, clientDeltaRequestMap: new Map(),
        clientActionRequestMap: new Map(), deltaCodeMap: new Map(), actionContractMap: new Map(),
        payerClientMap: new Map(), notifiedAccountClientMap: new Map(),
        disconnectTimeoutMap: new Map(), historyRequests: new Map(), staleRelayClients: new Set(),
        pendingRelayCancels: new Map()});
    manager.validateRequest = async () => ({status: 'OK'});
    return manager;
}

async function until(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'timed out waiting for fixture event');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function routerFor() {
    const router = Object.create(WSRouter.prototype);
    Object.assign(router, {clientMap: new Map(), codeTableRelayMap: new Map(),
        contractActionRelayMap: new Map(), payerRelayMap: new Map(), notifiedRelayMap: new Map()});
    return router;
}

test('a post-ACK history failure identifies the exact request', async () => {
    const {fastify} = fixture(async () => {throw new Error('Elasticsearch unavailable');});
    const socket = fakeSocket(), manager = managerFor(fastify, socket), responses = [];
    await manager.processStreamRequest('delta', socket, request(), response => responses.push(response));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 'OK');
    const terminal = socket.sent.find(item => item.event === 'message' && item.args[0].error);
    assert.ok(terminal);
    assert.equal(terminal.args[0].reqUUID, responses[0].reqUUID);
    assert.equal(terminal.args[0].mode, 'history');
});

test('canceling a pending history ACK releases its Elasticsearch scroll', async () => {
    let acknowledge;
    const waitingForAck = new Promise(resolve => {acknowledge = resolve;});
    const {fastify, cleared} = fixture(async () => firstPage());
    const socket = fakeSocket();
    socket.timeout = () => ({emitWithAck() {acknowledge(); return new Promise(() => {});}});
    const controller = new AbortController();
    const running = streamPastCommon(fastify, socket, 'request-a', request(), 'delta', controller.signal);
    await waitingForAck;
    controller.abort(new Error('stream cancelled'));
    await assert.rejects(Promise.race([running,
        new Promise((_, reject) => setTimeout(() => reject(new Error('history ignored cancellation')), 500))]),
    /stream cancelled/);
    assert.deepEqual(cleared, ['scroll-a']);
});

test('canceling the second history page releases the latest scroll cursor', async () => {
    let secondPageAck;
    const waitingForSecondPage = new Promise(resolve => {secondPageAck = resolve;});
    const {fastify, cleared} = fixture(async () => firstPage());
    fastify.elastic.scroll = async () => ({_scroll_id: 'scroll-b',
        hits: {total: {value: 2, relation: 'eq'}, hits: [{_source: {
            block_num: 2, code: 'eosio.token', table: 'accounts', scope: 'alice', payer: '',
            '@timestamp': '2026-10-23T00:00:01Z', data: {balance: '2.0000 SYS'}}}]}});
    const socket = fakeSocket();
    let delivered = 0;
    socket.timeout = () => ({emitWithAck() {
        if (++delivered === 1) return Promise.resolve({status: true});
        secondPageAck();
        return new Promise(() => {});
    }});
    const controller = new AbortController();
    const running = streamPastCommon(fastify, socket, 'request-a', request(), 'delta', controller.signal);
    await waitingForSecondPage;
    controller.abort(new Error('second page cancelled'));
    await assert.rejects(running, /second page cancelled/);
    assert.equal(delivered, 2);
    assert.deepEqual(cleared, ['scroll-b']);
});

test('cancel_stream_request stops its local history replay without a relay', async () => {
    let acknowledge;
    const waitingForAck = new Promise(resolve => {acknowledge = resolve;});
    const {fastify, cleared} = fixture(async () => firstPage());
    const socket = fakeSocket(), manager = managerFor(fastify, socket);
    socket.timeout = () => ({emitWithAck() {acknowledge(); return new Promise(() => {});}});
    manager.handleSocketConnection(socket, fastify);
    const started = new Promise(resolve => socket.trigger('delta_stream_request', request(), resolve));
    const response = await started;
    assert.equal(response.status, 'OK');
    await waitingForAck;
    const cancellation = await new Promise(resolve => socket.trigger('cancel_stream_request',
        {reqUUID: response.reqUUID}, resolve));
    assert.deepEqual(cancellation, {status: 'OK'});
    await until(() => cleared.length === 1);
    assert.equal(manager.historyRequests.size, 0);
    assert.deepEqual(cleared, ['scroll-a']);
});

test('canceling one account subscription leaves its sibling live', async () => {
    const {fastify} = fixture(async () => firstPage());
    const socket = fakeSocket(), manager = managerFor(fastify, socket);
    const relayEvents = [];
    manager.relay = {connected: true, emit(_event, message, callback) {
        relayEvents.push(message); callback?.({status: 'OK'});
    }};
    manager.handleSocketConnection(socket, fastify);
    manager.attachActionRequests(actionRequest(), socket.id, 'request-a');
    manager.attachActionRequests(actionRequest(), socket.id, 'request-b');
    const cancelled = await new Promise(resolve => socket.trigger('cancel_stream_request',
        {reqUUID: 'request-a'}, resolve));
    assert.deepEqual(cancelled, {status: 'OK'});
    await manager.routeActionTraceToClients({account: 'eosio.token', name: 'transfer',
        notified: 'alice', message: JSON.stringify({block_num: 1})});
    const delivered = socket.sent.filter(item => item.event === 'message').at(-1)?.args[0];
    assert.deepEqual(delivered.targets, ['request-b']);
    assert.deepEqual([...manager.clientActionRequestMap.get(socket.id).keys()], ['request-b']);
    assert.equal(relayEvents.at(-1).reqUUID, 'request-a');
});

test('an action-only reconnect restores its live route and retires the old router client', async () => {
    const {fastify} = fixture(async () => firstPage());
    const socket = fakeSocket('new-client'), manager = managerFor(fastify, socket), relayEvents = [];
    const router = routerFor();
    manager.relay = {connected: true, emit(_event, message, callback) {
        relayEvents.push(message); callback?.({status: 'OK'});
    }};
    manager.relay.emit = (_event, message, callback) => {
        relayEvents.push(message);
        if (message.type === 'client_reconnected') callback(router.reconnectClient(
            message.old_client_socket, message.client_socket, message.retained_request_ids, 'relay-a'));
        else if (message.type === 'client_disconnected') router.removeClient(message.id);
        else callback?.({status: 'OK'});
    };
    router.addActionRequest({request: actionRequest(), client_socket: 'old-client',
        reqUUID: 'request-a'}, 'relay-a');
    manager.attachActionRequests(actionRequest(), 'old-client', 'request-a');
    manager.handleSocketConnection(socket, fastify);
    socket.trigger('reconnect', {last_id: 'old-client'});
    await until(() => manager.clientActionRequestMap.get(socket.id)?.has('request-a') &&
        !manager.clientActionRequestMap.has('old-client'), 500);
    assert.equal(manager.clientActionRequestMap.has('old-client'), false);
    assert.ok(relayEvents.some(event => event.type === 'client_reconnected'
        && event.old_client_socket === 'old-client' && event.client_socket === socket.id));
    assert.equal(router.clientMap.has('old-client'), false);
    assert.ok(router.clientMap.get(socket.id)?.requests.has('request-a'));
    assert.deepEqual([...router.notifiedRelayMap.get('alice').get('relay-a')], ['request-a']);
});

test('router transfer retains independent subscriptions and drops replayed requests', () => {
    const router = routerFor();
    const replayed = {...actionRequest(), replayOnReconnect: true};
    router.addActionRequest({request: actionRequest(), client_socket: 'old-client',
        reqUUID: 'action-a'}, 'relay-a');
    router.addActionRequest({request: replayed, client_socket: 'old-client',
        reqUUID: 'action-b'}, 'relay-a');
    router.addDeltaRequest({request: request(), client_socket: 'old-client',
        reqUUID: 'delta-a'}, 'relay-a');
    router.addDeltaRequest({request: request(), client_socket: 'new-client',
        reqUUID: 'new-delta'}, 'relay-a');
    assert.deepEqual(router.reconnectClient('old-client', 'new-client',
        ['action-a', 'delta-a'], 'relay-a'), {status: 'OK'});
    assert.deepEqual([...router.clientMap.get('new-client').requests.keys()].sort(),
        ['action-a', 'delta-a', 'new-delta']);
    assert.equal(router.clientMap.has('old-client'), false);
    assert.deepEqual([...router.notifiedRelayMap.get('alice').get('relay-a')], ['action-a']);
    assert.deepEqual([...router.codeTableRelayMap.get('eosio.token').get('accounts').get('relay-a')].sort(),
        ['delta-a', 'new-delta']);
});

test('router relay reconnect moves links and request ownership to the new relay', () => {
    const router = routerFor();
    router.relays = {'relay-a': {clients: 1, connected: false}};
    router.addActionRequest({request: actionRequest(), client_socket: 'old-client',
        reqUUID: 'action-a'}, 'relay-a');
    router.addDeltaRequest({request: request(), client_socket: 'old-client',
        reqUUID: 'delta-a'}, 'relay-a');
    router.replaceRelay('relay-b', 'relay-a');
    assert.equal(router.relays['relay-a'], undefined);
    assert.equal(router.clientMap.get('old-client').relayId, 'relay-b');
    assert.equal(router.clientMap.get('old-client').requests.get('action-a').relay_id, 'relay-b');
    assert.deepEqual([...router.notifiedRelayMap.get('alice').keys()], ['relay-b']);
    assert.deepEqual([...router.codeTableRelayMap.get('eosio.token').get('accounts').keys()], ['relay-b']);
    assert.deepEqual(router.reconnectClient('old-client', 'new-client',
        ['action-a', 'delta-a'], 'relay-b'), {status: 'OK'});
});

test('failed live setup does not retain a subscription or attempt history', async () => {
    let searched = false;
    const {fastify} = fixture(async () => {searched = true; return firstPage();});
    const socket = fakeSocket(), manager = managerFor(fastify, socket), responses = [];
    manager.relay = {connected: false};
    await manager.processStreamRequest('action', socket, {...actionRequest(), start_from: 1},
        response => responses.push(response));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].status, 'ERROR');
    assert.equal(responses[0].error.retryable, true);
    assert.equal(manager.clientActionRequestMap.size, 0);
    assert.equal(manager.notifiedAccountClientMap.size, 0);
    assert.equal(manager.historyRequests.size, 0);
    assert.equal(searched, false);
});

test('history failure after live ACK removes both API and router subscriptions', async () => {
    const {fastify} = fixture(async () => {throw new Error('history search failed');});
    const socket = fakeSocket(), manager = managerFor(fastify, socket), events = [], responses = [];
    manager.relay = {connected: true, emit(_event, message, callback) {
        events.push(message); callback?.({status: 'OK'});
    }};
    await manager.processStreamRequest('action', socket, {...actionRequest(), start_from: 1},
        response => responses.push(response));
    assert.equal(responses[0].status, 'OK');
    assert.equal(manager.clientActionRequestMap.size, 0);
    assert.equal(manager.notifiedAccountClientMap.size, 0);
    assert.ok(events.some(event => event.type === 'cancel_request'
        && event.reqUUID === responses[0].reqUUID));
    assert.equal(socket.sent.find(item => item.event === 'message' && item.args[0].error)
        .args[0].reqUUID, responses[0].reqUUID);
});

test('offline cancellation queues the router cleanup for relay recovery', async () => {
    const {fastify} = fixture(async () => firstPage());
    const socket = fakeSocket(), manager = managerFor(fastify, socket), events = [];
    manager.relay = {connected: false, emit() {}};
    manager.attachActionRequests(actionRequest(), socket.id, 'request-a');
    manager.handleSocketConnection(socket, fastify);
    const response = await new Promise(resolve => socket.trigger('cancel_stream_request',
        {reqUUID: 'request-a'}, resolve));
    assert.deepEqual(response, {status: 'OK', pending: true});
    assert.equal(manager.clientActionRequestMap.size, 0);
    assert.ok(manager.pendingRelayCancels.get(socket.id).has('request-a'));
    manager.relay = {connected: true, emit(_event, message, callback) {
        events.push(message); callback?.({status: 'OK'});
    }};
    manager.flushPendingRelayCancels();
    assert.equal(manager.pendingRelayCancels.size, 0);
    assert.deepEqual(events, [{type: 'cancel_request', client_socket_id: socket.id,
        reqUUID: 'request-a'}]);
});

test('reconnect interrupts active history with a request-scoped retryable error', async () => {
    const {fastify} = fixture(async () => firstPage());
    const socket = fakeSocket('new-client'), manager = managerFor(fastify, socket);
    const router = routerFor();
    router.addActionRequest({request: actionRequest(), client_socket: 'old-client',
        reqUUID: 'request-a'}, 'relay-a');
    manager.relay = {connected: true, emit(_event, message, callback) {
        if (message.type === 'client_reconnected') callback(router.reconnectClient(
            message.old_client_socket, message.client_socket, message.retained_request_ids, 'relay-a'));
    }};
    manager.attachActionRequests(actionRequest(), 'old-client', 'request-a');
    const controller = new AbortController();
    manager.historyRequests.set('request-a', {clientId: 'old-client', controller,
        type: 'action', replayOnReconnect: false});
    manager.handleSocketConnection(socket, fastify);
    socket.trigger('reconnect', {last_id: 'old-client'});
    await until(() => socket.sent.some(item => item.event === 'message' && item.args[0].error));
    assert.equal(controller.signal.aborted, true);
    assert.equal(manager.clientActionRequestMap.has('old-client'), false);
    assert.equal(router.clientMap.has('old-client'), false);
    assert.equal(router.clientMap.has('new-client'), false);
    const terminal = socket.sent.find(item => item.event === 'message' && item.args[0].error).args[0];
    assert.equal(terminal.reqUUID, 'request-a');
    assert.equal(terminal.error.retryable, true);
});

test('lost transfer acknowledgement cleans both possible router owners before resending', async () => {
    const {fastify} = fixture(async () => firstPage());
    const socket = fakeSocket('new-client'), manager = managerFor(fastify, socket);
    const router = routerFor();
    router.addActionRequest({request: actionRequest(), client_socket: 'old-client',
        reqUUID: 'request-a'}, 'relay-a');
    manager.relay = {connected: true, emit(_event, message, callback) {
        if (message.type === 'client_reconnected') {
            router.reconnectClient(message.old_client_socket, message.client_socket,
                message.retained_request_ids, 'relay-a');
            callback({status: 'ERROR'});
        } else if (message.type === 'cancel_request') {
            router.removeClientRequest(message.client_socket_id, message.reqUUID);
            callback?.({status: 'OK'});
        } else if (message.type === 'client_disconnected') router.removeClient(message.id);
    }};
    manager.attachActionRequests(actionRequest(), 'old-client', 'request-a');
    manager.handleSocketConnection(socket, fastify);
    socket.trigger('reconnect', {last_id: 'old-client'});
    await until(() => socket.sent.some(item => item.event === 'resend_requests'));
    assert.equal(router.clientMap.has('old-client'), false);
    assert.equal(router.clientMap.has('new-client'), false);
    assert.equal(manager.clientActionRequestMap.has('old-client'), false);
    assert.equal(manager.clientActionRequestMap.has('new-client'), false);
});
