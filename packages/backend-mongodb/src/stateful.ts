import {randomBytes} from 'node:crypto';
import {
    STATEFUL_FAMILY, STATEFUL_ADAPTER_CAPABILITIES, STATEFUL_RECOVERY_LIMITS,
    assertStatefulView, captureStatefulCandidate, captureStatefulRollback, captureStatefulSource, captureStatefulView,
    StatefulContractError, type CapturedStatefulSource, type StatefulAdapter, type StatefulApplyResult, type StatefulCandidate,
    type StatefulDeclaration, type StatefulInspection, type StatefulKey, type StatefulRead, type StatefulRecovery, type StatefulRollback, type StatefulView,
} from '@eosrio/hyperion-sdk/projection-stateful';
import {WriteConcern, type ClientSession, type Collection, type Db, type MongoClient} from 'mongodb';
import {bsonBytes, MAX_METADATA_BYTES, retainedBytes} from './rollback-contract.js';
import {serverErrorCode} from './storage.js';
import {
    STATEFUL_STORAGE, MAX_BSON_BYTES, ZERO, blockOf, checkedImages, decodeRow, equalPoint, fields, hex, keyId, logicalKey,
    metadata, ready, receiveDeclaration, recoveryOf, requireState, rowOf, sha, size, slotFor, viewOf, writer,
    type StatefulImage, type StatefulMetadata, type StatefulPolicy, type StatefulReceipt, type StatefulRow, type StatefulUndo,
} from './stateful-contract.js';

export interface MongoDbStatefulAdapterOptions {
    /** Connected caller-owned client. The adapter never connects/closes it or selects source authority. */
    readonly client: MongoClient;
    readonly databaseName: string;
    readonly backendId: string;
    readonly collectionPrefix: string;
    /** Explicit configured declaration; receiving DTO validation does not negotiate host execution. */
    readonly declaration: StatefulDeclaration;
    readonly receiptRetention: number;
    readonly rollbackRetentionBlocks: number;
    readonly rollbackRetentionBytes: number;
    readonly rollbackMaxBlockBytes: number;
    readonly operationTimeoutMS: number;
    readonly transactionTimeoutMS: number;
}
const token = () => randomBytes(32).toString('hex');
const UNAVAILABLE_ANCESTOR_REASON = 'Ancestor outside retained exact-branch undo';

class MongoDbStatefulAdapter implements StatefulAdapter {
    readonly capabilities;
    private readonly db: Db;
    private readonly meta: Collection<StatefulMetadata>;
    private readonly rows: Collection<StatefulRow>;
    private readonly images: Collection<StatefulImage>;
    private readonly concern = new WriteConcern('majority', undefined, true);
    private readonly policy: StatefulPolicy;
    private readonly operationMS: number;
    private readonly transactionMS: number;

    constructor(private readonly options: MongoDbStatefulAdapterOptions, private readonly declaration: StatefulDeclaration) {
        requireState(options.client && /^[a-zA-Z0-9_-]{1,48}$/.test(options.databaseName) &&
            /^[a-z][a-z0-9_]{0,31}$/.test(options.collectionPrefix) && options.backendId === declaration.definition.binding.backendId, 'Explicit native adapter configuration differs');
        this.operationMS = size(options.operationTimeoutMS, 30000, 'operationTimeoutMS');
        this.transactionMS = size(options.transactionTimeoutMS, 60000, 'transactionTimeoutMS');
        this.policy = Object.freeze({maxBlocks: size(options.rollbackRetentionBlocks, STATEFUL_RECOVERY_LIMITS.retainedBlocks, 'rollbackRetentionBlocks'),
            maxBytes: size(options.rollbackRetentionBytes, STATEFUL_RECOVERY_LIMITS.retainedBytes, 'rollbackRetentionBytes'),
            maxBlockBytes: size(options.rollbackMaxBlockBytes, options.rollbackRetentionBytes, 'rollbackMaxBlockBytes'),
            receiptRetention: size(options.receiptRetention, STATEFUL_RECOVERY_LIMITS.retainedBlocks, 'receiptRetention')});
        // Values/keys are BSON string values, never BSON field names. This conservative exact byte
        // envelope covers both the row wrapper and the larger before-image wrapper.
        requireState(declaration.limits.value.recordBytes + 2 * declaration.limits.keyBytes + 1024 <= MAX_BSON_BYTES,
            'Offered value/key profile exceeds the BSON document envelope', 'stateful.capability-unavailable');
        const reasonBytes = Math.min(declaration.limits.keyBytes, declaration.limits.envelope.stringBytes);
        requireState(Buffer.byteLength(UNAVAILABLE_ANCESTOR_REASON) <= reasonBytes,
            'Offered text profile cannot retain the native unavailable-ancestor reason', 'stateful.capability-unavailable');
        const point = {blockNum: Number.MAX_SAFE_INTEGER, blockId: 'f'.repeat(64)};
        const receipt: StatefulReceipt = {...point, sourceDigest: 'f'.repeat(64), candidateDigest: 'f'.repeat(64)};
        const undo: StatefulUndo = {block: {...point, previousBlockId: 'f'.repeat(64)}, sourceDigest: receipt.sourceDigest,
            digest: receipt.candidateDigest, count: declaration.limits.mutations, imageBytes: this.policy.maxBlockBytes, imagesHash: 'f'.repeat(64)};
        const completed = {operationId: point.blockId, sourceRevision: point.blockId, from: point, ancestor: point, status: 'complete' as const, reason: null};
        const sample = {...this.initial(), initialized: true, checkpoint: point, floor: point, floorReceipt: receipt, rollback: completed,
            receipts: Array(this.policy.receiptRetention).fill(receipt), undo: Array(this.policy.maxBlocks).fill(undo)};
        // A completed rollback survives forward application and gap/pending admission. Reserve it
        // with full arrays/floor receipt and maximum numeric BSON widths. Pending and gap are
        // exclusive; running/unavailable rollback owns neither. BSON string growth is exactly its
        // UTF-8 byte count, so reason reservation needs no large synthetic string allocation.
        const phases = [bsonBytes(sample),
            bsonBytes({...sample, pending: {sourceDigest: receipt.sourceDigest, candidateDigest: receipt.candidateDigest, block: point}}),
            bsonBytes({...sample, gap: {sourceDigest: receipt.sourceDigest, block: point, reason: ''}}) + reasonBytes,
            bsonBytes({...sample, rollback: {...completed, status: 'running'}}),
            bsonBytes({...sample, rollback: {...completed, status: 'unavailable', reason: ''}}) + reasonBytes];
        requireState(Math.max(...phases) <= MAX_METADATA_BYTES,
            'Declaration/retention profile exceeds native metadata envelope', 'stateful.capability-unavailable');
        this.capabilities = Object.freeze({family: STATEFUL_FAMILY, interfaceVersion: 1 as const, supported: STATEFUL_ADAPTER_CAPABILITIES, limits: declaration.limits});
        this.db = options.client.db(options.databaseName, {readPreference: 'primary'});
        const prefix = options.collectionPrefix + '_stateful';
        this.meta = this.db.collection<StatefulMetadata>(prefix + '_metadata');
        this.rows = this.db.collection<StatefulRow>(prefix + '_r_' + declaration.digest);
        this.images = this.db.collection<StatefulImage>(prefix + '_u_' + declaration.digest);
    }
    private initial(): StatefulMetadata {
        return {_id: slotFor(this.declaration), storageVersion: STATEFUL_STORAGE, declaration: JSON.stringify(this.declaration), declarationDigest: this.declaration.digest,
            policy: this.policy, etag: token(), checkpoint: {...ZERO}, revision: token(), initialized: false,
            pending: null, gap: null, rollback: null, receipts: [], undo: [], floor: {...ZERO}, floorReceipt: null};
    }
    private async binding(input: unknown): Promise<void> {
        const d = await receiveDeclaration(input); requireState(d.digest === this.declaration.digest, 'Configured declaration differs', 'stateful.declaration-conflict');
    }
    private async source(input: CapturedStatefulSource): Promise<CapturedStatefulSource> {
        fields(input, ['declarationDigest', 'source', 'digest']);
        const source = await captureStatefulSource(this.declaration, input.source);
        requireState(source.digest === input.digest && input.declarationDigest === this.declaration.digest, 'Source capture identity differs'); return source;
    }
    private async guarded<T>(work: () => Promise<T>): Promise<T> {
        try {return await work();} catch (error) {
            if (error instanceof StatefulContractError) throw error;
            const unavailable = new StatefulContractError('stateful.apply-unavailable', 'MongoDB outcome is unavailable; inspect/retry only the original fixed input');
            unavailable.cause = error; throw unavailable;
        }
    }
    private async load(session?: ClientSession): Promise<StatefulMetadata> {
        const raw = await this.meta.findOne({_id: slotFor(this.declaration)}, session ? {session} : {
            readPreference: 'primary', readConcern: {level: 'linearizable'}, maxTimeMS: this.operationMS, timeoutMS: this.operationMS,
        });
        requireState(raw !== null, 'Projection storage is not initialized', 'stateful.not-initialized');
        return metadata(this.declaration, this.policy, raw);
    }
    private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
        const session = this.options.client.startSession({causalConsistency: false});
        try {
            const result = await session.withTransaction(() => work(session), {readConcern: {level: 'snapshot'}, writeConcern: this.concern,
                readPreference: 'primary', timeoutMS: this.transactionMS, maxCommitTimeMS: this.operationMS});
            requireState(result !== undefined, 'Driver returned no transaction result', 'stateful.commit-unknown'); return result;
        } finally {await session.endSession();}
    }
    private async save(before: StatefulMetadata, changes: Partial<StatefulMetadata>, session?: ClientSession): Promise<StatefulMetadata> {
        const next = metadata(this.declaration, this.policy, {...before, ...changes, etag: token()});
        const {_id, ...values} = next;
        const result = await this.meta.updateOne({_id, etag: before.etag, declarationDigest: before.declarationDigest}, {$set: values},
            session ? {session} : {writeConcern: this.concern, timeoutMS: this.operationMS});
        requireState(result.acknowledged && result.matchedCount === 1, 'Native progress/recovery fence changed', 'stateful.stale-view'); return next;
    }
    async initialize(input: StatefulDeclaration): Promise<StatefulView> {
        await this.binding(input);
        return this.guarded(async () => {
            const hello = await this.db.admin().command({hello: 1}, {readPreference: 'primary', timeoutMS: this.operationMS});
            // Linearizable single-document fences require an initialized replica-set primary.
            // Sharded/standalone topologies are not advertised by this factory.
            requireState(typeof hello.setName === 'string' && hello.setName.length > 0 && hello.isWritablePrimary === true &&
                Number.isSafeInteger(hello.maxWireVersion) && hello.maxWireVersion >= 7 && Number.isFinite(hello.logicalSessionTimeoutMinutes) &&
                hello.logicalSessionTimeoutMinutes > 0, 'Stateful MongoDB requires a transaction-capable replica-set primary', 'stateful.capability-unavailable');
            try {await this.meta.insertOne(this.initial(), {writeConcern: this.concern, timeoutMS: this.operationMS});}
            catch (error) {if (!serverErrorCode(error, 11000)) throw error;}
            let m = await this.load();
            if (!m.initialized) {
                for (const collection of [this.rows, this.images]) {
                    try {await this.db.createCollection(collection.collectionName, {collation: {locale: 'simple'}, writeConcern: this.concern, timeoutMS: this.operationMS});}
                    catch (error) {if (!serverErrorCode(error, 48)) throw error;}
                    const native = await collection.options({timeoutMS: this.operationMS});
                    requireState(!native.collation || native.collation.locale === 'simple', 'Simple key collation required');
                    requireState(await collection.countDocuments({}, {limit: 1, timeoutMS: this.operationMS}) === 0, 'Genesis cannot adopt existing state/undo');
                }
                m = await this.save(m, {initialized: true});
            }
            ready(m); return viewOf(this.declaration, m);
        });
    }
    async open(input: StatefulDeclaration): Promise<StatefulView> {
        await this.binding(input); return this.guarded(async () => {const m = await this.load(); ready(m); return viewOf(this.declaration, m);});
    }
    async recovery(input: StatefulDeclaration): Promise<StatefulRecovery> {
        await this.binding(input); return this.guarded(async () => recoveryOf(this.declaration, await this.load()));
    }
    async read(input: StatefulView, requested: readonly StatefulKey[]): Promise<{readonly view: StatefulView; readonly results: readonly StatefulRead[]}> {
        const d = this.declaration, view = captureStatefulView(d, input);
        requireState(Array.isArray(requested), 'Read keys must be a dense data vector');
        const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(requested as object);
        const length = descriptors.length.value as number;
        requireState(Object.getOwnPropertySymbols(requested).length === 0 && length <= d.limits.readKeys && length <= d.limits.responseRecords &&
            Object.keys(descriptors).length === length + 1, 'Read key bound/sparse vector');
        const keys: StatefulKey[] = [];
        for (let i = 0; i < length; i++) {const item = descriptors[String(i)];
            requireState(item?.enumerable && Object.hasOwn(item, 'value'), 'Accessor/sparse read key'); keys.push(logicalKey(d, item.value));}
        return this.guarded(async () => {
            const assert = (m: StatefulMetadata) => {ready(m); assertStatefulView(d, viewOf(d, m), view);};
            assert(await this.load());
            const answer = await this.transaction(async session => {
                assert(await this.load(session)); const results: StatefulRead[] = [];
                for (const key of keys) {
                    const row = await this.rows.findOne({_id: keyId(key)}, {session});
                    results.push(row === null ? {status: 'covered-absent'} : {status: 'present', value: decodeRow(d, key, row)});
                }
                requireState(Buffer.byteLength(JSON.stringify({view, results})) <= d.limits.responseBytes, 'Read response byte bound');
                return {view, results};
            });
            assert(await this.load()); return answer;
        });
    }
    private replay(m: StatefulMetadata, source: CapturedStatefulSource, candidateDigest?: string): StatefulReceipt | null {
        const block = source.source.block, r = m.receipts.find(r => r.blockNum === block.blockNum || r.blockId === block.blockId);
        if (r) requireState(equalPoint(r, block) && r.sourceDigest === source.digest &&
            (candidateDigest === undefined || r.candidateDigest === candidateDigest), 'Retained replay conflicts', 'stateful.replay-conflict');
        return r ?? null;
    }
    async inspect(input: StatefulDeclaration, supplied: CapturedStatefulSource): Promise<StatefulInspection> {
        await this.binding(input); const source = await this.source(supplied);
        return this.guarded(async () => {
            const m = await this.load(), r = this.replay(m, source);
            requireState(m.initialized, 'Projection is not initialized', 'stateful.not-initialized');
            if (!r && m.pending) requireState(m.pending.sourceDigest === source.digest && equalPoint(m.pending.block, source.source.block), 'Another pending source is retained', 'stateful.replay-conflict');
            if (m.gap?.block.blockNum === source.source.block.blockNum) requireState(m.gap.sourceDigest === source.digest, 'Incomplete source conflicts', 'stateful.replay-conflict');
            const phase = m.rollback && m.rollback.status !== 'complete' ? 'rollback' : m.gap ? 'gap' : m.pending ? 'pending' : 'ready';
            return {phase, status: r ? 'committed' : m.pending ? 'pending' : source.source.block.blockNum <= m.checkpoint.blockNum ? 'uncovered' : 'new',
                sourceDigest: r?.sourceDigest ?? m.pending?.sourceDigest ?? null, candidateDigest: r?.candidateDigest ?? m.pending?.candidateDigest ?? null,
                progress: viewOf(this.declaration, m)};
        });
    }
    async apply(input: StatefulCandidate): Promise<StatefulApplyResult> {
        const d = this.declaration, candidate = await captureStatefulCandidate(d, input), source = candidate.source, block = blockOf(source.source.block);
        return this.guarded(async () => {
            const initial = await this.load(); writer(initial);
            if (this.replay(initial, source, candidate.digest)) {ready(initial); return {status: 'duplicate', progress: viewOf(d, initial)};}
            requireState(block.blockNum > initial.checkpoint.blockNum, 'Source receipt coverage expired', 'stateful.receipt-unavailable');
            assertStatefulView(d, viewOf(d, initial), candidate.view);
            const pending = {sourceDigest: source.digest, candidateDigest: candidate.digest, block: {blockNum: block.blockNum, blockId: block.blockId}};
            requireState(initial.pending === null || JSON.stringify(initial.pending) === JSON.stringify(pending), 'Pending candidate conflicts', 'stateful.replay-conflict');
            await this.save(initial, {pending});
            return this.transaction(async session => {
                const m = await this.load(session); writer(m);
                if (this.replay(m, source, candidate.digest)) {ready(m); return {status: 'duplicate' as const, progress: viewOf(d, m)};}
                assertStatefulView(d, viewOf(d, m), candidate.view);
                requireState(JSON.stringify(m.pending) === JSON.stringify(pending), 'Original durable intent differs', 'stateful.replay-conflict');
                // Recheck original observations at the same native snapshot as effects/progress.
                for (const observation of candidate.observations) {
                    const raw = await this.rows.findOne({_id: keyId(observation.key)}, {session});
                    if (raw !== null) decodeRow(d, observation.key, raw);
                    requireState(observation.result.status === 'covered-absent' ? raw === null : raw !== null &&
                        raw.json === rowOf(d, observation.key, observation.result.value).json, 'Observed base record differs', 'stateful.stale-view');
                }
                const images = new Map<string, StatefulImage>(); let imageBytes = 0;
                for (const mutation of candidate.mutations) if (!images.has(keyId(mutation.target))) {
                    const raw = await this.rows.findOne({_id: keyId(mutation.target)}, {session});
                    if (raw !== null) decodeRow(d, mutation.target, raw);
                    const image: StatefulImage = {_id: sha(block.blockId + keyId(mutation.target)), blockId: block.blockId, target: mutation.target, before: raw?.json ?? null};
                    imageBytes += bsonBytes(image); requireState(imageBytes <= this.policy.maxBlockBytes, 'Before-image byte bound', 'stateful.apply-unavailable'); images.set(keyId(mutation.target), image);
                }
                const ordered = [...images.values()].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
                const undo: StatefulUndo = {block, digest: candidate.digest, sourceDigest: source.digest, count: ordered.length, imageBytes, imagesHash: sha(JSON.stringify(ordered))};
                requireState(retainedBytes([undo]) <= this.policy.maxBlockBytes, 'Undo descriptor byte bound', 'stateful.apply-unavailable'); checkedImages(d, undo, ordered);
                for (const image of ordered) await this.images.insertOne(image, {session});
                for (const mutation of candidate.mutations) {
                    if (mutation.kind === 'put') await this.rows.replaceOne({_id: keyId(mutation.target)}, rowOf(d, mutation.target, mutation.value), {session, upsert: true});
                    else await this.rows.deleteOne({_id: keyId(mutation.target)}, {session});
                }
                const retained = [...m.undo, undo]; let floor = m.floor, floorReceipt = m.floorReceipt;
                while (retained.length > this.policy.maxBlocks || retainedBytes(retained) > this.policy.maxBytes) {
                    const removed = retained.shift()!; await this.images.deleteMany({blockId: removed.block.blockId}, {session});
                    floor = {blockNum: removed.block.blockNum, blockId: removed.block.blockId}; floorReceipt = {...floor, sourceDigest: removed.sourceDigest, candidateDigest: removed.digest};
                }
                const checkpoint = {blockNum: block.blockNum, blockId: block.blockId};
                const receipts = [...m.receipts, {...checkpoint, sourceDigest: source.digest, candidateDigest: candidate.digest}].slice(-this.policy.receiptRetention);
                const next = await this.save(m, {checkpoint, receipts, pending: null, undo: retained, floor, floorReceipt}, session);
                return {status: 'applied' as const, progress: viewOf(d, next)};
            });
        });
    }
    async markIncomplete(input: StatefulDeclaration, expected: StatefulView, supplied: CapturedStatefulSource, reason: string): Promise<void> {
        await this.binding(input); const d = this.declaration, view = captureStatefulView(d, expected), source = await this.source(supplied);
        const gap = {sourceDigest: source.digest, block: {blockNum: source.source.block.blockNum, blockId: source.source.block.blockId}, reason};
        return this.guarded(async () => {
            const m = await this.load(); requireState(m.initialized && m.pending === null && (!m.rollback || m.rollback.status === 'complete'), 'Another recovery owns the source', 'stateful.incomplete');
            assertStatefulView(d, viewOf(d, m), view);
            requireState(equalPoint(source.source.previous, m.checkpoint), 'Incomplete source does not follow progress');
            requireState(m.gap === null || JSON.stringify(m.gap) === JSON.stringify(gap), 'Incomplete identity conflicts', 'stateful.replay-conflict');
            await this.save(m, {gap});
        });
    }
    async rollback(input: StatefulRollback) {
        return this.guarded(async () => {
            const d = this.declaration; let m = await this.load();
            const admitted = captureStatefulRollback(d, input, recoveryOf(d, m)), request = admitted.request;
            if (admitted.mode === 'duplicate') return {status: 'duplicate' as const, recovery: recoveryOf(d, m)};
            if (admitted.mode === 'start') {
                requireState(m.rollback === null || m.rollback.status === 'complete', 'Unavailable ancestry requires historical recovery or qualified reinitialization', 'stateful.rollback-unavailable');
                const available = equalPoint(m.floor, request.ancestor) || m.undo.some(u => equalPoint(u.block, request.ancestor));
                const rollback = {operationId: request.operationId, sourceRevision: request.revision, from: request.from, ancestor: request.ancestor,
                    status: available ? 'running' as const : 'unavailable' as const, reason: available ? null : UNAVAILABLE_ANCESTOR_REASON};
                m = await this.save(m, {revision: token(), rollback, pending: null, gap: null});
                requireState(available, 'Ancestor outside retained exact-branch undo', 'stateful.rollback-unavailable');
            }
            for (let step = 0; step < request.maxBlocks && m.rollback?.status === 'running'; step++) m = await this.transaction(async session => {
                const current = await this.load(session), operation = current.rollback;
                requireState(operation?.operationId === request.operationId && operation.sourceRevision === request.revision &&
                    equalPoint(operation.from, request.from) && equalPoint(operation.ancestor, request.ancestor), 'Another rollback owns progress', 'stateful.stale-view');
                if (operation.status !== 'running') return current;
                let checkpoint = current.checkpoint, undo = [...current.undo], receipts = [...current.receipts];
                if (!equalPoint(checkpoint, operation.ancestor)) {
                    const u = undo.pop(); requireState(u && equalPoint(u.block, checkpoint), 'Missing original undo descriptor');
                    const raw = await this.images.find({blockId: u.block.blockId}, {session}).sort({_id: 1}).limit(u.count + 1).toArray();
                    for (const image of checkedImages(d, u, raw)) {
                        if (image.before === null) await this.rows.deleteOne({_id: keyId(image.target)}, {session});
                        else await this.rows.replaceOne({_id: keyId(image.target)}, rowOf(d, image.target, JSON.parse(image.before)), {session, upsert: true});
                    }
                    await this.images.deleteMany({blockId: u.block.blockId}, {session});
                    checkpoint = {blockNum: u.block.blockNum - 1, blockId: u.block.previousBlockId}; receipts = receipts.filter(r => r.blockNum <= checkpoint.blockNum);
                    if (checkpoint.blockNum > 0 && !receipts.some(r => equalPoint(r, checkpoint))) {
                        const last = undo.at(-1), receipt = last ? {...checkpoint, sourceDigest: last.sourceDigest, candidateDigest: last.digest} : current.floorReceipt;
                        requireState(receipt && equalPoint(receipt, checkpoint), 'Missing predecessor replay receipt'); receipts.push(receipt);
                    }
                }
                return this.save(current, {checkpoint, undo, receipts, rollback: {...operation, status: equalPoint(checkpoint, operation.ancestor) ? 'complete' : 'running'}}, session);
            });
            return {status: m.rollback?.status === 'complete' ? 'rolled-back' as const : 'in-progress' as const, recovery: recoveryOf(d, m)};
        });
    }
    async retainedCheckpoints(input: StatefulDeclaration, revision: string) {
        await this.binding(input); hex(revision);
        return this.guarded(async () => {const m = await this.load(); requireState(revision === m.revision, 'Retained inspection revision changed', 'stateful.stale-view');
            return {recovery: recoveryOf(this.declaration, m), checkpoints: [...m.undo].reverse().map(u => ({blockNum: u.block.blockNum, blockId: u.block.blockId})).concat([{...m.floor}])};});
    }
}

/** Explicit opt-in only. Pure configured-declaration checks occur before any native operation. */
export async function createMongoDbStatefulAdapter(options: MongoDbStatefulAdapterOptions): Promise<StatefulAdapter> {
    const declaration = await receiveDeclaration(options.declaration); return new MongoDbStatefulAdapter({...options}, declaration);
}
