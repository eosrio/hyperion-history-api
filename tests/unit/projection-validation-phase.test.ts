import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {advanceProjectionMeasurementPhase, assertProjectionPhaseAck, assertProjectionMeasurementReport} from '../../scripts/qualification/projection-validation-phase.mjs';

const identity = {pid: 44, parentPid: 42, role: 'projection', viaParentPid: 42};
const ack = {event: 'qualifier_projection_phase_ack', ...identity, phase: 'prefix', requestId: 'request', attached: true};

test('phase acknowledgments require the attached actual sender, its parent and phase', () => {
    expect(assertProjectionPhaseAck(ack, {...identity, phase: 'prefix', requestId: 'request'})).toBe(ack);
    for (const patch of [{pid: 99}, {parentPid: 99}, {viaParentPid: 99}, {role: 'api'}, {phase: 'held-head'},
        {requestId: 'another'}, {attached: false}, {error: 'not attached'}]) {
        expect(() => assertProjectionPhaseAck({...ack, ...patch}, {...identity, phase: 'prefix', requestId: 'request'})).toThrow();
    }
});

class Child extends EventEmitter {
    pid = 42; exitCode = null; signalCode = null;
    sent: unknown;
    constructor(private readonly reply: (child: Child, message: any, callback: (error?: Error) => void) => void) {super();}
    send(message: any, callback: (error?: Error) => void) {
        this.sent = message; this.reply(this, message, callback); return false;
    }
}

test('the barrier accepts backpressure, ignores unrelated IPC and removes its listeners', async () => {
    const child = new Child((value, message, callback) => queueMicrotask(() => {
        value.emit('message', {...ack, requestId: 'foreign'});
        value.emit('message', {...ack, requestId: message.requestId}); callback();
    }));
    const result: any = await advanceProjectionMeasurementPhase(child, identity, 'prefix');
    expect(result.acknowledgment.pid).toBe(44);
    expect(result.receivedAt).toBeGreaterThanOrEqual(result.sentAt);
    expect(Object.keys(child.sent as any).sort()).toEqual(['event', 'phase', 'requestId']);
    for (const event of ['message', 'exit', 'error']) expect(child.listenerCount(event)).toBe(0);
});

test('phase failures retain their cause and release listeners', async () => {
    const failure = new Error('send failed');
    for (const reply of [
        (child: Child, message: any) => child.emit('message', {...ack, requestId: message.requestId, pid: 99}),
        (child: Child) => child.emit('exit', 0, null),
        (_child: Child, _message: any, callback: (error?: Error) => void) => callback(failure),
        () => {throw failure;},
        () => {},
    ]) {
        const child = new Child(reply);
        await expect(advanceProjectionMeasurementPhase(child, identity, 'prefix', 10)).rejects.toThrow();
        for (const event of ['message', 'exit', 'error']) expect(child.listenerCount(event)).toBe(0);
    }
});

test('phase barriers reject foreign ownership, invalid phases and excessive waits before sending', () => {
    const child = new Child(() => {throw new Error('must not send');});
    for (const selected of [{...identity, parentPid: 99}, {...identity, viaParentPid: undefined},
        {...identity, role: 'api'}, {...identity, pid: 0}]) {
        expect(() => advanceProjectionMeasurementPhase(child, selected, 'prefix')).toThrow();
    }
    for (const phase of ['startup', 'unknown']) expect(() => advanceProjectionMeasurementPhase(child, identity, phase)).toThrow();
    for (const timeout of [0, 10001]) expect(() => advanceProjectionMeasurementPhase(child, identity, 'prefix', timeout)).toThrow();
    expect(child.sent).toBeUndefined();
});

test('sealed receipts must match the independent process, emission and phase inventory', () => {
    const phases = ['prefix', 'held-head', 'verification', 'shutdown'];
    const barriers = phases.map(phase => ({phase, receipts: [{acknowledgment: {...ack, phase, requestId: phase}}]}));
    const hash = 'a'.repeat(64);
    const report = {schemaVersion: 1, qualificationOnly: true, enabled: true, pid: 44, parentPid: 42, role: 'projection', node: 'v24.19.0',
        sealed: true, sealTimedOut: false, errors: [], droppedSpans: 0, inFlight: [], suppressedRootSpans: 0,
        attachments: [{id: 1, initialPublicOperationUnobserved: false}], modules: [{path: '/owned/dist/storage.js', sha256: hash}],
        phases: phases.map((phase, index) => ({phase, requestId: phase, sequence: index + 1, atNs: String(index + 1)})),
        spans: [{id: 1, parentId: null, rootId: 1, attachmentId: 1, outcome: 'fulfilled', startNs: '1', endNs: '3', durationNs: '2',
            startPhase: 'prefix', endPhase: 'held-head'},
            {id: 2, parentId: 1, rootId: 1, attachmentId: 1, outcome: 'returned', startNs: '2', endNs: '3', durationNs: '1',
                startPhase: 'prefix', endPhase: 'held-head'}], counters: [{name: 'load', count: 1}], coverage: {lexicalValidation: 'unobserved'}};
    expect(assertProjectionMeasurementReport(report, identity, barriers, hash).spans).toBe(2);
    for (const mutate of [(copy: any) => {copy.pid = 99;}, (copy: any) => {copy.sealed = false;},
        (copy: any) => {copy.inFlight.push({id: 3});}, (copy: any) => {copy.errors.push('failed observer');},
        (copy: any) => {copy.droppedSpans = 1;}, (copy: any) => {copy.modules[0].sha256 = 'b'.repeat(64);},
        (copy: any) => {copy.phases[0].requestId = 'unrelated';}, (copy: any) => {copy.phases[1].sequence = 1;},
        (copy: any) => {copy.spans[1].durationNs = '3';}, (copy: any) => {copy.spans[1].rootId = 99;},
        (copy: any) => {copy.spans[1].id = 1;}, (copy: any) => {copy.spans[1].attachmentId = 99;},
        (copy: any) => {copy.spans[1].startPhase = 'verification';}, (copy: any) => {copy.attachments[0].initialPublicOperationUnobserved = true;}]) {
        const copy = structuredClone(report); mutate(copy);
        expect(() => assertProjectionMeasurementReport(copy, identity, barriers, hash)).toThrow();
    }
});
