import {Long, WriteConcern, type Document} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {StatefulContractError, type StatefulGuard, type StatefulKey, type StatefulRead,
    type StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {assertStatefulOwnerViewV2, captureStatefulOwnerViewV2, receiveStatefulOwnerDeclarationV2,
    STATEFUL_COMPLETE_KIND_FAMILY_V1, type StatefulCompleteKindAdapterV1,
    type StatefulCompleteKindLimitsV1, type StatefulCompleteKindRowV1, type StatefulCompletedReadV2,
    type StatefulOwnerAdapterV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {createMongoDbStatefulOwnerAdapterV2, type MongoDbStatefulOwnerAdapterOptionsV2} from './stateful-owner-v2.js';
import {decodeRow, fields, keyId, logicalKey, requireState} from './stateful-contract.js';

const indexName = 'h45_complete_kind_v1';
const methods = ['recovery', 'admitRaw', 'markRawFailure', 'markSourceFailure', 'bindSource', 'reductionRead',
    'reductionView', 'readReduction', 'inspectOwned', 'applyOwned', 'retireRaw', 'rollbackOwned', 'retainedCheckpoints',
    'completedView', 'readCompleted', 'closeRead'] as const;

/** Separate opt-in. The old owner factory/client/capability records and storage bytes remain unchanged. */
export async function createMongoDbStatefulCompleteKindAdapterV1(options: MongoDbStatefulOwnerAdapterOptionsV2,
    requested: StatefulCompleteKindLimitsV1): Promise<StatefulCompleteKindAdapterV1> {
    fields(options, ['client', 'databaseName', 'backendId', 'collectionPrefix', 'declaration', 'receiptRetention', 'rollbackRetentionBlocks',
        'rollbackRetentionBytes', 'rollbackMaxBlockBytes', 'operationTimeoutMS', 'transactionTimeoutMS']);
    const suppliedOptions = {...options};
    fields(requested, ['readAttempts', 'responseRecords', 'responseBytes']);
    const limits = Object.freeze({...requested});
    options = Object.freeze({...suppliedOptions, declaration: await receiveStatefulOwnerDeclarationV2(suppliedOptions.declaration)});
    const maximum = options.declaration.projection.limits;
    requireState(Number.isSafeInteger(limits.readAttempts) && limits.readAttempts > 0
        && Number.isSafeInteger(limits.responseRecords) && limits.responseRecords >= 0
        && Number.isSafeInteger(limits.responseBytes) && limits.responseBytes >= 2, 'Explicit complete-kind totals required');
    for (const name of ['readAttempts', 'responseRecords', 'responseBytes'] as const)
        requireState(limits[name] <= maximum[name], 'Complete-kind total exceeds the projection', 'stateful.capability-unavailable');
    const retryOptions = () => requireState(options.client.options.retryReads === false && options.client.options.retryWrites === false
        && options.client.options.maxAdaptiveRetries === 0, 'Complete-kind requires the managed nonretrying MongoDB client', 'stateful.capability-unavailable');
    retryOptions();
    const base = await createMongoDbStatefulOwnerAdapterV2(options), db = options.client.db(options.databaseName, {readPreference: 'primary'});
    const rows = db.collection(options.collectionPrefix + '_stateful_v2_r_' + options.declaration.digest,
        {writeConcern: new WriteConcern('majority', undefined, true)});
    const delegated = Object.fromEntries(methods.map(name => [name, base[name].bind(base)])) as Pick<StatefulOwnerAdapterV2, typeof methods[number]>;
    const active = new WeakMap<object, StatefulGuard>();
    const guarded = async <T>(guard: StatefulGuard, work: () => Promise<T>): Promise<T> => {
        guard(); try {return await work();} finally {guard();}
    };
    const admittedIndex = async (guard: StatefulGuard) => {
        retryOptions();
        const indexes = await guarded(guard, () => rows.listIndexes({timeoutMS: options.operationTimeoutMS}).toArray());
        const index = indexes.find(value => value.name === indexName);
        requireState(index && JSON.stringify(index.key) === JSON.stringify({kind: 1}) && !index.unique && !index.sparse
            && !index.hidden && index.partialFilterExpression === undefined && index.expireAfterSeconds === undefined
            && (!index.collation || index.collation.locale === 'simple'), 'Complete declared-kind index is not admitted', 'stateful.capability-unavailable');
        const collection = await guarded(guard, () => rows.options({timeoutMS: options.operationTimeoutMS}));
        requireState(!collection.collation || collection.collation.locale === 'simple', 'Complete-kind collection collation differs', 'stateful.capability-unavailable');
    };
    const context = (read: StatefulCompletedReadV2): StatefulGuard => {
        const guard = read && active.get(read); requireState(guard, 'Foreign or closed complete-kind read', 'stateful.unavailable'); guard(); return guard;
    };
    const remaining = (input: StatefulCompleteKindLimitsV1) => {
        fields(input, ['readAttempts', 'responseRecords', 'responseBytes']);
        const value = Object.freeze({...input});
        requireState(Number.isSafeInteger(value.readAttempts) && value.readAttempts > 0
            && Number.isSafeInteger(value.responseRecords) && value.responseRecords >= 0
            && Number.isSafeInteger(value.responseBytes) && value.responseBytes >= 2, 'Invalid remaining complete-kind totals');
        for (const name of ['readAttempts', 'responseRecords', 'responseBytes'] as const)
            requireState(value[name] <= limits[name], 'Expanded complete-kind allowance', 'stateful.unavailable');
        return value;
    };
    const readData = async (read: StatefulCompletedReadV2, expected: StatefulView, kind: string,
        available: StatefulCompleteKindLimitsV1, key?: StatefulKey) => {
        const guard = context(read), d = options.declaration;
        expected = captureStatefulOwnerViewV2(d, expected);
        requireState(d.projection.definition.records.some(record => record.kind === kind), 'Undeclared complete-kind record');
        retryOptions(); assertStatefulOwnerViewV2(d, await guarded(guard, () => base.completedView(read)), expected);
        let attempts = 0;
        // A trace label only; this supplies no read/owner authority and never reaches plugin results.
        const comment = {hyperion: 'stateful-complete-kind-v1', declaration: d.digest, operation: key ? 'key' : 'kind', trace: randomUUID()};
        const session = options.client.startSession({causalConsistency: false});
        try {
            const result = await guarded(guard, () => session.withTransaction(async () => {
                assertStatefulOwnerViewV2(d, await guarded(guard, () => base.completedView(read)), expected);
                let cursorId: Long = Long.ZERO;
                const command = async (value: Document): Promise<Document> => {
                    guard(); retryOptions();
                    requireState(attempts < available.readAttempts, 'Complete-kind data attempt total exceeded', 'stateful.unavailable'); attempts++;
                    const answer = await db.command({...value, comment}, {session, promoteLongs: false, signal: AbortSignal.timeout(options.operationTimeoutMS)});
                    // Cleanup bookkeeping must survive a cancellation detected immediately after this await.
                    if (answer.cursor && Long.isLong(answer.cursor.id)) cursorId = answer.cursor.id;
                    guard(); return answer;
                };
                const captured: StatefulCompleteKindRowV1[] = [], seen = new Set<string>();
                try {
                    let answer = await command({find: rows.collectionName, filter: key ? {_id: keyId(key)} : {kind},
                        hint: key ? '_id_' : indexName, batchSize: 1, maxTimeMS: options.operationTimeoutMS,
                        ...(key ? {singleBatch: true, limit: 1} : {})});
                    let batchName = 'firstBatch';
                    for (;;) {
                        const cursor = answer.cursor;
                        requireState(cursor && Long.isLong(cursor.id)
                            && cursor.ns === options.databaseName + '.' + rows.collectionName && Array.isArray(cursor[batchName])
                            && cursor[batchName].length <= 1, 'Malformed native complete-kind cursor', 'stateful.unavailable');
                        for (const raw of cursor[batchName]) {
                            fields(raw, ['_id', 'kind', 'key', 'json']);
                            const selected = logicalKey(d.projection, {kind: raw.kind, key: raw.key});
                            requireState(selected.kind === kind && (!key || selected.key === key.key) && !seen.has(selected.key),
                                'Foreign or duplicate complete-kind row', 'stateful.unavailable');
                            seen.add(selected.key);
                            requireState(captured.length < available.responseRecords, 'Complete-kind native row overflow', 'stateful.unavailable');
                            captured.push(Object.freeze({key: selected.key, value: decodeRow(d.projection, selected, raw)}));
                            const partial = key ? {view: expected, result: {status: 'present', value: captured[0].value}, attempts}
                                : {view: expected, kind, complete: true, rows: captured, attempts};
                            requireState(Buffer.byteLength(JSON.stringify(partial)) <= available.responseBytes,
                                'Complete-kind successful response byte total exceeded', 'stateful.unavailable');
                        }
                        if (cursor.id.isZero()) break;
                        requireState(!key, 'Keyed native cursor did not terminate', 'stateful.unavailable');
                        const previous = cursor.id;
                        answer = await command({getMore: previous, collection: rows.collectionName, batchSize: 1}); batchName = 'nextBatch';
                        requireState(Long.isLong(answer.cursor?.id) && (answer.cursor.id.isZero() || answer.cursor.id.equals(previous)),
                            'Native complete-kind cursor identity changed', 'stateful.unavailable');
                    }
                    assertStatefulOwnerViewV2(d, await guarded(guard, () => base.completedView(read)), expected);
                    const result: StatefulRead = captured.length ? {status: 'present', value: captured[0].value} : {status: 'covered-absent'};
                    const value = key ? {view: expected, result, attempts} : {view: expected, kind, complete: true as const, rows: Object.freeze(captured), attempts};
                    requireState(Buffer.byteLength(JSON.stringify(value)) <= available.responseBytes,
                        'Complete-kind successful response byte total exceeded', 'stateful.unavailable');
                    return value;
                } finally {
                    if (!cursorId.isZero()) await db.command({killCursors: rows.collectionName, cursors: [cursorId]},
                        {session, signal: AbortSignal.timeout(options.operationTimeoutMS)});
                }
            }, {readConcern: {level: 'snapshot'}, writeConcern: new WriteConcern('majority', undefined, true),
                readPreference: 'primary', timeoutMS: options.transactionTimeoutMS, maxCommitTimeMS: options.operationTimeoutMS}));
            requireState(result !== undefined, 'Native complete-kind transaction returned no result', 'stateful.unavailable');
            assertStatefulOwnerViewV2(d, await guarded(guard, () => base.completedView(read)), expected); return result;
        } catch (error) {
            if (error instanceof StatefulContractError) throw error;
            const failure = new StatefulContractError('stateful.unavailable', 'MongoDB complete-kind read is unavailable'); failure.cause = error; throw failure;
        } finally {await session.endSession();}
    };
    return Object.freeze({...delegated, capabilities: base.capabilities,
        completeKindCapabilities: Object.freeze({family: STATEFUL_COMPLETE_KIND_FAMILY_V1, interfaceVersion: 1 as const, limits}),
        async acquireOwner(request, guard) {
            retryOptions(); const lease = await base.acquireOwner(request, guard);
            await guarded(guard, () => base.retainedCheckpoints(lease));
            await guarded(guard, () => rows.createIndex({kind: 1}, {name: indexName, collation: {locale: 'simple'},
                maxTimeMS: options.operationTimeoutMS, timeoutMS: options.operationTimeoutMS}));
            await admittedIndex(guard); await guarded(guard, () => base.retainedCheckpoints(lease)); return lease;
        },
        async completedRead(owner, view, authority) {
            let read: StatefulCompletedReadV2 | undefined;
            try {
                authority(); read = await base.completedRead(owner, view, authority); authority();
                await admittedIndex(authority); await guarded(authority, () => base.completedView(read!));
                const selected = read; active.set(selected, () => {authority(); requireState(active.has(selected), 'Complete-kind read is closed', 'stateful.unavailable');});
                return read;
            } catch (error) {if (read) base.closeRead(read); throw error;}
        },
        async readCompletedKey(read, view, input, supplied) {
            requireState(options.declaration.projection.limits.readKeys >= 1, 'Complete-kind keyed read bound');
            const key = logicalKey(options.declaration.projection, input), available = remaining(supplied);
            requireState(available.responseRecords >= 1, 'Complete-kind keyed record total exceeded', 'stateful.unavailable');
            return await readData(read, view, key.kind, available, key) as Awaited<ReturnType<StatefulCompleteKindAdapterV1['readCompletedKey']>>;
        },
        async readCompletedKind(read, view, kind, supplied) {
            return await readData(read, view, kind, remaining(supplied)) as Awaited<ReturnType<StatefulCompleteKindAdapterV1['readCompletedKind']>>;
        },
        closeRead(read) {active.delete(read); base.closeRead(read);}
    } satisfies StatefulCompleteKindAdapterV1);
}
