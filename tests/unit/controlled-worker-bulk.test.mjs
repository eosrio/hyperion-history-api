import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fixtureWorkerTransport, dispatchFixtureService} from './controlled-worker-service-transport.mjs';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

test('worker bulk forwards ordered receipts, conflicts, and stored document copies', async () => {
    const memory = frontierMemoryClient(1), endpoint = new EventEmitter();
    await memory.client.indices.create({index: 'test', mappings: {}});
    const worker = {send(message, done) {queueMicrotask(() => endpoint.emit('message', message)); done?.();}};
    endpoint.send = (message, done) => {void dispatchFixtureService(worker, message, memory, async () => {}); done?.();};
    const transport = fixtureWorkerTransport(endpoint);
    try {
        const first = {value: 1}, second = {value: 2};
        const options = {refresh: false, wait_for_active_shards: 'all', pipeline: '_none'};
        const result = await transport.client.bulk({...options, operations: [
            {create: {_index: 'test', _id: 'a'}}, first,
            {create: {_index: 'test', _id: 'b'}}, second,
            {create: {_index: 'test', _id: 'a'}}, {value: 3},
        ]});
        assert.equal(result.errors, true);
        assert.deepEqual(result.items.map(({create}) => [create._index, create._id, create.status]),
            [['test', 'a', 201], ['test', 'b', 201], ['test', 'a', 409]]);
        for (const {create} of result.items.slice(0, 2)) {
            assert.equal(create.result, 'created'); assert.equal(create._primary_term, 1);
            assert.equal(typeof create._seq_no, 'number');
            assert.deepEqual(create._shards, {total: 2, successful: 2, failed: 0});
        }
        assert.equal(result.items[2].create.error.type, 'version_conflict_engine_exception');
        first.value = 99;
        assert.deepEqual((await transport.client.get({index: 'test', id: 'a'}))._source, {value: 1});
        assert.deepEqual(memory.calls.find(call => call.method === 'bulk').request.refresh, false);
        memory.faults.bulkReceipt = receipt => ({...receipt, items: []});
        assert.deepEqual((await transport.client.bulk({...options, operations: [
            {create: {_index: 'test', _id: 'c'}}, {value: 4},
        ]})).items, []);
    } finally {transport.close();}
});
