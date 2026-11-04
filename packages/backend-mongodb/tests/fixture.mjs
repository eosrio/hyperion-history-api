import assert from 'node:assert/strict';
import { MongoServerError } from 'mongodb';
import { createMongoDbProjectionAdapter, createMongoDbRollbackAdapter } from '../dist/index.js';

export const copy = value => structuredClone(value);
export const hex = value => value.toString(16).padStart(64, '0');
export const genesis = { blockNum: 0, blockId: hex(0) };
export const definition = {
    schemaVersion: 1, id: 'account-balance', mappingRevision: hex(10),
    source: { contract: 'token', table: 'accounts', abiDeployment: 'deployment-1', abiSha256: hex(11) },
    fields: [
        { name: 'owner', path: ['owner'], type: 'string' },
        { name: 'balance', path: ['balance'], type: 'integer' },
        { name: 'enabled', path: ['enabled'], type: 'boolean' },
        { name: 'empty', path: ['empty'], type: 'null' },
    ], initialization: { kind: 'genesis' },
};
export const binding = {
    chainId: hex(12), backendId: 'fixture-backend', projectionId: definition.id,
    mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment,
    abiSha256: definition.source.abiSha256, generation: 'generation-1',
};
export const value = (owner, balance) => ({ owner, balance, enabled: true, empty: null });
export const put = (key, owner, balance) => ({ kind: 'put', key, value: value(owner, balance) });
export const request = (number, mutations, selectedBinding = binding) => ({
    binding: selectedBinding,
    previous: { blockNum: number - 1, blockId: hex(number - 1) },
    block: { blockNum: number, blockId: hex(number), previousBlockId: hex(number - 1) }, mutations,
});
export const errorCode = code => error => error?.code === code;

/** Boundary fixture; transaction guarantees additionally require the real-Mongo runner. */
export function databaseFixture() {
    let storage = new Map();
    const native = [];
    const fixture = {
        hello: { setName: 'fixture', isWritablePrimary: true, logicalSessionTimeoutMinutes: 30, maxWireVersion: 25 },
        failPut: false,
        foreignErrors: false,
        beforeFind: null,
        failFindAndModify: null,
        failUpdate: null,
        failTransaction: null,
        retryTransaction: false,
        native,
        get storage() { return storage; },
    };
    const mapFor = (name, session) => {
        if (session?.hasEnded) throw new Error('Session has ended');
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
            fixture.copyObserver?.('update', null);
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
            fixture.copyObserver?.('findOne', null);
            return copy([...mapFor(name, options?.session).values()].find(record => matches(record, filter)) ?? null);
        },
        async updateOne(filter, change, options) {
            native.push({ command: 'update', name, options });
            const fault = fixture.failUpdate; fixture.failUpdate = null;
            if (fault === 'before') throw new Error('injected pre-persistence update rejection');
            if (fault === 'miss') return { acknowledged: true, matchedCount: 0 };
            const matchedCount = update(name, filter, change, options?.session) === null ? 0 : 1;
            if (fault === 'after') throw new Error('injected lost durable update receipt');
            return { acknowledged: true, matchedCount };
        },
        async findOneAndUpdate(filter, change, options) {
            native.push({ command: 'findAndModify', name, filter: copy(filter), change: copy(change), options });
            const fault = fixture.failFindAndModify; fixture.failFindAndModify = null;
            if (fault === 'before') throw new Error('injected pre-persistence CAS rejection');
            if (fault === 'miss') return null;
            const result = copy(update(name, filter, change, options?.session));
            if (fault === 'after') throw new Error('injected lost durable CAS receipt');
            return result;
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
        async deleteMany(filter, options) {
            native.push({ command: 'deleteMany', name, options });
            assert.ok(options.session);
            const records = mapFor(name, options.session);
            let deletedCount = 0;
            for (const [key, record] of records) if (matches(record, filter)) {
                records.delete(key); deletedCount++;
            }
            return { acknowledged: true, deletedCount };
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
            assert.ok(options.session || options.limit === 1, 'Only bounded empty-genesis probes may run outside a transaction');
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
                hasEnded: false,
                async withTransaction(operation, options) {
                    if (session.hasEnded) throw new Error('Session has ended');
                    native.push({ command: 'transaction', options });
                    const start = native.length;
                    fixture.copyObserver?.('transaction', storage);
                    session.storage = copy(storage);
                    let result = await operation(session);
                    if (session.hasEnded) throw new Error('Session has ended');
                    if (fixture.retryTransaction) {fixture.retryTransaction = false; fixture.copyObserver?.('transaction', storage); session.storage = copy(storage); result = await operation(session);}
                    if (session.hasEnded) throw new Error('Session has ended');
                    const fault = fixture.failTransaction; fixture.failTransaction = null;
                    if (fault === 'before') throw new Error('injected unknown before commit');
                    if (native.slice(start).some(n => n.options?.session === session && ['insert','update','replace','delete','deleteMany','findAndModify'].includes(n.command))) storage = session.storage;
                    if (fault === 'after') throw new Error('injected lost commit acknowledgment');
                    return result;
                },
                async endSession() {
                    native.push({ command: 'endSession' });
                    session.hasEnded = true;
                    // Audit records retain session identity, never obsolete transaction database copies.
                    session.storage = null;
                },
            };
            return session;
        },
    };
    fixture.adapter = options => createMongoDbProjectionAdapter({
        client: fixture.client, databaseName: 'portable_fixture', backendId: binding.backendId, ...options,
    });
    fixture.rollbackAdapter = options => createMongoDbRollbackAdapter({
        client: fixture.client, databaseName: 'portable_fixture', backendId: binding.backendId, ...options,
    });
    return fixture;
}
