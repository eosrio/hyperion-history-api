/** Actual supervisor with controlled callbacks; no real worker/source/semantic authority. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WorkerAttemptSupervisor, workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {installWorkerEndDiagnostics} from '../../scripts/qualification/worker-end-diagnostics.mjs';

let emitted = [], captureFailures = 0;
const originalHandle = WorkerAttemptSupervisor.prototype.handle, originalReply = WorkerAttemptSupervisor.prototype.reply;
let lastHandle, lastReply, throwReply;
const sentinel = new Error('original reply throw');
WorkerAttemptSupervisor.prototype.handle = function(...args) {
    const result = originalHandle.apply(this, args); lastHandle = {result, args}; return result;
};
WorkerAttemptSupervisor.prototype.reply = function(...args) {
    if (throwReply && (args[2]?.end || args[2]?.error === sentinel.message)) throw sentinel;
    const result = originalReply.apply(this, args); lastReply = {result, args}; return result;
};
function fixture() {
    const sent = [], supervisor = new WorkerAttemptSupervisor(), worker = Object.assign(new EventEmitter(), {
        isConnected: () => true, send(message, callback) {sent.push(message); callback?.(null); return true;}});
    supervisor.attach(worker, 'projection');
    const clientId = randomUUID();
    const send = payload => {
        const request = {event: 'worker_attempt_request', requestId: randomUUID(), payload: {clientId, ...payload}};
        const extra = Object.freeze({});
        const result = supervisor.handle(worker, request, extra);
        assert.equal(result, lastHandle.result); assert.equal(lastHandle.args[2], extra);
        return {request, result, reply: sent.at(-1).result};
    };
    const hello = send({operation: 'hello'}).reply;
    let sequence = 0;
    const end = (patch = {}, getter = false) => {
        const attemptId = randomUUID(), descriptor = {kind: 'projection-frame', receiptId: randomUUID(), payloadSha256: 'a'.repeat(64),
            headersSha256: null, consumerId: null, publisherId: null, queue: null, deliveryTag: null};
        const authority = {epoch: hello.epoch, incarnation: hello.incarnation, attemptId, sequence: ++sequence};
        const registration = send({operation: 'register', ...authority, descriptor}).reply;
        const payload = {operation: 'end', ...authority, challenge: registration.challenge,
            descriptorSha256: workerAttemptDigest(descriptor), bindingSha256: workerAttemptDigest({}),
            summary: {acknowledgementAttempted: false, rootResult: 'returned'}, ...patch};
        let reads = 0;
        if (getter) Object.defineProperty(payload, 'summary', {enumerable: true, get() {reads++; return {acknowledgementAttempted: false, rootResult: 'returned'};}});
        const request = {event: 'worker_attempt_request', requestId: randomUUID(), payload: {...{clientId}, ...payload}};
        // Preserve the accessor for direct-method transparency controls; native IPC never transports one.
        if (getter) Object.defineProperty(request.payload, 'summary', Object.getOwnPropertyDescriptor(payload, 'summary'));
        reads = 0;
        let result, error;
        try {result = supervisor.handle(worker, request);} catch (value) {error = value;}
        return {result, originalError: error === sentinel, reads, reply: sent.at(-1)?.result, request};
    };
    return {supervisor, worker, end, sent, close() {supervisor.observeExit(worker);}};
}
function runControls() {
    const f = fixture();
    try {
        const normal = f.end(); assert.equal(normal.result, true); assert.equal(normal.reply.ok, true);
        const invalid = f.end({bindingSha256: 'f'.repeat(64)});
        assert.equal(invalid.reply.error, 'Invalid worker attempt end association');
        const getter = f.end({}, true); assert.equal(getter.result, true);
        throwReply = true;
        const thrown = f.end(); assert.equal(thrown.originalError, true); throwReply = false;
        const token = Object.freeze({});
        const direct = f.supervisor.reply(f.worker, randomUUID(), {ok: true}, token);
        assert.equal(direct, lastReply.result); assert.equal(lastReply.args[3], token);
        return {getterReads: getter.reads, getterAccepted: getter.reply.ok, normal: normal.reply.ok, invalid: invalid.reply.error,
            originalThrow: thrown.originalError, originalReturn: normal.result};
    } finally {throwReply = false; f.close();}
}
const baseline = runControls();
const diagnostics = installWorkerEndDiagnostics({Supervisor: WorkerAttemptSupervisor,
    workerIdentity: () => ({pid: process.pid, controlledCallbackOnly: true}),
    emit(event, snapshot) {const value = snapshot(); emitted.push({event, value: structuredClone(value)}); value.reply.ok = false;},
    failed() {captureFailures++;}, maximumSuccesses: 2, maximumFailures: 2});
assert.deepEqual(runControls(), baseline, 'Observation must preserve original getters, arguments, returns and synchronous errors');
assert.ok(captureFailures > 0, 'Unsupported accessor/throw observations must remain explicit');
const before = diagnostics.snapshot();
const f = fixture();
try {for (let index = 0; index < 4; index++) assert.equal(f.end({bindingSha256: 'f'.repeat(64)}).reply.ok, false);}
finally {f.close();}
const after = diagnostics.snapshot();
assert.ok(after.omittedFailures > before.omittedFailures);
assert.ok(after.reportFailures > 0);
assert.ok(emitted.some(row => row.value.reply.error === 'Invalid worker attempt end association'));
assert.equal(JSON.stringify(emitted).includes('"challenge"'), false);
console.log(JSON.stringify({passed: true, originalOutcomesPreserved: true, getterReads: baseline.getterReads,
    omittedFailuresExplicit: true, controlledCallbacksOnly: true, productionAuthority: false}));
