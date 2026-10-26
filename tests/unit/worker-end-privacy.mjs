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
    emit(event, snapshot) {rows.push({event, ...snapshot()});}, failed() {captureFailures++;}, maximumSuccesses: 32});
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
const fields = ['operation','attemptId','sequence','descriptorSha256','bindingSha256'];
const aliases = ['requestId-clientId','requestId-challenge','attemptId-clientId','reply-receiptId-clientId','reply-binding-clientId'];
let cases = [...Object.keys(variants), ...fields.map(value => `structured-${value}`), ...aliases,
    'summary-key-clientId','summary-key-challenge','summary-key-both-collision'];
if (process.argv[2]) {assert.ok(cases.includes(process.argv[2])); cases = [process.argv[2]];}
let rejectedCount = 0;
for (const variant of cases) {
    const supervisor = new WorkerAttemptSupervisor(), sent = [];
    const worker = Object.assign(new EventEmitter(), {isConnected: () => true,
        send(message, callback) {sent.push(message); callback?.(null); return true;}});
    supervisor.attach(worker, 'projection');
    const clientId = randomUUID();
    const send = (payload, requestId = randomUUID()) => {
        const originalReturn = supervisor.handle(worker, {event: 'worker_attempt_request', requestId, payload: {clientId, ...payload}});
        assert.equal(originalReturn, true);
        return {requestId, reply: sent.at(-1).result};
    };
    try {
        const hello = send({operation: 'hello'}).reply, attemptId = variant === 'attemptId-clientId' ? clientId : randomUUID();
        const authority = {epoch: hello.epoch, incarnation: hello.incarnation, attemptId, sequence: 1};
        const descriptor = {kind: 'projection-frame', receiptId: variant === 'reply-receiptId-clientId' ? clientId : randomUUID(), payloadSha256: 'a'.repeat(64),
            headersSha256: null, consumerId: null, publisherId: null, queue: null, deliveryTag: null};
        const registration = send({operation: 'register', ...authority, descriptor}).reply;
        assert.equal(registration.ok, true);
        const binding = variant === 'reply-binding-clientId' ? {projectionId: clientId} : {};
        if (variant === 'reply-binding-clientId')
            assert.equal(send({operation: 'bind', ...authority, challenge: registration.challenge, version: 1, binding}).reply.ok, true);
        const end = {operation: 'end', ...authority, challenge: registration.challenge,
            descriptorSha256: workerAttemptDigest(descriptor), bindingSha256: workerAttemptDigest(binding),
            summary: {acknowledgementAttempted: false, rootResult: 'returned'}};
        const input = structuredClone(end);
        if (Object.hasOwn(variants, variant)) input.summary = variants[variant](clientId, registration.challenge);
        if (variant.startsWith('structured-')) input[variant.slice('structured-'.length)] = {clientId, challenge: registration.challenge};
        if (variant.startsWith('summary-key-')) input.summary[variant === 'summary-key-clientId' ? clientId : registration.challenge] = 'unknown value';
        if (variant === 'summary-key-both-collision') Object.assign(input.summary,
            {[clientId]: 'unknown client key', '[credential-redacted]': 'ordinary unknown key'});
        const requestId = variant === 'requestId-clientId' ? clientId : variant === 'requestId-challenge' ? registration.challenge : randomUUID();
        const result = send(input, requestId), accepted = aliases.includes(variant);
        assert.equal(result.reply.ok, accepted);
        if (!accepted) {assert.equal(typeof result.reply.error, 'string'); rejectedCount++;}
        const row = rows.at(-1);
        assert.ok(row, `Original end must remain observable: ${variant}`);
        const encoded = JSON.stringify(row);
        assert.equal(encoded.includes(clientId), false, `Issued client ID must be excluded: ${variant}`);
        assert.equal(encoded.includes(registration.challenge), false, `Issued challenge must be excluded: ${variant}`);
        assert.equal(row.credentialsRetained, false);
        assert.equal(row.reply.ok, accepted);
        if (Object.hasOwn(variants, variant) || variant.startsWith('summary-key-'))
            assert.ok(row.mismatches.some(value => value.startsWith('summary.')));
        if (variant === 'extra-key') assert.deepEqual(row.request.summary.extra, {valueRedacted: true});
        if (variant === 'summary-key-both-collision') {
            assert.equal(Object.keys(row.request.summary).length, 5);
            assert.deepEqual(row.request.summary['[credential-redacted]'], {valueRedacted: true});
        }
        // Observation and invalid input must not consume or invalidate the issued original capability.
        if (!accepted) assert.equal(send(end).reply.ok, true);
    } finally {supervisor.observeExit(worker);}
}
assert.equal(captureFailures, 0);
assert.equal(diagnostics.snapshot().reportFailures, 0);
assert.equal(diagnostics.snapshot().failures, rejectedCount);
console.log(JSON.stringify({passed: true, variants: cases.length, issuedCredentialsExcluded: true,
    originalOutcomesPreserved: true, controlledCallbacksOnly: true, productionAuthority: false}));
