import {
    PROJECTION_LIMITS, PROJECTION_ROLLBACK_LIMITS, ProjectionContractError,
    validateProjectionApply, validateProjectionRollbackRecovery,
    type ProjectionBinding, type ProjectionBlock, type ProjectionCheckpoint,
    type ProjectionRecord, type ProjectionRollbackReadView, type ProjectionRollbackRecoveryView,
    type ProjectionRollbackState,
} from '@eosrio/hyperion-sdk/projection';
import { BSON } from 'mongodb';
import {
    GENESIS, STORAGE_VERSION, checkpointOf, hash, sameCheckpoint, snapshot, stableJson, validateMetadata,
    type ProjectionMetadata, type Receipt,
} from './contract.js';

export const ROLLBACK_STORAGE_VERSION = 'h45-portable-mongodb-v2';
/** The single metadata document remains well below MongoDB's 16 MiB document ceiling. */
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export interface RollbackPolicy {
    readonly maxBlocks: number;
    readonly maxBytes: number;
    readonly maxBlockBytes: number;
}
export interface UndoDescriptor {
    readonly block: ProjectionBlock;
    readonly digest: string;
    readonly count: number;
    readonly imageBytes: number;
    readonly imagesHash: string;
}
export interface UndoImage {
    readonly _id: string;
    readonly blockId: string;
    readonly key: string;
    /** null means the key was absent before this block, including repeated mutations. */
    readonly before: ProjectionRecord | null;
}
export interface RollbackMetadata<D = ProjectionMetadata['definition']> extends Omit<ProjectionMetadata, 'storageVersion' | 'definition'> {
    readonly storageVersion: string;
    readonly definition: D;
    readonly revision: string;
    readonly policy: RollbackPolicy;
    readonly coverageFloor: ProjectionCheckpoint;
    readonly floorReceipt: Receipt | null;
    readonly undo: readonly UndoDescriptor[];
    readonly rollback: ProjectionRollbackState | null;
}
export interface StoredRollbackCheckpoint extends ProjectionCheckpoint {
    readonly revision: string;
}

export function storedRollbackCheckpoint(checkpoint: ProjectionCheckpoint, revision: string): StoredRollbackCheckpoint {
    return { blockNum: checkpoint.blockNum, blockId: checkpoint.blockId, revision };
}

export function storedRollbackMetadata<D>(metadata: RollbackMetadata<D>): RollbackMetadata<D> & { checkpoint: StoredRollbackCheckpoint } {
    return { ...metadata, checkpoint: storedRollbackCheckpoint(metadata.checkpoint, metadata.revision) };
}

export function invalidStorage(): never {
    throw new ProjectionContractError('projection.invalid-contract', 'Projection rollback storage failed integrity validation');
}

export function bsonBytes(value: object): number {
    return BSON.calculateObjectSize(value);
}

/** Actual additional BSON array metadata bytes plus the independently encoded image documents. */
export function retainedBytes(undo: readonly UndoDescriptor[]): number {
    return bsonBytes({ undo }) - bsonBytes({ undo: [] }) + undo.reduce((total, item) => total + item.imageBytes, 0);
}

export function rollbackView(metadata: RollbackMetadata<unknown>): ProjectionRollbackReadView {
    return snapshot({ binding: metadata.binding, checkpoint: metadata.checkpoint, revision: metadata.revision });
}

export function rollbackRecovery(metadata: RollbackMetadata<unknown>): ProjectionRollbackRecoveryView {
    return snapshot({
        binding: metadata.binding, checkpoint: metadata.checkpoint, initialized: metadata.initialized,
        pending: metadata.pending, gap: metadata.gap, revision: metadata.revision,
        coverage: { floor: metadata.coverageFloor, retainedBlocks: metadata.undo.length,
            retainedBytes: retainedBytes(metadata.undo), maxBlocks: metadata.policy.maxBlocks, maxBytes: metadata.policy.maxBytes },
        rollback: metadata.rollback,
    });
}

export function assertRevision(metadata: RollbackMetadata<unknown>, revision: string): void {
    if (revision !== metadata.revision) {
        throw new ProjectionContractError('projection.stale-revision', 'Projection revision changed; an earlier writer or read view cannot adopt the new revision');
    }
}

export function assertNotRollingBack(metadata: RollbackMetadata<unknown>): void {
    if (metadata.rollback && metadata.rollback.status !== 'complete') {
        throw new ProjectionContractError('projection.incomplete', 'Projection rollback must finish or obtain missing recovery data before serving or applying sources');
    }
}

export function assertRollbackReady(metadata: RollbackMetadata<unknown>): void {
    if (!metadata.initialized) {
        throw new ProjectionContractError('projection.not-initialized', 'Projection initialization has not completed');
    }
    assertNotRollingBack(metadata);
    if (metadata.pending !== null || metadata.gap !== null) {
        throw new ProjectionContractError('projection.incomplete', 'Projection has an incomplete source application');
    }
}

export function assertRollbackView(metadata: RollbackMetadata<unknown>, view: ProjectionRollbackReadView): void {
    assertRevision(metadata, view.revision);
    assertRollbackReady(metadata);
    if (stableJson(metadata.binding) !== stableJson(view.binding) || !sameCheckpoint(metadata.checkpoint, view.checkpoint)) {
        throw new ProjectionContractError('projection.stale-view', 'Projection read view no longer names the completed checkpoint');
    }
}

export function undoImage(blockId: string, key: string, before: ProjectionRecord | null): UndoImage {
    return { _id: hash({ blockId, key }), blockId, key, before: snapshot(before) };
}

/** Private storage dialect: no contextual batch is reinterpreted as a v1 source operation. */
export interface RollbackMetadataDialect<D> {
    readonly storageVersion: string;
    validateBase(input: RollbackMetadata<D>, binding: ProjectionBinding): void;
    validBlock(definition: D, binding: ProjectionBinding, previous: ProjectionCheckpoint, block: ProjectionBlock): boolean;
    validRecord(definition: D, binding: ProjectionBinding, block: ProjectionBlock, key: string, value: ProjectionRecord | null): boolean;
}
export const legacyMetadataDialect: RollbackMetadataDialect<ProjectionMetadata['definition']> = {
    storageVersion: ROLLBACK_STORAGE_VERSION,
    validateBase: (input, binding) => {validateMetadata({...input, storageVersion: STORAGE_VERSION}, binding);},
    validBlock: (definition, binding, previous, block) => validateProjectionApply(definition, {binding, previous, block, mutations: []}).valid,
    validRecord: (definition, binding, block, key, value) => validateProjectionApply(definition, {binding, block,
        previous: {blockNum: block.blockNum - 1, blockId: block.previousBlockId},
        mutations: [value === null ? {kind: 'delete', key} : {kind: 'put', key, value}]}).valid,
};
export function validateRecoveryUndoImages<D>(input: readonly UndoImage[], descriptor: UndoDescriptor,
    metadata: RollbackMetadata<D>, dialect: RollbackMetadataDialect<D>): readonly UndoImage[] {
    if (input.length !== descriptor.count || input.some(image => !image || typeof image !== 'object' || typeof image._id !== 'string')) return invalidStorage();
    const images = [...input].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
    const keys = new Set<string>();
    let size = 0;
    for (const image of images) {
        if (!image || typeof image !== 'object' || Object.keys(image).sort().join(',') !== '_id,before,blockId,key' ||
            image.blockId !== descriptor.block.blockId || image._id !== hash({ blockId: image.blockId, key: image.key }) ||
            typeof image.key !== 'string' || keys.has(image.key) ||
            !dialect.validRecord(metadata.definition, metadata.binding, descriptor.block, image.key, image.before)) return invalidStorage();
        keys.add(image.key);
        size += bsonBytes(image);
    }
    if (size !== descriptor.imageBytes || hash(images) !== descriptor.imagesHash) return invalidStorage();
    return images;
}

export function validateRecoveryMetadata<D>(input: unknown, binding: ProjectionBinding, policy: RollbackPolicy,
    dialect: RollbackMetadataDialect<D>): RollbackMetadata<D> {
    if (!input || typeof input !== 'object') return invalidStorage();
    const stored = input as RollbackMetadata<D> & { checkpoint: StoredRollbackCheckpoint };
    if (stored.storageVersion !== dialect.storageVersion) {
        throw new ProjectionContractError('projection.capability-unavailable', 'Projection must explicitly initialize the revision-fenced rollback interface before use');
    }
    if (!stored.checkpoint || Object.keys(stored.checkpoint).sort().join(',') !== 'blockId,blockNum,revision' ||
        stored.checkpoint.revision !== stored.revision) return invalidStorage();
    return validateRecoveryState({ ...stored, checkpoint: checkpointOf(stored.checkpoint) }, binding, policy, dialect);
}

/** Validate the logical state before serializing its native checkpoint fence. */
export function validateRecoveryState<D>(input: unknown, binding: ProjectionBinding, policy: RollbackPolicy,
    dialect: RollbackMetadataDialect<D>): RollbackMetadata<D> {
    if (!input || typeof input !== 'object') return invalidStorage();
    const data = input as RollbackMetadata<D>;
    if (data.storageVersion !== dialect.storageVersion) {
        throw new ProjectionContractError('projection.capability-unavailable', 'Projection must explicitly initialize the revision-fenced rollback interface before use');
    }
    // Reuse the established definition, binding, contiguous source and receipt checks unchanged.
    dialect.validateBase(data, binding);
    if (!data.policy || stableJson(data.policy) !== stableJson(policy) ||
        !Number.isSafeInteger(data.policy.maxBlocks) || data.policy.maxBlocks < 1 ||
        data.policy.maxBlocks > PROJECTION_ROLLBACK_LIMITS.retainedBlocks ||
        !Number.isSafeInteger(data.policy.maxBytes) || data.policy.maxBytes < 1 ||
        data.policy.maxBytes > PROJECTION_ROLLBACK_LIMITS.retainedBytes ||
        !Number.isSafeInteger(data.policy.maxBlockBytes) || data.policy.maxBlockBytes < 1 ||
        data.policy.maxBlockBytes > data.policy.maxBytes || !Array.isArray(data.undo) ||
        data.undo.length > data.policy.maxBlocks || bsonBytes(storedRollbackMetadata(data)) > MAX_METADATA_BYTES) return invalidStorage();
    const recovery = validateProjectionRollbackRecovery(rollbackRecovery(data));
    if (!recovery.valid) return invalidStorage();
    if (data.coverageFloor.blockNum === 0) {
        if (!sameCheckpoint(data.coverageFloor, GENESIS) || data.floorReceipt !== null) return invalidStorage();
    } else if (!data.floorReceipt || !sameCheckpoint(data.floorReceipt, data.coverageFloor) ||
        !/^[a-f0-9]{64}$/.test(data.floorReceipt.digest)) return invalidStorage();
    let previous = data.coverageFloor;
    const ids = new Set<string>([previous.blockId]);
    for (const descriptor of data.undo) {
        if (!descriptor || typeof descriptor !== 'object' ||
            Object.keys(descriptor).sort().join(',') !== 'block,count,digest,imageBytes,imagesHash' ||
            !Number.isSafeInteger(descriptor.count) || descriptor.count < 0 || descriptor.count > PROJECTION_LIMITS.mutations ||
            !Number.isSafeInteger(descriptor.imageBytes) || descriptor.imageBytes < 0 ||
            descriptor.imageBytes + bsonBytes({ undo: [descriptor] }) - bsonBytes({ undo: [] }) > data.policy.maxBlockBytes ||
            (descriptor.count === 0 ? descriptor.imageBytes !== 0 : descriptor.imageBytes === 0) ||
            !/^[a-f0-9]{64}$/.test(descriptor.digest) || !/^[a-f0-9]{64}$/.test(descriptor.imagesHash) ||
            !dialect.validBlock(data.definition, binding, previous, descriptor.block) ||
            ids.has(descriptor.block.blockId)) return invalidStorage();
        previous = checkpointOf(descriptor.block);
        ids.add(previous.blockId);
    }
    if (!sameCheckpoint(previous, data.checkpoint)) return invalidStorage();
    if (data.rollback && data.rollback.status !== 'complete' && (data.pending !== null || data.gap !== null)) return invalidStorage();
    return data;
}

export function validateUndoImages(input: readonly UndoImage[], descriptor: UndoDescriptor,
    metadata: RollbackMetadata): readonly UndoImage[] {
    return validateRecoveryUndoImages(input, descriptor, metadata, legacyMetadataDialect);
}
export function validateRollbackMetadata(input: unknown, binding: ProjectionBinding, policy: RollbackPolicy): RollbackMetadata {
    return validateRecoveryMetadata(input, binding, policy, legacyMetadataDialect);
}
export function validateRollbackState(input: unknown, binding: ProjectionBinding, policy: RollbackPolicy): RollbackMetadata {
    return validateRecoveryState(input, binding, policy, legacyMetadataDialect);
}
