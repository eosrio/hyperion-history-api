/** Actual parent termination/relaunch with original Wire callbacks and a controlled retained backend.
 * This exercises process/attempt ownership, not live broker, replica durability or fork recovery. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {readRestartSnapshot, restartDirectory} from './action-attempt-restart-snapshot.mjs';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {ActionAttemptAdjudicator} from '../../build/indexer/history/action-attempt-adjudicator.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {actionHistoryImmutableJson} from '../../build/indexer/history/action-history-manifest.js';
import {issueFreshActionWrite} from '../../build/indexer/history/action-fresh-write.js';

const self = fileURLToPath(import.meta.url), scenario = process.argv[2], phase = process.argv[3] ?? 'controller';
assert(['main', 'handoff'].includes(scenario));
assert(['controller', 'recover', 'read', 'fresh'].includes(phase));
const until = async (predicate, label, timeout = 20_000) => {
    const deadline = performance.now() + timeout;
    while (!predicate()) {assert(performance.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 5));}
};
function observeOwned(child, process = child) {
    const state = {child, messages: [], stdout: '', stderr: '', exited: false, code: null, signal: null};
    child.on('message', message => state.messages.push(message));
    process.stdout.on('data', bytes => {state.stdout += bytes.toString(); assert(state.stdout.length <= 256 * 1024);});
    process.stderr.on('data', bytes => {state.stderr += bytes.toString(); assert(state.stderr.length <= 256 * 1024);});
    child.on('exit', (code, signal) => Object.assign(state, {exited: true, code, signal}));
    return state;
}
function ownedChild(file, args) {return observeOwned(fork(file, args, {stdio: ['ignore','pipe','pipe','ipc']}));}
function ownedWorker(args) {
    cluster.setupPrimary({exec: self, args, silent: true});
    const worker = cluster.fork();
    return observeOwned(worker, worker.process);
}
async function cleanup(state) {
    if (!state?.exited) {
        state?.child.kill('SIGKILL');
        if (state) await until(() => state.exited, 'owned restart child cleanup', 5000);
    }
}
function retained(directory, expected) {
    const value = readRestartSnapshot(directory, expected), memory = frontierMemoryClient();
    for (const name of ['documents','mappings','settings']) for (const [key, item] of value.snapshot[name]) memory[name].set(key, item);
    // This fixture never deletes documents: the retained per-index maximum is its sequence watermark.
    for (const [key, item] of memory.documents) {
        const index = key.slice(0, key.indexOf('\0'));
        assert(Number.isSafeInteger(item.seq) && item.seq >= 0 && item.seq < Number.MAX_SAFE_INTEGER);
        memory.sequences.set(index, Math.max(memory.sequences.get(index) ?? 0, item.seq + 1));
    }
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const chain = 'handoff-worker-original', store = new ActionSourceAdmissionStore(memory.client, chain);
    return {...value, memory, chain, store};
}
async function readOriginal(state) {
    const admission = await state.store.resolve(state.snapshot.admissionId);
    if (scenario === 'main') {
        const original = await state.store.readAttemptDisposition(state.snapshot.recordId);
        assert.equal(original.observation.disposition, 'source-unprocessable');
        return {admission, record: original.observation, kind: 'attempt-disposition'};
    }
    const tx = admission.inventory.transactions.find(value => value.traceOrdinal === state.end.binding.traceOrdinal);
    const original = await state.store.readConfirmedHandoff(admission.id, tx.traceOrdinal, Buffer.from(tx.dispatch.canonicalJson));
    assert.equal(original.outcome.kind, 'confirmed-action-handoff');
    return {admission, record: original.outcome, kind: 'confirmed-handoff'};
}

if (phase === 'controller') {
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-attempt-restart-'));
    let before, after;
    try {
        before = ownedChild(fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)),
            [scenario + '-restart-checkpoint', directory]);
        await until(() => before.messages.some(message => message.event === 'restart_checkpoint') || before.exited,
            'original parent reaches durable result and authentic end without adjudication', 30_000);
        assert.equal(before.exited, false, before.stderr);
        const checkpoint = before.messages.find(message => message.event === 'restart_checkpoint');
        assert.equal(checkpoint.parentPid, before.child.pid);
        assert.equal(checkpoint.originalChildExited, true); assert.equal(checkpoint.associationWritten, false);
        const expected = {bytes: checkpoint.bytes, sha256: checkpoint.sha256};
        const original = readRestartSnapshot(directory, expected);
        assert.equal(original.oldParent.pid, before.child.pid);
        before.child.kill('SIGKILL');
        await until(() => before.exited, 'original parent actually exits before relaunch');
        assert.equal(before.signal, 'SIGKILL');
        after = ownedChild(self, [scenario, 'recover', directory, JSON.stringify(expected)]);
        await until(() => after.messages.some(message => message.event === 'recovery_complete') || after.exited,
            'new native parent completes read-only and fresh-write recovery checks');
        const recovered = after.messages.find(message => message.event === 'recovery_complete');
        assert(recovered, after.stderr);
        assert.equal(recovered.parentPid, after.child.pid);
        assert.notEqual(recovered.epoch, original.oldParent.epoch);
        assert.deepEqual(readRestartSnapshot(directory, expected), original, 'retained checkpoint bytes stay frozen');
        after.child.send({event: 'done'});
        await until(() => after.exited, 'new native parent exits');
        assert.equal(after.code, 0); assert.equal(after.stderr, '');
        assert.equal(before.stderr, '');
        console.log(JSON.stringify({passed: true, scenario, native: process.version,
            actualParentExit: {pid: before.child.pid, signal: before.signal}, newParentPid: after.child.pid,
            originalWorkerExitedBeforeParent: true, originalResultRetained: true, priorEndNotReissued: true,
            newReadOnlyAttemptUnresolved: true, newFreshConditionalWriteAssociated: true,
            brokerSettlement: 'unknown', controlledBackend: true, liveRestartQualification: false}));
    } finally {
        await cleanup(after); await cleanup(before);
        rmSync(restartDirectory(directory), {recursive: true, force: true});
    }
} else {
    const directory = restartDirectory(process.argv[4]), expected = JSON.parse(process.argv[5]), state = retained(directory, expected);
    if (phase === 'recover') {
        const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
        const {admission} = await readOriginal(state), source = admission.source.inventoryInput.source;
        const adjudicator = new ActionAttemptAdjudicator(supervisor, state.store,
            new ProtocolSourceBindingStore(state.memory.client, state.chain), {
                configurationSha256: () => admission.source.producer.configurationSha256,
                targetUuid: async name => {assert.equal(name, admission.target.name); return admission.target.uuid;},
                canonicalBlock: async num => {assert.equal(num, source.blockNum); return {...source,
                    previousBlockId: admission.source.previousBlockId, irreversible: true};}
            });
        const children = [];
        try {
            const writes = () => state.memory.calls.filter(call => ['create','index'].includes(call.method));
            await assert.rejects(adjudicator.adjudicate(state.end), /Unissued or foreign/);
            await assert.rejects(adjudicator.adjudicate({}), /Unissued or foreign/);
            assert.equal(writes().length, 0);
            for (const mode of ['read', 'fresh']) {
                const child = ownedWorker([scenario, mode, directory, JSON.stringify(expected)]); children.push(child);
                supervisor.attach(child.child, scenario === 'main' ? 'deserializer' : 'ds_pool_worker');
                const before = ends.length;
                await until(() => ends.length === before + 1 && child.messages.some(message => message.event === 'worker_complete') || child.exited,
                    `new original-delivery ${mode} attempt ends`);
                assert.equal(child.exited, false, child.stderr);
                const description = describeWorkerAttemptEnd(supervisor, ends[before]);
                assert.equal(description.status, 'quiescent'); assert.equal(description.rootResult, 'returned');
                assert.equal(description.acknowledgementAttempted, true);
                assert.equal(description.descriptor.payloadSha256, state.end.descriptor.payloadSha256);
                assert.notEqual(description.attemptId, state.end.attemptId);
                assert.equal(description.epoch, supervisor.epoch);
                if (mode === 'read') {
                    assert.equal(description.freshWrites.length, 0);
                    assert.deepEqual(await adjudicator.adjudicate(ends[before]), {state: 'unresolved'});
                    assert.equal(writes().length, 0);
                } else {
                    assert.equal(description.freshWrites.length, 1);
                    assert.equal(description.freshWrites[0].id, state.snapshot.recordId);
                    assert.equal(child.messages.find(message => message.event === 'worker_complete').conditionalManifestWrite, true);
                    const result = await adjudicator.adjudicate(ends[before]);
                    assert.equal(result.state, 'associated');
                    const saved = await state.store.readAttemptAssociation(result.id);
                    assert.equal(saved.observation.brokerSettlement, 'unknown');
                    assert.equal(saved.observation.end.epoch, supervisor.epoch);
                    assert.equal(saved.observation.end.attemptId, description.attemptId);
                }
                child.child.send({event: 'done'});
                await until(() => child.exited, `new ${mode} worker exits`);
                assert.equal(child.code, 0); assert.equal(child.stderr, '');
            }
            process.send({event: 'recovery_complete', epoch: supervisor.epoch, parentPid: process.pid});
            await new Promise(resolve => process.once('message', message => {assert.equal(message.event, 'done'); resolve();}));
        } finally {for (const child of children) await cleanup(child); supervisor.stop();}
        process.disconnect();
    } else {
        const client = new WorkerAttemptClient({mode: 'managed', role: scenario === 'main' ? 'deserializer' : 'ds_pool_worker',
            transport: process, timeoutMs: 1000, retries: 0});
        try {
            const descriptor = {...state.end.descriptor, receiptId: randomUUID(), consumerId: randomUUID(), publisherId: randomUUID()};
            const attempt = client.capture(descriptor);
            let conditionalManifestWrite = false;
            await client.run(attempt, async () => {
                await client.bindCurrent(state.end.binding);
                const {record, kind} = await readOriginal(state), result = {id: state.snapshot.recordId};
                if (phase === 'read') await assert.rejects(client.observeFreshActionWrite(result), /fresh result/);
                else {
                    const bundles = new ImmutableProtocolBundleStore(state.memory.client, state.chain, 0,
                        'action-source-admission', 'history-source-admission-v1');
                    const previousSequence = state.memory.documents.get(state.memory.key(state.store.index, result.id)).seq;
                    const proof = await bundles.prepare(result.id, {schemaVersion: 1, payloadJson: actionHistoryImmutableJson(record)});
                    conditionalManifestWrite = state.memory.calls.some(call => call.method === 'index'
                        && call.request.id === result.id && call.request.wait_for_active_shards === 'all'
                        && Number.isSafeInteger(call.request.if_seq_no) && Number.isSafeInteger(call.request.if_primary_term));
                    assert.equal(conditionalManifestWrite, true);
                    assert(state.memory.documents.get(state.memory.key(state.store.index, result.id)).seq > previousSequence);
                    issueFreshActionWrite(result, kind, result.id, record, proof, bundles);
                    assert.equal(await client.observeFreshActionWrite(result), true);
                }
                client.markAcknowledgementAttempt();
            });
            process.send({event: 'worker_complete', phase, conditionalManifestWrite});
            await new Promise(resolve => process.once('message', message => {assert.equal(message.event, 'done'); resolve();}));
        } finally {client.dispose();}
        process.disconnect();
    }
}
