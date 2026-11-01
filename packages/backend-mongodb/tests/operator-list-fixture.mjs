// Controlled storage/session/transport only. The real pinned driver prepares/executes each read.
// No socket, process, service, MongoDB instance or physical acceptance is provided by this fixture.
import assert from 'node:assert/strict';
import {Long, Timestamp, MongoServerError} from 'mongodb';
import {createMongoDbOperatorListSourceV1} from '../dist/operator-lists.js';
export const readLimits = () => ({names: 8, items: 32, bytes: 4096, attempts: 32});
export const context = (changes = {}) => ({signal: new AbortController().signal, deadlineMS: performance.now() + 15000, guard() {}, ...changes});
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
const error = message => new MongoServerError({ok: 0, code: 2, errmsg: message});

export function fixture() {
    const f = {storage: new Map(), cursors: new Map(), indexes: new Map(), commands: [], sessions: [], before: undefined, after: undefined,
        endFailure: undefined, cleanupFailure: undefined, emptyFirst: false, cursor: 1, version: 0};
    const rows = (store, database, collection) => {
        const key = database + '.' + collection;
        if (!store.has(key)) store.set(key, new Map()); return store.get(key);
    };
    f.rows = (collection, database = 'lists_fixture') => rows(f.storage, database, collection);
    const native = async (database, command, options = {}, transport = 'public') => {
        const type = ['find', 'getMore', 'aggregate', 'killCursors', 'createIndexes', 'insert', 'update'].find(name => command[name] !== undefined);
        const entry = {database, command, options, type, transport}; f.commands.push(entry);
        if (f.before) await f.before(entry);
        const session = options.session, store = session?.storage ?? f.storage;
        const dirty = () => {if (session) session.dirty = true; else f.version++;};
        let answer;
        if (type === 'killCursors') {
            if (f.cleanupFailure) throw f.cleanupFailure;
            for (const id of command.cursors) f.cursors.delete(id.toString());
            answer = {ok: 1, cursorsKilled: command.cursors, cursorsNotFound: [], cursorsAlive: [], cursorsUnknown: []};
        } else if (type === 'createIndexes') {
            for (const index of command.indexes) f.indexes.set(database + '.' + command.createIndexes + '.' + index.name, structuredClone(index));
            rows(store, database, command.createIndexes); dirty(); answer = {ok: 1};
        } else if (type === 'insert') {
            const target = rows(store, database, command.insert);
            for (const document of command.documents) {
                if (target.has(document._id)) throw error('duplicate key');
                target.set(document._id, structuredClone(document));
            }
            dirty(); answer = {ok: 1, n: command.documents.length};
        } else if (type === 'update') {
            let n = 0; const target = rows(store, database, command.update);
            for (const update of command.updates) for (const [key, value] of target) if (matches(value, update.q)) {
                target.set(key, update.u.$set ? {...value, ...structuredClone(update.u.$set)} : structuredClone(update.u)); n++; break;
            }
            dirty(); answer = {ok: 1, n};
        } else {
            assert.ok(session && f.sessions.includes(session) && !session.hasEnded && session.storage && !session.inTransaction(), 'Counted read requires this client/session snapshot');
            assert.equal(transport, 'executor'); assert.ok(options.signal instanceof AbortSignal);
            assert.equal(options.timeoutContext.csotEnabled(), true);
            options.signal.throwIfAborted();
            let state;
            if (type === 'getMore') {
                assert.equal(command.maxTimeMS, undefined, 'Do not add server maxTimeMS to a non-tailable getMore');
                state = f.cursors.get(command.getMore.toString()); assert.ok(state, 'Known cursor required');
            } else {
                const collection = command.find ?? command.aggregate;
                if (command.hint !== '_id_' && !f.indexes.has(database + '.' + collection + '.' + command.hint)) throw error('missing admitted index');
                let selected = [...rows(store, database, collection).values()].filter(row => matches(row, command.filter ?? command.pipeline[0].$match));
                if (type === 'aggregate') selected = selected.length ? [{count: selected.length}] : [];
                if (command.sort) selected.sort((a, b) => a.ordinal - b.ordinal);
                state = {database, collection, session, rows: selected, offset: 0, id: Long.fromNumber(f.cursor++)};
                f.cursors.set(state.id.toString(), state);
            }
            const count = command.batchSize ?? command.cursor?.batchSize;
            const empty = f.emptyFirst && type !== 'getMore'; if (empty) f.emptyFirst = false;
            const batch = empty ? [] : state.rows.slice(state.offset, state.offset + count); state.offset += batch.length;
            const exhausted = state.offset === state.rows.length;
            if (exhausted) f.cursors.delete(state.id.toString());
            answer = {ok: 1, cursor: {id: exhausted ? Long.ZERO : state.id, ns: database + '.' + state.collection,
                [type === 'getMore' ? 'nextBatch' : 'firstBatch']: structuredClone(batch)}};
        }
        if (f.after) await f.after(entry, answer); return answer;
    };
    const client = f.client = {options: {retryReads: false, retryWrites: false, maxAdaptiveRetries: 0},
        s: {options: {serverSelectionTimeoutMS: 1000, waitQueueTimeoutMS: 1000}},
        db(database) {return {command: (command, options) => native(database, command, options)};},
        startSession(options) {
            assert.deepEqual(options, {snapshot: true, causalConsistency: false});
            const session = {client, hasEnded: false, snapshotEnabled: true, snapshotTime: Timestamp.fromNumber(f.version + 1),
                storage: structuredClone(f.storage), transaction: {options: {}}, inTransaction() {return false;},
                withTransaction() {assert.fail('Snapshot provider must not enter a transaction/retry loop');},
                commitTransaction() {assert.fail('Snapshot provider must not issue transaction commits');},
                abortTransaction() {assert.fail('Snapshot provider must not issue transaction aborts');},
                async endSession() {
                    session.hasEnded = true;
                    if (f.endFailure) throw f.endFailure;
                }};
            f.sessions.push(session); return session;
        }};
    const server = {async command(operation, timeout) {
        const answer = await native(operation.ns.db, operation.buildCommand(), operation.buildOptions(timeout), 'executor');
        return {toObject: () => answer};
    }};
    client.topology = {lastHello: () => ({maxWireVersion: 25}), description: {type: 'ReplicaSetWithPrimary'}, s: {options: client.options}, selectServer: async () => server};
    f.data = () => f.commands.filter(row => row.command.comment?.hyperion === 'operator-list-read-v1');
    return f;
}
export function options(f, changes = {}) {
    return {client: f.client, databaseName: 'lists_fixture', collectionPrefix: 'bounded',
        binding: {chainId: 'a'.repeat(64), backendId: 'mongo-one', source: 'operator-schema-lists', generation: 'config-one'},
        limits: readLimits(), publicationLimits: {names: 256, items: 10000, bytes: 1024 * 1024, attempts: 4096},
        cache: {names: 256, items: 10000, bytes: 1024 * 1024}, pageSize: 2, batchDocuments: 3,
        operationTimeoutMS: 1000, snapshotTimeoutMS: 10000, ...changes};
}
export async function setup(entries = [{name: 'schemas', items: ['one', 'two', 'two', 'é', '😀']}], changes = {}, f = fixture()) {
    const source = createMongoDbOperatorListSourceV1(options(f, changes));
    const publication = await source.publish({revision: 'data-one', expectedRevision: null, entries}, context());
    f.commands = []; return {f, source, publication};
}
export const read = async (source, names, selected = readLimits(), ctx = context()) => source.createProvider(ctx).read(names, selected);
