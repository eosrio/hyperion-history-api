import {BSON, Long, type ClientSession, type Document, type MongoClient} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {OPERATOR_LIST_FAMILY_V1, type OperatorListCapabilitiesV1, type OperatorListEntryV1,
    type OperatorListLimitsV1, type OperatorListProviderV1} from '@eosrio/hyperion-sdk/operator-lists';
import {executeCompleteKindCommand} from './stateful-complete-kind-command.js';
import {addText, array, BSON_MAX, CACHE_MS, captureLists, digest, fits, FORMAT, identity, integer,
    limits, listHash, record, requireList, secondary, sha, text, unavailable, type CapturedList} from './operator-list-contract.js';

export interface MongoDbOperatorListBindingV1 {
    readonly chainId: string; readonly backendId: string; readonly source: string; readonly generation: string;
}
export interface MongoDbOperatorListContextV1 {
    readonly signal: AbortSignal;
    /** Absolute deadline on the process's performance.now() clock. It is never renewed. */
    readonly deadlineMS: number;
    readonly guard: () => void;
}
export interface MongoDbOperatorListOptionsV1 {
    readonly client: MongoClient; readonly databaseName: string; readonly collectionPrefix: string;
    readonly binding: MongoDbOperatorListBindingV1; readonly limits: OperatorListLimitsV1;
    readonly cache: {readonly names: number; readonly items: number; readonly bytes: number};
    /** Separate explicit import/verification totals; these never enlarge a portable read. */
    readonly publicationLimits: OperatorListLimitsV1;
    readonly pageSize: number; readonly batchDocuments: number;
    readonly operationTimeoutMS: number; readonly snapshotTimeoutMS: number;
}
export interface MongoDbOperatorListReaderV1 extends OperatorListProviderV1 {
    /** The host must retain this guard through serialization/cache publication/final onSend. */
    assertCurrent(): void;
    close(): void;
}
export interface MongoDbOperatorListPublicationV1 {
    readonly revision: string; readonly expectedRevision: string | null; readonly entries: readonly OperatorListEntryV1[];
}
export interface MongoDbOperatorListPublicationReceiptV1 {
    readonly revision: string; readonly digest: string; readonly names: number; readonly items: number; readonly bytes: number; readonly attempts: number;
}
export interface MongoDbOperatorListSourceV1 {
    readonly binding: MongoDbOperatorListBindingV1; readonly capabilities: OperatorListCapabilitiesV1;
    createProvider(context: MongoDbOperatorListContextV1): MongoDbOperatorListReaderV1;
    publish(publication: MongoDbOperatorListPublicationV1, context: MongoDbOperatorListContextV1): Promise<MongoDbOperatorListPublicationReceiptV1>;
    /** Config replacement retires every old reader; ordinary data publication does not. */
    retire(): void;
}
interface Meta {revision: string; names: number; items: number; bytes: number; digest: string}
interface Budget {attempts: number; items: number; bytes: number; maximum: OperatorListLimitsV1}
interface Context {guard(): void; remaining(): number; cleanupRemaining(): number; signal: AbortSignal; trace: string}
interface Cached {entry: OperatorListEntryV1; bytes: number; expires: number}
const headerIndex = 'h45_operator_list_headers_v1', itemIndex = 'h45_operator_list_items_v1';
const writeConcern = Object.freeze({w: 'majority', j: true});

/** Native adapter only. An operator publication is list authority, never chain/projection readiness. */
export function createMongoDbOperatorListSourceV1(input: MongoDbOperatorListOptionsV1): MongoDbOperatorListSourceV1 {
    const v = record(input, ['client', 'databaseName', 'collectionPrefix', 'binding', 'limits', 'cache', 'publicationLimits',
        'pageSize', 'batchDocuments', 'operationTimeoutMS', 'snapshotTimeoutMS']);
    const client = v.client as MongoClient, database = text(v.databaseName), prefix = text(v.collectionPrefix);
    requireList(/^[A-Za-z0-9_-]{1,48}$/.test(database) && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(prefix), 'Invalid operator-list storage names');
    const b = record(v.binding, ['chainId', 'backendId', 'source', 'generation']);
    const binding = Object.freeze({chainId: digest(b.chainId), backendId: identity(b.backendId), source: identity(b.source), generation: identity(b.generation)});
    const maximum = limits(v.limits), publishMaximum = limits(v.publicationLimits), c = record(v.cache, ['names', 'items', 'bytes']);
    const cacheMaximum = {names: integer(c.names, 1), items: integer(c.items), bytes: integer(c.bytes, 1)};
    const pageSize = integer(v.pageSize, 1, 1000), batchDocuments = integer(v.batchDocuments, 1, 1000);
    const operationMS = integer(v.operationTimeoutMS, 1, 30000), snapshotMS = integer(v.snapshotTimeoutMS, 1, 60000);
    // A requested name must fit its native filter and a single item must fit one BSON document.
    // Datasets/imports have independent aggregate totals and can exceed the BSON document limit.
    requireList(maximum.bytes <= BSON_MAX / 2, 'Portable operator-list byte capability exceeds the native document bound');
    const capabilities = Object.freeze({family: OPERATOR_LIST_FAMILY_V1, interfaceVersion: 1 as const, limits: maximum});
    const slot = sha(binding), control = prefix + '_ol_v1_source', revisions = prefix + '_ol_v1_revision';
    const headers = prefix + '_ol_v1_header', rows = prefix + '_ol_v1_item';
    const revisionId = (revision: string) => sha([slot, revision]), headerId = (revision: string, name: string) => sha([slot, revision, name]);
    const itemId = (header: string, ordinal: number) => sha([header, ordinal]);
    let active = true; const cache = new Map<string, Cached>();
    const retryOptions = () => requireList(client?.options?.retryReads === false && client.options.retryWrites === false
        && client.options.maxAdaptiveRetries === 0, 'Operator lists require a nonretrying MongoDB client');
    retryOptions();
    const context = (raw: MongoDbOperatorListContextV1, extra: () => void = () => {}) => {
        const v = record(raw, ['signal', 'deadlineMS', 'guard']);
        requireList(v.signal instanceof AbortSignal && typeof v.guard === 'function'
            && typeof v.deadlineMS === 'number' && Number.isFinite(v.deadlineMS), 'Explicit operator-list request lifetime required');
        const signal = v.signal, deadline = v.deadlineMS, authority = v.guard as () => void;
        const guard = () => {
            requireList(active, 'Operator-list source configuration is retired'); extra(); authority();
            // The host callback is an external boundary: it may synchronously retire
            // the source or close this provider even when it returns normally.
            requireList(active, 'Operator-list source configuration is retired'); extra();
            requireList(!signal.aborted && performance.now() < deadline, 'Operator-list request is cancelled or expired'); retryOptions();
        };
        const cleanupRemaining = () => {requireList(performance.now() < deadline, 'Operator-list cleanup deadline expired'); return Math.max(1, Math.ceil(deadline - performance.now()));};
        const result: Context = {signal, guard, remaining() {guard(); return cleanupRemaining();}, cleanupRemaining, trace: randomUUID()};
        guard(); return result;
    };
    const duration = (ctx: Context) => Math.min(operationMS, ctx.remaining());
    const charge = (budget: Budget) => {
        requireList(budget.attempts < budget.maximum.attempts, 'Operator-list native attempt total exceeded'); budget.attempts++;
    };
    const snapshot = async <T>(outer: Context, work: (session: ClientSession, context: Context) => Promise<T>): Promise<T> => {
        outer.guard(); const deadline = performance.now() + Math.min(snapshotMS, outer.remaining());
        const remaining = () => {requireList(performance.now() < deadline, 'Operator-list snapshot deadline expired'); return Math.min(outer.cleanupRemaining(), Math.max(1, Math.ceil(deadline - performance.now())));};
        const ctx: Context = {signal: outer.signal, trace: randomUUID(), guard() {outer.guard(); remaining();},
            remaining() {outer.guard(); return remaining();}, cleanupRemaining: remaining};
        const session = client.startSession({snapshot: true, causalConsistency: false}); let failure: ReturnType<typeof unavailable> | undefined;
        try {
            // Snapshot sessions fix atClusterTime without starting transactions. endSession
            // therefore has no implicit abort, and no commit/callback retry machinery is used.
            requireList(session.snapshotEnabled === true && !session.inTransaction(), 'Native snapshot session is unavailable');
            const result = await work(session, ctx); ctx.guard(); return result;
        } catch (error) {
            failure = unavailable(error); throw failure;
        } finally {
            try {await session.endSession();} catch (error) {if (failure) secondary(failure, error); else throw unavailable(error);}
        }
    };
    const scan = async (collection: string, initial: Document, session: ClientSession, ctx: Context, budget: Budget,
        consume: (row: unknown) => void, maximumRows: number): Promise<void> => {
        let cursorId = Long.ZERO, failure: ReturnType<typeof unavailable> | undefined, count = 0, uncertainCursor = false;
        const ownedCursors = new Map<string, Long>();
        const comment = {hyperion: 'operator-list-read-v1', source: slot, trace: ctx.trace};
        const command = async (value: Document) => {
            ctx.guard();
            // Reserve one physical dispatch for an active cursor's bounded killCursors.
            // A successful exhaustion does not spend that reservation or invent an attempt.
            requireList(budget.attempts + 1 < budget.maximum.attempts, 'Operator-list native cleanup attempt reserve exhausted'); charge(budget);
            uncertainCursor = true;
            const answer = await executeCompleteKindCommand(client, database, {...value, comment}, {session, promoteLongs: false,
                timeoutMS: duration(ctx), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(duration(ctx))])});
            // Preserve the real cursor for cleanup even when cancellation wins after the await.
            if (answer.cursor && Long.isLong(answer.cursor.id) && answer.cursor.ns === database + '.' + collection) {
                cursorId = answer.cursor.id; if (!cursorId.isZero()) ownedCursors.set(cursorId.toString(), cursorId);
                uncertainCursor = false;
            }
            const stamp = (session as ClientSession & {snapshotTime?: unknown}).snapshotTime;
            // Managed clients may come from another installed copy of the pinned driver/BSON.
            // Constructor identity is not BSON identity (the existing Long seam is cross-copy too).
            ctx.guard(); requireList(answer.ok === 1 && Long.isLong(stamp)
                && (stamp as unknown as {_bsontype?: unknown})._bsontype === 'Timestamp',
                'Operator-list native snapshot command did not establish atClusterTime'); return answer;
        };
        try {
            let answer = await command({...initial, collation: {locale: 'simple'}, maxTimeMS: duration(ctx)}), batchName = 'firstBatch';
            for (;;) {
                const cursor = answer.cursor;
                requireList(cursor && Long.isLong(cursor.id) && cursor.ns === database + '.' + collection,
                    'Malformed operator-list native cursor');
                const batch = array(cursor[batchName], pageSize);
                for (const row of batch) {ctx.guard(); requireList(count++ < maximumRows, 'Operator-list native row total exceeded'); consume(row);}
                if (cursor.id.isZero()) break;
                const previous = cursor.id;
                // A non-tailable getMore must not receive maxTimeMS; pinned executor retains CSOT + signal.
                answer = await command({getMore: previous, collection, batchSize: pageSize}); batchName = 'nextBatch';
                requireList(Long.isLong(answer.cursor?.id) && (answer.cursor.id.isZero() || answer.cursor.id.equals(previous)),
                    'Operator-list native cursor identity changed');
            }
        } catch (error) {failure = unavailable(error); throw failure;}
        finally {
            if (!cursorId.isZero() || failure && ownedCursors.size) {
                try {
                    // Only cleanup of this session/namespace survives cancellation/retirement;
                    // it retains the original absolute deadline and remaining attempt budget.
                    const timeout = Math.min(operationMS, ctx.cleanupRemaining()); charge(budget);
                    const cleaned = await executeCompleteKindCommand(client, database, {killCursors: collection, cursors: [...ownedCursors.values()], comment},
                        {session, promoteLongs: false, timeoutMS: timeout, signal: AbortSignal.timeout(timeout)});
                    requireList(cleaned.ok === 1, 'Operator-list cursor cleanup did not succeed');
                    const terminal = new Set<string>();
                    for (const name of ['cursorsKilled', 'cursorsNotFound', 'cursorsAlive', 'cursorsUnknown']) {
                        const ids = array(cleaned[name], ownedCursors.size);
                        requireList(name === 'cursorsKilled' || name === 'cursorsNotFound' || ids.length === 0, 'Operator-list cursor cleanup is incomplete');
                        for (const id of ids) {
                            requireList(Long.isLong(id) && ownedCursors.has(id.toString()) && !terminal.has(id.toString()), 'Foreign or duplicate cursor cleanup result');
                            terminal.add(id.toString());
                        }
                    }
                    requireList(terminal.size === ownedCursors.size, 'Operator-list cursor closure was not established');
                } catch (error) {if (failure) secondary(failure, error); else throw unavailable(error);}
            }
            if (failure && uncertainCursor) secondary(failure, unavailable(new Error('Native response did not establish complete cursor ownership/closure')));
        }
    };
    const one = async (collection: string, id: string, session: ClientSession, ctx: Context, budget: Budget) => {
        let result: unknown = null;
        await scan(collection, {find: collection, filter: {_id: id}, hint: '_id_', batchSize: pageSize}, session, ctx, budget,
            row => {result = row;}, 1); return result;
    };
    const total = async (collection: string, revision: string, index: string, session: ClientSession, ctx: Context, budget: Budget) => {
        let count = 0;
        await scan(collection, {aggregate: collection, pipeline: [{$match: {slot, revision}}, {$count: 'count'}], hint: index,
            cursor: {batchSize: pageSize}}, session, ctx, budget, raw => {
            const row = record(raw, ['count']);
            count = Long.isLong(row.count) ? integer(Number(row.count.toBigInt())) : integer(row.count);
        }, 1); return count;
    };
    const meta = (raw: unknown, revision?: string, complete = true): Meta => {
        const v = record(raw, revision === undefined ? ['_id', 'format', 'binding', 'revision', 'names', 'items', 'bytes', 'digest']
            : ['_id', 'format', 'slot', 'revision', 'complete', 'names', 'items', 'bytes', 'digest']);
        requireList(v.format === FORMAT, 'Foreign operator-list storage format');
        const selected = identity(v.revision);
        if (revision === undefined) {
            const bound = record(v.binding, ['chainId', 'backendId', 'source', 'generation']);
            requireList(v._id === slot && Object.entries(binding).every(([name, value]) => bound[name] === value), 'Foreign operator-list source');
        } else requireList(v._id === revisionId(revision) && v.slot === slot && selected === revision && v.complete === complete,
            'Incomplete or foreign operator-list revision');
        const result = {revision: selected, names: integer(v.names), items: integer(v.items), bytes: integer(v.bytes), digest: digest(v.digest)};
        requireList(result.names <= publishMaximum.names && result.items <= publishMaximum.items && result.bytes <= publishMaximum.bytes,
            'Published operator-list totals exceed the configured source'); return result;
    };
    const complete = async (expected: Meta, session: ClientSession, ctx: Context, budget: Budget, published = true) => {
        const actual = meta(await one(revisions, revisionId(expected.revision), session, ctx, budget), expected.revision, published);
        requireList(sha(actual) === sha(expected), 'Operator-list source/revision totals differ');
        requireList(await total(headers, expected.revision, headerIndex, session, ctx, budget) === expected.names
            && await total(rows, expected.revision, itemIndex, session, ctx, budget) === expected.items,
        'Operator-list published storage is incomplete');
    };
    const list = async (name: string, revision: string, session: ClientSession, ctx: Context, budget: Budget): Promise<CapturedList> => {
        const id = headerId(revision, name), raw = await one(headers, id, session, ctx, budget), nameBytes = Buffer.byteLength(name);
        if (raw === null) return Object.freeze({name, items: Object.freeze([]), bytes: nameBytes, digest: listHash(name).digest('hex')});
        const h = record(raw, ['_id', 'slot', 'revision', 'name', 'items', 'bytes', 'digest']);
        requireList(h._id === id && h.slot === slot && h.revision === revision && h.name === name, 'Foreign operator-list header');
        const expectedItems = integer(h.items), expectedBytes = integer(h.bytes, nameBytes), expectedDigest = digest(h.digest);
        requireList(expectedItems <= budget.maximum.items - budget.items && expectedBytes - nameBytes <= budget.maximum.bytes - budget.bytes,
            'Operator-list declared response total exceeded');
        const values: string[] = [], hash = listHash(name); let ownBytes = nameBytes;
        await scan(rows, {find: rows, filter: {slot, revision, list: id}, hint: itemIndex, sort: {ordinal: 1}, batchSize: pageSize},
            session, ctx, budget, raw => {
                const v = record(raw, ['_id', 'slot', 'revision', 'list', 'ordinal', 'value']), ordinal = integer(v.ordinal);
                requireList(v.slot === slot && v.revision === revision && v.list === id && ordinal === values.length && v._id === itemId(id, ordinal),
                    'Foreign, duplicate or out-of-order operator-list item');
                const item = text(v.value), size = Buffer.byteLength(item); budget.items++; budget.bytes += size; ownBytes += size;
                requireList(budget.items <= budget.maximum.items && budget.bytes <= budget.maximum.bytes, 'Operator-list decoded total exceeded');
                addText(hash, item); values.push(item);
            }, expectedItems);
        requireList(values.length === expectedItems && ownBytes === expectedBytes && hash.digest('hex') === expectedDigest,
            'Operator-list items are incomplete or differ from their published header');
        return Object.freeze({name, items: Object.freeze(values), bytes: ownBytes, digest: expectedDigest});
    };
    const write = async (value: Document, ctx: Context, budget: Budget) => {
        ctx.guard(); charge(budget); requireList(BSON.calculateObjectSize(value) < BSON_MAX, 'Operator-list native document/command bound exceeded');
        const timeoutMS = duration(ctx), options = {timeoutMS, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMS)])};
        // Public command is sufficient for writes (no getMore maxTimeMS exception). Actual driver CSOT is retained.
        let answer: Document;
        try {answer = await client.db(database, {readPreference: 'primary'}).command(value, options);}
        catch (error) {throw unavailable(error);}
        ctx.guard(); requireList(answer.ok === 1 && !answer.writeErrors?.length && !answer.writeConcernError,
            'Operator-list native write did not complete'); return answer;
    };
    const expire = (now: number) => {for (const [name, entry] of cache) if (entry.expires <= now) cache.delete(name);};
    return Object.freeze({binding, capabilities,
        createProvider(rawContext) {
            let closed = false, used = false;
            const ctx = context(rawContext, () => requireList(!closed, 'Operator-list request provider is closed'));
            return Object.freeze({capabilities, assertCurrent: ctx.guard, close() {closed = true;},
                async read(rawNames, rawLimits) {
                    requireList(!used, 'Operator-list provider is request-local and one-use'); used = true; ctx.guard();
                    const selected = limits(rawLimits); requireList(fits(selected, maximum), 'Expanded operator-list read allowance');
                    const names = array(rawNames, selected.names).map(text);
                    requireList(new Set(names).size === names.length, 'Operator-list names must be distinct');
                    const budget: Budget = {attempts: 0, items: 0, bytes: names.reduce((n, name) => n + Buffer.byteLength(name), 0), maximum: selected};
                    requireList(budget.bytes <= selected.bytes, 'Operator-list name byte total exceeded');
                    const started = performance.now(); expire(started);
                    const entries = new Map<string, OperatorListEntryV1>(), misses: string[] = [];
                    for (const name of names) {
                        const hit = cache.get(name);
                        if (!hit) {misses.push(name); continue;}
                        budget.items += hit.entry.items.length; budget.bytes += hit.bytes - Buffer.byteLength(name);
                        requireList(budget.items <= selected.items && budget.bytes <= selected.bytes, 'Cached operator-list total exceeded'); entries.set(name, hit.entry);
                    }
                    const additions: CapturedList[] = [];
                    if (misses.length || names.length === 0) await snapshot(ctx, async (session, selectedContext) => {
                        const published = meta(await one(control, slot, session, selectedContext, budget));
                        await complete(published, session, selectedContext, budget);
                        for (const name of misses) {
                            const value = await list(name, published.revision, session, selectedContext, budget); additions.push(value);
                            entries.set(name, Object.freeze({name, items: value.items}));
                        }
                        return true;
                    });
                    ctx.guard(); const now = performance.now(); expire(now);
                    // Complete results only. A concurrent winner keeps its original value and expiry;
                    // this reader still returns its own coherent snapshot, never a hybrid item array.
                    const eligible = additions.filter(value => !cache.has(value.name) && started + CACHE_MS > now);
                    let cachedItems = 0, cachedBytes = 0;
                    for (const value of cache.values()) {cachedItems += value.entry.items.length; cachedBytes += value.bytes;}
                    requireList(cache.size + eligible.length <= cacheMaximum.names
                        && cachedItems + eligible.reduce((n, value) => n + value.items.length, 0) <= cacheMaximum.items
                        && cachedBytes + eligible.reduce((n, value) => n + value.bytes, 0) <= cacheMaximum.bytes,
                    'Operator-list complete cache capacity exceeded');
                    for (const value of eligible) cache.set(value.name, {entry: Object.freeze({name: value.name, items: value.items}), bytes: value.bytes, expires: started + CACHE_MS});
                    ctx.guard();
                    return Object.freeze({source: binding.source, generation: binding.generation, complete: true, attempts: budget.attempts,
                        entries: Object.freeze(names.map(name => entries.get(name)!))});
                }
            } satisfies MongoDbOperatorListReaderV1);
        },
        async publish(rawPublication, rawContext) {
            const ctx = context(rawContext), p = record(rawPublication, ['revision', 'expectedRevision', 'entries']);
            const revision = identity(p.revision), expected = p.expectedRevision === null ? null : identity(p.expectedRevision);
            requireList(revision !== expected, 'A publication must have a new immutable data revision');
            const lists = captureLists(p.entries, publishMaximum);
            const selected: Meta = {revision, names: lists.length, items: lists.reduce((n, value) => n + value.items.length, 0),
                bytes: lists.reduce((n, value) => n + value.bytes, 0), digest: sha(lists.map(value => [value.name, value.items.length, value.bytes, value.digest]))};
            const budget: Budget = {attempts: 0, items: 0, bytes: 0, maximum: publishMaximum};
            const pending = {_id: revisionId(revision), format: FORMAT, slot, ...selected, complete: false};
            const headerRows = lists.map(value => ({_id: headerId(revision, value.name), slot, revision, name: value.name,
                items: value.items.length, bytes: value.bytes, digest: value.digest}));
            // Validate every document before the first effect, including values too large for one BSON record.
            requireList(BSON.calculateObjectSize(pending) < BSON_MAX, 'Operator-list revision document is too large');
            for (const row of headerRows) requireList(BSON.calculateObjectSize(row) < BSON_MAX / 2, 'Operator-list header document is too large');
            for (const value of lists) for (let ordinal = 0; ordinal < value.items.length; ordinal++) {
                const id = headerId(revision, value.name);
                requireList(BSON.calculateObjectSize({_id: itemId(id, ordinal), slot, revision, list: id, ordinal, value: value.items[ordinal]}) < BSON_MAX / 2,
                    'Operator-list item document is too large');
            }
            const insert = async (collection: string, documents: Document[]) => {
                const answer = await write({insert: collection, documents, ordered: true, writeConcern}, ctx, budget);
                requireList(answer.n === documents.length, 'Operator-list insert was incomplete');
            };
            // A snapshot find on a missing namespace returns no atClusterTime on MongoDB8.0.
            // Provision only its canonical index, never a source pointer, before verification.
            await write({createIndexes: control, indexes: [{name: '_id_', key: {_id: 1}}], writeConcern}, ctx, budget);
            await write({createIndexes: headers, indexes: [{name: headerIndex, key: {slot: 1, revision: 1}, collation: {locale: 'simple'}}],
                writeConcern}, ctx, budget);
            await write({createIndexes: rows, indexes: [{name: itemIndex, key: {slot: 1, revision: 1, list: 1, ordinal: 1}, unique: true,
                collation: {locale: 'simple'}}], writeConcern}, ctx, budget);
            await insert(revisions, [pending]);
            let batch: Document[] = [], batchBytes = 0;
            const append = async (collection: string, row: Document) => {
                const size = BSON.calculateObjectSize(row) + 16;
                if (batch.length && (batch.length >= batchDocuments || batchBytes + size > BSON_MAX / 2)) {await insert(collection, batch); batch = []; batchBytes = 0;}
                batch.push(row); batchBytes += size;
            };
            for (const row of headerRows) await append(headers, row);
            if (batch.length) await insert(headers, batch); batch = []; batchBytes = 0;
            for (const value of lists) {
                const id = headerId(revision, value.name);
                for (let ordinal = 0; ordinal < value.items.length; ordinal++)
                    await append(rows, {_id: itemId(id, ordinal), slot, revision, list: id, ordinal, value: value.items[ordinal]});
            }
            if (batch.length) await insert(rows, batch);
            await snapshot(ctx, async (session, selectedContext) => {
                const previous = await one(control, slot, session, selectedContext, budget);
                requireList(expected === null ? previous === null : previous !== null && meta(previous).revision === expected,
                    'Operator-list publication compare-and-swap differs');
                await complete(selected, session, selectedContext, budget, false);
                for (const value of lists) {
                    budget.bytes += Buffer.byteLength(value.name);
                    const actual = await list(value.name, revision, session, selectedContext, budget);
                    requireList(actual.digest === value.digest && actual.bytes === value.bytes && actual.items.length === value.items.length,
                        'Operator-list publication verification differs');
                }
                return true;
            });
            // Insert-only data has been verified at one majority-committed snapshot. A
            // complete but unselected revision is safe; only this small pointer CAS activates it.
            const marked = await write({update: revisions, updates: [{q: {_id: revisionId(revision), complete: false}, u: {$set: {complete: true}}, multi: false}], writeConcern}, ctx, budget);
            requireList(marked.n === 1, 'Operator-list revision completion differs');
            const next = {_id: slot, format: FORMAT, binding, ...selected};
            if (expected === null) {
                const inserted = await write({insert: control, documents: [next], ordered: true, writeConcern}, ctx, budget);
                requireList(inserted.n === 1, 'Operator-list source publication was incomplete');
            } else {
                const replaced = await write({update: control, updates: [{q: {_id: slot, revision: expected}, u: next, multi: false}], writeConcern}, ctx, budget);
                requireList(replaced.n === 1, 'Operator-list publication compare-and-swap lost');
            }
            ctx.guard(); return Object.freeze({...selected, attempts: budget.attempts});
        },
        retire() {active = false; cache.clear();}
    } satisfies MongoDbOperatorListSourceV1);
}
