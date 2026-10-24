/** Original Wire MainDS/DS callbacks through owned native children and parent adjudication.
 * Storage and canonical authority are controlled; this is not a live broker or fork qualification. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {createHash} from 'node:crypto';
import {readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';

const mode = process.argv[2] ?? 'main';
assert(['main','main-held-write','main-failed-write','main-ack-throws','main-held-operation','main-held-end','main-failed-end',
    'main-held-adjudication','main-unknown-association','ds','contract','handoff',
    'handoff-held-confirm','handoff-failed-confirm','handoff-held-drain','handoff-failed-drain'].includes(mode));
const isMain = mode.startsWith('main');
const role = isMain ? 'deserializer' : 'ds_pool_worker';
cluster.setupPrimary({exec: fileURLToPath(new URL('./action-attempt-disposition-worker.mjs', import.meta.url)),
    args: [mode === 'main-held-write' ? 'managed-original-main-held-write'
        : mode === 'main-failed-write' ? 'managed-original-main-failed-write'
        : mode === 'main-ack-throws' ? 'managed-original-main-ack-throws'
        : ['main','main-held-adjudication','main-unknown-association'].includes(mode) ? 'managed-original-main'
        : mode === 'ds' ? 'managed-original-ds'
        : mode === 'contract' ? 'managed-original-contract' : 'managed-original-' + mode],
    silent: true});
const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
const child = cluster.fork(), messages = [];
let stderr = '', stdout = '', exited = false, exitCode, snapshotPath;
child.process.stderr.on('data', bytes => {stderr += bytes.toString();});
child.process.stdout.on('data', bytes => {stdout += bytes.toString();});
child.on('message', message => messages.push(message));
child.on('exit', code => {exited = true; exitCode = code;});
supervisor.attach(child, role);

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
    supervisor.attach(peer, 'deserializer');
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
    if (mode === 'main-failed-end') {
        await waitFor(() => messages.some(message => message?.event === 'qualification_end_failed') || exited,
            'original Wire callback durable result and ACK with failed original end sends');
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
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
        assert.equal(exited, false, JSON.stringify({exitCode, stderr: stderr.slice(-4000)}));
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
    const memory = frontierMemoryClient();
    for (const [key, value] of snapshot.documents) memory.documents.set(key, value);
    for (const [key, value] of snapshot.mappings) memory.mappings.set(key, value);
    for (const [key, value] of snapshot.settings) memory.settings.set(key, value);
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const chain = 'handoff-worker-original', store = new ActionSourceAdmissionStore(memory.client, chain),
        selections = new ProtocolSourceBindingStore(memory.client, chain);
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
    const authority = {
        configurationSha256: () => admission.source.producer.configurationSha256,
        targetUuid: async name => {assert.equal(name, admission.target.name); return memory.settings.get(name)['index.uuid'];},
        canonicalBlock: async blockNum => {
            assert.equal(blockNum, source.blockNum);
            return {chainId: source.chainId, blockId: source.blockId,
                previousBlockId: admission.source.previousBlockId, irreversible: true};
        }
    };
    const adjudicator = new ActionAttemptAdjudicator(supervisor, store, selections, authority);
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
    if (mode === 'main-unknown-association') {
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
    const associated = await adjudicator.adjudicate(ends[0]);
    assert.equal(associated.state, 'associated');
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
    if (snapshotPath) {
        const owned = resolve(snapshotPath);
        assert.equal(dirname(owned), resolve(tmpdir()));
        assert.match(basename(owned), /^hyperion-managed-wire-(?:main|ds)-[0-9a-f-]+\.json$/);
        rmSync(owned, {force: true});
    }
    supervisor.stop();
}
