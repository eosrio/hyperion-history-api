import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {replayStreamHistory} from '../../build/api/helpers/functions.js';

const request = () => ({code: 'eosio.token', table: 'accounts', scope: 'alice', payer: '',
    start_from: 100, read_until: 101, ignore_live: true,
    filters: [{field: 'data.enabled', value: false}]});

function fixture() {
    const cleared = [];
    const fastify = {manager: {chain: 'fixture', config: {api: {stream_scroll_batch: 2,
        stream_scroll_limit: -1}, settings: {protocol: {provider: 'legacy'}}}}, elastic: {
        search: async () => ({_scroll_id: 'owned-scroll', hits: {total: {value: 2, relation: 'eq'}, hits: [
            {_source: {block_num: 100, block_id: 'a'.repeat(64), '@timestamp': '2026-10-23T00:00:00Z',
                code: 'eosio.token', table: 'accounts', scope: 'alice',
                primary_key: '18446744073709551615', data: {enabled: false}}},
            {_source: {block_num: 101, block_id: 'b'.repeat(64), '@timestamp': '2026-10-23T00:00:00.500Z',
                code: 'eosio.token', table: 'accounts', scope: 'alice', primary_key: '1', data: {enabled: true}}}
        ]}}),
        scroll: async () => {throw new Error('unexpected additional page');},
        clearScroll: async value => {cleared.push(value.scroll_id);}
    }};
    return {fastify, cleared};
}

// This adapter exercises the shared delivery interface without Socket.IO methods or framing.
function delivery() {
    const connection = Object.assign(new EventEmitter(), {id: 'interface-fixture', connected: true});
    const starts = [], batches = [];
    return {connection, starts, batches,
        begin(value) {starts.push(value);},
        async deliver(value, timeoutMs) {batches.push({value, timeoutMs}); return {status: true};}};
}

test('a transport-neutral history delivery preserves filtering, metadata and exact keys', async () => {
    const {fastify, cleared} = fixture(), peer = delivery();
    const result = await replayStreamHistory(fastify, peer, 'request-a', request(), 'delta');
    assert.deepEqual(peer.starts, [{requestId: 'request-a', firstBlock: 100, totalResults: 2}]);
    assert.deepEqual(peer.batches, [{timeoutMs: 120000, value: {requestId: 'request-a', kind: 'delta', filtered: 1,
        messages: [{block_num: 100, block_id: 'a'.repeat(64), code: 'eosio.token', table: 'accounts', scope: 'alice',
            primary_key: '18446744073709551615', data: {enabled: false}, timestamp: '2026-10-23T00:00:00Z'}]}}]);
    assert.equal(result.status, true);
    assert.equal(result.counter, 2);
    assert.equal(result.lastTransmittedBlock, 101);
    assert.deepEqual(cleared, ['owned-scroll']);
    assert.equal(peer.connection.listenerCount('disconnect'), 0);
});

test('cancellation during transport admission releases the owned history cursor', async () => {
    const {fastify, cleared} = fixture(), peer = delivery(), controller = new AbortController();
    let admit;
    const entered = new Promise(resolve => {admit = resolve;});
    peer.deliver = () => {admit(); return new Promise(() => {});};
    const running = replayStreamHistory(fastify, peer, 'request-a', request(), 'delta', controller.signal);
    await entered;
    controller.abort(new Error('cancelled at delivery interface'));
    await assert.rejects(running, /cancelled at delivery interface/);
    assert.deepEqual(cleared, ['owned-scroll']);
    assert.equal(peer.connection.listenerCount('disconnect'), 0);
});

test('a delivery rejection ends only its history operation and clears its cursor', async () => {
    const {fastify, cleared} = fixture(), peer = delivery();
    peer.deliver = async () => ({status: false, error: 'bounded delivery unavailable'});
    const result = await replayStreamHistory(fastify, peer, 'request-a', request(), 'delta');
    assert.deepEqual(result, {status: false, error: 'bounded delivery unavailable'});
    assert.deepEqual(cleared, ['owned-scroll']);
    assert.equal(peer.connection.listenerCount('disconnect'), 0);
});
