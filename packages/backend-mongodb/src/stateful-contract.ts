import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {
    captureStatefulDeclaration, captureStatefulRecovery, canonicalStatefulRecord, StatefulContractError,
    type StatefulDeclaration, type StatefulKey, type StatefulRecovery, type StatefulView,
} from '@eosrio/hyperion-sdk/projection-stateful';
import type {ProjectionBlock, ProjectionCheckpoint, ProjectionRollbackState} from '@eosrio/hyperion-sdk/projection';
import {bsonBytes, MAX_METADATA_BYTES, retainedBytes, type RollbackPolicy, type UndoDescriptor} from './rollback-contract.js';

export const STATEFUL_STORAGE = 'h45-stateful-mongodb-v1';
export const MAX_BSON_BYTES = 16 * 1024 * 1024;
export const ZERO: ProjectionCheckpoint = Object.freeze({blockNum: 0, blockId: '0'.repeat(64)});
// Static schema/predicate allocations only; every supplied metadata value is revalidated.
const nonHexCharacter = /[^a-f0-9]/;
const receiptFields = ['blockNum', 'blockId', 'sourceDigest', 'candidateDigest'] as const;
const undoFields = ['block', 'digest', 'sourceDigest', 'count', 'imageBytes', 'imagesHash'] as const;
const blockFields = ['blockNum', 'blockId', 'previousBlockId'] as const;
export const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
export const equalPoint = (a: ProjectionCheckpoint, b: ProjectionCheckpoint): boolean => a.blockNum === b.blockNum && a.blockId === b.blockId;
export function requireState(ok: unknown, message: string, code = 'stateful.invalid-contract'): asserts ok {
    if (!ok) throw new StatefulContractError(code, message);
}
export function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
    requireState(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected data record');
    // Preserve the original reflection order for proxies whose traps can change the record.
    if (isProxy(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        requireState(Object.getOwnPropertySymbols(value).length === 0 && Object.keys(descriptors).length === names.length &&
            names.every(n => descriptors[n]?.enumerable && Object.hasOwn(descriptors[n], 'value')), 'Unexpected fields/accessors');
        return;
    }
    const keys = Reflect.ownKeys(value);
    requireState(keys.every(key => typeof key === 'string') && keys.length === names.length && names.every(name => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    }), 'Unexpected fields/accessors');
}
export function hex(value: unknown): asserts value is string {
    requireState(typeof value === 'string' && value.length === 64 && !nonHexCharacter.test(value), 'Expected SHA-256');
}
export function size(value: number, maximum: number, name: string): number {
    requireState(Number.isSafeInteger(value) && value > 0 && value <= maximum, `Explicit ${name} bound required`); return value;
}
/** Receiving SDK instance validates a DTO; it never creates a negotiated execution handle. */
export async function receiveDeclaration(input: unknown): Promise<StatefulDeclaration> {
    fields(input, ['definition', 'limits', 'digest']);
    const captured = await captureStatefulDeclaration(input.definition, input.limits as StatefulDeclaration['limits']);
    requireState(captured.digest === input.digest, 'Declaration digest differs'); return captured;
}
export interface StatefulPolicy extends RollbackPolicy {readonly receiptRetention: number}
export interface StatefulReceipt extends ProjectionCheckpoint {readonly sourceDigest: string; readonly candidateDigest: string}
export interface StatefulUndo extends UndoDescriptor {readonly sourceDigest: string}
export interface StatefulImage {
    readonly _id: string; readonly blockId: string; readonly target: StatefulKey; readonly before: string | null;
}
export interface StatefulRow {readonly _id: string; readonly kind: string; readonly key: string; readonly json: string}
export interface StatefulMetadata {
    readonly _id: string; readonly storageVersion: typeof STATEFUL_STORAGE; readonly declaration: string;
    readonly declarationDigest: string; readonly policy: StatefulPolicy; readonly etag: string;
    readonly checkpoint: ProjectionCheckpoint; readonly revision: string; readonly initialized: boolean;
    readonly pending: {readonly sourceDigest: string; readonly candidateDigest: string; readonly block: ProjectionCheckpoint} | null;
    readonly gap: StatefulRecovery['gap']; readonly rollback: ProjectionRollbackState | null;
    readonly receipts: readonly StatefulReceipt[]; readonly undo: readonly StatefulUndo[];
    readonly floor: ProjectionCheckpoint; readonly floorReceipt: StatefulReceipt | null;
}
export const slotFor = (d: StatefulDeclaration): string => sha(JSON.stringify([d.definition.binding.chainId, d.definition.binding.backendId, d.definition.id]));
export const keyId = (k: StatefulKey): string => sha(JSON.stringify([k.kind, k.key]));
export function viewOf(d: StatefulDeclaration, m: StatefulMetadata): StatefulView {
    return {declarationDigest: d.digest, backendId: d.definition.binding.backendId, generation: d.definition.binding.generation,
        revision: m.revision, checkpoint: {...m.checkpoint}};
}
export function recoveryOf(d: StatefulDeclaration, m: StatefulMetadata): StatefulRecovery {
    return captureStatefulRecovery(d, {view: viewOf(d, m), initialized: m.initialized,
        pending: m.pending && {sourceDigest: m.pending.sourceDigest, candidateDigest: m.pending.candidateDigest},
        gap: m.gap, rollback: m.rollback, coverage: {floor: m.floor, retainedBlocks: m.undo.length,
            retainedBytes: retainedBytes(m.undo), maxBlocks: m.policy.maxBlocks, maxBytes: m.policy.maxBytes}});
}
export function ready(m: StatefulMetadata): void {
    requireState(m.initialized, 'Projection is not initialized', 'stateful.not-initialized');
    requireState(m.pending === null && m.gap === null && (m.rollback === null || m.rollback.status === 'complete'), 'Projection is incomplete', 'stateful.incomplete');
}
export function writer(m: StatefulMetadata): void {
    requireState(m.initialized && m.gap === null && (m.rollback === null || m.rollback.status === 'complete'), 'Projection recovery is incomplete', 'stateful.incomplete');
}
export function logicalKey(d: StatefulDeclaration, input: unknown): StatefulKey {
    fields(input, ['kind', 'key']);
    requireState(typeof input.kind === 'string' && d.definition.records.some(r => r.kind === input.kind), 'Undeclared record kind');
    const value = input.key;
    requireState(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= d.limits.keyBytes, 'Logical key byte bound');
    for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {const next = value.charCodeAt(++i); requireState(next >= 0xdc00 && next <= 0xdfff, 'Malformed key Unicode');}
        else requireState(unit < 0xdc00 || unit > 0xdfff, 'Malformed key Unicode');
    }
    return Object.freeze({kind: input.kind, key: value});
}
export function rowOf(d: StatefulDeclaration, target: StatefulKey, input: unknown): StatefulRow {
    const row = {_id: keyId(target), ...target, json: canonicalStatefulRecord(d, target.kind, input).canonical};
    requireState(bsonBytes(row) <= MAX_BSON_BYTES, 'BSON record bound'); return row;
}
export function decodeRow(d: StatefulDeclaration, target: StatefulKey, input: unknown) {
    fields(input, ['_id', 'kind', 'key', 'json']);
    requireState(input._id === keyId(target) && input.kind === target.kind && input.key === target.key && typeof input.json === 'string', 'Stored logical key differs');
    const result = canonicalStatefulRecord(d, target.kind, JSON.parse(input.json));
    requireState(result.canonical === input.json && bsonBytes(input) <= MAX_BSON_BYTES, 'Stored canonical value differs'); return result.value;
}
function receipt(value: unknown): asserts value is StatefulReceipt {
    fields(value, receiptFields); hex(value.blockId); hex(value.sourceDigest); hex(value.candidateDigest);
    requireState(Number.isSafeInteger(value.blockNum) && (value.blockNum as number) > 0, 'Receipt height differs');
}
/** Complete portable state plus native chain/receipt/byte invariants on every storage load/CAS. */
export function metadata(d: StatefulDeclaration, policy: StatefulPolicy, input: unknown): StatefulMetadata {
    fields(input, ['_id', 'storageVersion', 'declaration', 'declarationDigest', 'policy', 'etag', 'checkpoint', 'revision', 'initialized',
        'pending', 'gap', 'rollback', 'receipts', 'undo', 'floor', 'floorReceipt']);
    const m = input as unknown as StatefulMetadata;
    requireState(m._id === slotFor(d) && m.storageVersion === STATEFUL_STORAGE && m.declarationDigest === d.digest &&
        m.declaration === JSON.stringify(d) && JSON.stringify(m.policy) === JSON.stringify(policy), 'Stored declaration/policy differs');
    hex(m.etag); hex(m.revision);
    requireState(Array.isArray(m.receipts) && m.receipts.length <= policy.receiptRetention && Array.isArray(m.undo), 'Receipt/undo bound');
    recoveryOf(d, m);
    if (!m.initialized) requireState(equalPoint(m.checkpoint, ZERO) && m.pending === null && m.gap === null && m.rollback === null &&
        m.undo.length === 0 && m.receipts.length === 0 && equalPoint(m.floor, ZERO) && m.floorReceipt === null, 'Uninitialized storage contains effects/progress');
    assertStatefulHistory(d, policy, m);
    if (m.pending) {
        fields(m.pending, ['sourceDigest', 'candidateDigest', 'block']);
        fields(m.pending.block, ['blockNum', 'blockId']);
        requireState(m.pending.block.blockNum === m.checkpoint.blockNum + 1, 'Pending source is not next');
        hex(m.pending.block.blockId);
    }
    if (m.gap) requireState(m.gap.block.blockNum === m.checkpoint.blockNum + 1, 'Incomplete source is not next');
    requireState(!(m.pending && m.gap) && (!m.rollback || m.rollback.status === 'complete' || !(m.pending || m.gap)), 'Conflicting recovery ownership');
    requireState(bsonBytes(m) <= MAX_METADATA_BYTES, 'Metadata BSON bound'); return m;
}
/** Shared actual receipt/undo branch validation, with family-specific recovery validation left intact. */
export function assertStatefulHistory(d: StatefulDeclaration, policy: StatefulPolicy,
    m: Pick<StatefulMetadata, 'floor' | 'floorReceipt' | 'undo' | 'receipts' | 'checkpoint'>): void {
    requireState(Array.isArray(m.receipts) && m.receipts.length <= policy.receiptRetention && Array.isArray(m.undo), 'Receipt/undo bound');
    let previous = m.floor; const ids = new Set<string>([previous.blockId]);
    for (const u of m.undo as readonly StatefulUndo[]) {
        fields(u, undoFields);
        fields(u.block, blockFields); hex(u.block.blockId); hex(u.block.previousBlockId);
        hex(u.digest); hex(u.sourceDigest); hex(u.imagesHash);
        requireState(u.block.blockNum === previous.blockNum + 1 && u.block.previousBlockId === previous.blockId && !ids.has(u.block.blockId) &&
            Number.isSafeInteger(u.count) && u.count >= 0 && u.count <= d.limits.mutations && Number.isSafeInteger(u.imageBytes) && u.imageBytes >= 0 &&
            retainedBytes([u]) <= policy.maxBlockBytes && (u.count === 0 ? u.imageBytes === 0 : u.imageBytes > 0), 'Undo branch/count/byte identity differs');
        previous = u.block; ids.add(previous.blockId);
    }
    requireState(equalPoint(previous, m.checkpoint), 'Undo branch does not end at progress');
    let height = 0; const receiptIds = new Set<string>();
    for (const r of m.receipts) {
        receipt(r); requireState(r.blockNum > height && r.blockNum <= m.checkpoint.blockNum && !receiptIds.has(r.blockId), 'Retained receipt order differs');
        const retained = m.undo.find(u => equalPoint(u.block, r)) ?? (m.floorReceipt && equalPoint(m.floorReceipt, r) ? m.floorReceipt : null);
        requireState(r.blockNum < m.floor.blockNum || retained !== null, 'Receipt is not on the retained branch');
        requireState(!ids.has(r.blockId) || retained !== null, 'Receipt block identity conflicts with retained branch');
        if (retained) requireState(('digest' in retained ? retained.digest : retained.candidateDigest) === r.candidateDigest && retained.sourceDigest === r.sourceDigest, 'Receipt and undo disagree');
        height = r.blockNum; receiptIds.add(r.blockId);
    }
    if (m.checkpoint.blockNum > 0) requireState(m.receipts.some(r => equalPoint(r, m.checkpoint)), 'Completed progress has no receipt');
    if (m.floor.blockNum === 0) requireState(equalPoint(m.floor, ZERO) && m.floorReceipt === null, 'Genesis coverage differs');
    else {receipt(m.floorReceipt); requireState(equalPoint(m.floorReceipt, m.floor), 'Floor receipt differs');}
}
export function checkedImages(d: StatefulDeclaration, u: StatefulUndo, input: readonly StatefulImage[]): readonly StatefulImage[] {
    requireState(input.length === u.count, 'Missing/extra undo images');
    const sorted = [...input].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0), ids = new Set<string>();
    let bytes = 0;
    for (const image of sorted) {
        fields(image, ['_id', 'blockId', 'target', 'before']); const target = logicalKey(d, image.target);
        requireState(image.blockId === u.block.blockId && image._id === sha(image.blockId + keyId(target)) && !ids.has(keyId(target)), 'Undo image identity differs');
        if (image.before !== null) {requireState(typeof image.before === 'string', 'Undo value differs');
            requireState(rowOf(d, target, JSON.parse(image.before)).json === image.before, 'Undo canonical value differs');}
        bytes += bsonBytes(image); ids.add(keyId(target));
    }
    requireState(bytes === u.imageBytes && sha(JSON.stringify(sorted)) === u.imagesHash, 'Undo checksum/bytes differ'); return sorted;
}
export const blockOf = (block: ProjectionBlock): ProjectionBlock => ({blockNum: block.blockNum, blockId: block.blockId, previousBlockId: block.previousBlockId});
