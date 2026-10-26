/** Qualification-only physical storage inspection. Never used by a product query or adapter. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BSON, ReadConcern, type ClientSession, type Document, type MongoClient} from 'mongodb';
import {validateProjectionBinding, validateProjectionDefinition, type ProjectionBinding, type ProjectionBlock,
    type ProjectionCheckpoint, type ProjectionDefinition, type ProjectionQueryResult} from '@eosrio/hyperion-sdk/projection';

export const portableMongoAuditLimits = Object.freeze({projections: 9, rows: 256, receipts: 4096,
    documentBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, timeoutMS: 5000});
const storageVersion = 'h45-portable-mongodb-v1', prefix = 'h45_projection';
const stable = (value: any): string => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
    : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    : JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const same = (actual: unknown, expected: unknown, message: string) => assert.equal(stable(actual), stable(expected), message);
const fields = (value: Document, names: string[]) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
type Row = ProjectionQueryResult['rows'][number];
export interface PortableMongoExpectation {
    readonly definition: ProjectionDefinition; readonly binding: ProjectionBinding;
    readonly rows: readonly Row[]; readonly checkpoint: ProjectionCheckpoint;
    /** The deliberately invalid source mapping remains pending with no stored effects. */
    readonly failedBlock?: ProjectionBlock;
}
export interface PortableMongoAuditInput {
    readonly client: MongoClient; readonly database: string; readonly backendId: string; readonly chainId: string;
    readonly replicaSet: string; readonly version: string; readonly through: number;
    readonly source: readonly ProjectionCheckpoint[]; readonly expectations: readonly PortableMongoExpectation[];
}

export interface PortableMongoAuditOptions {
    readonly budget?: {readonly deadline: number};
    readonly now?: () => number;
    readonly capture?: (sample: PortableMongoPhysicalSample) => void;
}
export interface PortableMongoPhysicalSample {
    schemaVersion: number; through: number; complete: boolean; outcome: string;
    bytes: number; documents: number; observations: Record<string, any>; error?: unknown;
}
export const portableMongoAdmissionReason = 'Canonical projection source admitted; durable application is pending';
const admissionTransitions = new WeakMap<object, PortableMongoPhysicalSample>();
/** Only the complete strict audit may issue this retry classification. Copied errors do not qualify. */
export const isPortableMongoAdmissionTransition = (error: unknown, sample?: PortableMongoPhysicalSample) =>
    typeof error === 'object' && error !== null && admissionTransitions.has(error) && (!sample || admissionTransitions.get(error) === sample);
export function portableMongoError(error: any, seen = new Set<unknown>(), depth = 0): unknown {
    if (!(error instanceof Error)) return {thrown: error};
    if (seen.has(error) || depth >= 8) return {incompleteCause: true, reason: seen.has(error) ? 'circular cause' : 'cause depth bound'};
    seen.add(error); const native = error as any;
    return {name: error.name, message: error.message, stack: error.stack, code: native.code, errorResponse: native.errorResponse,
        ...(native.cause === undefined ? {} : {cause: portableMongoError(native.cause, seen, depth + 1)})};
}

/** Exact namespace/binding validation precedes every native database operation. */
export async function auditPortablePhysicalMongo(input: PortableMongoAuditInput, options: PortableMongoAuditOptions = {}) {
    const sample: PortableMongoPhysicalSample = {schemaVersion: 1, through: input.through, complete: false,
        outcome: 'started', bytes: 0, documents: 0, observations: {timeouts: []}};
    try {
        const result = await inspectPortablePhysicalMongo(input, options, sample); sample.outcome = 'passed'; return result;
    } catch (error) {
        sample.outcome = isPortableMongoAdmissionTransition(error, sample) ? 'admission-transition' : 'fatal';
        sample.error = portableMongoError(error); throw error;
    } finally {options.capture?.(sample);}
}
async function inspectPortablePhysicalMongo(input: PortableMongoAuditInput, options: PortableMongoAuditOptions, sample: PortableMongoPhysicalSample) {

    const now = options.now ?? (() => performance.now());
    const timeout = (operation: string, cleanup = false) => {
        const remaining = options.budget ? Math.floor(options.budget.deadline - now()) : portableMongoAuditLimits.timeoutMS;
        if (!cleanup) assert.ok(remaining > 0, 'physical Mongo inherited isolation deadline exceeded');
        const timeoutMS = Math.max(1, Math.min(portableMongoAuditLimits.timeoutMS, remaining));
        sample.observations.timeouts.push({operation, timeoutMS, remainingMs: remaining}); return timeoutMS;
    };
    const {client, database, backendId, chainId, replicaSet, version, through, source, expectations} = input;
    assert.match(database, /^h45_p191_[0-9a-f]{12}$/); assert.equal(backendId, 'p191-' + database.slice(-12));
    assert.match(chainId, /^[0-9a-f]{64}$/); assert.match(replicaSet, /^h45rs_[0-9a-f]{32}$/); assert.equal(version, '8.0.34');
    assert.ok(Number.isSafeInteger(through) && through > 0 && through <= 4096);
    assert.ok(source.length >= through && source.length <= 4096);
    assert.ok(expectations.length > 0 && expectations.length <= portableMongoAuditLimits.projections);
    assert.equal(new Set(expectations.map(value => value.binding.projectionId)).size, expectations.length);
    const checkpoint = (height: number) => {
        if (height === 0) return {blockNum: 0, blockId: '0'.repeat(64)};
        const original = source[height - 1];
        return {blockNum: original?.blockNum, blockId: original?.blockId};
    };
    for (const [index, value] of source.entries()) {assert.equal(value.blockNum, index + 1); assert.match(value.blockId, /^[0-9a-f]{64}$/);}
    for (const expected of expectations) {
        assert.equal(validateProjectionDefinition(expected.definition).valid, true);
        assert.equal(validateProjectionBinding(expected.definition, expected.binding).valid, true);
        assert.equal(expected.binding.chainId, chainId); assert.equal(expected.binding.backendId, backendId);
        assert.ok(expected.rows.length <= portableMongoAuditLimits.rows); assert.equal(new Set(expected.rows.map(row => row.key)).size, expected.rows.length);
        same(expected.checkpoint, checkpoint(expected.checkpoint.blockNum), 'expected checkpoint must bind original source');
        if (expected.failedBlock) {assert.equal(expected.rows.length, 0); assert.ok(expected.failedBlock.blockNum <= through);
            same(expected.failedBlock, {...checkpoint(expected.checkpoint.blockNum + 1), previousBlockId: expected.checkpoint.blockId}, 'failed source must be contiguous');}
        else same(expected.checkpoint, checkpoint(through), 'healthy source must be held at this prefix');
    }
    // The caller supplies the fixture-owned client, never a user-provided cluster URI.
    assert.equal(client.options.directConnection, true); assert.equal(client.options.replicaSet, replicaSet);
    assert.equal(client.options.hosts.length, 1); assert.equal(typeof client.options.hosts[0].host, 'string');
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(client.options.hosts[0].host!));
    assert.ok(client.options.hosts[0].port! > 1024 && client.options.hosts[0].port! < 65536);
    timeout('start');
    const db = client.db(database, {readPreference: 'primary', readConcern: new ReadConcern('majority')});
    let totalBytes = 0;
    const admit = <T extends Document>(value: T): T => {
        const bytes = BSON.calculateObjectSize(value); sample.documents++; sample.bytes += bytes; assert.ok(bytes <= portableMongoAuditLimits.documentBytes, 'physical Mongo document exceeds audit bound');
        totalBytes += bytes; assert.ok(totalBytes <= portableMongoAuditLimits.totalBytes, 'physical Mongo audit byte budget exhausted'); return value;
    };
    const identity = async (phase: string) => {
        const raw: Document = {}; sample.observations[phase] = raw;
        const hello = admit(await db.admin().command({hello: 1}, {timeoutMS: timeout(phase + '.hello'), readPreference: 'primary'}));
        raw.hello = BSON.EJSON.serialize(hello);
        const build = admit(await db.admin().command({buildInfo: 1}, {timeoutMS: timeout(phase + '.buildInfo'), readPreference: 'primary'}));
        raw.buildInfo = BSON.EJSON.serialize(build);
        assert.equal(hello.setName, replicaSet); assert.equal(hello.isWritablePrimary, true); assert.equal(build.version, version);
        assert.equal(typeof hello.me, 'string'); assert.ok(hello.topologyVersion?.processId);
        return {setName: hello.setName, me: hello.me, primary: hello.primary, maxWireVersion: hello.maxWireVersion,
            processId: BSON.EJSON.serialize(hello.topologyVersion.processId), version: build.version, gitVersion: build.gitVersion};
    };
    const names = expectations.map(value => `${prefix}_r_${hash(value.binding)}`);
    const expectedNames = [`${prefix}_metadata`, ...names].sort();
    const collections = async (phase: string) => {
        const result: Document[] = []; sample.observations[phase] = result;
        const cursor = db.listCollections({}, {nameOnly: false, batchSize: expectedNames.length + 1, timeoutMS: timeout(phase)});
        try {for await (const item of cursor) {result.push(admit(item)); assert.ok(result.length <= expectedNames.length, 'unplanned physical Mongo namespace');}}
        finally {await cursor.close();}
        assert.deepEqual(result.map(item => item.name).sort(), expectedNames, 'physical Mongo namespace inventory differs');
        for (const item of result) {assert.equal(item.type, 'collection'); assert.equal(item.options?.collation?.locale ?? 'simple', 'simple');
            assert.ok(!item.options?.capped && !item.options?.viewOn);}
        return result.sort((a, b) => a.name < b.name ? -1 : 1).map(value => BSON.EJSON.serialize(value));
    };
    const metadata = async (phase: string, session?: ClientSession) => {
        const rows: Document[] = []; sample.observations[phase] = rows;
        const cursor = db.collection(`${prefix}_metadata`).find({}, {session, collation: {locale: 'simple'}, batchSize: 16,
            timeoutMS: timeout(phase), ...(session ? {} : {readPreference: 'primary', readConcern: {level: 'majority'}})}).sort({_id: 1}).limit(expectations.length + 1);
        try {for await (const row of cursor) {rows.push(admit(row)); assert.ok(rows.length <= expectations.length, 'unplanned physical Mongo binding');}
            assert.equal(rows.length, expectations.length); return rows;}
        finally {await cursor.close();}
    };
    const serverBefore = await identity('serverBefore'), collectionsBefore = await collections('collectionsBefore'), before = await metadata('metadataBefore');
    const session = client.startSession({causalConsistency: false});
    const projections: Document[] = []; sample.observations.projections = projections; let snapshot: Document[];
    try {
        session.startTransaction({readConcern: {level: 'snapshot'}, readPreference: 'primary'});
        snapshot = await metadata('metadataSnapshot', session);
        for (const [index, expected] of expectations.entries()) {
            const slot = hash({chainId, projectionId: expected.binding.projectionId}), stored = snapshot.find(value => value._id === slot);
            assert.ok(stored, 'expected physical Mongo binding slot is absent');
            fields(stored, ['_id', 'storageVersion', 'definition', 'definitionHash', 'binding', 'checkpoint', 'initialized', 'pending', 'gap', 'receipts']);
            assert.equal(stored.storageVersion, storageVersion); assert.equal(stored.definitionHash, hash(expected.definition));
            same(stored.definition, expected.definition, 'physical Mongo definition differs'); same(stored.binding, expected.binding, 'physical Mongo immutable binding/generation differs');
            same(stored.checkpoint, expected.checkpoint, 'physical Mongo checkpoint differs'); assert.equal(stored.initialized, true); assert.equal(stored.gap, null);
            if (expected.failedBlock) {fields(stored.pending, ['block', 'digest', 'reason']); same(stored.pending.block, expected.failedBlock, 'physical failed source differs');
                assert.equal(stored.pending.digest, null); assert.equal(typeof stored.pending.reason, 'string'); assert.ok(Buffer.byteLength(stored.pending.reason) <= 4096);}
            else assert.equal(stored.pending, null);
            assert.ok(Array.isArray(stored.receipts) && stored.receipts.length > 0 && stored.receipts.length <= portableMongoAuditLimits.receipts);
            let prior = 0;
            for (const receipt of stored.receipts) {fields(receipt, ['blockNum', 'blockId', 'digest']); assert.ok(receipt.blockNum > prior && receipt.blockNum <= expected.checkpoint.blockNum);
                same({blockNum: receipt.blockNum, blockId: receipt.blockId}, checkpoint(receipt.blockNum), 'physical receipt differs from original source');
                assert.match(receipt.digest, /^[0-9a-f]{64}$/); prior = receipt.blockNum;}
            const last = stored.receipts.at(-1); same({blockNum: last.blockNum, blockId: last.blockId}, expected.checkpoint, 'physical receipt does not end at checkpoint');
            const records = db.collection(names[index]);
            const count = await records.countDocuments({}, {session, collation: {locale: 'simple'}, limit: portableMongoAuditLimits.rows + 1, timeoutMS: timeout('rows.count')});
            const documents: Document[] = [];
            const projection = {projectionId: expected.binding.projectionId, collection: names[index], metadataSlot: slot,
                binding: stored.binding, checkpoint: stored.checkpoint, count, documents, sha256: '', metadataSha256: hash(stored)};
            projections.push(projection);
            assert.equal(count, expected.rows.length, 'physical Mongo row count differs from independent source oracle');
            const cursor = records.find({}, {session, collation: {locale: 'simple'}, batchSize: 16, timeoutMS: timeout('rows.find')}).sort({_id: 1}).limit(expected.rows.length + 1);
            try {for await (const document of cursor) {documents.push(admit(document)); assert.ok(documents.length <= expected.rows.length, 'extra physical Mongo row');
                fields(document, ['_id', 'value']);}}
            finally {await cursor.close();}
            const expectedDocuments = expected.rows.map(row => ({_id: row.key, value: row.value})).sort((a, b) => Buffer.compare(Buffer.from(a._id), Buffer.from(b._id)));
            same(documents, expectedDocuments, 'physical Mongo keys/values differ from independent source oracle');
            projection.sha256 = hash(documents);
        }
    } finally {try {await session.abortTransaction({timeoutMS: timeout('abortTransaction', true)});} finally {await session.endSession();}}
    const after = await metadata('metadataAfter'), collectionsAfter = await collections('collectionsAfter'), serverAfter = await identity('serverAfter');
    sample.complete = true;
    timeout('completed');
    const reasons = new Map<string, string[]>();
    const withoutFailedReasons = (rows: Document[]) => rows.map(row => {
        const expected = expectations.find(value => value.failedBlock && row._id === hash({chainId, projectionId: value.binding.projectionId}));
        if (!expected) return row;
        assert.equal(typeof row.pending?.reason, 'string'); assert.ok(Buffer.byteLength(row.pending.reason) <= 4096);
        const reason = row.pending.reason;
        if (reason !== portableMongoAdmissionReason) assert.match(reason, /Required source field is missing/);
        const values = reasons.get(row._id) ?? []; values.push(reason); reasons.set(row._id, values); return {...row, pending: {...row.pending, reason: null}};
    });
    const beforeInvariant = withoutFailedReasons(before), snapshotInvariant = withoutFailedReasons(snapshot), afterInvariant = withoutFailedReasons(after);
    same(snapshotInvariant, beforeInvariant, 'physical Mongo metadata changed before snapshot');
    same(afterInvariant, beforeInvariant, 'physical Mongo binding/checkpoint changed during held audit');
    same(collectionsAfter, collectionsBefore, 'physical Mongo collections changed during held audit');
    same(serverAfter, serverBefore, 'physical Mongo server identity changed during audit');
    for (const values of reasons.values()) if (new Set(values).size > 1)
        assert.ok(values.includes(portableMongoAdmissionReason) && values.some(value => /Required source field is missing/.test(value)),
            'physical Mongo reason changed outside the exact admission transition');
    if ([...reasons.values()].some(values => values.includes(portableMongoAdmissionReason))) {
        const error = new assert.AssertionError({actual: portableMongoAdmissionReason, expected: /Required source field is missing/, operator: 'match'});
        admissionTransitions.set(error, sample); throw error;
    }
    return {schemaVersion: 1, through, database, backendId, chainId, storageVersion, readOnly: true,
        expectationOrigin: 'independent original source/official-clio plan rows', serverBefore, serverAfter,
        collections: collectionsBefore, metadataBefore: before, metadataSnapshot: snapshot, metadataAfter: after,
        projections, metadataSha256: hash(before), bytes: totalBytes, limits: portableMongoAuditLimits};
}
