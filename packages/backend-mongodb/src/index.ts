import { createHash } from 'node:crypto';
import {
    canonicalProjectionBatch,
    PROJECTION_CAPABILITIES,
    PROJECTION_LIMITS,
    ProjectionContractError,
    validateProjectionActivation,
    validateProjectionApply,
    validateProjectionDefinition,
    validateProjectionQuery,
    validateProjectionQueryInput,
    validateProjectionView,
    type ProjectionAdapter,
    type ProjectionAdapterCapabilities,
    type ProjectionApplyRequest,
    type ProjectionApplyResult,
    type ProjectionBinding,
    type ProjectionBlock,
    type ProjectionCheckpoint,
    type ProjectionDefinition,
    type ProjectionQuery,
    type ProjectionQueryResult,
    type ProjectionReadView,
} from '@eosrio/hyperion-sdk/projection';
import {
    ReadConcern,
    WriteConcern,
    type ClientSession,
    type Collection,
    type Db,
    type Document,
    type MongoClient,
} from 'mongodb';
import {
    assertReady,
    assertView,
    checkBinding,
    checkpointOf,
    GENESIS,
    hash,
    MAX_RECEIPTS,
    readView,
    sameBlock,
    sameCheckpoint,
    slot,
    snapshot,
    stableJson,
    STORAGE_VERSION,
    storedRecord,
    valid,
    validateMetadata,
    type PendingApplication,
    type ProjectionMetadata,
    type Receipt,
    type StoredRecord,
} from './contract.js';

export interface MongoDbProjectionAdapterOptions {
    /** Caller-owned client; this adapter never closes it. */
    readonly client: MongoClient;
    readonly databaseName: string;
    readonly backendId: string;
    readonly collectionPrefix?: string;
    readonly receiptRetention?: number;
    readonly operationTimeoutMS?: number;
    readonly transactionTimeoutMS?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
        throw new ProjectionContractError('projection.invalid-contract', `${name} must be an integer between 1 and ${maximum}`);
    }
    return selected;
}

function serverErrorCode(error: unknown, code: number): boolean {
    // The caller-owned client may load a different physical copy of the driver.
    return typeof error === 'object' && error !== null &&
        (error as { name?: unknown }).name === 'MongoServerError' &&
        (error as { code?: unknown }).code === code;
}

class MongoDbProjectionAdapter implements ProjectionAdapter {
    readonly capabilities: ProjectionAdapterCapabilities = Object.freeze({
        interfaceVersion: 1,
        supported: Object.freeze([...PROJECTION_CAPABILITIES]),
    });
    private readonly client: MongoClient;
    private readonly database: Db;
    private readonly backendId: string;
    private readonly prefix: string;
    private readonly metadata: Collection<ProjectionMetadata>;
    private readonly receiptRetention: number;
    private readonly operationTimeoutMS: number;
    private readonly transactionTimeoutMS: number;
    private readonly writeConcern = new WriteConcern('majority', undefined, true);

    constructor(options: MongoDbProjectionAdapterOptions) {
        if (!options || !options.client || typeof options.databaseName !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,48}$/.test(options.databaseName) ||
            typeof options.backendId !== 'string' || options.backendId.length === 0 ||
            Buffer.byteLength(options.backendId) > 256) {
            throw new ProjectionContractError('projection.invalid-contract', 'A client, bounded database name and backend identity are required');
        }
        this.prefix = options.collectionPrefix ?? 'h45_projection';
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(this.prefix)) {
            throw new ProjectionContractError('projection.invalid-contract', 'Collection prefix must use 1 to 32 lowercase identifier characters');
        }
        this.client = options.client;
        this.database = this.client.db(options.databaseName, { readPreference: 'primary', readConcern: new ReadConcern('majority') });
        this.backendId = options.backendId;
        this.receiptRetention = boundedInteger(options.receiptRetention, 256, MAX_RECEIPTS, 'receiptRetention');
        this.operationTimeoutMS = boundedInteger(options.operationTimeoutMS, 5000, 30000, 'operationTimeoutMS');
        this.transactionTimeoutMS = boundedInteger(options.transactionTimeoutMS, 15000, 60000, 'transactionTimeoutMS');
        this.metadata = this.database.collection<ProjectionMetadata>(`${this.prefix}_metadata`);
    }

    private records(binding: ProjectionBinding): Collection<StoredRecord> {
        return this.database.collection<StoredRecord>(`${this.prefix}_r_${hash(binding)}`);
    }

    private async load(binding: ProjectionBinding, session?: ClientSession): Promise<ProjectionMetadata> {
        const options = session ? { session } : { timeoutMS: this.operationTimeoutMS, readPreference: 'primary' as const, readConcern: { level: 'majority' as const } };
        const metadata = await this.metadata.findOne({ _id: slot(binding) }, options);
        if (metadata === null) {
            throw new ProjectionContractError('projection.not-initialized', 'Projection storage has not been initialized');
        }
        return validateMetadata(metadata, binding);
    }

    private async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
        const session = this.client.startSession({ causalConsistency: false });
        try {
            return await session.withTransaction(() => operation(session), {
                readConcern: { level: 'snapshot' },
                writeConcern: this.writeConcern,
                readPreference: 'primary',
                timeoutMS: this.transactionTimeoutMS,
                maxCommitTimeMS: this.operationTimeoutMS,
            });
        } finally {
            await session.endSession();
        }
    }

    private async guarded<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (error instanceof ProjectionContractError) throw error;
            const unavailable = new ProjectionContractError('projection.apply-unavailable', 'MongoDB projection operation did not complete; retry the same source or request');
            unavailable.cause = error;
            throw unavailable;
        }
    }

    private async assertTopology(): Promise<void> {
        const hello = await this.database.admin().command({ hello: 1 }, { timeoutMS: this.operationTimeoutMS, readPreference: 'primary' });
        const replicaSet = typeof hello.setName === 'string' && hello.setName.length > 0 && hello.isWritablePrimary === true;
        const sharded = hello.msg === 'isdbgrid';
        if ((!replicaSet && !sharded) || !Number.isFinite(hello.logicalSessionTimeoutMinutes) ||
            hello.logicalSessionTimeoutMinutes <= 0 || !Number.isSafeInteger(hello.maxWireVersion) ||
            hello.maxWireVersion < (sharded ? 8 : 7)) {
            throw new ProjectionContractError('projection.capability-unavailable', 'Portable MongoDB projections require an initialized transaction-capable replica set or sharded cluster');
        }
    }

    async initialize(input: ProjectionDefinition, inputBinding: ProjectionBinding, genesis: ProjectionCheckpoint): Promise<ProjectionReadView> {
        const definition = valid(validateProjectionDefinition(input));
        const binding = checkBinding(inputBinding, this.backendId);
        valid(validateProjectionActivation(definition, binding, this.capabilities));
        if (!genesis || !sameCheckpoint(genesis, GENESIS) || Object.keys(genesis).length !== 2) {
            throw new ProjectionContractError('projection.invalid-contract', 'This adapter initializes only explicit block-zero genesis with an all-zero block ID');
        }
        return this.guarded(async () => {
            await this.assertTopology();
            const candidate: ProjectionMetadata = {
                _id: slot(binding), storageVersion: STORAGE_VERSION, definition, definitionHash: hash(definition),
                binding, checkpoint: snapshot(GENESIS), initialized: false, pending: null, gap: null, receipts: [],
            };
            try {
                await this.metadata.insertOne(candidate, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS });
            } catch (error) {
                if (!serverErrorCode(error, 11000)) throw error;
            }
            const existing = await this.load(binding);
            if (existing.definitionHash !== candidate.definitionHash || stableJson(existing.definition) !== stableJson(candidate.definition)) {
                throw new ProjectionContractError('projection.invalid-contract', 'A projection binding cannot be reinitialized with another definition');
            }
            if (existing.initialized) {
                assertReady(existing);
                return readView(existing);
            }
            try {
                await this.database.createCollection(this.records(binding).collectionName, {
                    collation: { locale: 'simple' }, writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS,
                });
            } catch (error) {
                if (!serverErrorCode(error, 48)) throw error;
                const options = await this.records(binding).options({ timeoutMS: this.operationTimeoutMS });
                if (options.collation && options.collation.locale !== 'simple') {
                    throw new ProjectionContractError('projection.capability-unavailable', 'Projection key ordering requires simple MongoDB collation');
                }
                if (await this.records(binding).countDocuments({}, { limit: 1, timeoutMS: this.operationTimeoutMS }) !== 0) {
                    throw new ProjectionContractError('projection.invalid-contract', 'Genesis initialization cannot adopt preexisting projection records');
                }
            }
            const activated = await this.metadata.updateOne({
                _id: candidate._id, initialized: false, pending: null, gap: null, definitionHash: candidate.definitionHash,
                'checkpoint.blockNum': 0, 'checkpoint.blockId': GENESIS.blockId,
            }, { $set: { initialized: true } }, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS });
            if (activated.matchedCount !== 1) {
                const current = await this.load(binding);
                assertReady(current);
                return readView(current);
            }
            const current = await this.load(binding);
            assertReady(current);
            return readView(current);
        });
    }

    async open(input: ProjectionBinding): Promise<ProjectionReadView> {
        const binding = checkBinding(input, this.backendId);
        return this.guarded(async () => {
            const metadata = await this.load(binding);
            assertReady(metadata);
            return readView(metadata);
        });
    }

    private replay(metadata: ProjectionMetadata, request: ProjectionApplyRequest, digest: string): ProjectionApplyResult | undefined {
        const receipt = metadata.receipts.find(item => item.blockNum === request.block.blockNum || item.blockId === request.block.blockId);
        if (receipt) {
            if (!sameCheckpoint(receipt, request.block) || receipt.digest !== digest) {
                throw new ProjectionContractError('projection.conflicting-replay', 'A retained source receipt has different effects or source identity');
            }
            // Receipts prove durable completion while a separate gap may still fence reads.
            if (metadata.pending !== null) {
                throw new ProjectionContractError('projection.incomplete', 'A failed source application must recover before older receipts can complete');
            }
            return { status: 'duplicate', view: readView(metadata) };
        }
        if (request.block.blockNum <= metadata.checkpoint.blockNum) {
            throw new ProjectionContractError('projection.replay-unavailable', 'This older source is outside the retained replay receipts');
        }
        if (!sameCheckpoint(metadata.checkpoint, request.previous)) {
            throw new ProjectionContractError('projection.source-gap', 'Source does not immediately follow the completed projection checkpoint');
        }
        return undefined;
    }

    private assertGapAuthority(metadata: ProjectionMetadata, block: ProjectionBlock, digest: string | null): void {
        const gap = metadata.gap;
        if (gap === null) return;
        if (block.blockNum === gap.block.blockNum && (!sameBlock(block, gap.block) ||
            (digest !== null && gap.digest !== null && digest !== gap.digest))) {
            throw new ProjectionContractError('projection.conflicting-replay', 'Observed gap target must retain its exact source identity and known effects');
        }
        if (block.blockNum === gap.block.blockNum - 1 && block.blockId !== gap.block.previousBlockId) {
            throw new ProjectionContractError('projection.conflicting-replay', 'Missing source contradicts the observed gap target predecessor');
        }
    }

    private async recordGap(metadata: ProjectionMetadata, block: ProjectionBlock, digest: string | null, reason: string | null): Promise<never> {
        this.assertGapAuthority(metadata, block, digest);
        if (metadata.pending && metadata.pending.block.blockNum === block.blockNum - 1 &&
            metadata.pending.block.blockId !== block.previousBlockId) {
            throw new ProjectionContractError('projection.conflicting-replay', 'Observed future source contradicts the existing pending predecessor');
        }
        // One authority is retained. Additional future frames remain unacknowledged for replay.
        if (metadata.gap !== null && !sameBlock(metadata.gap.block, block)) {
            throw new ProjectionContractError('projection.apply-unavailable', 'Source gap recovery slot is occupied; retry this unadmitted future frame after recovery');
        }
        const gap: PendingApplication = {
            block: snapshot(block), digest: metadata.gap?.digest ?? digest, reason: metadata.gap?.reason ?? reason,
        };
        const stored = await this.metadata.findOneAndUpdate({
            _id: metadata._id, initialized: true, checkpoint: metadata.checkpoint,
            pending: metadata.pending, gap: metadata.gap,
        }, { $set: { gap } }, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after' });
        if (stored === null) {
            throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while recording its source gap; retry the same source');
        }
        throw new ProjectionContractError('projection.source-gap', 'Missing contiguous source inputs leave this projection durably incomplete');
    }

    async apply(input: ProjectionApplyRequest): Promise<ProjectionApplyResult> {
        // Capture and validate every source/mutation before the first asynchronous read.
        const captured = JSON.parse(canonicalProjectionBatch(input)) as ProjectionApplyRequest;
        const binding = checkBinding(captured.binding, this.backendId);
        return this.guarded(async () => {
            const initial = await this.load(binding);
            if (!initial.initialized) throw new ProjectionContractError('projection.not-initialized', 'Projection initialization has not completed');
            const request = valid(validateProjectionApply(initial.definition, captured));
            const digest = createHash('sha256').update(canonicalProjectionBatch(request)).digest('hex');
            this.assertGapAuthority(initial, request.block, digest);
            if (request.block.blockNum > initial.checkpoint.blockNum + 1) {
                return this.recordGap(initial, request.block, digest, null);
            }
            const duplicate = this.replay(initial, request, digest);
            if (duplicate) return duplicate;
            if (initial.pending !== null && (!sameBlock(initial.pending.block, request.block) ||
                (initial.pending.digest !== null && initial.pending.digest !== digest))) {
                throw new ProjectionContractError('projection.conflicting-replay', 'Pending source application must be resumed with its identical effects');
            }
            const pending: PendingApplication = { block: snapshot(request.block), digest, reason: initial.pending?.reason ?? null };
            const prepared = await this.metadata.findOneAndUpdate({
                _id: initial._id, initialized: true, checkpoint: initial.checkpoint, pending: initial.pending, gap: initial.gap,
            }, { $set: { pending } }, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after' });
            if (prepared === null) {
                throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while preparing source application; retry the same source');
            }
            return this.transaction(async session => {
                const metadata = await this.load(binding, session);
                this.assertGapAuthority(metadata, request.block, digest);
                const completed = this.replay(metadata, request, digest);
                if (completed) return completed;
                if (!metadata.pending || !sameBlock(metadata.pending.block, request.block) || metadata.pending.digest !== digest) {
                    throw new ProjectionContractError('projection.incomplete', 'Durable source intent changed before transaction application');
                }
                const records = this.records(binding);
                for (const mutation of request.mutations) {
                    if (mutation.kind === 'put') {
                        await records.replaceOne({ _id: mutation.key }, storedRecord(mutation.key, mutation.value), { upsert: true, session });
                    } else {
                        await records.deleteOne({ _id: mutation.key }, { session });
                    }
                }
                const checkpoint = checkpointOf(request.block);
                const receipt: Receipt = { ...checkpoint, digest };
                const receipts = [...metadata.receipts, receipt].slice(-this.receiptRetention);
                const gap = metadata.gap !== null && sameBlock(metadata.gap.block, request.block) ? null : metadata.gap;
                const result = await this.metadata.updateOne({
                    _id: metadata._id, checkpoint: metadata.checkpoint, pending: metadata.pending, gap: metadata.gap,
                }, { $set: { checkpoint, receipts, pending: null, gap } }, { session });
                if (result.matchedCount !== 1) {
                    throw new ProjectionContractError('projection.incomplete', 'Source intent changed before durable completion');
                }
                return { status: 'applied' as const, view: snapshot({ binding, checkpoint }) };
            });
        });
    }

    async markIncomplete(input: ProjectionBinding, failedBlock: ProjectionBlock, reason: string): Promise<void> {
        const binding = checkBinding(input, this.backendId);
        const captured = JSON.parse(canonicalProjectionBatch({
            binding,
            previous: { blockNum: failedBlock?.blockNum - 1, blockId: failedBlock?.previousBlockId },
            block: failedBlock,
            mutations: [],
        })) as ProjectionApplyRequest;
        if (typeof reason !== 'string' || reason.length === 0 || Buffer.byteLength(reason) > 4096) {
            throw new ProjectionContractError('projection.invalid-contract', 'Incomplete reason must be nonempty and bounded to 4096 UTF-8 bytes');
        }
        return this.guarded(async () => {
            const metadata = await this.load(binding);
            if (!metadata.initialized) throw new ProjectionContractError('projection.not-initialized', 'Projection initialization has not completed');
            this.assertGapAuthority(metadata, captured.block, null);
            if (captured.block.blockNum > metadata.checkpoint.blockNum + 1) {
                return this.recordGap(metadata, captured.block, null, reason);
            }
            const request = valid(validateProjectionApply(metadata.definition, {
                binding, previous: metadata.checkpoint, block: captured.block, mutations: [],
            }));
            if (metadata.pending && !sameBlock(metadata.pending.block, request.block)) {
                throw new ProjectionContractError('projection.conflicting-replay', 'A different incomplete source already owns this projection');
            }
            const pending: PendingApplication = {
                block: snapshot(request.block), digest: metadata.pending?.digest ?? null, reason,
            };
            const result = await this.metadata.updateOne({
                _id: metadata._id, initialized: true, checkpoint: metadata.checkpoint, pending: metadata.pending, gap: metadata.gap,
            }, { $set: { pending } }, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS });
            if (result.matchedCount !== 1) {
                throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while recording incomplete source; retry its failure marker');
            }
        });
    }

    async query(inputView: ProjectionReadView, inputQuery: ProjectionQuery): Promise<ProjectionQueryResult> {
        const view = valid(validateProjectionView(inputView));
        const captured = valid(validateProjectionQueryInput(inputQuery));
        checkBinding(view.binding, this.backendId);
        return this.guarded(async () => {
            const initial = await this.load(view.binding);
            assertView(initial, view);
            const query = valid(validateProjectionQuery(initial.definition, captured));
            const result = await this.transaction(async session => {
                const metadata = await this.load(view.binding, session);
                assertView(metadata, view);
                const filter: Document = {};
                for (const term of query.filter) {
                    // SDK field identifiers are single safe path segments, validated above.
                    const name = `value.${term.field}`;
                    // An explicit $eq keeps values from being interpreted as operators.
                    const predicate = { [name]: { $eq: term.value } };
                    (filter.$and ??= []).push(predicate);
                }
                const pageFilter = query.afterKey === undefined ? filter : { $and: [filter, { _id: { $gt: query.afterKey } }] };
                const records = this.records(view.binding);
                const cursor = records.find(pageFilter, {
                    session, collation: { locale: 'simple' }, projection: { _id: 1, value: 1 },
                    batchSize: Math.min(query.limit + 1, 16),
                })
                    .sort({ _id: 1 }).limit(query.limit + 1);
                const rows: { key: string; value: StoredRecord['value'] }[] = [];
                // Reserve the response envelope and the largest escaped cursor/count suffix.
                const rowBudget = PROJECTION_LIMITS.queryBytes - Buffer.byteLength(stableJson({ view, rows: [] })) -
                    PROJECTION_LIMITS.keyBytes * 6 - 128;
                let bytes = 0;
                let more = false;
                try {
                    for await (const record of cursor) {
                        const row = { key: record._id, value: snapshot(record.value) };
                        const added = Buffer.byteLength(stableJson(row)) + (rows.length > 0 ? 1 : 0);
                        if (rows.length >= query.limit || bytes + added > rowBudget) {
                            if (rows.length === 0) {
                                throw new ProjectionContractError('projection.incomplete', 'Stored projection record exceeds the portable response budget');
                            }
                            more = true;
                            break;
                        }
                        rows.push(row);
                        bytes += added;
                    }
                } finally {
                    await cursor.close();
                }
                const response: ProjectionQueryResult = {
                    view: snapshot(view), rows,
                    ...(more ? { nextAfterKey: rows[rows.length - 1].key } : {}),
                };
                if (query.count) {
                    const counted = await records.countDocuments(filter, { session, collation: { locale: 'simple' }, limit: query.count.upTo + 1 });
                    return { ...response, count: { value: Math.min(counted, query.count.upTo), exact: counted <= query.count.upTo } };
                }
                return response;
            });
            // A transaction snapshot alone must not reopen a view after a known failure/cutover.
            assertView(await this.load(view.binding), view);
            return result;
        });
    }
}

/** Create a native adapter; topology and projection storage are checked on initialize. */
export function createMongoDbProjectionAdapter(options: MongoDbProjectionAdapterOptions): ProjectionAdapter {
    return new MongoDbProjectionAdapter(options);
}
