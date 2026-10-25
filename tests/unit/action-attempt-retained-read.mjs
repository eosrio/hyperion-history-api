/** Original managed Wire callbacks; delayed transport/canonical inputs are controlled, not live qualification. */
import assert from 'node:assert/strict';
import {describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {managedWireAttemptFixture} from './managed-wire-attempt-fixture.mjs';

const mode = process.argv[2] ?? 'main-held-proof';
const selected = /^(main|handoff)-(held|failed|cancelled)-(proof|open)$/.exec(mode);
assert(selected && (selected[3] !== 'open' || selected[2] === 'cancelled'));
const isMain = selected[1] === 'main', kind = selected[2], phase = selected[3], late = phase === 'proof';
const fixture = managedWireAttemptFixture({role: isMain ? 'deserializer' : 'ds_pool_worker', workerMode: 'managed-original-' + mode});
const {supervisor, spawn, event, requests, ownEnd, until, inspectOriginal, associateOriginal, finish} = fixture;
try {
    // Prepare the sibling before the held worker starts its original five-second proof wait.
    const peer = spawn({HYPERION_QUALIFICATION_PLAIN_PROOF: 'true'});
    await until(() => event(peer, 'qualification_peer_ready'), peer, 'independent worker is ready to run its original callback');
    const first = spawn();
    await until(() => event(first, 'qualification_proof_held'), first, 'original callback reaches required retained control read');
    const held = event(first, 'qualification_proof_held');
    assert.equal(held.originalAckCount, 0); assert.equal(held.signalPassed, true);
    assert.equal(held.request.id, 'control'); assert.match(held.request.index, /-protocol-abi-frontier-v1$/);
    assert(held.scope.pendingOperations >= 1, 'the real proof read remains owned by its original scope');
    assert.equal(requests(first, 'observe').length, late ? 1 : 0);
    assert.equal(!!held.freshWrite, late);
    assert.equal(event(first, 'qualification_ack'), undefined); assert.equal(ownEnd(first), undefined);
    assert.equal(supervisor.snapshot().active, 2);
    assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(requests(first, 'register')[0].payload)), /Unissued or foreign/);

    // The same supervisor can accept another actual physical callback while the first read stays held.
    peer.child.send({event: 'qualification_start_peer'});
    await until(() => event(peer, 'qualification_fixture') && ownEnd(peer), peer, 'independent original worker completes');
    const other = await inspectOriginal(peer);
    assert.equal(other.end.rootResult, 'returned'); assert.equal(other.end.acknowledgementAttempted, true);
    assert.equal(other.end.freshWrites.length, 1); assert.equal(other.snapshot.originalAckCount, 1);
    assert.notEqual(other.end.incarnation, requests(first, 'register')[0].payload.incarnation);
    await associateOriginal(other); await finish(peer);
    assert.equal(ownEnd(first), undefined); assert.equal(event(first, 'qualification_proof_settled'), undefined);

    if (kind === 'cancelled') {
        supervisor.fenceActive();
        await until(() => event(first, 'qualification_proof_fenced'), first, 'original scope observes the authenticated parent fence');
        const fenced = event(first, 'qualification_proof_fenced');
        assert.deepEqual(fenced.effects, held.effects, 'the fence cannot admit a new output or storage dispatch');
        assert.equal(fenced.readSettled, false); assert.equal(fenced.readSignalAborted, true);
        assert.equal(fenced.originalAckCount, 0); assert.equal(fenced.scope.state, 'fenced');
        assert(fenced.scope.pendingOperations >= 1);
        if (!late) {
            await until(() => event(first, 'qualification_proof_wait_rejected'), first, 'real outer proof wait rejects before its inner read');
            const rejected = event(first, 'qualification_proof_wait_rejected');
            assert.equal(rejected.code, 'proof_cancelled'); assert.equal(rejected.readSettled, false);
        }
        await until(() => event(first, 'qualification_proof_probe'), first, 'actual retained proof or bound open helper rejects post-fence use');
        const probe = event(first, 'qualification_proof_probe');
        assert.equal(probe.kind, late ? isMain ? 'issued-abi-view' : 'issued-native-view' : 'retained-open-helper');
        assert.equal(probe.accepted, false); assert.equal(probe.code, 'worker_attempt_fenced');
        assert.equal(probe.ownsFence, true); assert.equal(probe.readSettled, false);
        assert.deepEqual(probe.effects, fenced.effects, 'post-fence proof use must not dispatch IO or output');
        await new Promise(yes => setTimeout(yes, 20));
        assert.equal(ownEnd(first), undefined, 'outer rejection cannot issue an end while its actual inner read is pending');
        assert.equal(event(first, 'qualification_ack'), undefined);
        assert.equal(event(first, 'qualification_proof_settled'), undefined);
    }
    first.child.send({event: 'qualification_release_proof'});
    await until(() => event(first, 'qualification_fixture') && ownEnd(first), first, 'real read settles before authenticated original end');
    const original = await inspectOriginal(first), failed = kind !== 'held';
    assert.equal(original.end.rootResult, failed ? 'threw' : 'returned');
    assert.equal(original.end.acknowledgementAttempted, !failed);
    assert.equal(original.snapshot.originalAckCount, failed ? 0 : 1);
    assert.equal(original.end.freshWrites.length, late ? 1 : 0);
    const settled = first.messages.findIndex(x => x.event === 'qualification_proof_settled');
    const ended = first.messages.findIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'end');
    assert(settled >= 0 && ended > settled);
    if (kind === 'cancelled') {
        const fenced = event(first, 'qualification_proof_fenced');
        assert.deepEqual(event(first, 'qualification_proof_settled').effects, fenced.effects,
            'inner-read settlement cannot authorize a new dispatch after the fence');
        assert.deepEqual(event(first, 'qualification_proof_failed').effects, fenced.effects,
            'the eventual original end cannot hide post-fence output or IO');
    }
    if (failed) {
        const failure = event(first, 'qualification_proof_failed');
        assert(failure); assert.equal(event(first, 'qualification_ack'), undefined);
        if (kind === 'failed') assert.deepEqual({name: failure.errorName, code: failure.errorCode, status: failure.statusCode},
            isMain ? {name: 'Error', code: null, status: null}
                : {name: 'ProtocolNativeActionUnavailableError', code: 'native_read_unavailable', status: 503});
        const untouched = new Proxy({}, {get() {assert.fail('failed original callback reached adjudication storage or authority');}});
        const adjudicator = new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched);
        assert.deepEqual(await adjudicator.adjudicate(original.evidence), {state: 'unresolved'});
        if (late) {
            const write = original.end.freshWrites[0];
            assert.equal(write.classification, isMain ? 'source-incomplete' : 'confirmed-handoff');
            const record = isMain ? await original.store.readAttemptDisposition(write.id)
                : await original.store.readConfirmedHandoff(original.end.binding.admissionId, original.end.binding.traceOrdinal,
                    Buffer.from((await original.store.resolve(original.end.binding.admissionId)).inventory.transactions
                        .find(x => x.traceOrdinal === original.end.binding.traceOrdinal).dispatch.canonicalJson));
            assert.equal(record.id, write.id);
            assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(original.end)), /Unissued or foreign/);
        }
    } else {
        const observed = first.messages.findIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'observe');
        const ack = first.messages.findIndex(x => x.event === 'qualification_ack');
        assert(observed >= 0 && settled > observed && ack > settled && ended > ack);
        await associateOriginal(original);
    }
    await finish(first);
    console.log(JSON.stringify({passed: true, native: process.version, mode, originalWireCallbacks: true,
        actualRetainedControlRead: true, originalFreshWriteBeforeHeldRead: late, unrelatedWorkerAssociated: true,
        noAckOnReadFailure: failed, outerRejectionBeforeInnerDrain: !late,
        postFenceProofAndOutputObserved: kind === 'cancelled',
        originalReadSettledBeforeEnd: true, controlledStorageAndCanonicalAuthority: true,
        brokerSettlement: 'unknown', capacityAuthority: false, fullWorkerQualification: false}));
} finally {
    await fixture.close();
}
