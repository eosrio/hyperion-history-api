import { createHash } from 'node:crypto';
import {
    ProjectionContractError,
    validateProjectionApply,
    validateProjectionBinding,
    validateProjectionDefinition,
    validateProjectionView,
    type ProjectionBinding,
    type ProjectionBlock,
    type ProjectionCheckpoint,
    type ProjectionDefinition,
    type ProjectionReadView,
    type ProjectionRecord,
} from '@eosrio/hyperion-sdk/projection';

export const STORAGE_VERSION = 'h45-portable-mongodb-v1';
export const MAX_RECEIPTS = 4096;
export const GENESIS: ProjectionCheckpoint = Object.freeze({ blockNum: 0, blockId: '0'.repeat(64) });

export interface Receipt extends ProjectionCheckpoint {
    readonly digest: string;
}

export interface PendingApplication {
    readonly block: ProjectionBlock;
    readonly digest: string | null;
    readonly reason: string | null;
}

export interface ProjectionMetadata {
    readonly _id: string;
    readonly storageVersion: typeof STORAGE_VERSION;
    readonly definition: ProjectionDefinition;
    readonly definitionHash: string;
    readonly binding: ProjectionBinding;
    readonly checkpoint: ProjectionCheckpoint;
    readonly initialized: boolean;
    readonly pending: PendingApplication | null;
    /** First observed future source; missing contiguous frames may complete below it. */
    readonly gap: PendingApplication | null;
    readonly receipts: readonly Receipt[];
}

export interface StoredRecord {
    readonly _id: string;
    readonly value: ProjectionRecord;
}

/** SDK validation has already constrained these values to finite inert JSON. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function hash(value: unknown): string {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** This slice has one immutable active binding, without an implicit cutover API. */
export function slot(binding: ProjectionBinding): string {
    return hash({ chainId: binding.chainId, projectionId: binding.projectionId });
}

export function sameCheckpoint(a: ProjectionCheckpoint, b: ProjectionCheckpoint): boolean {
    return a.blockNum === b.blockNum && a.blockId === b.blockId;
}

export function sameBlock(a: ProjectionBlock, b: ProjectionBlock): boolean {
    return sameCheckpoint(a, b) && a.previousBlockId === b.previousBlockId;
}

export function checkpointOf(block: ProjectionCheckpoint): ProjectionCheckpoint {
    return { blockNum: block.blockNum, blockId: block.blockId };
}

export function snapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function valid<T>(result: { valid: true; value: T } | { valid: false; errors: readonly { message: string }[] }): T {
    if (!result.valid) {
        throw new ProjectionContractError('projection.invalid-contract', result.errors.map(error => error.message).join('; '));
    }
    return snapshot(result.value);
}

export function checkBinding(input: ProjectionBinding, backendId: string): ProjectionBinding {
    const binding = valid(validateProjectionView({ binding: input, checkpoint: GENESIS })).binding;
    if (binding.backendId !== backendId) {
        throw new ProjectionContractError('projection.invalid-contract', 'Projection binding names another backend instance');
    }
    return binding;
}

export function readView(metadata: ProjectionMetadata): ProjectionReadView {
    return snapshot({ binding: metadata.binding, checkpoint: metadata.checkpoint });
}

export function assertReady(metadata: ProjectionMetadata): void {
    if (!metadata.initialized) {
        throw new ProjectionContractError('projection.not-initialized', 'Projection initialization has not completed');
    }
    if (metadata.pending !== null || metadata.gap !== null) {
        throw new ProjectionContractError('projection.incomplete', 'Projection has an incomplete source application');
    }
}

export function assertView(metadata: ProjectionMetadata, view: ProjectionReadView): void {
    assertReady(metadata);
    if (stableJson(metadata.binding) !== stableJson(view.binding) || !sameCheckpoint(metadata.checkpoint, view.checkpoint)) {
        throw new ProjectionContractError('projection.stale-view', 'Projection read view no longer names the completed checkpoint');
    }
}

function corrupt(): never {
    throw new ProjectionContractError('projection.invalid-contract', 'Projection metadata failed storage integrity validation');
}

export function validateMetadata(input: unknown, binding: ProjectionBinding): ProjectionMetadata {
    if (!input || typeof input !== 'object') return corrupt();
    const data = input as ProjectionMetadata;
    if (data._id !== slot(binding) || data.storageVersion !== STORAGE_VERSION ||
        typeof data.initialized !== 'boolean') return corrupt();
    if (stableJson(data.binding) !== stableJson(binding)) {
        throw new ProjectionContractError('projection.stale-view', 'Projection slot is owned by another immutable binding');
    }
    const definition = validateProjectionDefinition(data.definition);
    if (!definition.valid || !validateProjectionBinding(definition.value, binding).valid ||
        data.definitionHash !== hash(definition.value) || !validateProjectionView(readView(data)).valid) return corrupt();
    if (!Array.isArray(data.receipts) || data.receipts.length > MAX_RECEIPTS) return corrupt();
    const blocks = new Set<number>();
    const ids = new Set<string>();
    let previousNumber = -1;
    for (const receipt of data.receipts) {
        if (!receipt || !Number.isSafeInteger(receipt.blockNum) || receipt.blockNum < 1 ||
            receipt.blockNum > data.checkpoint.blockNum || receipt.blockNum <= previousNumber ||
            !/^[a-f0-9]{64}$/.test(receipt.blockId) || !/^[a-f0-9]{64}$/.test(receipt.digest) ||
            blocks.has(receipt.blockNum) || ids.has(receipt.blockId)) return corrupt();
        blocks.add(receipt.blockNum);
        ids.add(receipt.blockId);
        previousNumber = receipt.blockNum;
    }
    if (data.checkpoint.blockNum === 0) {
        if (!sameCheckpoint(data.checkpoint, GENESIS) || data.receipts.length !== 0) return corrupt();
    } else if (data.receipts.length === 0 || !sameCheckpoint(data.receipts[data.receipts.length - 1], data.checkpoint)) {
        return corrupt();
    }
    if (data.pending !== null) {
        if (!data.pending || typeof data.pending !== 'object' ||
            !(data.pending.digest === null || /^[a-f0-9]{64}$/.test(data.pending.digest)) ||
            !(data.pending.reason === null || (typeof data.pending.reason === 'string' && Buffer.byteLength(data.pending.reason) <= 4096)) ||
            !validateProjectionApply(definition.value, {
                binding, previous: data.checkpoint, block: data.pending.block, mutations: [],
            }).valid) return corrupt();
    }
    if (data.gap !== null) {
        if (!data.gap || typeof data.gap !== 'object' ||
            !(data.gap.digest === null || /^[a-f0-9]{64}$/.test(data.gap.digest)) ||
            !(data.gap.reason === null || (typeof data.gap.reason === 'string' && Buffer.byteLength(data.gap.reason) <= 4096)) ||
            !validateProjectionApply(definition.value, {
                binding,
                previous: { blockNum: data.gap.block?.blockNum - 1, blockId: data.gap.block?.previousBlockId },
                block: data.gap.block,
                mutations: [],
            }).valid || data.gap.block.blockNum <= data.checkpoint.blockNum) return corrupt();
        if (data.gap.block.blockNum === data.checkpoint.blockNum + 1 &&
            data.gap.block.previousBlockId !== data.checkpoint.blockId) return corrupt();
        if (data.pending && (data.pending.block.blockNum > data.gap.block.blockNum ||
            (data.pending.block.blockNum === data.gap.block.blockNum &&
                (!sameBlock(data.pending.block, data.gap.block) ||
                    (data.pending.digest !== null && data.gap.digest !== null && data.pending.digest !== data.gap.digest))) ||
            (data.pending.block.blockNum === data.gap.block.blockNum - 1 && data.pending.block.blockId !== data.gap.block.previousBlockId))) {
            return corrupt();
        }
    }
    if (!data.initialized && (!sameCheckpoint(data.checkpoint, GENESIS) || data.receipts.length !== 0 ||
        data.pending !== null || data.gap !== null)) {
        return corrupt();
    }
    return data;
}

export function storedRecord(key: string, value: ProjectionRecord): StoredRecord {
    return { _id: key, value: snapshot(value) };
}
