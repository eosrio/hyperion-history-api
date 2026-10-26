/** Real original supervisor with controlled transport; no production/source authority. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WorkerAttemptSupervisor, workerAttemptDigest} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {installWorkerEndDiagnostics} from '../../scripts/qualification/worker-end-diagnostics.mjs';

const rows = [];
let captureFailures = 0;
const diagnostics = installWorkerEndDiagnostics({Supervisor: WorkerAttemptSupervisor,
    workerIdentity: () => ({pid: process.pid, controlledCallbacksOnly: true}),
    emit(event, snapshot) {rows.push({event, ...snapshot()});}, failed() {captureFailures++;}});
const variants = {
    array: (clientId, challenge) => [clientId, challenge],
    string: (clientId, challenge) => challenge,
    number: () => 42,
    null: () => null,
    'root-object': (clientId, challenge) => ({acknowledgementAttempted: false, rootResult: {clientId, challenge}}),
    'root-array': (clientId, challenge) => ({acknowledgementAttempted: false, rootResult: [clientId, challenge]}),
    'root-string': (clientId, challenge) => ({acknowledgementAttempted: false, rootResult: challenge}),
    'ack-object': (clientId, challenge) => ({acknowledgementAttempted: {clientId, challenge}, rootResult: 'returned'}),
    'ack-string': (clientId, challenge) => ({acknowledgementAttempted: challenge, rootResult: 'returned'}),
    'extra-key': (clientId, challenge) => ({acknowledgementAttempted: false, rootResult: 'returned', extra: {clientId, challenge}})
};
for (const [variant, summary] of Object.entries(variants)) {
    const supervisor = new WorkerAttemptSupervisor(), sent = [];
    const worker = Object.assign(new EventEmitter(), {isConnected: () => true,
        send(message, callback) {sent.push(message); callback?.(null); return true;}});
    supervisor.attach(worker, 'projection');
    const clientId = randomUUID();
    const send = payload => {
        const requestId = randomUUID();
        const originalReturn = supervisor.handle(worker, {event: 'worker_attempt_request', requestId, payload: {clientId, ...payload}});
        assert.equal(originalReturn, true);
        return {requestId, reply: sent.at(-1).result};
    };
    try {
        const hello = send({operation: 'hello'}).reply, attemptId = randomUUID();
        const authority = {epoch: hello.epoch, incarnation: hello.incarnation, attemptId, sequence: 1};
        const descriptor = {kind: 'projection-frame', receiptId: randomUUID(), payloadSha256: 'a'.repeat(64),
            headersSha256: null, consumerId: null, publisherId: null, queue: null, deliveryTag: null};
        const registration = send({operation: 'register', ...authority, descriptor}).reply;
        assert.equal(registration.ok, true);
        const end = {operation: 'end', ...authority, challenge: registration.challenge,
            descriptorSha256: workerAttemptDigest(descriptor), bindingSha256: workerAttemptDigest({})};
        const rejected = send({...end, summary: summary(clientId, registration.challenge)});
        assert.equal(rejected.reply.error, 'Invalid worker attempt end association');
        const row = rows.find(value => value.requestId === rejected.requestId);
        assert.ok(row, `Original rejected end must remain observable: ${variant}`);
        const encoded = JSON.stringify(row);
        assert.equal(encoded.includes(clientId), false, `Issued client ID must be excluded: ${variant}`);
        assert.equal(encoded.includes(registration.challenge), false, `Issued challenge must be excluded: ${variant}`);
        assert.equal(row.credentialsRetained, false);
        assert.equal(row.reply.ok, false);
        assert.ok(row.mismatches.some(value => value.startsWith('summary.')));
        if (variant === 'extra-key') assert.deepEqual(row.request.summary.extra, {valueRedacted: true});
        // Observation and invalid input must not consume or invalidate the issued original capability.
        assert.equal(send({...end, summary: {acknowledgementAttempted: false, rootResult: 'returned'}}).reply.ok, true);
    } finally {supervisor.observeExit(worker);}
}
assert.equal(captureFailures, 0);
assert.equal(diagnostics.snapshot().reportFailures, 0);
assert.equal(diagnostics.snapshot().failures, Object.keys(variants).length);
console.log(JSON.stringify({passed: true, variants: Object.keys(variants).length, issuedCredentialsExcluded: true,
    originalOutcomesPreserved: true, controlledCallbacksOnly: true, productionAuthority: false}));
