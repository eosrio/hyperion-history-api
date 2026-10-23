import { createHash, randomBytes } from 'node:crypto';
import {
    canonicalProjectionBatch, PROJECTION_ROLLBACK_CAPABILITIES, PROJECTION_ROLLBACK_LIMITS,
    ProjectionContractError, validateProjectionDefinition, validateProjectionQuery, validateProjectionQueryInput, validateProjectionView,
    validateProjectionRollbackActivation, validateProjectionRollbackApply, validateProjectionRollbackApplyInput, validateProjectionRollbackIncomplete,
    validateProjectionRollbackRequest, validateProjectionRollbackView,
    type ProjectionApplyRequest, type ProjectionBinding, type ProjectionBlock, type ProjectionCheckpoint,
    type ProjectionDefinition, type ProjectionQuery, type ProjectionRollbackAdapter,
    type ProjectionRollbackAdapterCapabilities, type ProjectionRollbackApplyRequest, type ProjectionRollbackApplyResult,
    type ProjectionRollbackIncompleteRequest, type ProjectionRollbackQueryResult, type ProjectionRollbackReadView,
    type ProjectionRollbackRecoveryView, type ProjectionRollbackRequest, type ProjectionRollbackResult,
    type ProjectionRollbackState,
} from '@eosrio/hyperion-sdk/projection';
import { type Collection, type Document, type Filter } from 'mongodb';
import {
    checkBinding, checkpointOf, GENESIS, hash, sameBlock, sameCheckpoint, slot, snapshot, stableJson,
    STORAGE_VERSION, storedRecord, valid, validateMetadata, type PendingApplication, type Receipt,
} from './contract.js';
import {
    assertNotRollingBack, assertRevision, assertRollbackReady, assertRollbackView, bsonBytes,
    invalidStorage, retainedBytes, ROLLBACK_STORAGE_VERSION, rollbackRecovery,
    rollbackView, storedRollbackCheckpoint, storedRollbackMetadata, undoImage, validateRollbackMetadata, validateRollbackState, validateUndoImages,
    type RollbackMetadata, type RollbackPolicy, type UndoDescriptor, type UndoImage,
} from './rollback-contract.js';
import {
    boundedInteger, MongoProjectionStorage, serverErrorCode, type MongoDbProjectionAdapterOptions,
} from './storage.js';

export interface MongoDbRollbackAdapterOptions extends MongoDbProjectionAdapterOptions {
    readonly rollbackRetentionBlocks?: number;
    readonly rollbackRetentionBytes?: number;
    readonly rollbackMaxBlockBytes?: number;
}

class MongoDbRollbackAdapter extends MongoProjectionStorage<RollbackMetadata> implements ProjectionRollbackAdapter {
    readonly capabilities: ProjectionRollbackAdapterCapabilities = Object.freeze({
        interfaceVersion: 2, supported: PROJECTION_ROLLBACK_CAPABILITIES,
    });
    private readonly policy: RollbackPolicy;

    constructor(options: MongoDbRollbackAdapterOptions) {
        const maxBytes = boundedInteger(options?.rollbackRetentionBytes, 64 * 1024 * 1024,
            PROJECTION_ROLLBACK_LIMITS.retainedBytes, 'rollbackRetentionBytes');
        const policy = {
            maxBlocks: boundedInteger(options?.rollbackRetentionBlocks, 256,
                PROJECTION_ROLLBACK_LIMITS.retainedBlocks, 'rollbackRetentionBlocks'),
            maxBytes,
            maxBlockBytes: boundedInteger(options?.rollbackMaxBlockBytes, Math.min(16 * 1024 * 1024, maxBytes),
                maxBytes, 'rollbackMaxBlockBytes'),
        };
        super(options, (input, binding) => validateRollbackMetadata(input, binding, policy));
        this.policy = policy;
    }

    private images(binding: ProjectionBinding): Collection<UndoImage> {
        return this.database.collection<UndoImage>(`${this.prefix}_u_${hash(binding)}`);
    }

    private sourceFilter(metadata: RollbackMetadata): Filter<RollbackMetadata> {
        return { _id: metadata._id, storageVersion: ROLLBACK_STORAGE_VERSION,
            revision: metadata.revision, initialized: metadata.initialized,
            checkpoint: storedRollbackCheckpoint(metadata.checkpoint, metadata.revision),
            pending: metadata.pending, gap: metadata.gap, rollback: metadata.rollback };
    }

    private async ensureCollection(name: string, empty: boolean): Promise<void> {
        try {
            await this.database.createCollection(name, {
                collation: { locale: 'simple' }, writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS,
            });
        } catch (error) {
            if (!serverErrorCode(error, 48)) throw error;
            const collection = this.database.collection(name);
            const options = await collection.options({ timeoutMS: this.operationTimeoutMS });
            if (options.collation && options.collation.locale !== 'simple') {
                throw new ProjectionContractError('projection.capability-unavailable', 'Projection storage requires simple MongoDB collation');
            }
            if (empty && await collection.countDocuments({}, { limit: 1, timeoutMS: this.operationTimeoutMS }) !== 0) {
                throw new ProjectionContractError('projection.invalid-contract', 'Initialization cannot adopt preexisting projection effects or undo data');
            }
        }
    }

    async initialize(input: ProjectionDefinition, inputBinding: ProjectionBinding,
        genesis: ProjectionCheckpoint): Promise<ProjectionRollbackReadView> {
        const definition = valid(validateProjectionDefinition(input));
        const binding = checkBinding(inputBinding, this.backendId);
        valid(validateProjectionRollbackActivation(definition, binding, this.capabilities));
        const capturedGenesis = valid(validateProjectionView({ binding, checkpoint: genesis })).checkpoint;
        if (!sameCheckpoint(capturedGenesis, GENESIS)) {
            throw new ProjectionContractError('projection.invalid-contract', 'This adapter initializes only explicit block-zero genesis');
        }
        return this.guarded(async () => {
            await this.assertTopology();
            const candidate: RollbackMetadata = {
                _id: slot(binding), storageVersion: ROLLBACK_STORAGE_VERSION, definition, definitionHash: hash(definition),
                binding, checkpoint: snapshot(GENESIS), initialized: false, pending: null, gap: null, receipts: [],
                revision: randomBytes(32).toString('hex'), policy: this.policy, coverageFloor: snapshot(GENESIS),
                floorReceipt: null, undo: [], rollback: null,
            };
            try {
                await this.metadata.insertOne(storedRollbackMetadata(candidate), { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS });
            } catch (error) {
                if (!serverErrorCode(error, 11000)) throw error;
            }
            const raw = await this.metadata.findOne({ _id: slot(binding) }, {
                readConcern: { level: 'majority' }, readPreference: 'primary', timeoutMS: this.operationTimeoutMS,
            });
            if (raw === null) return invalidStorage();
            if (raw.storageVersion as string === STORAGE_VERSION) {
                // Only this explicit v2 initialization may adopt v1. Receipts are never undo data.
                const legacy = validateMetadata(raw, binding);
                if (legacy.definitionHash !== candidate.definitionHash || stableJson(legacy.definition) !== stableJson(definition)) {
                    throw new ProjectionContractError('projection.invalid-contract', 'A projection binding cannot adopt another definition');
                }
                await this.ensureCollection(this.records(binding).collectionName, !legacy.initialized);
                await this.ensureCollection(this.images(binding).collectionName, true);
                await this.transaction(async session => {
                    const currentRaw = await this.metadata.findOne({ _id: slot(binding) }, { session });
                    if (currentRaw?.storageVersion === ROLLBACK_STORAGE_VERSION) {
                        validateRollbackMetadata(currentRaw, binding, this.policy);
                        return;
                    }
                    const current = validateMetadata(currentRaw, binding);
                    if (current.definitionHash !== candidate.definitionHash) return invalidStorage();
                    const upgraded: RollbackMetadata = {
                        ...current, storageVersion: ROLLBACK_STORAGE_VERSION, initialized: true,
                        revision: candidate.revision, policy: this.policy, coverageFloor: snapshot(current.checkpoint),
                        floorReceipt: current.checkpoint.blockNum === 0 ? null : snapshot(current.receipts[current.receipts.length - 1]),
                        undo: [], rollback: null,
                    };
                    validateRollbackState(upgraded, binding, this.policy);
                    const replaced = await this.database.collection<Document & { _id: string }>(this.metadata.collectionName).replaceOne({
                        _id: current._id, storageVersion: STORAGE_VERSION,
                        initialized: current.initialized, checkpoint: current.checkpoint, pending: current.pending, gap: current.gap,
                    }, storedRollbackMetadata(upgraded), { session });
                    if (replaced.matchedCount !== 1) {
                        throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while enabling revision-fenced rollback');
                    }
                });
            } else {
                const current = validateRollbackMetadata(raw, binding, this.policy);
                if (current.definitionHash !== candidate.definitionHash || stableJson(current.definition) !== stableJson(definition)) {
                    throw new ProjectionContractError('projection.invalid-contract', 'A projection binding cannot be reinitialized with another definition');
                }
                if (!current.initialized) {
                    await this.ensureCollection(this.records(binding).collectionName, true);
                    await this.ensureCollection(this.images(binding).collectionName, true);
                    const activated = await this.metadata.updateOne(this.sourceFilter(current), { $set: { initialized: true } }, {
                        writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS,
                    });
                    if (activated.matchedCount !== 1) {
                        throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while initializing rollback storage');
                    }
                }
            }
            const current = await this.load(binding);
            assertRollbackReady(current);
            return rollbackView(current);
        });
    }

    async open(input: ProjectionBinding): Promise<ProjectionRollbackReadView> {
        const binding = checkBinding(input, this.backendId);
        return this.guarded(async () => {
            const metadata = await this.load(binding);
            assertRollbackReady(metadata);
            return rollbackView(metadata);
        });
    }

    async recovery(input: ProjectionBinding): Promise<ProjectionRollbackRecoveryView> {
        const binding = checkBinding(input, this.backendId);
        return this.guarded(async () => rollbackRecovery(await this.load(binding)));
    }

    private assertWriter(metadata: RollbackMetadata, revision: string): void {
        assertRevision(metadata, revision);
        if (!metadata.initialized) throw new ProjectionContractError('projection.not-initialized', 'Projection initialization has not completed');
        assertNotRollingBack(metadata);
    }

    private replay(metadata: RollbackMetadata, request: ProjectionApplyRequest, digest: string): ProjectionRollbackApplyResult | undefined {
        const receipt = metadata.receipts.find(item => item.blockNum === request.block.blockNum || item.blockId === request.block.blockId);
        if (receipt) {
            if (!sameCheckpoint(receipt, request.block) || receipt.digest !== digest) {
                throw new ProjectionContractError('projection.conflicting-replay', 'Retained source receipt differs in effects or source identity');
            }
            if (metadata.pending !== null) throw new ProjectionContractError('projection.incomplete', 'Pending source must recover before older receipts complete');
            return { status: 'duplicate', view: rollbackView(metadata) };
        }
        if (request.block.blockNum <= metadata.checkpoint.blockNum) {
            throw new ProjectionContractError('projection.replay-unavailable', 'Older source is outside the retained replay receipts');
        }
        if (!sameCheckpoint(metadata.checkpoint, request.previous)) {
            throw new ProjectionContractError('projection.source-gap', 'Source does not immediately follow the completed checkpoint');
        }
        return undefined;
    }

    private assertGapAuthority(metadata: RollbackMetadata, block: ProjectionBlock, digest: string | null): void {
        const gap = metadata.gap;
        if (gap === null) return;
        if (block.blockNum === gap.block.blockNum && (!sameBlock(block, gap.block) ||
            (digest !== null && gap.digest !== null && digest !== gap.digest))) {
            throw new ProjectionContractError('projection.conflicting-replay', 'Observed gap target must retain its exact source and effects');
        }
        if (block.blockNum === gap.block.blockNum - 1 && block.blockId !== gap.block.previousBlockId) {
            throw new ProjectionContractError('projection.conflicting-replay', 'Missing source contradicts the gap target predecessor');
        }
    }

    private async recordGap(metadata: RollbackMetadata, block: ProjectionBlock, digest: string | null, reason: string | null): Promise<never> {
        this.assertGapAuthority(metadata, block, digest);
        if (metadata.pending && metadata.pending.block.blockNum === block.blockNum - 1 && metadata.pending.block.blockId !== block.previousBlockId) {
            throw new ProjectionContractError('projection.conflicting-replay', 'Future source contradicts the pending predecessor');
        }
        if (metadata.gap !== null && !sameBlock(metadata.gap.block, block)) {
            throw new ProjectionContractError('projection.apply-unavailable', 'Source gap recovery slot is occupied');
        }
        const gap: PendingApplication = { block: snapshot(block), digest: metadata.gap?.digest ?? digest, reason: metadata.gap?.reason ?? reason };
        const changed = await this.metadata.findOneAndUpdate(this.sourceFilter(metadata), { $set: { gap } }, {
            writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after',
        });
        if (changed === null) throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while recording its source gap');
        throw new ProjectionContractError('projection.source-gap', 'Missing source inputs leave this projection durably incomplete');
    }

    async apply(input: ProjectionRollbackApplyRequest): Promise<ProjectionRollbackApplyResult> {
        // Canonical capture validates the batch before I/O; the full envelope is validated as well.
        const captured = valid(validateProjectionRollbackApplyInput(input));
        const binding = checkBinding(captured.batch.binding, this.backendId);
        return this.guarded(async () => {
            const initial = await this.load(binding);
            this.assertWriter(initial, captured.revision);
            const envelope = valid(validateProjectionRollbackApply(initial.definition, captured));
            const request = envelope.batch;
            const digest = createHash('sha256').update(canonicalProjectionBatch(request)).digest('hex');
            this.assertGapAuthority(initial, request.block, digest);
            if (request.block.blockNum > initial.checkpoint.blockNum + 1) return this.recordGap(initial, request.block, digest, null);
            const duplicate = this.replay(initial, request, digest);
            if (duplicate) return duplicate;
            if (initial.pending !== null && (!sameBlock(initial.pending.block, request.block) ||
                (initial.pending.digest !== null && initial.pending.digest !== digest))) {
                throw new ProjectionContractError('projection.conflicting-replay', 'Pending source must resume with identical effects');
            }
            const pending: PendingApplication = { block: snapshot(request.block), digest, reason: initial.pending?.reason ?? null };
            const prepared = await this.metadata.findOneAndUpdate(this.sourceFilter(initial), { $set: { pending } }, {
                writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after',
            });
            if (prepared === null) throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while preparing source application');
            return this.transaction(async session => {
                const metadata = await this.load(binding, session);
                this.assertWriter(metadata, envelope.revision);
                this.assertGapAuthority(metadata, request.block, digest);
                const completed = this.replay(metadata, request, digest);
                if (completed) return completed;
                if (!metadata.pending || !sameBlock(metadata.pending.block, request.block) || metadata.pending.digest !== digest) {
                    throw new ProjectionContractError('projection.incomplete', 'Durable source intent changed before application');
                }
                const records = this.records(binding), images: UndoImage[] = [];
                let imageBytes = 0;
                for (const key of new Set(request.mutations.map(mutation => mutation.key))) {
                    const previous = await records.findOne({ _id: key }, { session });
                    if (previous !== null && (Object.keys(previous).sort().join(',') !== '_id,value' ||
                        previous._id !== key || previous.value === null || typeof previous.value !== 'object')) return invalidStorage();
                    const image = undoImage(request.block.blockId, key, previous === null ? null : previous.value);
                    imageBytes += bsonBytes(image);
                    if (imageBytes > this.policy.maxBlockBytes) {
                        throw new ProjectionContractError('projection.apply-unavailable', 'Source before-images exceed the configured per-block undo budget');
                    }
                    images.push(image);
                }
                images.sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
                const descriptor: UndoDescriptor = { block: snapshot(request.block), digest, count: images.length, imageBytes, imagesHash: hash(images) };
                if (retainedBytes([descriptor]) > this.policy.maxBlockBytes) {
                    throw new ProjectionContractError('projection.apply-unavailable', 'Source undo descriptor and before-images exceed the configured per-block budget');
                }
                validateUndoImages(images, descriptor, metadata);
                for (const image of images) await this.images(binding).insertOne(image, { session });
                for (const mutation of request.mutations) {
                    if (mutation.kind === 'put') await records.replaceOne({ _id: mutation.key }, storedRecord(mutation.key, mutation.value), { upsert: true, session });
                    else await records.deleteOne({ _id: mutation.key }, { session });
                }
                const undo = [...metadata.undo, descriptor];
                let coverageFloor = metadata.coverageFloor, floorReceipt = metadata.floorReceipt;
                while (undo.length > this.policy.maxBlocks || retainedBytes(undo) > this.policy.maxBytes) {
                    const removed = undo.shift()!;
                    await this.images(binding).deleteMany({ blockId: removed.block.blockId }, { session });
                    coverageFloor = checkpointOf(removed.block);
                    floorReceipt = { ...coverageFloor, digest: removed.digest };
                }
                const checkpoint = checkpointOf(request.block);
                const receipt: Receipt = { ...checkpoint, digest };
                const receipts = [...metadata.receipts, receipt].slice(-this.receiptRetention);
                const gap = metadata.gap !== null && sameBlock(metadata.gap.block, request.block) ? null : metadata.gap;
                const next: RollbackMetadata = { ...metadata, checkpoint, receipts, pending: null, gap, undo, coverageFloor, floorReceipt };
                validateRollbackState(next, binding, this.policy);
                const result = await this.metadata.updateOne(this.sourceFilter(metadata), {
                    $set: { checkpoint: storedRollbackCheckpoint(checkpoint, metadata.revision), receipts, pending: null, gap, undo, coverageFloor, floorReceipt },
                }, { session });
                if (result.matchedCount !== 1) throw new ProjectionContractError('projection.incomplete', 'Source intent changed before durable completion');
                return { status: 'applied' as const, view: rollbackView(next) };
            });
        });
    }

    async markIncomplete(input: ProjectionRollbackIncompleteRequest): Promise<void> {
        const request = valid(validateProjectionRollbackIncomplete(input));
        const binding = checkBinding(request.binding, this.backendId);
        return this.guarded(async () => {
            const metadata = await this.load(binding);
            this.assertWriter(metadata, request.revision);
            this.assertGapAuthority(metadata, request.block, null);
            if (request.block.blockNum > metadata.checkpoint.blockNum + 1) return this.recordGap(metadata, request.block, null, request.reason);
            if (request.block.blockNum !== metadata.checkpoint.blockNum + 1 || request.block.previousBlockId !== metadata.checkpoint.blockId) {
                throw new ProjectionContractError('projection.source-gap', 'Incomplete source must follow the exact completed checkpoint');
            }
            if (metadata.pending && !sameBlock(metadata.pending.block, request.block)) {
                throw new ProjectionContractError('projection.conflicting-replay', 'Another incomplete source owns this projection');
            }
            const pending: PendingApplication = { block: snapshot(request.block), digest: metadata.pending?.digest ?? null, reason: request.reason };
            const changed = await this.metadata.findOneAndUpdate(this.sourceFilter(metadata), { $set: { pending } }, {
                writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after',
            });
            if (changed === null) throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while recording incomplete source');
        });
    }

    private sameOperation(state: ProjectionRollbackState, request: ProjectionRollbackRequest): boolean {
        return state.operationId === request.operationId && state.sourceRevision === request.revision &&
            sameCheckpoint(state.from, request.from) && sameCheckpoint(state.ancestor, request.ancestor);
    }

    private covered(metadata: RollbackMetadata, ancestor: ProjectionCheckpoint): boolean {
        return sameCheckpoint(ancestor, metadata.coverageFloor) || metadata.undo.some(item => sameCheckpoint(item.block, ancestor));
    }

    private async undoOne(binding: ProjectionBinding, request: ProjectionRollbackRequest): Promise<RollbackMetadata> {
        return this.transaction(async session => {
            const metadata = await this.load(binding, session);
            const operation = metadata.rollback;
            if (!operation || !this.sameOperation(operation, request)) {
                throw new ProjectionContractError('projection.stale-revision', 'Another recovery owns this projection');
            }
            if (operation.status !== 'running') return metadata;
            let checkpoint = metadata.checkpoint, undo = [...metadata.undo], receipts = [...metadata.receipts];
            if (!sameCheckpoint(checkpoint, operation.ancestor)) {
                const descriptor = undo.pop();
                if (!descriptor || !sameCheckpoint(descriptor.block, checkpoint)) return invalidStorage();
                const rawImages = await this.images(binding).find({ blockId: descriptor.block.blockId }, { session })
                    .sort({ _id: 1 }).limit(descriptor.count + 1).toArray();
                const images = validateUndoImages(rawImages, descriptor, metadata);
                const records = this.records(binding);
                for (const image of images) {
                    if (image.before === null) await records.deleteOne({ _id: image.key }, { session });
                    else await records.replaceOne({ _id: image.key }, storedRecord(image.key, image.before), { upsert: true, session });
                }
                await this.images(binding).deleteMany({ blockId: descriptor.block.blockId }, { session });
                checkpoint = { blockNum: descriptor.block.blockNum - 1, blockId: descriptor.block.previousBlockId };
                receipts = receipts.filter(item => item.blockNum <= checkpoint.blockNum);
                if (checkpoint.blockNum > 0 && !receipts.some(item => sameCheckpoint(item, checkpoint))) {
                    const retained = undo[undo.length - 1];
                    const receipt = retained && sameCheckpoint(retained.block, checkpoint)
                        ? { ...checkpoint, digest: retained.digest } : metadata.floorReceipt;
                    if (!receipt || !sameCheckpoint(receipt, checkpoint)) return invalidStorage();
                    receipts.push(snapshot(receipt));
                }
            }
            const rollback: ProjectionRollbackState = {
                ...operation, status: sameCheckpoint(checkpoint, operation.ancestor) ? 'complete' : 'running',
            };
            const next: RollbackMetadata = { ...metadata, checkpoint, receipts, undo, rollback };
            validateRollbackState(next, binding, this.policy);
            const changed = await this.metadata.updateOne(this.sourceFilter(metadata), {
                $set: { checkpoint: storedRollbackCheckpoint(checkpoint, metadata.revision), receipts, undo, rollback },
            }, { session });
            if (changed.matchedCount !== 1) throw new ProjectionContractError('projection.incomplete', 'Rollback intent changed before durable undo');
            return next;
        });
    }

    async rollback(input: ProjectionRollbackRequest): Promise<ProjectionRollbackResult> {
        const request = valid(validateProjectionRollbackRequest(input));
        const binding = checkBinding(request.binding, this.backendId);
        return this.guarded(async () => {
            let metadata = await this.load(binding);
            const previous = metadata.rollback;
            if (previous && previous.operationId === request.operationId) {
                if (!this.sameOperation(previous, request)) {
                    throw new ProjectionContractError('projection.conflicting-replay', 'Rollback operation identity was reused with a different request');
                }
                if (previous.status === 'complete') return { status: 'duplicate', recovery: rollbackRecovery(metadata) };
                if (previous.status === 'unavailable') {
                    throw new ProjectionContractError('projection.rollback-unavailable', previous.reason!);
                }
            } else {
                this.assertWriter(metadata, request.revision);
                if (!sameCheckpoint(metadata.checkpoint, request.from)) {
                    throw new ProjectionContractError('projection.stale-view', 'Rollback must start at the exact completed checkpoint');
                }
                const available = this.covered(metadata, request.ancestor);
                const rollback: ProjectionRollbackState = {
                    operationId: request.operationId, sourceRevision: request.revision, from: snapshot(request.from),
                    ancestor: snapshot(request.ancestor), status: available ? 'running' : 'unavailable',
                    reason: available ? null : 'Requested ancestor is outside the retained exact-branch undo coverage; historical recovery or qualified reinitialization is required',
                };
                const revision = randomBytes(32).toString('hex');
                const next: RollbackMetadata = { ...metadata, revision, rollback, pending: null, gap: null };
                validateRollbackState(next, binding, this.policy);
                const admitted = await this.metadata.findOneAndUpdate(this.sourceFilter(metadata), {
                    $set: { revision, checkpoint: storedRollbackCheckpoint(metadata.checkpoint, revision), rollback, pending: null, gap: null },
                }, { writeConcern: this.writeConcern, timeoutMS: this.operationTimeoutMS, returnDocument: 'after' });
                if (admitted === null) throw new ProjectionContractError('projection.apply-unavailable', 'Projection changed while admitting rollback');
                metadata = validateRollbackMetadata(admitted, binding, this.policy);
                if (!available) throw new ProjectionContractError('projection.rollback-unavailable', rollback.reason!);
            }
            for (let step = 0; step < request.maxBlocks && metadata.rollback?.status === 'running'; step++) {
                metadata = await this.undoOne(binding, request);
            }
            return { status: metadata.rollback?.status === 'complete' ? 'rolled-back' : 'in-progress', recovery: rollbackRecovery(metadata) };
        });
    }

    async query(input: ProjectionRollbackReadView, queryInput: ProjectionQuery): Promise<ProjectionRollbackQueryResult> {
        const view = valid(validateProjectionRollbackView(input));
        const captured = valid(validateProjectionQueryInput(queryInput));
        checkBinding(view.binding, this.backendId);
        return this.guarded(async () => {
            const metadata = await this.load(view.binding);
            assertRollbackView(metadata, view);
            const query = valid(validateProjectionQuery(metadata.definition, captured));
            const result = await this.transaction(async session => {
                assertRollbackView(await this.load(view.binding, session), view);
                return this.queryRecords(view, query, session);
            });
            assertRollbackView(await this.load(view.binding), view);
            return result;
        });
    }
}

/** Explicit opt-in: initialization upgrades only the selected immutable projection instance. */
export function createMongoDbRollbackAdapter(options: MongoDbRollbackAdapterOptions): ProjectionRollbackAdapter {
    return new MongoDbRollbackAdapter(options);
}
