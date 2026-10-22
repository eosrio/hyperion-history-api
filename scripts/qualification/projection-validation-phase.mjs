/** Qualification-only barriers; a process must acknowledge attachment before source release. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export const projectionMeasurementPhases = Object.freeze(['prefix', 'held-head', 'verification', 'shutdown']);

export function assertProjectionPhaseAck(message, expected) {
    assert.equal(message?.event, 'qualifier_projection_phase_ack');
    assert.equal(message.requestId, expected.requestId);
    assert.equal(message.phase, expected.phase);
    assert.equal(message.pid, expected.pid, 'Measurement acknowledgment came from a foreign process');
    assert.equal(message.parentPid, expected.parentPid);
    assert.equal(message.role, expected.role);
    assert.equal(message.attached, true, 'Actual adapter must be attached before phase acknowledgment');
    assert.equal(message.error ?? null, null);
    if (expected.viaParentPid === undefined) assert.equal(message.viaParentPid, undefined);
    else assert.equal(message.viaParentPid, expected.viaParentPid, 'Master must attest the actual child sender');
    return message;
}

/** Audit a sealed receipt against independently owned PIDs and the actual phase barriers. */
export function assertProjectionMeasurementReport(value, identity, phaseReceipts, storageSha256) {
    assert.equal(value?.schemaVersion, 1); assert.equal(value.qualificationOnly, true); assert.equal(value.enabled, true);
    for (const key of ['pid', 'parentPid', 'role']) assert.equal(value[key], identity[key]);
    assert.match(value.node, /^v(?:22|24)\./);
    assert.equal(value.sealed, true); assert.equal(value.sealTimedOut, false);
    assert.deepEqual(value.errors, []); assert.equal(value.droppedSpans, 0); assert.deepEqual(value.inFlight, []);
    assert.ok(Number.isSafeInteger(value.suppressedRootSpans) && value.suppressedRootSpans >= 0);
    assert.ok(Array.isArray(value.attachments) && value.attachments.length === 1);
    assert.equal(value.attachments[0].initialPublicOperationUnobserved, identity.role === 'api');
    assert.ok(Array.isArray(value.modules) && value.modules.some(module =>
        typeof module.path === 'string' && /(?:^|[\\/])storage\.js$/.test(module.path) && module.sha256 === storageSha256),
    'Actual storage module must match the pre-run emitted file');
    assert.ok(Array.isArray(value.phases)); assert.equal(value.phases.length, projectionMeasurementPhases.length);
    const uint = input => {assert.equal(typeof input, 'string'); assert.match(input, /^(?:0|[1-9][0-9]{0,19})$/); return BigInt(input);};
    let preceding = 0n;
    for (const [index, phase] of value.phases.entries()) {
        assert.equal(phase.phase, projectionMeasurementPhases[index]); assert.equal(phase.sequence, index + 1);
        const expected = phaseReceipts.find(receipt => receipt.phase === phase.phase)?.receipts
            .find(receipt => receipt.acknowledgment.pid === identity.pid)?.acknowledgment;
        assert.ok(expected, 'Independent phase acknowledgment is missing'); assert.equal(phase.requestId, expected.requestId);
        const at = uint(phase.atNs); assert.ok(at >= preceding); preceding = at;
    }
    assert.ok(Array.isArray(value.spans) && value.spans.length > 0 && value.spans.length <= 50000);
    const spans = new Map(), phases = ['startup', ...projectionMeasurementPhases];
    for (const span of value.spans) {
        assert.ok(Number.isSafeInteger(span.id) && span.id > 0 && !spans.has(span.id)); spans.set(span.id, span);
        assert.ok(['returned', 'fulfilled', 'rejected', 'threw'].includes(span.outcome));
        const start = uint(span.startNs), end = uint(span.endNs), duration = uint(span.durationNs);
        assert.ok(end >= start && duration === end - start && duration <= 1200000000000n);
        assert.ok(phases.includes(span.startPhase) && phases.includes(span.endPhase));
        assert.ok(phases.indexOf(span.startPhase) <= phases.indexOf(span.endPhase));
    }
    for (const span of value.spans) {
        const root = spans.get(span.rootId); assert.ok(root && root.parentId === null && root.rootId === root.id);
        assert.equal(span.attachmentId, value.attachments[0].id);
        if (span.parentId !== null) {
            const parent = spans.get(span.parentId); assert.ok(parent && parent.rootId === span.rootId && parent.id < span.id);
            assert.ok(uint(parent.startNs) <= uint(span.startNs));
        }
    }
    assert.ok(Array.isArray(value.counters) && value.counters.length > 0 && value.counters.length <= 512);
    return {pid: value.pid, parentPid: value.parentPid, role: value.role, node: value.node,
        spans: value.spans.length, counters: value.counters, phases: value.phases, attachments: value.attachments,
        suppressedRootSpans: value.suppressedRootSpans, sealed: true, coverage: value.coverage};
}

/** Keep this barrier separate from measured operation spans. False send results mean backpressure. */
export function advanceProjectionMeasurementPhase(child, identity, phase, timeoutMS = 10000) {
    assert.ok(projectionMeasurementPhases.includes(phase));
    assert.ok(Number.isSafeInteger(timeoutMS) && timeoutMS >= 1 && timeoutMS <= 10000);
    assert.ok(Number.isSafeInteger(child?.pid) && child.pid > 0);
    assert.ok(Number.isSafeInteger(identity?.pid) && identity.pid > 0);
    assert.ok(Number.isSafeInteger(identity.parentPid) && identity.parentPid > 0);
    assert.ok(['projection', 'api'].includes(identity.role));
    if (identity.role === 'projection') {
        assert.notEqual(identity.pid, child.pid, 'Projection worker must be a distinct actual child');
        assert.equal(identity.parentPid, child.pid);
        assert.equal(identity.viaParentPid, child.pid);
    } else {
        assert.equal(identity.pid, child.pid);
        assert.equal(identity.viaParentPid, undefined);
    }
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const requestId = randomUUID(), expected = {...identity, requestId, phase};
    const sentAt = Date.now(), sentMonotonicNs = process.hrtime.bigint().toString();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, acknowledgment) => {
            if (settled) return; settled = true; clearTimeout(timer);
            child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
            if (error) reject(error);
            else resolve({sentAt, sentMonotonicNs, receivedAt: Date.now(),
                receivedMonotonicNs: process.hrtime.bigint().toString(), acknowledgment});
        };
        const onMessage = message => {
            if (message?.event !== 'qualifier_projection_phase_ack' || message.requestId !== requestId) return;
            try {finish(null, assertProjectionPhaseAck(message, expected));} catch (error) {finish(error);}
        };
        const onExit = (code, signal) => finish(new Error(`Measurement process exited before phase acknowledgment (${code}, ${signal})`));
        const onError = error => finish(error);
        const timer = setTimeout(() => finish(new Error('Measurement phase acknowledgment timed out: ' + phase)), timeoutMS);
        child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
        try {child.send({event: 'qualifier_projection_phase', requestId, phase}, error => {if (error) finish(error);});}
        catch (error) {finish(error);}
    });
}
