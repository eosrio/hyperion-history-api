/** Controlled EventEmitters exercise original callbacks; these are not physical IPC/death evidence. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {installWorkerFenceDiagnostics} from '../../scripts/qualification/worker-fence-diagnostics.mjs';

const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hapi-fence-callbacks-'));
mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'fence-callbacks'}, indexer: {}, whitelists: {}, blacklists: {}}));
process.env.CONFIG_JSON = join(directory, 'chain.json'); process.chdir(directory);
const {HyperionMaster} = await import('../../build/indexer/modules/master.js');
const rows = [], unavailable = new Set(); let failures = 0;
const diagnostics = installWorkerFenceDiagnostics({WorkerClient: WorkerAttemptClient, Supervisor: WorkerAttemptSupervisor,
    Master: HyperionMaster, physical: pid => {
        if (unavailable.has(pid)) throw new Error('ENOENT: controlled unavailable process identity');
        return {pid, birthTicks: null, birthObservation: 'controlled-transport-not-physical-worker'};
    },
    failed: () => {failures++;}, emit: (event, snapshot) => rows.push({event, ...structuredClone(snapshot())})});
const descriptor = () => ({kind: 'ds-delivery', receiptId: randomUUID(), payloadSha256: 'a'.repeat(64),
    headersSha256: 'b'.repeat(64), consumerId: randomUUID(), publisherId: randomUUID(), queue: 'controlled', deliveryTag: 1});
const pairs = [];
function pair() {
    const transport = new EventEmitter(), worker = new EventEmitter(), ends = [];
    const supervisor = new WorkerAttemptSupervisor({onEnd: value => ends.push(value)});
    let throwSend, callbackError, returnValue = true;
    Object.assign(worker, {id: 7, process: {pid: process.pid}, isConnected: () => true, send(message, callback) {
        assert.equal(this, worker);
        if (message.event.startsWith('worker_attempt_fence')) {
            if (throwSend) throw throwSend;
            if (callbackError) {callback(callbackError); return returnValue;}
        }
        queueMicrotask(() => {transport.emit('message', message); callback?.(null);}); return returnValue;
    }});
    transport.send = function(message, callback) {
        assert.equal(this, transport);
        queueMicrotask(() => {worker.emit('message', message); callback?.(null);}); return true;
    };
    supervisor.attach(worker, 'ds_pool_worker');
    const client = new WorkerAttemptClient({mode: 'managed', role: 'ds_pool_worker', transport});
    const value = {worker, transport, supervisor, client, ends,
        sendFailure: (error, callback = false) => {if (callback) callbackError = error; else throwSend = error; returnValue = false;}};
    pairs.push(value); return value;
}
try {
    const absent = {id: 99, process: {pid: 2147483647}, isConnected: () => false}; unavailable.add(absent.process.pid);
    const master = Object.create(HyperionMaster.prototype);
    assert.equal(master.revokeProtocolAbiReader(absent), undefined);
    await master.handleProtocolAbiCoordinatorRequest(absent, {event: 'protocol_abi_coordinator_request', mId: randomUUID(),
        data: {operation: 'open', contextId: 'h45srcctx1:' + 'c'.repeat(64), readerSessionId: 'irrelevant-session'}});
    assert.equal(failures, 0, 'original no-op/unauthorized calls must not require a dead process identity');
    assert.equal(rows.length, 0);
    const first = pair(), unrelated = pair();
    const handles = Array.from({length: 34}, () => first.client.capture(descriptor()));
    const other = unrelated.client.capture(descriptor());
    await Promise.all([...handles.map(handle => first.client.attempts.get(handle).accepted), unrelated.client.attempts.get(other).accepted]);
    first.supervisor.fenceActive(); await new Promise(resolve => setImmediate(resolve));
    const sent = rows.find(row => row.event === 'worker_attempt_fence_sent');
    const chunks = rows.filter(row => row.event === 'worker_attempt_fence_members' && row.sendId === sent.sendId);
    assert.deepEqual(chunks.map(row => [row.offset, row.members.length]), [[0, 32], [32, 2]]);
    assert.equal(sent.memberCount, 34); assert.equal(sent.returned, true);
    assert.equal(unrelated.client.describe(other).scope.state, 'open', 'a separate original owner cannot inherit another owner fence');
    for (const handle of handles) {
        const origin = diagnostics.describe(first.client, handle);
        assert.equal(origin.origin.kind, 'parent-ipc');
        first.client.fenceChannel(first.client.describe(handle).descriptor.consumerId);
        assert.deepEqual(diagnostics.describe(first.client, handle), origin, 'a later local fence cannot replace the first cause');
        await assert.rejects(first.client.run(handle, () => assert.fail('fenced root cannot execute')), {code: 'worker_attempt_fenced'});
    }
    assert.equal(first.ends.length, 34);
    for (const evidence of first.ends) {
        const end = describeWorkerAttemptEnd(first.supervisor, evidence);
        assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'threw'); assert.equal(end.acknowledgementAttempted, false);
    }
    const returned = {};
    assert.equal(await unrelated.client.run(other, () => returned), returned, 'normal root result identity is unchanged');

    const revoker = Object.assign(Object.create(HyperionMaster.prototype), {workerAttemptSupervisor: first.supervisor,
        liveReader: {wref: first.worker}, protocolAbiSource: {worker: first.worker, readerSessionId: 'cached-session'},
        protocolAbiCoordinator: {async revokeSource() {}}});
    unavailable.add(process.pid); // Controlled lookup failure after the original Worker identity was captured.
    revoker.revokeProtocolAbiReader(first.worker, 'cached-session'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(rows.findLast(row => row.event === 'worker_attempt_fence_sent').sourceOperation.reader.pid, process.pid);
    assert.equal(failures, 0, 'relevant revocation must use its original retained Worker birth'); unavailable.delete(process.pid);

    for (const kind of ['disconnect', 'dispose', 'direct']) {
        const current = pair(), handle = current.client.capture(descriptor());
        await current.client.attempts.get(handle).accepted;
        if (kind === 'disconnect') current.transport.emit('disconnect');
        else if (kind === 'dispose') current.client.dispose();
        else current.client.fenceActiveAttempts();
        assert.equal(diagnostics.describe(current.client, handle).origin.kind,
            kind === 'disconnect' ? 'ipc-disconnect' : kind === 'dispose' ? 'dispose' : 'unclassified-local');
        assert.equal(current.client.describe(handle).scope.state, 'fenced'); assert.equal(current.ends.length, 0);
        // A callback dispatch proves no drain or physical exit; deliberately do not synthesize either.
    }
    for (const callback of [false, true]) {
        const current = pair(), handle = current.client.capture(descriptor()), error = new Error('Original controlled send failure');
        await current.client.attempts.get(handle).accepted;
        current.sendFailure(error, callback); current.supervisor.fenceActive();
        const row = rows.findLast(value => value.event === (callback ? 'worker_attempt_fence_send_callback' : 'worker_attempt_fence_send_threw'));
        assert.equal(row.error.message, error.message);
        assert.equal(current.client.describe(handle).scope.state, 'open');
        assert.equal(diagnostics.describe(current.client, handle), null);
        if (callback) assert.equal(rows.findLast(value => value.event === 'worker_attempt_fence_sent').returned, false);
    }
    const scope = new ProofConsumerScope('original-drain-promise');
    const originalPromise = scope.closeAndDrain();
    assert.equal(originalPromise, scope.ending); assert.equal(scope.closeAndDrain(), originalPromise); await originalPromise;
    assert.equal(failures, 0);
    console.log(JSON.stringify({passed: true, controlledCallbacksOnly: true, physicalIpcOrExitEvidence: false, chunks: chunks.length}));
} finally {
    for (const {client, supervisor} of pairs) {client.dispose(); supervisor.stop();}
    process.chdir(previous); assert.ok(directory.startsWith(join(tmpdir(), 'hapi-fence-callbacks-')));
    rmSync(directory, {recursive: true, force: true});
}
