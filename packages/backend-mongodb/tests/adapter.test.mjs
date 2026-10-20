import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoServerError } from 'mongodb';
import { createMongoDbProjectionAdapter } from '../dist/index.js';

const copy = value => structuredClone(value);
const hex = value => value.toString(16).padStart(64, '0');
const genesis = { blockNum: 0, blockId: hex(0) };
const definition = {
    schemaVersion: 1, id: 'account-balance', mappingRevision: hex(10),
    source: { contract: 'token', table: 'accounts', abiDeployment: 'deployment-1', abiSha256: hex(11) },
    fields: [
        { name: 'owner', path: ['owner'], type: 'string' },
        { name: 'balance', path: ['balance'], type: 'integer' },
        { name: 'enabled', path: ['enabled'], type: 'boolean' },
        { name: 'empty', path: ['empty'], type: 'null' },
    ], initialization: { kind: 'genesis' },
};
const binding = {
    chainId: hex(12), backendId: 'fixture-backend', projectionId: definition.id,
    mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment,
    abiSha256: definition.source.abiSha256, generation: 'generation-1',
};
const value = (owner, balance) => ({ owner, balance, enabled: true, empty: null });
const put = (key, owner, balance) => ({ kind: 'put', key, value: value(owner, balance) });
const request = (number, mutations, selectedBinding = binding) => ({
    binding: selectedBinding,
    previous: { blockNum: number - 1, blockId: hex(number - 1) },
    block: { blockNum: number, blockId: hex(number), previousBlockId: hex(number - 1) }, mutations,
});
const errorCode = code => error => error?.code === code;

/** Boundary fixture; transaction guarantees additionally require the real-Mongo runner. */
function databaseFixture() {
    let storage = new Map();
    const native = [];
    const fixture = {
        hello: { setName: 'fixture', isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 25 },
        failPut: false,
        foreignErrors: false,
        beforeFind: null,
        native,
        get storage() { return storage; },
    };
    const mapFor = (name, session) => {
        const selected = session?.storage ?? storage;
        if (!selected.has(name)) selected.set(name, new Map());
        return selected.get(name);
    };
    const get = (record, path) => path.split('.').reduce((parent, key) => parent?.[key], record);
    const matches = (record, filter) => Object.entries(filter).every(([key, predicate]) => {
        if (key === '$and') return predicate.every(term => matches(record, term));
        const actual = get(record, key);
        if (predicate && typeof predicate === 'object' && Object.hasOwn(predicate, '$eq')) return actual === predicate.$eq;
        if (predicate && typeof predicate === 'object' && Object.hasOwn(predicate, '$gt')) {
            return Buffer.compare(Buffer.from(actual), Buffer.from(predicate.$gt)) > 0;
        }
        return JSON.stringify(actual) === JSON.stringify(predicate);
    });
    const update = (collection, filter, change, session) => {
        const records = mapFor(collection, session);
        for (const [key, record] of records) if (matches(record, filter)) {
            const changed = { ...record, ...copy(change.$set) };
            records.set(key, changed);
            return changed;
        }
        return null;
    };
    const collection = name => ({
        collectionName: name,
        async insertOne(record, options) {
            native.push({ command: 'insert', name, options });
            const records = mapFor(name, options?.session);
            if (records.has(record._id)) {
                throw fixture.foreignErrors ? Object.assign(new Error('duplicate'), { name: 'MongoServerError', code: 11000 }) :
                    new MongoServerError({ message: 'duplicate', code: 11000 });
            }
            records.set(record._id, copy(record));
            return { acknowledged: true, insertedId: record._id };
        },
        async findOne(filter, options) {
            native.push({ command: 'findOne', name, options });
            if (fixture.beforeFind) await fixture.beforeFind(name, options);
            return copy([...mapFor(name, options?.session).values()].find(record => matches(record, filter)) ?? null);
        },
        async updateOne(filter, change, options) {
            native.push({ command: 'update', name, options });
            return { acknowledged: true, matchedCount: update(name, filter, change, options?.session) === null ? 0 : 1 };
        },
        async findOneAndUpdate(filter, change, options) {
            native.push({ command: 'findAndModify', name, options });
            return copy(update(name, filter, change, options?.session));
        },
        async replaceOne(filter, replacement, options) {
            native.push({ command: 'replace', name, options });
            assert.ok(options.session, 'effects must carry the transaction session');
            if (fixture.failPut) { fixture.failPut = false; throw new Error('injected storage failure'); }
            mapFor(name, options.session).set(filter._id, copy(replacement));
            return { acknowledged: true, matchedCount: 1 };
        },
        async deleteOne(filter, options) {
            native.push({ command: 'delete', name, options });
            assert.ok(options.session);
            return { acknowledged: true, deletedCount: Number(mapFor(name, options.session).delete(filter._id)) };
        },
        async options() { return { collation: { locale: 'simple' } }; },
        find(filter, options) {
            native.push({ command: 'find', name, options, filter });
            assert.ok(options.session);
            let limit = Infinity;
            const cursor = {
                sort(order) { assert.deepEqual(order, { _id: 1 }); return cursor; },
                limit(number) { limit = number; return cursor; },
                async toArray() {
                    return copy([...mapFor(name, options.session).values()].filter(record => matches(record, filter))
                        .sort((a, b) => Buffer.compare(Buffer.from(a._id), Buffer.from(b._id))).slice(0, limit));
                },
                async *[Symbol.asyncIterator]() { yield* await cursor.toArray(); },
                async close() { native.push({ command: 'close', name }); },
            };
            return cursor;
        },
        async countDocuments(filter, options) {
            native.push({ command: 'count', name, options, filter });
            assert.ok(options.session);
            return [...mapFor(name, options.session).values()].filter(record => matches(record, filter)).slice(0, options.limit).length;
        },
    });
    const db = {
        collection,
        admin() { return { command: async () => { native.push({ command: 'hello' }); return fixture.hello; } }; },
        async createCollection(name) {
            native.push({ command: 'createCollection', name });
            if (storage.has(name)) throw new MongoServerError({ message: 'exists', code: 48 });
            storage.set(name, new Map());
        },
    };
    fixture.client = {
        db() { return db; },
        startSession() {
            const session = {
                storage: null,
                async withTransaction(operation, options) {
                    native.push({ command: 'transaction', options });
                    session.storage = copy(storage);
                    const result = await operation(session);
                    storage = session.storage;
                    return result;
                },
                async endSession() { native.push({ command: 'endSession' }); },
            };
            return session;
        },
    };
    fixture.adapter = options => createMongoDbProjectionAdapter({
        client: fixture.client, databaseName: 'portable_fixture', backendId: binding.backendId, ...options,
    });
    return fixture;
}

test('initialization rejects unsupported topology before storage and rejects contract changes', async () => {
    const fixture = databaseFixture();
    fixture.hello = { isWritablePrimary: true, maxWireVersion: 25, logicalSessionTimeoutMinutes: 30 };
    await assert.rejects(fixture.adapter().initialize(definition, binding, genesis), errorCode('projection.capability-unavailable'));
    assert.deepEqual(fixture.native.map(call => call.command), ['hello']);
    fixture.hello = { setName: 'fixture', isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 25 };
    const adapter = fixture.adapter();
    assert.deepEqual(await adapter.initialize(definition, binding, genesis), { binding, checkpoint: genesis });
    fixture.foreignErrors = true;
    assert.deepEqual(await adapter.initialize(definition, binding, genesis), { binding, checkpoint: genesis });
    const changed = copy(definition);
    changed.fields[0].path = ['different'];
    await assert.rejects(adapter.initialize(changed, binding, genesis), errorCode('projection.invalid-contract'));
    await assert.rejects(adapter.initialize(definition, { ...binding, generation: 'another-generation' }, genesis), errorCode('projection.stale-view'));
    assert.deepEqual(await adapter.open(binding), { binding, checkpoint: genesis });
});

test('initialize incomplete is reserved for a valid exact stored binding and definition', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    await adapter.markIncomplete(binding, request(1, []).block, 'contract input failed');
    await assert.rejects(adapter.initialize(definition, binding, genesis), errorCode('projection.incomplete'));
    const changed = copy(definition);
    changed.fields[0].path = ['another'];
    await assert.rejects(adapter.initialize(changed, binding, genesis), errorCode('projection.invalid-contract'));
    const meta = [...fixture.storage.values()].flatMap(collection => [...collection.values()]).find(record => record.storageVersion);
    meta.definitionHash = hex(999);
    await assert.rejects(adapter.initialize(definition, binding, genesis), errorCode('projection.invalid-contract'));
});

test('ordered effects, checkpoint, receipt, binary paging and capped count share a completed view', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    const applied = await adapter.apply(request(1, [put('z', 'alice', 1), put('z', 'alice', 2), put('a', 'bob', 3), put('😀', 'alice', 4), put('\uE000', 'alice', 5)]));
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.view.checkpoint, { blockNum: 1, blockId: hex(1) });
    const page = await adapter.query(applied.view, { filter: [{ field: 'owner', op: 'eq', value: 'alice' }], limit: 2, count: { upTo: 2 } });
    assert.deepEqual(page.rows.map(row => row.key), ['z', '\uE000']);
    assert.equal(page.rows[0].value.balance, 2);
    assert.equal(page.nextAfterKey, '\uE000');
    assert.deepEqual(page.count, { value: 2, exact: false });
    const next = await adapter.query(applied.view, { filter: [{ field: 'owner', op: 'eq', value: 'alice' }], afterKey: page.nextAfterKey, limit: 2, count: { upTo: 3 } });
    assert.deepEqual(next.rows.map(row => row.key), ['😀']);
    assert.deepEqual(next.count, { value: 3, exact: true });
    assert.equal(next.nextAfterKey, undefined);
    const second = await adapter.apply(request(2, [{ kind: 'delete', key: 'z' }]));
    await assert.rejects(adapter.query(applied.view, { filter: [], limit: 1 }), errorCode('projection.stale-view'));
    assert.equal((await adapter.query(second.view, { filter: [{ field: 'empty', op: 'eq', value: null }], limit: 10 })).rows.length, 3);
    const transaction = fixture.native.find(call => call.command === 'transaction');
    assert.equal(transaction.options.timeoutMS, 15000);
    assert.deepEqual(transaction.options.readConcern, { level: 'snapshot' });
    assert.equal(transaction.options.writeConcern.w, 'majority');
    assert.equal(transaction.options.writeConcern.journal, true);
});

test('failed transaction leaves durable intent across restart and exact replay never rewrites newer state', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter({ receiptRetention: 2 });
    await adapter.initialize(definition, binding, genesis);
    fixture.failPut = true;
    await assert.rejects(adapter.apply(request(1, [put('x', 'alice', 1)])), errorCode('projection.apply-unavailable'));
    const restarted = fixture.adapter({ receiptRetention: 2 });
    await assert.rejects(restarted.open(binding), errorCode('projection.incomplete'));
    await assert.rejects(restarted.apply(request(1, [put('x', 'alice', 9)])), errorCode('projection.conflicting-replay'));
    assert.equal((await restarted.apply(request(1, [put('x', 'alice', 1)]))).status, 'applied');
    const second = await restarted.apply(request(2, [put('x', 'alice', 2)]));
    const writes = fixture.native.filter(call => call.command === 'replace').length;
    const duplicate = await restarted.apply(request(1, [put('x', 'alice', 1)]));
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(duplicate.view, second.view);
    assert.equal(fixture.native.filter(call => call.command === 'replace').length, writes);
    assert.equal((await restarted.query(duplicate.view, { filter: [], limit: 2 })).rows[0].value.balance, 2);
    await assert.rejects(restarted.apply(request(1, [put('x', 'alice', 8)])), errorCode('projection.conflicting-replay'));
    const third = await restarted.apply(request(3, [put('x', 'alice', 3)]));
    await assert.rejects(restarted.apply(request(1, [put('x', 'alice', 1)])), errorCode('projection.replay-unavailable'));
    const meta = [...fixture.storage.values()].flatMap(collection => [...collection.values()]).find(record => record.storageVersion);
    assert.equal(meta.receipts.length, 2);
    assert.deepEqual(meta.checkpoint, third.view.checkpoint);
});

test('pre-apply failure survives restart, isolates another projection, and only exact source resumes', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    await adapter.markIncomplete(binding, request(1, []).block, 'invalid contract row');
    const restarted = fixture.adapter();
    await assert.rejects(restarted.open(binding), errorCode('projection.incomplete'));
    await assert.rejects(restarted.apply({ ...request(1, []), block: { ...request(1, []).block, blockId: hex(99) } }), errorCode('projection.conflicting-replay'));
    const independentDefinition = { ...definition, id: 'independent' };
    const independentBinding = { ...binding, projectionId: independentDefinition.id };
    await restarted.initialize(independentDefinition, independentBinding, genesis);
    const unrelated = await restarted.apply(request(1, [put('other', 'bob', 5)], independentBinding));
    assert.equal((await restarted.query(unrelated.view, { filter: [], limit: 10 })).rows[0].value.owner, 'bob');
    const recovered = await restarted.apply(request(1, [put('recovered', 'alice', 1)]));
    assert.deepEqual(await restarted.open(binding), recovered.view);
});

test('rejects malformed inputs before effects and captures application input before asynchronous storage', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    const original = request(1, [put('x', 'alice', 1)]);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    fixture.beforeFind = async (_name, options) => {
        if (!options.session) { entered(); await held; }
    };
    const applying = adapter.apply(original);
    await started;
    original.mutations[0].value.balance = 88;
    original.binding = { ...binding, generation: 'changed-after-call' };
    release();
    const result = await applying;
    fixture.beforeFind = null;
    assert.equal((await adapter.query(result.view, { filter: [], limit: 2 })).rows[0].value.balance, 1);
    const before = fixture.native.length;
    await assert.rejects(adapter.apply({ ...request(2, []), mutations: [{ kind: 'increment', key: 'x', value: 1 }] }), errorCode('projection.invalid-contract'));
    assert.equal(fixture.native.length, before);
    await assert.rejects(adapter.query(result.view, { filter: [{ field: 'balance', op: 'eq', value: '1' }], limit: 2 }), errorCode('projection.invalid-contract'));
    await assert.rejects(adapter.apply(request(3, [])), errorCode('projection.source-gap'));
});

test('captures logical query before storage await and rejects unsafe syntax without native I/O', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    const applied = await adapter.apply(request(1, [put('alice', 'alice', 1), put('bob', 'bob', 2)]));
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    fixture.beforeFind = async (_name, options) => { if (!options.session) { entered(); await held; } };
    const query = { filter: [{ field: 'owner', op: 'eq', value: 'alice' }], limit: 10 };
    const querying = adapter.query(applied.view, query);
    await started;
    query.filter[0].value = 'bob';
    release();
    assert.deepEqual((await querying).rows.map(row => row.key), ['alice']);
    fixture.beforeFind = null;
    const before = fixture.native.length;
    await assert.rejects(adapter.query(applied.view, { filter: [{ field: '$where', op: 'eq', value: 'evil' }], limit: 1 }), errorCode('projection.invalid-contract'));
    assert.equal(fixture.native.length, before);
});

test('streams bounded byte pages with a usable cursor and an independent count', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    const large = 'x'.repeat(60000);
    const mutations = Array.from({ length: 80 }, (_, index) => put(`key-${index.toString().padStart(3, '0')}`, large, index));
    await adapter.apply(request(1, mutations.slice(0, 40)));
    const applied = await adapter.apply(request(2, mutations.slice(40)));
    const first = await adapter.query(applied.view, { filter: [], limit: 1000, count: { upTo: 100 } });
    assert.ok(first.rows.length > 0 && first.rows.length < 80);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 4194304);
    assert.deepEqual(first.count, { value: 80, exact: true });
    assert.equal(first.nextAfterKey, first.rows.at(-1).key);
    const second = await adapter.query(applied.view, { filter: [], afterKey: first.nextAfterKey, limit: 1000 });
    assert.deepEqual([...first.rows, ...second.rows].map(row => row.key), mutations.map(mutation => mutation.key));
    assert.equal(second.nextAfterKey, undefined);
});

test('durable future gap gates reads through restart and missing-frame completion until exact target replay', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    const first = await adapter.apply(request(1, [put('x', 'alice', 1)]));
    const future = request(3, [put('x', 'alice', 3)]);
    await assert.rejects(adapter.apply(future), errorCode('projection.source-gap'));
    await assert.rejects(adapter.query(first.view, { filter: [], limit: 1 }), errorCode('projection.incomplete'));
    const restarted = fixture.adapter();
    await assert.rejects(restarted.initialize(definition, binding, genesis), errorCode('projection.incomplete'));
    await assert.rejects(restarted.open(binding), errorCode('projection.incomplete'));
    await assert.rejects(restarted.apply({ ...request(2, []), block: { ...request(2, []).block, blockId: hex(200) } }), errorCode('projection.conflicting-replay'));
    const secondRequest = request(2, [put('x', 'alice', 2)]);
    const second = await restarted.apply(secondRequest);
    assert.equal(second.status, 'applied');
    assert.equal(second.view.checkpoint.blockNum, 2);
    assert.equal((await restarted.apply(secondRequest)).status, 'duplicate', 'durable missing-frame receipt may ACK while gap fences reads');
    await assert.rejects(restarted.query(second.view, { filter: [], limit: 1 }), errorCode('projection.incomplete'));
    const stored = [...fixture.storage.values()].flatMap(collection => [...collection.values()]).find(record => record.storageVersion);
    stored.gap.block.previousBlockId = hex(999);
    await assert.rejects(restarted.initialize(definition, binding, genesis), errorCode('projection.invalid-contract'));
    stored.gap.block.previousBlockId = hex(2);
    await assert.rejects(restarted.apply(request(3, [put('x', 'alice', 300)])), errorCode('projection.conflicting-replay'));
    await assert.rejects(restarted.apply({ ...future, block: { ...future.block, blockId: hex(303) } }), errorCode('projection.conflicting-replay'));
    await assert.rejects(restarted.open(binding), errorCode('projection.incomplete'));
    const third = await restarted.apply(future);
    assert.equal(third.view.checkpoint.blockNum, 3);
    assert.deepEqual(await restarted.open(binding), third.view);
    assert.equal((await restarted.query(third.view, { filter: [], limit: 1 })).rows[0].value.balance, 3);
    const meta = [...fixture.storage.values()].flatMap(collection => [...collection.values()]).find(record => record.storageVersion);
    assert.equal(meta.gap, null);
    assert.equal(meta.pending, null);
});

test('one bounded gap authority survives additional future frames and isolates unrelated projections', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    await adapter.apply(request(1, [put('x', 'alice', 1)]));
    const future = request(3, [put('x', 'alice', 3)]);
    await assert.rejects(adapter.apply(future), errorCode('projection.source-gap'));
    for (let number = 4; number < 30; number++) {
        await assert.rejects(adapter.apply(request(number, [])), errorCode('projection.apply-unavailable'));
    }
    const meta = [...fixture.storage.values()].flatMap(collection => [...collection.values()]).find(record => record.storageVersion);
    assert.equal(meta.gap.block.blockNum, 3);
    assert.equal(meta.receipts.length, 1);
    assert.equal(meta.pending, null);
    assert.ok(Buffer.byteLength(JSON.stringify(meta.gap)) < 512);
    const otherDefinition = { ...definition, id: 'unrelated-gap' };
    const otherBinding = { ...binding, projectionId: otherDefinition.id };
    await adapter.initialize(otherDefinition, otherBinding, genesis);
    const other = await adapter.apply(request(1, [put('y', 'bob', 7)], otherBinding));
    assert.equal((await adapter.query(other.view, { filter: [], limit: 1 })).rows[0].value.balance, 7);
    await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
});

test('future pre-apply failure records identity without effects and remains distinct from failed current application', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.adapter();
    await adapter.initialize(definition, binding, genesis);
    await adapter.apply(request(1, [put('x', 'alice', 1)]));
    await adapter.markIncomplete(binding, request(2, []).block, 'invalid row in missing block');
    await assert.rejects(adapter.markIncomplete(binding, request(3, []).block, 'invalid future contract row'), errorCode('projection.source-gap'));
    const restarted = fixture.adapter();
    await assert.rejects(restarted.open(binding), errorCode('projection.incomplete'));
    await assert.rejects(restarted.apply({ ...request(3, []), block: { ...request(3, []).block, blockId: hex(999) } }), errorCode('projection.conflicting-replay'));
    const second = await restarted.apply(request(2, [put('x', 'alice', 2)]));
    await assert.rejects(restarted.query(second.view, { filter: [], limit: 1 }), errorCode('projection.incomplete'));
    const future = request(3, [put('x', 'alice', 3)]);
    fixture.failPut = true;
    await assert.rejects(restarted.apply(future), errorCode('projection.apply-unavailable'));
    await assert.rejects(restarted.apply(request(3, [put('x', 'alice', 33)])), errorCode('projection.conflicting-replay'));
    const third = await fixture.adapter().apply(future);
    assert.equal((await restarted.query(third.view, { filter: [], limit: 1 })).rows[0].value.balance, 3);
});
