/** Owned native Wire callbacks and bounded snapshot custody. Canonical/storage inputs are controlled. */
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

export function managedWireAttemptFixture({role, workerMode}) {
    const isMain = role === 'deserializer', ends = [], children = [], snapshots = [];
    const supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    cluster.setupPrimary({exec: fileURLToPath(new URL('./action-attempt-disposition-worker.mjs', import.meta.url)),
        args: [workerMode], silent: true});
    function spawn(environment = {}) {
        const child = cluster.fork({HYPERION_QUALIFICATION_PLAIN_PROOF: 'false',
            HYPERION_QUALIFICATION_PLAIN_HANDOFF: 'false', ...environment});
        const state = {child, messages: [], exited: false, stderr: '', stdout: ''};
        child.on('message', message => state.messages.push(message));
        child.on('exit', code => {state.exited = true; state.code = code;});
        child.process.stdout.on('data', bytes => {state.stdout += bytes;});
        child.process.stderr.on('data', bytes => {state.stderr += bytes;});
        children.push(state); supervisor.attach(child, role); return state;
    }
    async function until(predicate, state, label, timeout = 30_000) {
        const deadline = Date.now() + timeout;
        while (!predicate()) {
            assert(!state.exited && Date.now() < deadline, JSON.stringify({label, code: state.code,
                stderr: state.stderr.slice(-3000), stdout: state.stdout.slice(-3000), events: state.messages.map(x => x.event)}));
            await new Promise(yes => setTimeout(yes, 5));
        }
    }
    const event = (state, name) => state.messages.find(x => x.event === name);
    const requests = (state, operation) => state.messages.filter(x => x.event === 'worker_attempt_request' && x.payload?.operation === operation);
    function ownEnd(state, attemptIndex = 0) {
        const registration = requests(state, 'register')[attemptIndex]?.payload;
        return registration && ends.find(value => {
            const end = describeWorkerAttemptEnd(supervisor, value);
            return end.incarnation === registration.incarnation && end.attemptId === registration.attemptId;
        });
    }
    function retainedSnapshot(state, snapshotIndex) {
        const receipt = state.messages.filter(x => x.event === 'qualification_fixture')[snapshotIndex], path = resolve(receipt.path);
        assert.equal(dirname(path), resolve(tmpdir()));
        assert.match(basename(path), /^hyperion-managed-wire-(?:main|ds)-[0-9a-f-]+\.json$/);
        snapshots.push(path);
        const bytes = readFileSync(path); assert.equal(statSync(path).size, receipt.bytes);
        assert(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024); assert.equal(hash(bytes), receipt.sha256);
        const snapshot = JSON.parse(bytes), memory = frontierMemoryClient();
        for (const field of ['documents', 'mappings', 'settings']) for (const [key, value] of snapshot[field]) memory[field].set(key, value);
        memory.client.indices.exists = async ({index}) => memory.settings.has(index);
        return {snapshot, memory, store: new ActionSourceAdmissionStore(memory.client, 'handoff-worker-original'),
            selections: new ProtocolSourceBindingStore(memory.client, 'handoff-worker-original')};
    }
    async function inspectOriginal(state, attemptIndex = 0) {
        const evidence = ownEnd(state, attemptIndex), end = describeWorkerAttemptEnd(supervisor, evidence), retained = retainedSnapshot(state, attemptIndex);
        assert.equal(end.role, role); assert.equal(end.status, 'quiescent');
        assert.equal(end.binding.blockNum, isMain ? 1 : 33);
        if (isMain) {
            const ingress = await retained.store.resolveIngress(end.binding.ingressId);
            assert.equal(hash(Buffer.from(ingress.frameHex, 'hex')), end.descriptor.payloadSha256);
        } else {
            const admission = await retained.store.resolve(end.binding.admissionId);
            const transaction = admission.inventory.transactions.find(x => x.traceOrdinal === end.binding.traceOrdinal);
            assert.equal(hash(Buffer.from(transaction.dispatch.canonicalJson)), end.descriptor.payloadSha256);
        }
        return {...retained, evidence, end};
    }
    async function associateOriginal(retained) {
        const admission = await retained.store.resolve(retained.end.binding.admissionId), source = admission.source.inventoryInput.source;
        const issued = new WeakSet();
        const current = {configurationSha256: () => admission.source.producer.configurationSha256,
            targetUuid: async name => retained.memory.settings.get(name)['index.uuid'],
            canonicalBlock: async blockNum => {
                assert.equal(blockNum, source.blockNum);
                const block = Object.freeze({chainId: source.chainId, blockId: source.blockId,
                    previousBlockId: admission.source.previousBlockId, irreversible: true}); issued.add(block); return block;
            },
            assertCanonicalCurrent: block => assert(issued.has(block), 'unissued controlled canonical observation')};
        const adjudicator = new ActionAttemptAdjudicator(supervisor, retained.store, retained.selections, current);
        const result = await adjudicator.adjudicate(retained.evidence); assert.equal(result.state, 'associated');
        const stored = (await retained.store.readAttemptAssociation(result.id)).observation;
        assert.equal(stored.end.attemptId, retained.end.attemptId); assert.equal(stored.brokerSettlement, 'unknown');
        assert.deepEqual(stored.results, [{id: retained.snapshot.recordId, classification: isMain ? 'source-incomplete' : 'confirmed-handoff'}]);
    }
    async function finish(state) {
        state.child.send({event: 'qualification_done'});
        await until(() => state.exited, state, 'owned original callback exits');
        assert.equal(state.code, 0, state.stdout.slice(-3000)); assert.equal(state.stderr, '');
    }
    async function close() {
        for (const state of children) if (!state.exited) {
            try {state.child.send({event: 'qualification_release_proof'}); state.child.send({event: 'qualification_release_write'}); state.child.send({event: 'qualification_done'});} catch {}
            try {state.child.process.kill();} catch {}
            await until(() => state.exited, state, 'owned failed-case child cleanup', 5000).catch(() => {});
        }
        for (const path of snapshots) rmSync(path, {force: true});
        supervisor.stop();
    }
    return {supervisor, spawn, event, requests, ownEnd, until, inspectOriginal, associateOriginal, finish, close};
}
