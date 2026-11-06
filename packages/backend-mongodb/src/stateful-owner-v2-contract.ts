import {captureStatefulOwnerRecoveryV2, type CapturedRawStatefulTargetV2, type StatefulFailureV2,
    type StatefulOwnerClaimV2, type StatefulOwnerDeclarationV2, type StatefulOwnerRecoveryV2, type StatefulRawAdmissionV2}
    from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import type {StatefulView} from '@eosrio/hyperion-sdk/projection-stateful';
import {bsonBytes, MAX_METADATA_BYTES, retainedBytes} from './rollback-contract.js';
import {assertStatefulHistory, equalPoint, fields, hex, requireState, slotFor,
    type StatefulMetadata, type StatefulPolicy} from './stateful-contract.js';

export const STATEFUL_OWNER_STORAGE_V2 = 'h45-stateful-mongodb-owner-v2' as const;
export interface OwnerMetadataV2 extends Omit<StatefulMetadata, 'storageVersion' | 'gap'> {
    readonly storageVersion: typeof STATEFUL_OWNER_STORAGE_V2;
    readonly owner: StatefulOwnerClaimV2;
    readonly raw: StatefulRawAdmissionV2 | null;
    readonly gap: StatefulFailureV2 | null;
}
export const ownerSlot = (d: StatefulOwnerDeclarationV2) => slotFor(d.projection);
export function ownerView(d: StatefulOwnerDeclarationV2, m: OwnerMetadataV2): StatefulView {
    return {declarationDigest: d.digest, backendId: d.projection.definition.binding.backendId,
        generation: d.projection.definition.binding.generation, revision: m.revision, checkpoint: {...m.checkpoint}};
}
export function ownerRecovery(d: StatefulOwnerDeclarationV2, m: OwnerMetadataV2): Promise<StatefulOwnerRecoveryV2> {
    return captureStatefulOwnerRecoveryV2(d, {interfaceVersion: 2, sourceInputVersion: 2, version: m.etag,
        view: ownerView(d, m), initialized: m.initialized, owner: m.owner, raw: m.raw,
        pending: m.pending && {sourceDigest: m.pending.sourceDigest, candidateDigest: m.pending.candidateDigest}, gap: m.gap,
        rollback: m.rollback, coverage: {floor: m.floor, retainedBlocks: m.undo.length, retainedBytes: retainedBytes(m.undo),
            maxBlocks: m.policy.maxBlocks, maxBytes: m.policy.maxBytes}});
}
export async function ownerMetadata(d: StatefulOwnerDeclarationV2, policy: StatefulPolicy, input: unknown): Promise<OwnerMetadataV2> {
    fields(input, ['_id', 'storageVersion', 'declaration', 'declarationDigest', 'policy', 'etag', 'checkpoint', 'revision', 'initialized',
        'pending', 'gap', 'rollback', 'receipts', 'undo', 'floor', 'floorReceipt', 'owner', 'raw']);
    const m = input as unknown as OwnerMetadataV2;
    requireState(m._id === ownerSlot(d) && m.storageVersion === STATEFUL_OWNER_STORAGE_V2 && m.declarationDigest === d.digest
        && m.declaration === JSON.stringify(d) && JSON.stringify(m.policy) === JSON.stringify(policy), 'Stored owner declaration/policy differs');
    hex(m.etag); hex(m.revision); requireState(m.owner !== null, 'Owner namespace requires its original claim');
    await ownerRecovery(d, m); assertStatefulHistory(d.projection, policy, m);
    if (!m.initialized) requireState(m.floorReceipt === null && equalPoint(m.floor, m.checkpoint) && m.receipts.length === 0,
        'Uninitialized owner storage contains history');
    if (m.pending) {
        fields(m.pending, ['sourceDigest', 'candidateDigest', 'block']); fields(m.pending.block, ['blockNum', 'blockId']); hex(m.pending.block.blockId);
        requireState(m.raw !== null && equalPoint(m.pending.block, m.raw.target.target.block), 'Pending original block differs');
    }
    if (m.raw && m.raw.target.target.block.blockNum === m.checkpoint.blockNum) {
        const receipt = m.receipts.find(r => equalPoint(r, m.checkpoint));
        requireState(receipt?.sourceDigest === m.raw.sourceDigest && m.pending === null, 'Completed raw target lacks its original receipt');
    }
    requireState(bsonBytes(m) <= MAX_METADATA_BYTES, 'Owner metadata BSON bound'); return m;
}
export function matchingRaw(m: OwnerMetadataV2, targetDigest: string): CapturedRawStatefulTargetV2 {
    hex(targetDigest); requireState(m.raw?.target.digest === targetDigest, 'Exact original raw slot differs', 'stateful.replay-conflict');
    return m.raw.target;
}
