import assert from 'node:assert/strict';
import test from 'node:test';
import {StatefulCompleteKindMongoClient} from '../../build/indexer/connections/stateful-complete-kind-client.js';
const source = () => ({uri: 'mongodb://same-configured-chain.invalid:27017', options: {directConnection: true, replicaSet: 'same_chain'}});
function factory(change = value => value) {
    const clients = [];
    const create = (uri, options) => {
        const client = {uri, options: change(options), connects: 0, closes: 0,
            async connect() {client.connects++; return client;}, async close() {client.closes++;}};
        clients.push(client); return client;
    };
    return {clients, create};
}
test('one lazy same-URI bounded client is cached across concurrent requests and closed once', async () => {
    const fake = factory(), pool = new StatefulCompleteKindMongoClient(source, fake.create);
    assert.equal(fake.clients.length, 0); const first = pool.get(1000), second = pool.get(1000);
    assert.equal(first, second); const client = await first;
    assert.equal(fake.clients.length, 1); assert.equal(client.uri, source().uri); assert.equal(client.connects, 1);
    assert.deepEqual(client.options, {...source().options, retryReads: false, retryWrites: false, maxAdaptiveRetries: 0,
        maxPoolSize: 2, minPoolSize: 0, maxConnecting: 1, waitQueueTimeoutMS: 1000, connectTimeoutMS: 1000, serverSelectionTimeoutMS: 1000});
    assert.equal(await pool.get(1000), client); await pool.close(); await pool.close(); assert.equal(client.closes, 1);
    await assert.rejects(pool.get(1000), /unavailable/);
});
test('unsupported effective driver options fail closed before connection and release the client', async () => {
    for (const change of [options => ({...options, maxAdaptiveRetries: 2}), options => ({...options, retryReads: true}),
        options => ({...options, maxPoolSize: 100}), options => ({...options, serverSelectionTimeoutMS: undefined})]) {
        const fake = factory(change), pool = new StatefulCompleteKindMongoClient(source, fake.create);
        await assert.rejects(pool.get(1000), /did not enforce/);
        assert.equal(fake.clients[0].connects, 0); assert.equal(fake.clients[0].closes, 1); await pool.close();
    }
});
test('connection failure and an early connection-source failure are retryable without leaking pools', async () => {
    const fake = factory(); let failures = 1;
    const pool = new StatefulCompleteKindMongoClient(() => {if (failures--) throw new Error('source unavailable'); return source();}, fake.create);
    await assert.rejects(pool.get(1000), /source unavailable/); await new Promise(resolve => setImmediate(resolve));
    const client = await pool.get(1000); assert.equal(fake.clients.length, 1); await pool.close(); assert.equal(client.closes, 1);
    const connection = factory(), original = connection.create;
    const retry = new StatefulCompleteKindMongoClient(source, (uri, options) => {
        const client = original(uri, options); if (connection.clients.length === 1) client.connect = async () => {throw new Error('connect failed');}; return client;
    });
    await assert.rejects(retry.get(1000), /connect failed/); await new Promise(resolve => setImmediate(resolve));
    await retry.get(1000); assert.equal(connection.clients[0].closes, 1); await retry.close(); assert.equal(connection.clients[1].closes, 1);
});
test('shutdown during connection prevents late reuse and closes the pending client', async () => {
    const fake = factory(); let release;
    const gate = new Promise(resolve => {release = resolve;});
    const pool = new StatefulCompleteKindMongoClient(source, (uri, options) => {
        const client = fake.create(uri, options); client.connect = async () => {await gate; return client;}; return client;
    });
    const pending = pool.get(1000); pending.catch(() => {}); await Promise.resolve();
    const closing = pool.close(); release(); await assert.rejects(pending, /closed while connecting/); await closing;
    assert.equal(fake.clients[0].closes, 1); await assert.rejects(pool.get(1000), /unavailable/);
});
test('a chain cannot replace the selected timeout or allocate a pool from invalid totals', async () => {
    const fake = factory(), pool = new StatefulCompleteKindMongoClient(source, fake.create);
    for (const value of [0, -1, 1.5, 30001, undefined, '1000']) await assert.rejects(pool.get(value), /unavailable/);
    assert.equal(fake.clients.length, 0); await pool.get(1000); await assert.rejects(pool.get(2000), /unavailable/);
    assert.equal(fake.clients.length, 1); await pool.close();
});
