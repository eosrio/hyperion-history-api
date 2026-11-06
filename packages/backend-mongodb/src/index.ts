import { createHash } from 'node:crypto';
export {createMongoDbContextualRecoveryAdapter} from './contextual.js';
import {
    canonicalProjectionBatch,
    PROJECTION_CAPABILITIES,
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
    type ProjectionRecoveryView,
} from '@eosrio/hyperion-sdk/projection';
import { MongoProjectionStorage, serverErrorCode, type MongoDbProjectionAdapterOptions } from './storage.js';
export type { MongoDbProjectionAdapterOptions } from './storage.js';
export { createMongoDbRollbackAdapter, type MongoDbRollbackAdapterOptions } from './rollback.js';
import {
    assertReady,
    assertView,
    checkBinding,
    checkpointOf,
    GENESIS,
    hash,
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
} from './contract.js';

class MongoDbProjectionAdapter extends MongoProjectionStorage<ProjectionMetadata> implements ProjectionAdapter {
    readonly capabilities: ProjectionAdapterCapabilities = Object.freeze({
        interfaceVersion: 1,
        supported: Object.freeze([...PROJECTION_CAPABILITIES]),
    });

    constructor(options: MongoDbProjectionAdapterOptions) {
        super(options, validateMetadata);
    }

    async initialize(input: ProjectionDefinition, inputBinding: ProjectionBinding, genesis: ProjectionCheckpoint): Promise<ProjectionReadView> {
        const definition = valid(validateProjectionDefinition(input));
        const binding = checkBinding(inputBinding, this.backendId);
        valid(validateProjectionActivation(definition, binding, this.capabilities));
        const capturedGenesis = valid(validateProjectionView({ binding, checkpoint: genesis })).checkpoint;
        if (!sameCheckpoint(capturedGenesis, GENESIS)) {
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
                _id: candidate._id, storageVersion: STORAGE_VERSION, initialized: false, pending: null, gap: null, definitionHash: candidate.definitionHash,
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

    async recovery(input: ProjectionBinding): Promise<ProjectionRecoveryView> {
        const binding = checkBinding(input, this.backendId);
        return this.guarded(async () => {
            // load validates the full immutable binding and persisted checkpoint/intent/receipt
            // invariants using majority-visible primary storage. Pending work fences open/query,
            // but must not hide the completed checkpoint from a restarting source scheduler.
            const metadata = await this.load(binding);
            return snapshot({binding: metadata.binding, checkpoint: metadata.checkpoint,
                initialized: metadata.initialized, pending: metadata.pending, gap: metadata.gap});
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
            _id: metadata._id, storageVersion: STORAGE_VERSION, initialized: true, checkpoint: metadata.checkpoint,
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
                _id: initial._id, storageVersion: STORAGE_VERSION, initialized: true, checkpoint: initial.checkpoint, pending: initial.pending, gap: initial.gap,
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
                    _id: metadata._id, storageVersion: STORAGE_VERSION, checkpoint: metadata.checkpoint, pending: metadata.pending, gap: metadata.gap,
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
            const result = await this.metadata.findOneAndUpdate({
                _id: metadata._id, storageVersion: STORAGE_VERSION, initialized: true, checkpoint: metadata.checkpoint, pending: metadata.pending, gap: metadata.gap,
            }, { $set: { pending } }, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after' });
            if (result === null) {
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
                return this.queryRecords(view, query, session);
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
