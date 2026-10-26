/** Original Wire MainDS/DS callbacks through owned native children and parent adjudication.
 * Storage and canonical authority are controlled; this is not a live broker or fork qualification. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {createHash} from 'node:crypto';
import {readFileSync, rmSync, statSync, appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deserialize as deserializeShadowHeaders} from 'node:v8';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {persistRestartSnapshot, restartDirectory} from './action-attempt-restart-snapshot.mjs';

const mode = process.argv[2] ?? 'main';
const missingHeaderAccounting = process.argv.includes('--shadow-missing-headers');
const receiptBridgeEnabled = process.argv.includes('--receipt-bridge');
const receiptRegistrationHolds = process.argv.includes('--receipt-registration-holds');
const lateReceipt = process.argv.includes('--receipt-late-capture') ? 'capture'
    : process.argv.includes('--receipt-late-binding') ? 'binding' : undefined;
const receiptWorkerUnavailable = process.argv.includes('--receipt-worker-unavailable');
const unavailableReceipt = !!lateReceipt || receiptWorkerUnavailable;
const accountingEnabled = process.argv.includes('--shadow-accounting') || missingHeaderAccounting || receiptBridgeEnabled;
const shadowTransition = process.argv.includes('--shadow-transition') || accountingEnabled;
assert(!shadowTransition || ['handoff-held-confirm', 'handoff-late-source-manifest', 'handoff-unknown-association'].includes(mode));
assert(!accountingEnabled || mode === 'handoff-held-confirm');
const verifiedTransitions = [];
const lateAuthorityCases = {
    'main-late-config-target': ['config', 'target'],
    'handoff-late-config-canonical': ['config', 'canonical'],
    'handoff-late-target-canonical': ['target', 'canonical'],
    'handoff-late-config-selection': ['config', 'selection'],
    'handoff-late-target-selection': ['target', 'selection'],
    'handoff-late-config-chunk': ['config', 'chunk'],
    'handoff-late-target-chunk': ['target', 'chunk'],
    'handoff-late-config-manifest': ['config', 'manifest'],
    'handoff-late-target-manifest': ['target', 'manifest'],
    'handoff-late-config-reassertion-read': ['config', 'reassertion-read'],
    'handoff-late-target-reassertion-read': ['target', 'reassertion-read'],
    'handoff-late-source-selection': ['source', 'selection'],
    'handoff-late-source-manifest': ['source', 'manifest'],
    'handoff-late-source-prewrite-target': ['source', 'prewrite-target'],
    'handoff-late-source-postwrite-target': ['source', 'postwrite-target'],
    'handoff-late-source-reassertion-read': ['source', 'reassertion-read']
};
const lateAuthorityCase = lateAuthorityCases[mode];
assert(['main','main-held-write','main-failed-write','main-ack-throws','main-held-operation','main-held-end','main-failed-end',
    'main-held-adjudication','main-unknown-association','main-restart-checkpoint','handoff-restart-checkpoint','ds','contract','handoff',
    'handoff-held-confirm','handoff-failed-confirm','handoff-held-drain','handoff-failed-drain',
    'handoff-unknown-association'].includes(mode) || lateAuthorityCase);
const isMain = mode.startsWith('main');
const checkpointDirectory = mode.endsWith('-restart-checkpoint') ? restartDirectory(process.argv[3]) : undefined;
if (checkpointDirectory) assert.equal(typeof process.send, 'function', 'restart checkpoint requires its owning controller');
const role = isMain ? 'deserializer' : 'ds_pool_worker';
cluster.setupPrimary({exec: fileURLToPath(new URL('./action-attempt-disposition-worker.mjs', import.meta.url)),
    args: [lateAuthorityCase ? isMain ? 'managed-original-main' : 'managed-original-handoff'
        : mode === 'main-held-write' ? 'managed-original-main-held-write'
        : mode === 'main-failed-write' ? 'managed-original-main-failed-write'
        : mode === 'main-ack-throws' ? 'managed-original-main-ack-throws'
        : ['main','main-held-adjudication','main-unknown-association','main-restart-checkpoint'].includes(mode) ? 'managed-original-main'
        : mode === 'handoff-restart-checkpoint' ? 'managed-original-handoff'
        : mode === 'handoff-unknown-association' ? 'managed-original-handoff'
        : mode === 'ds' ? 'managed-original-ds'
        : mode === 'contract' ? 'managed-original-contract' : 'managed-original-' + mode],
    silent: true});
let receiptEnrollment;
const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end),
    ...(receiptBridgeEnabled ? {onObservation: token => {receiptEnrollment?.observe(token);}} : {})});
let shadow;
if (accountingEnabled) {
    const {ActionProofDemandShadow} = await import('../../build/indexer/history/action-proof-demand.js');
    const memory = frontierMemoryClient();
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const store = new ActionSourceAdmissionStore(memory.client, 'handoff-worker-original');
    const selections = new ProtocolSourceBindingStore(memory.client, 'handoff-worker-original');
    const state = {memory, store, selections, authority: undefined};
    const current = () => {assert(state.authority, 'original controlled RPC boundary is not ready'); return state.authority;};
    const adjudicator = new ActionAttemptAdjudicator(supervisor, store, selections, {
        configurationSha256: () => current().configurationSha256(),
        canonicalBlock: number => current().canonicalBlock(number),
        assertCanonicalCurrent: block => current().assertCanonicalCurrent(block),
        targetUuid: name => current().targetUuid(name),
    }, {onVerifiedDsTransition: token => {
        verifiedTransitions.push(token);
        const before = state.accounting.snapshot();
        state.accounting.observe(structuredClone(token));
        const rejected = state.accounting.snapshot();
        assert.equal(rejected.rejectedTransitions, before.rejectedTransitions + 1,
            'copied transition must not consume the original');
        assert.equal(rejected.pendingDemands, before.pendingDemands);
        assert.equal(rejected.resolvedDemands, before.resolvedDemands);
        assert.equal(rejected.knownPendingBytes, before.knownPendingBytes);
        state.accounting.observe(token);
        const consumed = state.accounting.snapshot();
        state.accounting.observe(token);
        assert.equal(state.accounting.snapshot().rejectedTransitions, consumed.rejectedTransitions + 1,
            'transition cannot be consumed twice');
    }});
    state.adjudicator = adjudicator;
    state.accounting = new ActionProofDemandShadow(adjudicator, {maximumDemands: 8, maximumBytes: 1024 * 1024});
    shadow = state;
    if (receiptBridgeEnabled) {
        const {ActionProofDemandEnrollment} = await import('../../build/indexer/history/action-proof-demand-enrollment.js');
        receiptEnrollment = new ActionProofDemandEnrollment(supervisor, state.accounting);
    }
}
const child = cluster.fork(receiptBridgeEnabled ? {HYPERION_PROOF_DEMAND_RECEIPT_TEST: '1',
    ...(receiptWorkerUnavailable ? {HYPERION_PROOF_DEMAND_RECEIPT_UNAVAILABLE_TEST: '1'} : {})}
    : accountingEnabled ? {HYPERION_PROOF_DEMAND_SHADOW_TEST: '1'} : {}), messages = [];
let stderr = '', stdout = '', exited = false, exitCode, exitSignal, snapshotPath;
child.process.stderr.on('data', bytes => {stderr += bytes.toString();});
child.process.stdout.on('data', bytes => {stdout += bytes.toString();});
child.on('message', message => {
    messages.push(message);
    if (receiptBridgeEnabled && message?.event === 'qualification_receipt_observation'
        && JSON.parse(message.packet).type !== lateReceipt) receiptEnrollment.receive(child, message.packet);
});
child.on('exit', (code, signal) => {exited = true; exitCode = code; exitSignal = signal;});
supervisor.attach(child, role);
let heldReceiptRegistration, heldReceiptReply, receiptRegistrationReleased = !receiptRegistrationHolds;
const originalReceiptHandle = supervisor.handle.bind(supervisor), originalReceiptSend = child.send.bind(child);
if (receiptRegistrationHolds) {
    supervisor.handle = (worker, message) => {
        if (!receiptRegistrationReleased && message?.event === 'worker_attempt_request' && message.payload?.operation === 'register') {
            assert(!heldReceiptRegistration || heldReceiptRegistration.requestId === message.requestId);
            heldReceiptRegistration = message; return true;
        }
        return originalReceiptHandle(worker, message);
    };
    child.send = (message, ...args) => {
        if (message?.event === 'worker_attempt_reply' && message.result?.descriptorSha256 && !heldReceiptReply) {
            heldReceiptReply = {message, args}; return true;
        }
        return originalReceiptSend(message, ...args);
    };
}

function waitFor(predicate, label, timeout = 30_000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolveWait, reject) => {
        const poll = setInterval(() => {if (predicate()) {clearInterval(poll); clearTimeout(timer); resolveWait();}}, 5);
        const timer = setTimeout(() => {clearInterval(poll); reject(new Error('Timed out: ' + label));}, timeout);
    });
}

/** Another original callback must finish while the first post-end association is held. */
async function unrelatedWorkerProgress(supervisor, ends) {
    const peer = cluster.fork(), peerMessages = [];
    let peerExited = false, peerCode, peerError = '';
    peer.on('message', message => peerMessages.push(message));
    peer.process.stdout.resume();
    peer.process.stderr.on('data', bytes => {peerError += bytes.toString();});
    peer.on('exit', code => {peerExited = true; peerCode = code;});
    supervisor.attach(peer, role);
    try {
        await waitFor(() => peerMessages.some(message => message.event === 'qualification_fixture')
            && ends.length === 2 || peerExited, 'unrelated original Wire callback during held adjudication');
        assert.equal(peerExited, false, peerError);
        const snapshot = peerMessages.find(message => message.event === 'qualification_fixture');
        assert(snapshot);
        const observed = describeWorkerAttemptEnd(supervisor, ends[1]);
        assert.equal(observed.status, 'quiescent');
        assert.equal(observed.rootResult, 'returned');
        assert.equal(observed.acknowledgementAttempted, true);
        assert.equal(observed.freshWrites.length, 1);
        assert.notEqual(observed.incarnation, describeWorkerAttemptEnd(supervisor, ends[0]).incarnation);
        assert(peerMessages.some(message => message.event === 'qualification_ack'));
        peer.send({event: 'qualification_done'});
        await waitFor(() => peerExited, 'unrelated owned Wire child exit');
        assert.equal(peerCode, 0); assert.equal(peerError, '');
    } finally {
        if (!peerExited) {
            try {peer.send({event: 'qualification_done'});} catch {}
            try {peer.process.kill();} catch {}
            await waitFor(() => peerExited, 'unrelated owned Wire child failure cleanup', 5000).catch(() => {});
        }
    }
}

try {
    if (receiptBridgeEnabled) {
        await waitFor(() => messages.some(message => message?.event === 'qualification_receipt_queued') || exited,
            'original native consume callback queues its input before DS entry').catch(error => {
                error.message += ' ' + JSON.stringify({exited, exitCode, exitSignal, childPid: child.process.pid,
                    stdout: stdout.slice(-8000), stderr: stderr.slice(-8000)}); throw error;
            });
        assert.equal(exited, false, stderr);
        const queued = messages.find(message => message.event === 'qualification_receipt_queued');
        assert.equal(queued.queued, 1); assert.equal(queued.running, 0); assert.equal(queued.originalAckCount, 0);
        assert.equal(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'bind'), false);
        if (!receiptWorkerUnavailable) assert(messages.some(message => message.event === 'qualification_receipt_observation' && JSON.parse(message.packet).type === 'capture'),
            'the original consume callback must automatically capture the queued receipt');
        else {assert.equal(queued.observer.failures, 1); assert.equal(queued.observer.knownCapturedPayloadBytes, 1369);
            assert(queued.observer.reservedEncodedCopyBytes > 0);}
        if (receiptRegistrationHolds) {
            await waitFor(() => heldReceiptRegistration, 'original DS registration request held before supervisor entry');
            assert.equal(supervisor.snapshot().active, 0);
            assert.equal(receiptEnrollment.snapshot().receipts[0].owner, null);
            assert.equal(receiptEnrollment.snapshot().receipts[0].phase, 'receipt-process-custody');
            receiptRegistrationReleased = true; originalReceiptHandle(child, heldReceiptRegistration);
            assert(heldReceiptReply); assert.equal(supervisor.snapshot().active, 1);
            assert(receiptEnrollment.snapshot().receipts[0].owner);
            assert.equal(receiptEnrollment.snapshot().receipts[0].sourceClaim, null);
            originalReceiptSend(heldReceiptReply.message, ...heldReceiptReply.args);
        }
        if (receiptWorkerUnavailable) await waitFor(() => receiptEnrollment.snapshot().receipts.length === 1, 'original registration owns unknown diagnostic input');
        const before = receiptEnrollment.snapshot();
        assert.equal(before.receipts.length, 1); assert.equal(before.receipts[0].payloadBytes, lateReceipt === 'capture' || receiptWorkerUnavailable ? null : 1369);
        assert.equal(before.receipts[0].sourceClaim, null); assert.equal(before.receipts[0].enrolled, false);
        assert.equal(before.accounting.retainedDemands, 0); assert.equal(before.canonicalAuthority, false);
        assert.equal(before.coverage, 'incomplete'); assert.equal(before.receiptCustodyCount, 1);
        assert.equal(before.semanticCustodyKnownBytesLowerBound > 1369, lateReceipt !== 'capture' && !receiptWorkerUnavailable);
        child.send({event: 'qualification_release_receipt'});
    }
    if (mode === 'main-failed-end') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_end_failed') || exited,
            'original Wire callback durable result and ACK with failed original end sends');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000), stdout: stdout.slice(-4000)}));
        const failed = messages.find(message => message.event === 'qualification_end_failed');
        assert.deepEqual({originalAckCount: failed.originalAckCount, retainedAttemptRecords: failed.retainedAttemptRecords,
            failedEndSends: failed.failedEndSends}, {originalAckCount: 1, retainedAttemptRecords: 1, failedEndSends: 3});
        assert.equal(ends.length, 0);
        assert.equal(supervisor.snapshot().active, 1);
        const attempts = messages.filter(message => message.event === 'qualification_end_send_failed');
        assert.equal(attempts.length, 3);
        for (const attempt of attempts) assert.deepEqual(attempt.request, attempts[0].request);
        assert(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'observe'));
        assert(messages.some(message => message.event === 'qualification_ack'));
        assert.equal(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'end'), false);
        const untouched = new Proxy({}, {get() {assert.fail('missing end reached storage or current authority');}});
        const adjudicator = new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched);
        await assert.rejects(adjudicator.adjudicate(structuredClone(attempts[0].request.payload)), /Unissued or foreign/);
        child.send({event: 'qualification_done'});
        await waitFor(() => exited && ends.length === 1, 'original owner exit observed after its missing end');
        const end = describeWorkerAttemptEnd(supervisor, ends[0]);
        assert.equal(end.status, 'process-exited-unresolved');
        assert.equal(end.rootResult, 'unknown'); assert.equal(end.acknowledgementAttempted, null);
        assert.equal(end.freshWrites.length, 1);
        assert.equal(end.descriptor.payloadSha256, failed.originalFrameSha256);
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        assert.equal(exitCode, 0, stdout.slice(-4000)); assert.equal(stderr, '', stdout.slice(-4000));
        console.log(JSON.stringify({passed: true, native: process.version, mode, managedParentEnd: true,
            durableResultAndAckBeforeMissingEnd: true, authenticatedQuiescentEnd: false,
            endOnlyAtObservedExit: true, noAssociation: true, brokerSettlement: 'unknown', fullWorkerQualification: false}));
    } else if (mode === 'main-failed-write') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_write_failed') && ends.length === 1 || exited,
            'original Wire MainDS failed disposition write and owned worker end');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
        const failed = messages.find(message => message.event === 'qualification_write_failed');
        assert.deepEqual({originalAckCount: failed.originalAckCount, failedWrites: failed.failedWrites,
            retainedAttemptRecords: failed.retainedAttemptRecords},
        {originalAckCount: 0, failedWrites: 1, retainedAttemptRecords: 0});
        const end = describeWorkerAttemptEnd(supervisor, ends[0]);
        assert.equal(end.role, role);
        assert.equal(end.status, 'quiescent');
        assert.equal(end.rootResult, 'threw');
        assert.equal(end.acknowledgementAttempted, false);
        assert.equal(end.freshWrites.length, 0);
        assert.equal(end.binding.blockNum, 1);
        assert.equal(end.descriptor.payloadSha256, failed.originalFrameSha256);
        const registration = messages.findIndex(message => message.event === 'worker_attempt_request'
            && message.payload?.operation === 'register');
        const endRequest = messages.findIndex(message => message.event === 'worker_attempt_request'
            && message.payload?.operation === 'end');
        assert(registration >= 0 && endRequest > registration);
        assert.equal(messages.some(message => message.event === 'worker_attempt_request'
            && message.payload?.operation === 'observe'), false);
        assert.equal(messages.some(message => message.event === 'qualification_ack'), false);
        const untouched = new Proxy({}, {get() {assert.fail('failed write reached storage or current authority');}});
        const adjudicator = new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched);
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        child.send({event: 'qualification_done'});
        await waitFor(() => exited, 'owned Wire failed-write child exit');
        assert.equal(exitCode, 0, stdout.slice(-4000));
        assert.equal(stderr, '', stdout.slice(-4000));
        console.log(JSON.stringify({passed: true, native: process.version, mode,
            originalWireMainCallback: true, managedParentEnd: true, failedWriteNoAck: true,
            noFreshWriteOrAssociation: true, controlledStorageAndCanonicalAuthority: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false}));
    } else if (mode === 'handoff-failed-confirm' || mode === 'handoff-failed-drain') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_publish_failed') && ends.length === 1 || exited,
            'original Wire DS failed publisher confirm and owned worker end');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
        const failed = messages.find(message => message.event === 'qualification_publish_failed');
        assert.deepEqual({originalAckCount: failed.originalAckCount, failedConfirms: failed.failedConfirms,
            failedDrains: failed.failedDrains, confirmCalls: failed.confirmCalls,
            retainedHandoffs: failed.retainedHandoffs},
        {originalAckCount: 0, failedConfirms: mode === 'handoff-failed-confirm' ? 1 : 0,
            failedDrains: mode === 'handoff-failed-drain' ? 1 : 0, confirmCalls: 1, retainedHandoffs: 0});
        const end = describeWorkerAttemptEnd(supervisor, ends[0]);
        assert.equal(end.role, role);
        assert.equal(end.status, 'quiescent');
        assert.equal(end.rootResult, 'threw');
        assert.equal(end.acknowledgementAttempted, false);
        assert.equal(end.freshWrites.length, 0);
        assert.equal(end.binding.blockNum, 33);
        assert.equal(end.descriptor.payloadSha256, failed.originalPayloadSha256);
        assert.equal(messages.some(message => message.event === 'worker_attempt_request'
            && message.payload?.operation === 'observe'), false);
        assert.equal(messages.some(message => message.event === 'qualification_ack'), false);
        const untouched = new Proxy({}, {get() {assert.fail('failed confirm reached storage or current authority');}});
        const adjudicator = new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched);
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        child.send({event: 'qualification_done'});
        await waitFor(() => exited, 'owned Wire failed-confirm child exit');
        assert.equal(exitCode, 0, stdout.slice(-4000));
        assert.equal(stderr, '', stdout.slice(-4000));
        console.log(JSON.stringify({passed: true, native: process.version, mode,
            originalWireDsCallback: true, managedParentEnd: true,
            failedConfirmNoAck: mode === 'handoff-failed-confirm',
            confirmedButFailedDrainNoAck: mode === 'handoff-failed-drain',
            noFreshWriteOrAssociation: true, controlledStorageAndBroker: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false}));
    } else {
    if (mode === 'main-held-end') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_end_held') || exited,
            'original Wire callback drained with its authentic end request held before the parent');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
        assert(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'observe'));
        assert(messages.some(message => message.event === 'qualification_ack'));
        assert.equal(ends.length, 0); assert.equal(supervisor.snapshot().active, 1);
        assert.equal(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'end'), false);
        const held = messages.find(message => message.event === 'qualification_end_held');
        assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(held.request.payload)), /Unissued or foreign/);
        child.send({event: 'qualification_release_end'});
    }
    if (mode === 'main-held-operation') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_operation_fenced') || exited,
            'original Wire root and ACK ended while the retained consumer operation is still pending');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
        const fenced = messages.find(message => message.event === 'qualification_operation_fenced');
        assert.equal(fenced.originalAckCount, 1);
        assert.equal(fenced.scope.state, 'fenced'); assert.ok(fenced.scope.pendingOperations >= 1);
        assert(messages.some(message => message.event === 'qualification_operation_held'));
        assert(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'observe'));
        assert(messages.some(message => message.event === 'qualification_ack'));
        assert.equal(messages.some(message => message.event === 'worker_attempt_request' && message.payload?.operation === 'end'), false);
        assert.equal(ends.length, 0);
        child.send({event: 'qualification_release_operation'});
    }
    if (mode === 'main-held-write') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_write_held') || exited,
            'original Wire MainDS disposition write held');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
        const held = messages.find(message => message.event === 'qualification_write_held');
        assert.equal(held.originalAckCount, 0);
        assert(messages.some(message => message.event === 'worker_attempt_request'
            && message.payload?.operation === 'register'));
        assert.equal(messages.some(message => message.event === 'worker_attempt_request'
            && ['observe','end'].includes(message.payload?.operation)), false);
        assert.equal(messages.some(message => message.event === 'qualification_ack'), false);
        assert.equal(ends.length, 0);
        child.send({event: 'qualification_release_write'});
    }
    if (mode === 'handoff-held-confirm' || mode === 'handoff-held-drain') {
        const event = mode === 'handoff-held-confirm' ? 'qualification_confirm_held' : 'qualification_drain_held';
        await waitFor(() => messages.some(message => message?.event === event) || exited,
            `original Wire DS ${mode} publisher hold`);
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000), stdout: stdout.slice(-4000)}));
        const held = messages.find(message => message.event === event);
        assert.equal(held.originalAckCount, 0);
        assert.equal(held.retainedHandoffs, 0);
        assert.equal(held.confirmCalls, mode === 'handoff-held-confirm' ? 0 : 1);
        assert(messages.some(message => message.event === 'worker_attempt_request'
            && message.payload?.operation === 'register'));
        assert.equal(messages.some(message => message.event === 'worker_attempt_request'
            && ['observe','end'].includes(message.payload?.operation)), false);
        assert.equal(messages.some(message => message.event === 'qualification_ack'), false);
        assert.equal(ends.length, 0);
        if (shadow && !receiptBridgeEnabled) {
            const input = messages.find(message => message.event === 'qualification_shadow_input');
            assert(input, 'accounting observes the same original dispatch before the held return');
            const registration = messages.find(message => message.event === 'worker_attempt_request'
                && message.payload?.operation === 'register' && message.payload.descriptor?.kind === 'ds-delivery').payload;
            shadow.accounting.retain({owner: {epoch: registration.epoch, incarnation: registration.incarnation,
                attemptId: registration.attemptId}, source: input.source, admissionId: input.admissionId,
                traceOrdinal: input.traceOrdinal, payload: Buffer.from(input.payloadHex, 'hex'),
                ...(missingHeaderAccounting ? {} : {headers: deserializeShadowHeaders(Buffer.from(input.headersHex, 'hex'))}),
                stage: 'ds-input'});
            shadow.before = shadow.accounting.snapshot();
            assert.equal(shadow.before.pendingDemands, 1);
            assert.equal(shadow.before.resolvedDemands, 0);
            assert.equal(verifiedTransitions.length, 0);
        }
        if (receiptBridgeEnabled) {
            shadow.before = shadow.accounting.snapshot();
            assert.equal(shadow.before.pendingDemands, unavailableReceipt ? 0 : 1); assert.equal(shadow.before.resolvedDemands, 0);
            assert.equal(receiptEnrollment.snapshot().receipts[0].phase, unavailableReceipt ? 'registered-custody' : 'child-binding-observed');
            assert.equal(receiptEnrollment.snapshot().canonicalAuthority, false);
        }
        child.send({event: mode === 'handoff-held-confirm' ? 'qualification_release_confirm' : 'qualification_release_drain'});
    }
    await waitFor(() => messages.some(message => message?.event === 'qualification_fixture') && ends.length === 1 || exited,
        `original Wire ${mode} fresh result and owned worker end`);
    assert(messages.some(message => message?.event === 'qualification_fixture') && ends.length === 1,
        JSON.stringify({mode, exitCode, stderr: stderr.slice(-4000), stdout: stdout.slice(-4000),
            events: messages.map(message => message.event), ends: ends.length}));
    const fixture = messages.find(message => message.event === 'qualification_fixture');
    snapshotPath = resolve(fixture.path);
    assert.equal(dirname(snapshotPath), resolve(tmpdir()));
    assert.match(basename(snapshotPath), /^hyperion-managed-wire-(?:main|ds)-[0-9a-f-]+\.json$/);
    const size = statSync(snapshotPath).size;
    assert(size > 0 && size <= 64 * 1024 * 1024 && size === fixture.bytes);
    const bytes = readFileSync(snapshotPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    const snapshot = JSON.parse(bytes.toString());
    assert.equal(snapshot.originalAckCount, mode === 'main-ack-throws' ? 0 : 1);
    const registration = messages.findIndex(message => message.event === 'worker_attempt_request'
        && message.payload?.operation === 'register');
    const freshWrite = messages.findIndex(message => message.event === 'worker_attempt_request'
        && message.payload?.operation === 'observe');
    const ack = messages.findIndex(message => message.event === 'qualification_ack'
        && message.recordId === snapshot.recordId);
    const endRequest = messages.findIndex(message => message.event === 'worker_attempt_request'
        && message.payload?.operation === 'end');
    assert(registration >= 0 && freshWrite > registration && ack > freshWrite && endRequest > ack,
        'the original callback must observe its fresh write before ACK and quiescent end');
    if (mode === 'main-held-end') {
        const held = messages.findIndex(message => message.event === 'qualification_end_held');
        assert(held > ack && endRequest > held, 'held original transport must release before the authentic end is accepted');
    }
    if (mode === 'main-held-operation') {
        const fenced = messages.findIndex(message => message.event === 'qualification_operation_fenced');
        const released = messages.findIndex(message => message.event === 'qualification_operation_released');
        assert(fenced > ack && released > fenced && endRequest > released,
            'only the physically settled retained consumer operation permits an authenticated end');
    }
    const memory = shadow?.memory ?? frontierMemoryClient();
    for (const [key, value] of snapshot.documents) memory.documents.set(key, value);
    for (const [key, value] of snapshot.mappings) memory.mappings.set(key, value);
    for (const [key, value] of snapshot.settings) memory.settings.set(key, value);
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const chain = 'handoff-worker-original', store = shadow?.store ?? new ActionSourceAdmissionStore(memory.client, chain),
        selections = shadow?.selections ?? new ProtocolSourceBindingStore(memory.client, chain);
    const admission = await store.resolve(snapshot.admissionId);
    const source = admission.source.inventoryInput.source, end = describeWorkerAttemptEnd(supervisor, ends[0]);
    assert.equal(source.blockNum, isMain ? 1 : mode.startsWith('handoff') ? 33 : 36);
    assert.equal(end.role, role);
    assert.equal(end.status, 'quiescent');
    assert.equal(end.rootResult, mode === 'main-ack-throws' ? 'threw' : 'returned');
    assert.equal(end.acknowledgementAttempted, true);
    assert.equal(end.freshWrites.length, 1);
    assert.equal(end.freshWrites[0].id, snapshot.recordId);
    const originalPayload = isMain ? Buffer.from(admission.source.frameHex, 'hex')
        : Buffer.from(admission.inventory.transactions.find(value => value.traceOrdinal === end.binding.traceOrdinal)
            .dispatch.canonicalJson);
    assert.equal(end.descriptor.payloadSha256, createHash('sha256').update(originalPayload).digest('hex'));
    if (mode.startsWith('handoff')) {
        const recorded = await store.readConfirmedHandoff(admission.id, end.binding.traceOrdinal, originalPayload);
        assert.equal(recorded.id, snapshot.recordId);
        assert.equal(recorded.outcome.kind, 'confirmed-action-handoff');
        assert.equal(recorded.outcome.effects.length, 1);
    } else {
        const recorded = await store.readAttemptDisposition(snapshot.recordId);
        assert.equal(recorded.observation.disposition, isMain ? 'source-unprocessable'
            : mode === 'ds' ? 'no-effects' : 'contract-output-incomplete');
        if (isMain) assert.equal(recorded.observation.reason, 'source-traces-missing');
        if (mode === 'contract') assert.equal(recorded.observation.reason, 'contract-finalization-invalid');
    }
    let observation, recovery = {};
    if (mode === 'main-ack-throws') {
        const untouched = new Proxy({}, {get() {assert.fail('failed ACK reached storage or current authority');}});
        const adjudicator = new ActionAttemptAdjudicator(supervisor, untouched, untouched, untouched);
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
    } else {
    let currentConfiguration = admission.source.producer.configurationSha256, canonicalGeneration = 0,
        canonicalReturned = false, latestCanonical;
    const canonicalObservations = new WeakMap();
    const authority = {
        configurationSha256: () => currentConfiguration,
        assertCanonicalCurrent: block => {
            assert.ok(canonicalObservations.has(block), 'unissued controlled canonical observation');
            assert.equal(canonicalObservations.get(block), canonicalGeneration, 'controlled canonical source was revoked');
        }, // Constructed generations, not a live source qualification; the real master fence has separate native tests.
        targetUuid: async name => {assert.equal(name, admission.target.name); return memory.settings.get(name)['index.uuid'];},
        canonicalBlock: async blockNum => {
            assert.equal(blockNum, source.blockNum);
            const value = Object.freeze({chainId: source.chainId, blockId: source.blockId,
                previousBlockId: admission.source.previousBlockId, irreversible: true});
            canonicalObservations.set(value, canonicalGeneration); canonicalReturned = true; latestCanonical = value;
            return value;
        }
    };
    if (shadow) shadow.authority = authority;
    const adjudicator = shadow?.adjudicator ?? new ActionAttemptAdjudicator(supervisor, store, selections, authority,
        shadowTransition ? {onVerifiedDsTransition: token => {verifiedTransitions.push(token);}} : undefined);
    if (lateAuthorityCase) {
        const [change, boundary] = lateAuthorityCase, originalConfiguration = currentConfiguration;
        const targetSettings = memory.settings.get(admission.target.name), originalUuid = targetSettings['index.uuid'];
        const originalTarget = authority.targetUuid, originalCanonical = authority.canonicalBlock,
            originalSelection = selections.readSelection, originalAssociation = store.recordAttemptAssociation;
        const isAssociation = request => request.index === store.index && request.document?.bundle_id?.startsWith('h45actionassociation1:');
        let prior;
        if (boundary === 'reassertion-read') {
            prior = await adjudicator.adjudicate(ends[0]); assert.equal(prior.state, 'associated');
        } else assert.equal(memory.calls.some(call => ['create','index'].includes(call.method) && isAssociation(call.request)), false,
            'no association was already written before the controlled authority hold');
        let reached = false, release;
        const gate = new Promise(resolveGate => {release = resolveGate;});
        const hold = async () => {if (!reached) {reached = true; await gate;}};
        if (boundary === 'prewrite-target' || boundary === 'postwrite-target') {
            let associationReturned = false;
            store.recordAttemptAssociation = async (...args) => {
                const value = await originalAssociation.apply(store, args); associationReturned = true; return value;
            };
            authority.targetUuid = async name => {
                const uuid = await originalTarget(name);
                if (canonicalReturned && associationReturned === (boundary === 'postwrite-target')) await hold();
                return uuid;
            };
        } else if (boundary === 'target') authority.targetUuid = async name => {
            const uuid = await originalTarget(name); await hold(); return uuid;
        };
        else if (boundary === 'canonical') authority.canonicalBlock = async block => {
            const value = await originalCanonical(block); await hold(); return value;
        };
        else if (boundary === 'selection') {
            assert.ok(admission.source.inventoryInput.sourceSelectionId, 'original selected source required');
            selections.readSelection = async (...args) => {
                const value = await originalSelection.apply(selections, args); await hold(); return value;
            };
        } else if (boundary === 'reassertion-read') memory.faults.beforeRead = async request => {
            if (request.index === store.index && request.id === prior.id) await hold();
        };
        else memory.faults.beforeWrite = async request => {
            if (isAssociation(request) && request.document.kind === boundary) await hold();
        };
        const before = memory.calls.length, pending = adjudicator.adjudicate(ends[0]); void pending.catch(() => {});
        try {
            await waitFor(() => reached, `original ${boundary} operation held`);
            if (change === 'config') {
                currentConfiguration = '0'.repeat(64); assert.notEqual(currentConfiguration, originalConfiguration);
                assert.equal(authority.configurationSha256(), currentConfiguration, 'current getter observes changed configuration');
            } else if (change === 'target') {
                targetSettings['index.uuid'] = 'changed-physical-target'; assert.notEqual(await originalTarget(admission.target.name), originalUuid);
            } else canonicalGeneration++;
            if (change === 'config' && boundary === 'manifest') await unrelatedWorkerProgress(supervisor, ends);
            release();
            if (change === 'source') await assert.rejects(pending, /controlled canonical source was revoked/);
            else assert.deepEqual(await pending, {state: 'unresolved'}, `${change} changed during ${boundary} must not associate`);
            if (shadowTransition) assert.equal(verifiedTransitions.length, 0,
                'a written association with a failed final source check issues no transition');
            const storedDuringWrite = ['chunk', 'manifest', 'reassertion-read', 'postwrite-target'].includes(boundary);
            if (storedDuringWrite) {
                const id = 'h45actionassociation1:' + createHash('sha256').update(JSON.stringify([end.epoch, end.incarnation, end.attemptId])).digest('hex');
                const retained = await store.readAttemptAssociation(id);
                assert.equal(retained.observation.end.attemptId, end.attemptId); assert.equal(retained.observation.brokerSettlement, 'unknown');
                const foreign = new WorkerAttemptSupervisor();
                try {assert.throws(() => describeWorkerAttemptEnd(foreign, retained.observation.end), /Unissued or foreign/);}
                finally {foreign.stop();}
            } else assert.equal(memory.calls.slice(before).some(call => ['create','index'].includes(call.method) && isAssociation(call.request)), false);
            recovery = {lateAuthorityRejected: true, lateAuthorityChange: change, lateAuthorityBoundary: boundary,
                retainedRecordInspectionOnly: storedDuringWrite, restoredOriginalContextControl: true,
                unrelatedWorkerProgressDuringHold: change === 'config' && boundary === 'manifest'};
            if (shadowTransition) recovery.transitionCallbacksBeforeRecovery = verifiedTransitions.length;
        } finally {
            release(); await pending.catch(() => {});
            authority.targetUuid = originalTarget; authority.canonicalBlock = originalCanonical; selections.readSelection = originalSelection;
            store.recordAttemptAssociation = originalAssociation;
            delete memory.faults.beforeRead; delete memory.faults.beforeWrite;
            currentConfiguration = originalConfiguration; targetSettings['index.uuid'] = originalUuid;
        }
        if (change === 'source') assert.throws(() => authority.assertCanonicalCurrent(latestCanonical), /controlled canonical source was revoked/);
    }
    if (checkpointDirectory) {
        assert.equal(memory.calls.some(call => ['create','index'].includes(call.method)
            && call.request.document?.bundle_id?.startsWith('h45actionassociation1:')), false);
        // Finish the original physical child before the controller kills this parent: no orphan is needed.
        child.send({event: 'qualification_done'});
        await waitFor(() => exited, 'original Wire child exits before parent restart boundary');
        assert.equal(exitCode, 0); assert.equal(stderr, '');
        const retained = persistRestartSnapshot(checkpointDirectory, snapshot, end, supervisor.epoch);
        process.send({event: 'restart_checkpoint', ...retained, parentPid: process.pid,
            originalChildPid: child.process.pid, originalChildExited: true, associationWritten: false});
        await new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('Restart controller did not terminate the original parent')), 20_000);
            process.once('disconnect', () => {clearTimeout(timer); reject(new Error('Restart controller disconnected'));});
        });
        assert.fail('restart checkpoint cannot return normally');
    }
    if (mode === 'main-held-adjudication') {
        let release, heldId;
        const held = new Promise(resolveHold => {release = resolveHold;});
        memory.faults.beforeWrite = async request => {
            if (request.index === store.index && request.document?.kind === 'manifest'
                && request.document.bundle_id.startsWith('h45actionassociation1:')) {
                heldId = request.id;
                await held;
            }
        };
        try {
            adjudicator.enqueue(ends[0]);
            await waitFor(() => heldId !== undefined, 'post-end private association write held');
            assert.deepEqual(adjudicator.snapshot(), {active: 1, pending: 0, failures: 0, dropped: 0});
            assert.equal(memory.documents.has(memory.key(store.index, heldId)), false);
            await unrelatedWorkerProgress(supervisor, ends);
            assert.deepEqual(adjudicator.snapshot(), {active: 1, pending: 0, failures: 0, dropped: 0});
            assert.equal(memory.documents.has(memory.key(store.index, heldId)), false);
        } finally {
            delete memory.faults.beforeWrite;
            release();
        }
        await waitFor(() => adjudicator.snapshot().active === 0, 'released post-end association');
        assert.deepEqual(adjudicator.snapshot(), {active: 0, pending: 0, failures: 0, dropped: 0});
        const saved = await store.readAttemptAssociation(heldId);
        assert.equal(saved.observation.end.attemptId, end.attemptId);
        recovery = {heldAdjudicationBeforePersistence: true, unrelatedWorkerProgressDuringHold: true};
    }
    if (mode === 'main-unknown-association' || mode === 'handoff-unknown-association') {
        let unknownId, lostReceipts = 0;
        memory.faults.receipt = (receipt, request) => {
            if (request.index === store.index && request.document?.kind === 'manifest'
                && request.document.bundle_id.startsWith('h45actionassociation1:')) {
                unknownId = request.id; lostReceipts++;
                throw new Error('constructed lost association write receipt');
            }
            return receipt;
        };
        try {
            adjudicator.enqueue(ends[0]);
            await waitFor(() => adjudicator.snapshot().active === 0 && adjudicator.snapshot().failures === 1,
                'unknown post-end association write recorded as a failed adjudication');
        } finally {delete memory.faults.receipt;}
        assert.equal(lostReceipts, 1);
        if (shadowTransition) assert.equal(verifiedTransitions.length, 0,
            'a visible record with a lost original write receipt issues no transition');
        assert(memory.documents.has(memory.key(store.index, unknownId)));
        await unrelatedWorkerProgress(supervisor, ends);
        assert.deepEqual(adjudicator.snapshot(), {active: 0, pending: 0, failures: 1, dropped: 0});
        const reopened = new ActionSourceAdmissionStore(memory.client, chain);
        const inspected = await reopened.readAttemptAssociation(unknownId);
        assert.equal(inspected.observation.brokerSettlement, 'unknown');
        const restarted = new WorkerAttemptSupervisor();
        try {
            const afterRestart = new ActionAttemptAdjudicator(restarted, reopened, selections, authority);
            const writesBefore = memory.calls.filter(call => ['create','index'].includes(call.method)).length;
            await assert.rejects(afterRestart.adjudicate(ends[0]), /Unissued or foreign/);
            await assert.rejects(afterRestart.adjudicate(inspected.observation.end), /Unissued or foreign/);
            assert.equal(memory.calls.filter(call => ['create','index'].includes(call.method)).length, writesBefore);
        } finally {restarted.stop();}
        // Reads did not acknowledge the lost write. Even the original live parent must retry the write.
        const beforeRetry = memory.calls.length;
        const retried = await adjudicator.adjudicate(ends[0]);
        assert.equal(retried.state, 'associated'); assert.equal(retried.id, unknownId);
        const manifestRetry = memory.calls.slice(beforeRetry).find(call => call.method === 'index'
            && call.request.index === store.index && call.request.id === unknownId);
        assert(manifestRetry);
        assert.equal(manifestRetry.request.wait_for_active_shards, 'all');
        assert(Number.isSafeInteger(manifestRetry.request.if_seq_no));
        assert(Number.isSafeInteger(manifestRetry.request.if_primary_term));
        recovery = {unknownAssociationWrite: true, failedAdjudicationIsolated: true,
            unrelatedWorkerProgressDuringFailure: true, primaryVisibleInspectionOnly: true,
            restartCannotReissueEnd: true, freshRetryReceiptRequired: true};
    }
    const beforeControl = memory.calls.length, associated = await adjudicator.adjudicate(ends[0]);
    assert.equal(associated.state, 'associated');
    if (shadowTransition) {
        assert.equal(verifiedTransitions.length, 1,
            'the original verified DS end must notify shadow accounting after fresh association and final authority checks');
        assert.equal(adjudicator.transitionSnapshot().failures, 0, 'the observer must finish synchronously without failure');
        assert.equal((await adjudicator.adjudicate(ends[0])).state, 'associated');
        assert.equal(verifiedTransitions.length, 1, 're-adjudicating the same authentic end cannot duplicate its transition');
        if (shadow) {
            shadow.after = shadow.accounting.snapshot();
            assert.equal(shadow.after.pendingDemands, missingHeaderAccounting ? 1 : 0, JSON.stringify({before: shadow.before, after: shadow.after,
                originalOwner: {epoch: end.epoch, incarnation: end.incarnation, attemptId: end.attemptId},
                originalHeadersSha256: end.descriptor.headersSha256}));
            assert.equal(shadow.after.resolvedDemands, missingHeaderAccounting || unavailableReceipt ? 0 : 1);
            assert.equal(shadow.after.knownPendingBytes, missingHeaderAccounting ? 1369 : 0);
            assert.equal(shadow.after.unknownPendingHeaders, missingHeaderAccounting ? 1 : 0);
            const rejected = shadow.after.rejectedTransitions;
            shadow.accounting.observe(verifiedTransitions[0]);
            assert.equal(shadow.accounting.snapshot().rejectedTransitions, rejected + 1,
                'callback-expired transition is unusable');
            assert.equal(shadow.accounting.snapshot().resolvedDemands, missingHeaderAccounting || unavailableReceipt ? 0 : 1);
            if (lateReceipt) {
                const packet = messages.find(message => message.event === 'qualification_receipt_observation' && JSON.parse(message.packet).type === lateReceipt).packet;
                receiptEnrollment.receive(child, packet);
                const late = receiptEnrollment.snapshot();
                assert.equal(late.late, 1); assert.equal(late.coverage, 'incomplete'); assert.equal(late.receipts[0].unavailable, true);
                assert(late.semanticCustodyKnownBytesLowerBound > 1369);
                assert.equal(late.accounting.retainedDemands, 0); assert.equal(late.accounting.resolvedDemands, 0);
            }
        }
    }
    if (recovery?.retainedRecordInspectionOnly) {
        const reassertion = memory.calls.slice(beforeControl).find(call => call.method === 'index'
            && call.request.index === store.index && call.request.id === associated.id);
        assert(reassertion, 'a visible record still needs a fresh conditional association write');
        assert.equal(reassertion.request.wait_for_active_shards, 'all');
        assert(Number.isSafeInteger(reassertion.request.if_seq_no)); assert(Number.isSafeInteger(reassertion.request.if_primary_term));
        recovery.freshReassertionReceiptRequired = true;
    }
    observation = (await store.readAttemptAssociation(associated.id)).observation;
    assert.deepEqual(observation.results, [{id: snapshot.recordId,
        classification: isMain ? 'source-incomplete'
            : mode === 'ds' ? 'intentional-no-effect' : mode === 'contract' ? 'contract-incomplete' : 'confirmed-handoff'}]);
    assert.equal(observation.brokerSettlement, 'unknown');
    assert.equal(observation.sourceChecked, true);
    assert.equal(observation.end.attemptId, end.attemptId);
    }
    child.send({event: 'qualification_done'});
    await waitFor(() => exited, `owned Wire ${mode} child exit`);
    assert.equal(exitCode, 0, stdout.slice(-4000));
    assert.equal(stderr, '', stdout.slice(-4000));
    console.log(JSON.stringify(mode === 'main-ack-throws' ? {passed: true, native: process.version, mode,
        originalWireMainCallback: true, managedParentEnd: true, durableResultBeforeAckAttempt: true,
        originalAckCount: 0, acknowledgementAttempted: true, noAssociation: true,
        controlledStorageAndCanonicalAuthority: true, brokerSettlement: 'unknown', fullWorkerQualification: false}
        : {passed: true, native: process.version, mode,
        originalWireMainCallback: isMain, originalWireDsCallback: !isMain,
        managedParentEnd: true, writeBeforeAckBeforeEnd: true, originalAckCount: 1,
        heldWriteBeforeObservation: mode === 'main-held-write',
        heldOperationAcrossAckAndRoot: mode === 'main-held-operation',
        heldEndBeforeAssociation: mode === 'main-held-end',
        heldPublishBeforeObservation: mode === 'handoff-held-confirm' || mode === 'handoff-held-drain',
        ...(shadowTransition ? {shadowTransition: true, verifiedDsTransitionCallbacks: verifiedTransitions.length} : {}),
        ...(shadow ? {shadowAccounting: true, missingHeaderAccounting,
            accountingBefore: shadow.before, accountingAfter: shadow.after} : {}),
        ...(receiptBridgeEnabled ? {receiptBridge: true, receiptRegistrationHolds, lateReceipt: lateReceipt ?? null,
            receiptWorkerUnavailable, receiptEnrollment: receiptEnrollment.snapshot()} : {}),
        ...recovery,
        classification: observation.results[0].classification,
        controlledStorageAndCanonicalAuthority: true, brokerSettlement: observation.brokerSettlement,
        fullWorkerQualification: false}));
    }
} finally {
    if (!exited) {
        try {child.send({event: 'qualification_done'});} catch {}
        try {child.process.kill();} catch {}
        await waitFor(() => exited, `owned Wire ${mode} failure cleanup`, 5000).catch(() => {});
    }
    if (process.env.HYPERION_PROOF_DEMAND_EVIDENCE_DIR) appendFileSync(resolve(process.env.HYPERION_PROOF_DEMAND_EVIDENCE_DIR,
        'native-child-cleanup.jsonl'), JSON.stringify({mode, flags: process.argv.slice(3), native: process.version,
            parentPid: process.pid, childPid: child.process.pid, exited, exitCode: exitCode ?? null, exitSignal: exitSignal ?? null,
            stdout, stderr, eventTypes: messages.map(message => message.event)}) + '\n');
    if (snapshotPath) {
        const owned = resolve(snapshotPath);
        assert.equal(dirname(owned), resolve(tmpdir()));
        assert.match(basename(owned), /^hyperion-managed-wire-(?:main|ds)-[0-9a-f-]+\.json$/);
        rmSync(owned, {force: true});
    }
    supervisor.stop();
}
