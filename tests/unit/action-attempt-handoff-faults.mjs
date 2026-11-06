/** Original DS handoff faults with controlled transports; no live broker or capacity authority. */
import assert from 'node:assert/strict';
import {describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {managedWireAttemptFixture} from './managed-wire-attempt-fixture.mjs';

const mode = process.argv[2] ?? 'held-write';
assert(['held-write', 'failed-write', 'lost-receipt', 'ack-throws'].includes(mode));
const fixture = managedWireAttemptFixture({role: 'ds_pool_worker', workerMode: 'managed-original-handoff-' + mode});
const {supervisor, spawn, event, requests, ownEnd, until, inspectOriginal, associateOriginal, finish} = fixture;
try {
    const peer = spawn({HYPERION_QUALIFICATION_PLAIN_HANDOFF: 'true'});
    await until(() => event(peer, 'qualification_peer_ready'), peer, 'independent DS callback is prepared');
    const first = spawn();
    if (mode === 'held-write') {
        await until(() => event(first, 'qualification_handoff_write_held'), first, 'original DS manifest write is held');
        const held = event(first, 'qualification_handoff_write_held');
        assert.equal(held.originalAckCount, 0); assert.equal(held.confirmCalls, 1); assert.equal(held.retainedHandoffs, 0);
        assert.equal(held.request.kind, 'manifest'); assert.equal(held.request.requiredCopies, 'all');
        assert.match(held.request.bundleId, /^h45actionhandoff1:/);
        assert.equal(requests(first, 'observe').length, 0);
        assert.equal(event(first, 'qualification_ack'), undefined); assert.equal(ownEnd(first), undefined);
        assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(requests(first, 'register')[0].payload)), /Unissued or foreign/);
    } else {
        await until(() => event(first, 'qualification_fixture') && ownEnd(first), first, 'original failed DS callback drains');
    }

    // A distinct physical callback under this same supervisor still writes, ACKs and associates.
    peer.child.send({event: 'qualification_start_peer'});
    await until(() => event(peer, 'qualification_fixture') && ownEnd(peer), peer, 'independent original DS callback completes');
    const other = await inspectOriginal(peer);
    assert.equal(other.end.rootResult, 'returned'); assert.equal(other.end.acknowledgementAttempted, true);
    assert.equal(other.end.freshWrites.length, 1); assert.equal(other.snapshot.originalAckCount, 1);
    assert.notEqual(other.end.incarnation, requests(first, 'register')[0].payload.incarnation);
    await associateOriginal(other); await finish(peer);

    if (mode === 'held-write') {
        assert.equal(ownEnd(first), undefined); assert.equal(requests(first, 'observe').length, 0);
        assert.equal(event(first, 'qualification_ack'), undefined);
        first.child.send({event: 'qualification_release_write'});
        await until(() => event(first, 'qualification_fixture') && ownEnd(first), first, 'released original DS handoff completes');
    }
    const original = await inspectOriginal(first), failed = mode !== 'held-write', ackThrows = mode === 'ack-throws';
    assert.equal(original.end.rootResult, failed ? 'threw' : 'returned');
    assert.equal(original.end.acknowledgementAttempted, !failed || ackThrows);
    assert.equal(original.snapshot.originalAckCount, failed ? 0 : 1);
    assert.equal(original.end.freshWrites.length, !failed || ackThrows ? 1 : 0);
    const observed = first.messages.findIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'observe');
    const ack = first.messages.findIndex(x => x.event === 'qualification_ack');
    const ended = first.messages.findIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'end');
    if (!failed || ackThrows) assert(observed >= 0 && ack > observed && ended > ack);
    else assert.equal(ack, -1);

    if (original.snapshot.recordId) {
        const admission = await original.store.resolve(original.end.binding.admissionId);
        const payload = Buffer.from(admission.inventory.transactions.find(x => x.traceOrdinal === original.end.binding.traceOrdinal).dispatch.canonicalJson);
        const writesBefore = original.memory.calls.filter(x => ['create', 'index'].includes(x.method)).length;
        const record = await original.store.readConfirmedHandoff(admission.id, original.end.binding.traceOrdinal, payload);
        assert.equal(record.id, original.snapshot.recordId); assert.equal(record.outcome.kind, 'confirmed-action-handoff');
        assert.equal(record.outcome.effects.length, 1);
        assert.equal(original.memory.calls.filter(x => ['create', 'index'].includes(x.method)).length, writesBefore,
            'inspection cannot manufacture a fresh conditional write receipt');
        assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(original.end)), /Unissued or foreign/);
    } else assert.equal(mode, 'failed-write');

    if (failed) {
        const failure = event(first, 'qualification_handoff_failed');
        assert.equal(failure.kind, mode); assert.equal(failure.originalAckCount, 0); assert.equal(failure.confirmCalls, 1);
        assert.equal(failure.errorName, 'Error');
        assert.equal(failure.failedWrites, mode === 'failed-write' ? 1 : 0);
        assert.equal(failure.lostReceipts, mode === 'lost-receipt' ? 1 : 0);
        assert.equal(failure.retainedHandoffs, mode === 'failed-write' ? 0 : 1);
        assert.equal(failure.originalPayloadSha256, original.end.descriptor.payloadSha256);
        const untouched = new Proxy({}, {get() {assert.fail('failed DS callback reached adjudication storage or authority');}});
        const adjudicator = new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched);
        assert.deepEqual(await adjudicator.adjudicate(original.evidence), {state: 'unresolved'});
        assert.equal(requests(first, 'observe').length, ackThrows ? 1 : 0,
            'visible handoff bytes cannot reissue the missing write acknowledgement');
    } else await associateOriginal(original);
    if (mode === 'lost-receipt') {
        first.child.send({event: 'qualification_retry_handoff'});
        await until(() => first.messages.filter(x => x.event === 'qualification_fixture').length === 2 && ownEnd(first, 1),
            first, 'a fresh DS attempt reasserts the original handoff');
        const retried = await inspectOriginal(first, 1), receipt = event(first, 'qualification_handoff_retry_receipt');
        assert(receipt); assert.equal(receipt.recordId, original.snapshot.recordId);
        assert.equal(receipt.conditionalWrites, 1); assert.equal(receipt.acceptedReceipts, 1);
        assert.equal(receipt.requiredCopies, 'all');
        assert(Number.isSafeInteger(receipt.ifSeqNo)); assert(Number.isSafeInteger(receipt.ifPrimaryTerm));
        assert.equal(retried.end.incarnation, original.end.incarnation);
        assert.notEqual(retried.end.attemptId, original.end.attemptId);
        assert.notEqual(retried.end.descriptor.receiptId, original.end.descriptor.receiptId);
        assert.equal(retried.end.descriptor.payloadSha256, original.end.descriptor.payloadSha256);
        assert.equal(retried.end.binding.admissionId, original.end.binding.admissionId);
        assert.equal(retried.end.rootResult, 'returned'); assert.equal(retried.end.acknowledgementAttempted, true);
        assert.equal(retried.snapshot.originalAckCount, 1); assert.equal(retried.end.freshWrites.length, 1);
        assert.equal(retried.end.freshWrites[0].id, original.snapshot.recordId);
        const receiptAt = first.messages.findIndex(x => x.event === 'qualification_handoff_retry_receipt');
        const observedAt = first.messages.findLastIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'observe');
        const ackAt = first.messages.findLastIndex(x => x.event === 'qualification_ack');
        const endAt = first.messages.findLastIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'end');
        assert(receiptAt >= 0 && observedAt > receiptAt && ackAt > observedAt && endAt > ackAt);
        await associateOriginal(retried);
        const untouched = new Proxy({}, {get() {assert.fail('the old failed end borrowed a new attempt receipt');}});
        assert.deepEqual(await new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched)
            .adjudicate(original.evidence), {state: 'unresolved'});
    }
    await finish(first);
    console.log(JSON.stringify({passed: true, native: process.version, mode, originalWireDsCallback: true,
        originalPublicationConfirmed: true, unrelatedWorkerAssociated: true, originalWriteAckEndOrder: !failed,
        failedCoreWriteNoAck: mode === 'failed-write' || mode === 'lost-receipt',
        primaryVisibleInspectionOnly: mode === 'lost-receipt', freshConditionalRetryRequired: mode === 'lost-receipt',
        ackAttemptWithoutReturn: ackThrows,
        noAssociationOnFailure: failed, controlledStorageAndCanonicalAuthority: true,
        brokerSettlement: 'unknown', capacityAuthority: false, fullWorkerQualification: false}));
} finally {
    await fixture.close();
}
