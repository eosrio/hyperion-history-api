/** Shared read-only recovery audit; descriptions never recreate accepted worker evidence. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {actionHistoryImmutableJson} from '../../build/indexer/history/action-history-manifest.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(actionHistoryImmutableJson(value));
export const wireRecoveryAssociationId = end => 'h45actionassociation1:' + digest([end.epoch, end.incarnation, end.attemptId]);

export function assertWireRecoveryEnd(control, end, resumed = false) {
    assert.equal(end.role, 'ds_pool_worker'); assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'returned');
    assert.equal(end.acknowledgementAttempted, true); assert.equal(end.freshWriteOverflow, false);
    assert.equal(end.binding.blockNum, resumed ? control.resumeBlockNum : control.blockNum);
    assert.equal(end.binding.blockId, resumed ? control.resumeBlockId : control.blockId);
    assert.equal(end.binding.traceOrdinal, control.traceOrdinal); assert.ok(end.binding.admissionId && end.binding.planId);
    assert.equal(end.descriptor.kind, 'ds-delivery'); assert.match(end.descriptor.payloadSha256, /^[a-f0-9]{64}$/);
    assert.match(end.descriptor.headersSha256, /^[a-f0-9]{64}$/);
    assert.equal(end.freshWrites.length, 1); const write = end.freshWrites[0];
    assert.equal(write.kind, 'confirmed-handoff'); assert.equal(write.classification, 'confirmed-handoff');
    assert.match(write.id, /^h45actionhandoff1:[a-f0-9]{64}$/);
}

export async function auditWireRecoveryEnd(control, end, store, resumed = false) {
    assertWireRecoveryEnd(control, end, resumed);
    const blockNum = resumed ? control.resumeBlockNum : control.blockNum, blockId = resumed ? control.resumeBlockId : control.blockId;
    const frameSha256 = resumed ? control.resumeFrameSha256 : control.frameSha256;
    const admission = await store.resolve(end.binding.admissionId), source = admission.source;
    assert.equal(source.inventoryInput.source.chainId, control.chainId);
    assert.equal(source.inventoryInput.source.blockNum, blockNum); assert.equal(source.inventoryInput.source.blockId, blockId);
    assert.equal(source.inventoryInput.profileId, control.profileId); assert.equal(source.producer.profileId, control.profileId);
    assert.equal(hash(Buffer.from(source.frameHex, 'hex')), frameSha256);
    assert.equal(admission.planId, end.binding.planId); assert.equal(source.inventoryInput.sourceSelectionId, end.binding.selectionId);
    assert.equal(source.producer.configurationSha256, end.binding.configurationSha256);
    assert.equal(admission.target.name, end.binding.targetName); assert.equal(admission.target.uuid, end.binding.targetUuid);
    const tx = admission.inventory.transactions.find(value => value.traceOrdinal === control.traceOrdinal);
    assert.ok(tx?.dispatch?.canonicalJson);
    const payload = Buffer.from(tx.dispatch.canonicalJson); assert.equal(hash(payload), end.descriptor.payloadSha256);
    const record = await store.readConfirmedHandoff(admission.id, control.traceOrdinal, payload);
    assert.equal(record.id, end.freshWrites[0].id); assert.equal(record.outcome.kind, 'confirmed-action-handoff');
    assert.equal(digest(record.outcome), end.freshWrites[0].recordSha256);
    assert.equal(digest(record.outcome.work), end.freshWrites[0].workSha256);
    return {admissionId: admission.id, planId: admission.planId, target: admission.target, recordId: record.id,
        recordSha256: digest(record.outcome), payloadSha256: hash(payload), frameSha256};
}
