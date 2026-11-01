import {Long, WriteConcern, type Document} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {StatefulContractError, type StatefulGuard, type StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {assertStatefulOwnerViewV2, captureStatefulOwnerViewV2, negotiateStatefulOwnerV2, receiveStatefulOwnerDeclarationV2,
    STATEFUL_OWNER_FAMILY_V2, STATEFUL_OWNER_HOST_CAPABILITIES_V2, type StatefulCompleteKindAdapterV1,
    type StatefulCompleteKindLimitsV1, type StatefulCompletedReadV2, type StatefulOwnerAdapterV2}
    from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {captureIndexedRequestV1, STATEFUL_INDEXED_QUERY_FAMILY_V1, type IndexedDeclarationV1, type IndexedLimitsV1, type IndexedOfferV1,
    type IndexedOwnerAdapterV1} from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import {createMongoDbStatefulOwnerAdapterV2, type MongoDbStatefulOwnerAdapterOptionsV2} from './stateful-owner-v2.js';
import {createMongoDbStatefulCompleteKindAdapterV1} from './stateful-complete-kind-v1.js';
import {assertStatefulOwnerCompletedSnapshotV2, createStatefulOwnerCompletedSessionV2, registerStatefulOwnerNativeFacadeV1,
    registerStatefulOwnerSidecarsV1, withStatefulOwnerNativeSnapshotV1} from './stateful-owner-v2-internal.js';
import {assertStatefulOwnerNativeBindingV1} from './stateful-owner-v2-internal.js';
import {executeCompleteKindCommand} from './stateful-complete-kind-command.js';
import {fields, requireState, type StatefulRow} from './stateful-contract.js';
import {createMongoIndexedSidecarsV1, indexedCoverageV1, matchingIndexedCoverageV1, type MongoIndexedCoverageV1,
    type MongoIndexedMaterializationV1, type CoverageImageV1} from './stateful-indexed-materialization-v1.js';
import {assertMongoIndexedIndexesV1, mongoIndexedIndexesV1, planMongoIndexedQueryV1, receiveMongoIndexedModelV1,
    MONGO_SIMPLE_INDEXED_COMPARISON_V1, type MongoIndexedRowV1} from './stateful-indexed-model-v1.js';
import {readMongoIndexedCursorV1} from './stateful-indexed-cursor-v1.js';
import {serverErrorCode} from './storage.js';
import {registerIndexedEngineeringFacadeV1} from './stateful-indexed-engineering-internal.js';

export interface MongoDbIndexedRequirementV1 {readonly declaration: IndexedDeclarationV1; readonly limits: IndexedLimitsV1}
/** Native host attachment only. A returned offer facade still requires the original owner-issued read. */
export interface MongoDbStatefulIndexedAdapterV1 extends IndexedOwnerAdapterV1 {
    indexedForModel(expected: StatefulView, digest: string, guard: StatefulGuard): Promise<IndexedOwnerAdapterV1>;
}
const methods = ['recovery','admitRaw','markRawFailure','markSourceFailure','bindSource','reductionRead','reductionView',
    'readReduction','inspectOwned','applyOwned','retireRaw','rollbackOwned','retainedCheckpoints','completedView','readCompleted'] as const;

/** Explicit opt-in, one existing owner and namespace. No legacy storage adoption, rebuilt-on-read data or new owner state. */
export async function createMongoDbStatefulIndexedAdapterV1(input: MongoDbStatefulOwnerAdapterOptionsV2,
    requirements: readonly MongoDbIndexedRequirementV1[], completeKind?: StatefulCompleteKindLimitsV1,
    original?: StatefulOwnerAdapterV2): Promise<MongoDbStatefulIndexedAdapterV1> {
    const options = Object.freeze({...input, declaration: await receiveStatefulOwnerDeclarationV2(input.declaration)});
    requireState(Array.isArray(requirements) && requirements.length > 0 && requirements.length <= 32, 'Explicit indexed model budget required');
    const retryOptions = () => requireState(options.client.options.retryReads === false && options.client.options.retryWrites === false
        && options.client.options.maxAdaptiveRetries === 0, 'Indexed queries require the managed nonretrying MongoDB client', 'stateful.capability-unavailable');
    retryOptions();
    const base = original ?? (completeKind ? await createMongoDbStatefulCompleteKindAdapterV1(options, completeKind) : await createMongoDbStatefulOwnerAdapterV2(options));
    assertStatefulOwnerNativeBindingV1(base,options);
    const owner = await negotiateStatefulOwnerV2(options.declaration.projection, {family: STATEFUL_OWNER_FAMILY_V2, interfaceVersion:2,
        sourceInputVersions:[2], supported:STATEFUL_OWNER_HOST_CAPABILITIES_V2, limits:options.declaration.projection.limits}, base.capabilities);
    requireState(owner.digest === options.declaration.digest, 'Native indexed owner recapture differs');
    const db = options.client.db(options.databaseName, {readPreference:'primary'}), entries: MongoIndexedMaterializationV1[] = [];
    // Operational collection initialization only, never coverage/read authority. Missing initialization
    // leaves persisted coverage behind the canonical checkpoint and therefore refuses indexed reads.
    const materialized: MongoIndexedMaterializationV1[] = [];
    for (const supplied of requirements) {
        fields(supplied, ['declaration','limits']);
        const model = await receiveMongoIndexedModelV1(owner, supplied.declaration as unknown as IndexedDeclarationV1, supplied.limits as unknown as IndexedLimitsV1);
        requireState(!entries.some(entry => entry.model.declaration.model.id === model.declaration.model.id
            || entry.model.declaration.digest === model.declaration.digest), 'Ambiguous indexed model');
        const prefix = options.collectionPrefix + '_ix1_' + model.declaration.digest;
        entries.push(Object.freeze({model, rows:db.collection<MongoIndexedRowV1>(prefix + '_r'),
            coverage:db.collection<MongoIndexedCoverageV1>(prefix + '_c'), images:db.collection<CoverageImageV1>(prefix + '_u')}));
    }
    const empty: IndexedOfferV1 = Object.freeze({family:STATEFUL_INDEXED_QUERY_FAMILY_V1, interfaceVersion:1,
        queryDeclarationDigests:Object.freeze([]), comparisonProfiles:Object.freeze([]), limits:entries[0]!.model.limits});
    const guarded = async <T>(guard: StatefulGuard, work: () => Promise<T>): Promise<T> => {guard(); try {return await work();} finally {guard();}};
    const admission = async (entry: MongoIndexedMaterializationV1, guard: StatefulGuard, engineering=false) => {
        retryOptions();
        requireState(entry.model.declaration.model.textComparison === MONGO_SIMPLE_INDEXED_COMPARISON_V1,
            'This comparison profile has no native qualification', 'stateful.capability-unavailable');
        requireState(engineering,'Comparison offers require the explicitly pinned indexed engineering assembly', 'stateful.capability-unavailable');
        const indexes = await guarded(guard, () => entry.rows.listIndexes({timeoutMS:options.operationTimeoutMS}).toArray());
        assertMongoIndexedIndexesV1(entry.model, indexes);
        const collection = await guarded(guard, () => entry.rows.options({timeoutMS:options.operationTimeoutMS}));
        requireState(!collection.collation || collection.collation.locale === 'simple', 'Indexed collection collation differs', 'stateful.capability-unavailable');
    };
    const active = new WeakMap<object, StatefulGuard>();
    const engineeringReads = new WeakSet<object>();
    const context = (read: StatefulCompletedReadV2) => {const guard = read && active.get(read);
        requireState(guard, 'Foreign or closed indexed completed read', 'stateful.unavailable'); guard(); return guard;};
    const unavailable = (error: unknown) => {if (error instanceof StatefulContractError) return error;
        const failure = new StatefulContractError('stateful.unavailable', 'MongoDB indexed query is unavailable'); failure.cause = error; return failure;};
    const delegated = Object.fromEntries(methods.map(name => [name, base[name].bind(base)])) as Pick<StatefulOwnerAdapterV2, typeof methods[number]>;
    const complete = completeKind ? base as StatefulCompleteKindAdapterV1 : undefined;
    let facade: MongoDbStatefulIndexedAdapterV1;
    const offerForModel = async (expected:StatefulView,digest:string,guard:StatefulGuard,engineering:boolean,
        selected:MongoDbStatefulIndexedAdapterV1) => {
        expected = captureStatefulOwnerViewV2(owner, expected);
        const entry = entries.find(entry => entry.model.declaration.digest === digest); requireState(entry, 'Unknown selected indexed model', 'stateful.capability-unavailable');
        await admission(entry, guard,engineering);
        const recovery = await guarded(guard, () => base.recovery()); requireState(recovery?.initialized, 'Indexed owner is not initialized', 'stateful.unavailable');
        assertStatefulOwnerViewV2(owner, recovery.view, expected);
        const coverage = await guarded(guard, () => entry.coverage.findOne({_id:digest}, {readConcern:{level:'linearizable'}, timeoutMS:options.operationTimeoutMS}));
        requireState(matchingIndexedCoverageV1(entry, expected, coverage) && coverage.ready, 'Indexed materialization is not covered', 'stateful.capability-unavailable');
        const after = await guarded(guard, () => base.recovery()); requireState(after?.initialized, 'Indexed owner is unavailable', 'stateful.unavailable');
        assertStatefulOwnerViewV2(owner, after.view, expected);
        const indexedCapabilities: IndexedOfferV1 = Object.freeze({family:STATEFUL_INDEXED_QUERY_FAMILY_V1, interfaceVersion:1,
            queryDeclarationDigests:Object.freeze([digest]), comparisonProfiles:Object.freeze([entry.model.declaration.model.textComparison]), limits:entry.model.limits});
        return Object.freeze({...selected, indexedCapabilities});
    };
    facade = Object.freeze({...delegated, capabilities:base.capabilities, indexedCapabilities:empty,
        ...(complete ? {completeKindCapabilities:complete.completeKindCapabilities,
            readCompletedKey:complete.readCompletedKey.bind(complete), readCompletedKind:complete.readCompletedKind.bind(complete)} : {}),
        async acquireOwner(request, guard) {
            let rejected=false,rejection:unknown;
            const retained=()=>{if(rejected)throw rejection;try{guard();}catch(error){rejected=true;rejection=error;throw error;}};
            const lease = await base.acquireOwner(request, retained);
            for (const entry of entries) {
                // Index syntax is model-local; an unsupported model never disables the canonical owner.
                let indexes: ReturnType<typeof mongoIndexedIndexesV1>;
                try {indexes = mongoIndexedIndexesV1(entry.model);} catch {continue;}
                try {
                    for (const collection of [entry.rows, entry.coverage, entry.images]) {
                        try {await guarded(retained, () => db.createCollection(collection.collectionName, {collation:{locale:'simple'}, timeoutMS:options.operationTimeoutMS}));}
                        catch (error) {if (!serverErrorCode(error, 48)) throw error;}
                    }
                    for (const index of indexes) await guarded(retained, () => entry.rows.createIndex(index.key, {name:index.name,
                        unique:index.unique, ...(index.partial ? {partialFilterExpression:index.partial} : {}), collation:{locale:'simple'},
                        maxTimeMS:options.operationTimeoutMS, timeoutMS:options.operationTimeoutMS}));
                    assertMongoIndexedIndexesV1(entry.model, await guarded(retained, () => entry.rows.listIndexes({timeoutMS:options.operationTimeoutMS}).toArray()));
                } catch {retained(); continue;}
                // The existing real owner lease fences initialization. Only empty genesis can establish completeness.
                try {await withStatefulOwnerNativeSnapshotV1(base, lease, async scope => {
                    const previous = await scope.call(() => entry.coverage.findOne({_id:entry.model.declaration.digest}, {session:scope.session}));
                    if (matchingIndexedCoverageV1(entry, scope.view, previous)) return;
                    const canonical = db.collection<StatefulRow>(options.collectionPrefix + '_stateful_v2_r_' + owner.digest);
                    const present = scope.view.checkpoint.blockNum === 0 ? await scope.call(() => canonical.findOne({},
                        {session:scope.session, projection:{_id:1}})) : true;
                    const sidecar = present === null ? await scope.call(() => entry.rows.findOne({}, {session:scope.session, projection:{_id:1}})) : true;
                    const undo = sidecar === null ? await scope.call(() => entry.images.findOne({}, {session:scope.session, projection:{_id:1}})) : true;
                    const clean = present === null && sidecar === null && undo === null && previous === null && scope.view.checkpoint.blockNum === 0;
                    await scope.call(() => entry.coverage.replaceOne({_id:entry.model.declaration.digest},
                        indexedCoverageV1(entry, scope.view, clean, clean ? null : 'state-only-rebuild-required'), {session:scope.session, upsert:true}));
                });} catch {retained(); continue;}
                if (!materialized.includes(entry)) materialized.push(entry);
            }
            await guarded(retained, () => base.retainedCheckpoints(lease)); return lease;
        },
        async completedRead(identity, view, authority) {
            let read: StatefulCompletedReadV2 | undefined;
            try {read = await base.completedRead(identity, view, authority); authority();
                const selected = read; active.set(selected, () => {authority(); requireState(active.has(selected), 'Indexed read is closed', 'stateful.unavailable');}); return read;
            } catch (error) {if (read) base.closeRead(read); throw error;}
        },
        closeRead(read) {active.delete(read); engineeringReads.delete(read); base.closeRead(read);},
        indexedForModel(expected,digest,guard) {return offerForModel(expected,digest,guard,false,facade);},
        async queryCompleted(read, expected, request, supplied, selected) {
            const guard = context(read); expected = captureStatefulOwnerViewV2(owner, expected);
            const entry = selected ? entries.find(entry => entry.model.declaration.digest === selected.digest) : entries.length === 1 ? entries[0] : undefined;
            requireState(entry, 'Selected indexed model is ambiguous or unavailable', 'stateful.capability-unavailable');
            if (selected) await guarded(guard, async () => {await receiveMongoIndexedModelV1(owner, selected, entry.model.limits);});
            fields(supplied, ['readAttempts','responseRecords','responseBytes','queryBytes','predicates','orderTerms','setValues']);
            const available = Object.freeze({...supplied});
            for (const key of Object.keys(entry.model.limits) as (keyof IndexedLimitsV1)[])
                requireState(Number.isSafeInteger(available[key]) && available[key] >= 0 && available[key] <= entry.model.limits[key], 'Expanded indexed allowance', 'stateful.unavailable');
            requireState(available.readAttempts > 0 && available.responseBytes >= 2, 'Indexed native allowance exhausted', 'stateful.unavailable');
            const captured=captureIndexedRequestV1(entry.model.selection,request);
            // The SDK supplies its allowance from before charging this request. Measure the
            // immutable local capture against it here, before admission or any native work.
            const costs={queryBytes:Buffer.byteLength(JSON.stringify(captured)),predicates:captured.where.length,
                orderTerms:captured.kind==='page'?captured.order.length:0,
                setValues:captured.where.reduce((sum,predicate)=>sum+('values'in predicate?predicate.values.length:0),0)};
            for(const key of Object.keys(costs) as (keyof typeof costs)[])
                requireState(costs[key]<=available[key],'Indexed remaining '+key+' allowance exceeded','stateful.unavailable');
            if(captured.kind==='count')requireState(available.responseRecords>=1,'Indexed count responseRecords allowance exhausted','stateful.unavailable');
            const plan = planMongoIndexedQueryV1(entry.model, captured, entry.rows.collectionName);
            await admission(entry, guard,engineeringReads.has(read));
            assertStatefulOwnerViewV2(owner, await guarded(guard, () => base.completedView(read)), expected);
            const session = createStatefulOwnerCompletedSessionV2(base), comment = {hyperion:'stateful-indexed-v1', model:entry.model.declaration.digest, trace:randomUUID()};
            let attempts = 0, cursorId = Long.ZERO, failed = false;
            const cleanup = async () => {if (!cursorId.isZero()) {
                await executeCompleteKindCommand(options.client, options.databaseName, {killCursors:entry.rows.collectionName, cursors:[cursorId]},
                    {session, signal:AbortSignal.timeout(options.operationTimeoutMS)}); cursorId = Long.ZERO;
            }};
            try {
                const result = await guarded(guard, () => session.withTransaction(async () => {
                    await guarded(guard, () => assertStatefulOwnerCompletedSnapshotV2(base, read, expected, session));
                    const coverage = await guarded(guard, () => entry.coverage.findOne({_id:entry.model.declaration.digest}, {session}));
                    requireState(matchingIndexedCoverageV1(entry, expected, coverage) && coverage.ready, 'Indexed snapshot coverage changed', 'stateful.capability-unavailable');
                    let dataFailed = false;
                    try {return await readMongoIndexedCursorV1(entry.model, plan, {database:options.databaseName, collection:entry.rows.collectionName,
                        view:expected, available, operationTimeoutMS:options.operationTimeoutMS, attempts:() => attempts, cleanup,
                        command:async (value: Document) => {
                            guard(); retryOptions(); requireState(attempts < available.readAttempts, 'Indexed native attempt total exceeded', 'stateful.unavailable'); attempts++;
                            const answer = await executeCompleteKindCommand(options.client, options.databaseName, {...value, comment},
                                {session, promoteLongs:false, signal:AbortSignal.timeout(options.operationTimeoutMS)});
                            if (Long.isLong(answer.cursor?.id)) cursorId = answer.cursor.id; guard(); return answer;
                        }});
                    } catch (error) {dataFailed = true; throw error;}
                    finally {try {await cleanup();} catch (error) {if (!dataFailed) throw error;}}
                }, {readConcern:{level:'snapshot'}, writeConcern:new WriteConcern('majority', undefined, true), readPreference:'primary',
                    timeoutMS:options.transactionTimeoutMS, maxCommitTimeMS:options.operationTimeoutMS}));
                requireState(result !== undefined, 'Native indexed transaction returned no result', 'stateful.unavailable');
                assertStatefulOwnerViewV2(owner, await guarded(guard, () => base.completedView(read)), expected);
                await admission(entry, guard,engineeringReads.has(read)); return result;
            } catch (error) {failed = true; throw unavailable(error);}
            finally {try {await session.endSession();} catch (error) {if (!failed) throw unavailable(error);}}
        }
    } satisfies MongoDbStatefulIndexedAdapterV1);
    registerStatefulOwnerNativeFacadeV1(facade, base);
    registerStatefulOwnerSidecarsV1(base, createMongoIndexedSidecarsV1(materialized, options.rollbackMaxBlockBytes));
    registerIndexedEngineeringFacadeV1(facade,()=>{
        const engineering:MongoDbStatefulIndexedAdapterV1=Object.freeze({...facade,
            async completedRead(...args:Parameters<StatefulOwnerAdapterV2['completedRead']>){const read=await facade.completedRead(...args);engineeringReads.add(read);return read;},
            indexedForModel(expected:StatefulView,digest:string,guard:StatefulGuard){return offerForModel(expected,digest,guard,true,engineering);}});
        registerStatefulOwnerNativeFacadeV1(engineering,facade);
        return engineering;
    });
    return facade;
}
