/** Original Wire MainDS source callback through an owned native child and parent adjudicator.
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

cluster.setupPrimary({exec: fileURLToPath(new URL('./action-attempt-disposition-worker.mjs', import.meta.url)),
    args: ['managed-original-main'], silent: true});
const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: end => ends.push(end)});
const child = cluster.fork(), messages = [];
let stderr = '', stdout = '', exited = false, exitCode, snapshotPath;
child.process.stderr.on('data', bytes => {stderr += bytes.toString();});
child.process.stdout.on('data', bytes => {stdout += bytes.toString();});
child.on('message', message => messages.push(message));
child.on('exit', code => {exited = true; exitCode = code;});
supervisor.attach(child, 'deserializer');

function waitFor(predicate, label, timeout = 30_000) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolveWait, reject) => {
        const poll = setInterval(() => {if (predicate()) {clearInterval(poll); clearTimeout(timer); resolveWait();}}, 5);
        const timer = setTimeout(() => {clearInterval(poll); reject(new Error('Timed out: ' + label));}, timeout);
    });
}

try {
    await waitFor(() => messages.some(message => message?.event === 'qualification_fixture') && ends.length === 1,
        'original Wire MainDS fresh result and owned worker end');
    const fixture = messages.find(message => message.event === 'qualification_fixture');
    snapshotPath = resolve(fixture.path);
    assert.equal(dirname(snapshotPath), resolve(tmpdir()));
    assert.match(basename(snapshotPath), /^hyperion-managed-wire-main-[0-9a-f-]+\.json$/);
    const size = statSync(snapshotPath).size;
    assert(size > 0 && size <= 64 * 1024 * 1024 && size === fixture.bytes);
    const bytes = readFileSync(snapshotPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
    const snapshot = JSON.parse(bytes.toString());
    assert.equal(snapshot.originalAckCount, 1);
    const registration = messages.findIndex(message => message.event === 'worker_attempt_request'
        && message.payload?.operation === 'register');
    const freshWrite = messages.findIndex(message => message.event === 'worker_attempt_request'
        && message.payload?.operation === 'observe');
    const ack = messages.findIndex(message => message.event === 'qualification_ack'
        && message.dispositionId === snapshot.dispositionId);
    const endRequest = messages.findIndex(message => message.event === 'worker_attempt_request'
        && message.payload?.operation === 'end');
    assert(registration >= 0 && freshWrite > registration && ack > freshWrite && endRequest > ack,
        'the original MainDS callback must observe its fresh write before ACK and quiescent end');
    const memory = frontierMemoryClient();
    for (const [key, value] of snapshot.documents) memory.documents.set(key, value);
    for (const [key, value] of snapshot.mappings) memory.mappings.set(key, value);
    for (const [key, value] of snapshot.settings) memory.settings.set(key, value);
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    const chain = 'handoff-worker-original', store = new ActionSourceAdmissionStore(memory.client, chain),
        selections = new ProtocolSourceBindingStore(memory.client, chain);
    const admission = await store.resolve(snapshot.admissionId);
    const recorded = await store.readAttemptDisposition(snapshot.dispositionId);
    assert.equal(recorded.observation.disposition, 'source-unprocessable');
    assert.equal(recorded.observation.reason, 'source-traces-missing');
    const source = admission.source.inventoryInput.source, end = describeWorkerAttemptEnd(supervisor, ends[0]);
    assert.equal(source.blockNum, 1);
    assert.equal(end.role, 'deserializer');
    assert.equal(end.status, 'quiescent');
    assert.equal(end.rootResult, 'returned');
    assert.equal(end.acknowledgementAttempted, true);
    assert.equal(end.freshWrites.length, 1);
    assert.equal(end.freshWrites[0].id, snapshot.dispositionId);
    assert.equal(end.descriptor.payloadSha256, createHash('sha256').update(Buffer.from(admission.source.frameHex, 'hex')).digest('hex'));
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
    const associated = await adjudicator.adjudicate(ends[0]);
    assert.equal(associated.state, 'associated');
    const observation = (await store.readAttemptAssociation(associated.id)).observation;
    assert.deepEqual(observation.results, [{id: snapshot.dispositionId, classification: 'source-incomplete'}]);
    assert.equal(observation.brokerSettlement, 'unknown');
    assert.equal(observation.sourceChecked, true);
    assert.equal(observation.end.attemptId, end.attemptId);
    child.send({event: 'qualification_done'});
    await waitFor(() => exited, 'owned Wire MainDS child exit');
    assert.equal(exitCode, 0, stdout.slice(-4000));
    assert.equal(stderr, '', stdout.slice(-4000));
    console.log(JSON.stringify({passed: true, native: process.version, originalWireMainCallback: true,
        managedParentEnd: true, writeBeforeAckBeforeEnd: true, originalAckCount: 1,
        classification: observation.results[0].classification,
        controlledStorageAndCanonicalAuthority: true, brokerSettlement: observation.brokerSettlement,
        fullWorkerQualification: false}));
} finally {
    if (!exited) {
        try {child.send({event: 'qualification_done'});} catch {}
        try {child.process.kill();} catch {}
        await waitFor(() => exited, 'owned Wire MainDS failure cleanup', 5000).catch(() => {});
    }
    if (snapshotPath) {
        const owned = resolve(snapshotPath);
        assert.equal(dirname(owned), resolve(tmpdir()));
        assert.match(basename(owned), /^hyperion-managed-wire-main-[0-9a-f-]+\.json$/);
        rmSync(owned, {force: true});
    }
    supervisor.stop();
}
