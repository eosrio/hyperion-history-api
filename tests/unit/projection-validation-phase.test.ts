import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {advanceProjectionMeasurementPhase, assertProjectionPhaseAck, assertProjectionMeasurementReport} from '../../scripts/qualification/projection-validation-phase.mjs';
import {createProjectionValidationObserver} from '../../scripts/qualification/projection-validation-observer.mjs';

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

test('a delayed actual adapter keeps the prefix barrier and source release pending', async () => {
    const observer = createProjectionValidationObserver({identity: {pid: 44, parentPid: 42, role: 'projection', node: 'v24.19.0'},
        limits: {readinessTimeoutMS: 1000}});
    const child = new Child((value, message, callback) => {
        void observer.handlePhase(message).then(reply => value.emit('message', {...reply, viaParentPid: 42})); callback();
    });
    let releases = 0;
    const barrier = advanceProjectionMeasurementPhase(child, identity, 'prefix', 2000).then(result => {releases++; return result;});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(releases).toBe(0); expect(observer.report().phases).toEqual([]);
    const adapter = {validate: (value: unknown) => value, metadata: {async findOne() {}},
        client: {startSession() {}}, async transaction() {}, async initialize() {}, async open() {}, async recovery() {},
        async retainedCheckpoints() {}, async markIncomplete() {}, async apply() {}, async rollback() {}, async query() {}};
    expect(observer.attachAdapter(adapter, 'owner')).toBe(true);
    const result: any = await barrier;
    expect(releases).toBe(1); expect(result.acknowledgment.attached).toBe(true);
    expect(observer.report().phases.map((phase: any) => phase.phase)).toEqual(['prefix']);
    expect(observer.report().errors).toEqual([]);
    for (const event of ['message', 'exit', 'error']) expect(child.listenerCount(event)).toBe(0);
    observer.restore();
});

test('prefix retries preserve one request identity and stop after acknowledgment', async () => {
    const messages: any[] = [];
    const child = new Child((value, message, callback) => {
        messages.push(message);
        if (messages.length === 2) value.emit('message', {...ack, requestId: message.requestId});
        callback();
    });
    const result: any = await advanceProjectionMeasurementPhase(child, identity, 'prefix', 1000);
    expect(result.sendAttempts).toBe(2); expect(result.retryIntervalMS).toBe(100);
    expect(messages[1]).toEqual(messages[0]);
    await new Promise(resolve => setTimeout(resolve, 120)); expect(messages).toHaveLength(2);
    for (const event of ['message', 'exit', 'error']) expect(child.listenerCount(event)).toBe(0);
});

const native = process.env.HYPERION_NATIVE_NODE ?? process.env.HYPERION_TEST_NODE ?? 'node';
let nativeVersion = ''; try {nativeVersion = execFileSync(native, ['--version'], {encoding: 'utf8', timeout: 5000}).trim();} catch {}
test('native IPC with an existing earlier listener recovers a consumed prefix exactly once', {skip: !/^v(?:22|24)\./.test(nativeVersion), timeout: 20000}, () => {
    const directory = mkdtempSync(join(tmpdir(), 'hapi252-early-ipc-')), childFile = join(directory, 'late-observer.mjs');
    const observerURL = new URL('../../scripts/qualification/projection-validation-observer.mjs', import.meta.url).href;
    const phaseURL = new URL('../../scripts/qualification/projection-validation-phase.mjs', import.meta.url).href;
    writeFileSync(childFile, `
        import {setTimeout as delay} from 'node:timers/promises';
        let early = 0, firstPhase;
        const consumed = new Promise(resolve => {firstPhase = resolve;});
        process.on('message', message => {if (message?.event === 'qualifier_projection_phase') {early++; firstPhase();}});
        process.send({event: 'early-listener-ready'});
        await consumed;
        await delay(150);
        const {createProjectionValidationObserver} = await import(${JSON.stringify(observerURL)});
        const observer = createProjectionValidationObserver({identity: {pid: process.pid, parentPid: process.ppid, role: 'api', node: process.version}});
        const adapter = {validate: x => x, metadata: {async findOne() {}}, client: {startSession() {}},
            async transaction() {}, async initialize() {}, async open() {}, async recovery() {}, async retainedCheckpoints() {},
            async markIncomplete() {}, async apply() {}, async rollback() {}, async query() {}};
        observer.attachAdapter(adapter, 'api-discovery');
        process.on('message', message => {if (message?.event === 'qualifier_projection_phase')
            void observer.handlePhase(message).then(ack => process.send({...ack, early, phases: observer.report().phases.length}));});
    `);
    const code = `
        import assert from 'node:assert/strict'; import {fork} from 'node:child_process'; import {once} from 'node:events';
        import {advanceProjectionMeasurementPhase} from ${JSON.stringify(phaseURL)};
        const child = fork(new URL(${JSON.stringify(pathToFileURL(childFile).href)}), [], {execArgv: [], silent: true});
        let releases = 0;
        try {
            const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => {throw Error('IPC child exited before ready');})]);
            assert.equal(ready.event, 'early-listener-ready');
            const receipt = await advanceProjectionMeasurementPhase(child, {pid: child.pid, parentPid: process.pid, role: 'api'}, 'prefix', 5000);
            releases++; assert.equal(receipt.acknowledgment.phases, 1); assert.ok(receipt.acknowledgment.early >= 2);
            assert.ok(receipt.sendAttempts >= 2 && receipt.sendAttempts <= 50); assert.equal(releases, 1);
            console.log(JSON.stringify({node: process.version, releases, phases: receipt.acknowledgment.phases, sendAttempts: receipt.sendAttempts}));
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit'); if (child.connected) child.disconnect();
                const [code, signal] = await exited; assert.equal(code, 0); assert.equal(signal, null);
            } else {assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);}
        }
    `;
    try {
        const output = JSON.parse(execFileSync(native, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 15000}));
        expect(output.node).toBe(nativeVersion); expect(output.releases).toBe(1); expect(output.phases).toBe(1);
        expect(output.sendAttempts).toBeGreaterThanOrEqual(2);
    } finally {unlinkSync(childFile); rmdirSync(directory);}
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
        sessionHooks: {maximum: 50000, weakReferenceSlots: 2, limitExceeded: 0},
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
        (copy: any) => {copy.spans[1].startPhase = 'verification';}, (copy: any) => {copy.attachments[0].initialPublicOperationUnobserved = true;},
        (copy: any) => {delete copy.sessionHooks;}, (copy: any) => {copy.sessionHooks.maximum = 50001;},
        (copy: any) => {copy.sessionHooks.weakReferenceSlots = 50001;}, (copy: any) => {copy.sessionHooks.limitExceeded = 1;}]) {
        const copy = structuredClone(report); mutate(copy);
        expect(() => assertProjectionMeasurementReport(copy, identity, barriers, hash)).toThrow();
    }
});
