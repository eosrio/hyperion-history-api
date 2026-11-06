/** Native Antelope lifecycle plus actual master adjudication; external inputs are controlled. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {readFileSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Checksum256, UInt32} from '@wharfkit/antelope';
import {WorkerAttemptSupervisor, describeWorkerAttemptEnd} from '../../build/indexer/protocol/worker-attempt-supervisor.js';
import {HyperionMaster} from '../../build/indexer/modules/master.js';
import {HyperionModuleLoader} from '../../build/indexer/modules/loader.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const mode = process.argv[2] ?? 'handoff', role = mode === 'handoff' ? 'ds_pool_worker' : 'deserializer';
const fixtureBytes = readFileSync(new URL('../fixtures/antelope-worker/source.json', import.meta.url));
const input = JSON.parse(fixtureBytes), hash = value => createHash('sha256').update(value).digest('hex');
const ends = [], supervisor = new WorkerAttemptSupervisor({onEnd: value => ends.push(value)}), events = [];
cluster.setupPrimary({exec: fileURLToPath(new URL('./antelope-attempt-worker.mjs', import.meta.url)), args: [mode], silent: true});
const child = cluster.fork({HYPERION_QUALIFICATION_PLAIN_PROOF: 'false', HYPERION_QUALIFICATION_PLAIN_HANDOFF: 'false'});
let exited = false, exitCode, stdout = '', stderr = '';
child.on('exit', code => {exited = true; exitCode = code;});
child.process.stdout.on('data', bytes => {stdout += bytes;});
child.process.stderr.on('data', bytes => {stderr += bytes;});
child.on('message', value => events.push(value)); supervisor.attach(child, role);
async function until(predicate, label) {
    const deadline = Date.now() + 30_000;
    while (!predicate()) {
        assert(!exited && Date.now() < deadline, JSON.stringify({label, exitCode, stdout, stderr, events: events.map(x => x.event)}));
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
try {
    await until(() => events.some(x => x.event === 'qualification_fixture') && ends.length === 1, 'Original native callback and authentic end');
    const receipt = events.find(x => x.event === 'qualification_fixture'), path = resolve(receipt.path);
    assert.equal(dirname(path), resolve(tmpdir())); assert.match(basename(path), /^hyperion-antelope-attempt-[0-9a-f-]+\.json$/);
    assert(receipt.bytes > 0 && receipt.bytes <= 64 * 1024 * 1024);
    assert.equal(statSync(path).size, receipt.bytes); const bytes = readFileSync(path); assert.equal(hash(bytes), receipt.sha256);
    const retained = JSON.parse(bytes), memory = frontierMemoryClient(1);
    for (const key of ['documents', 'mappings', 'settings', 'sequences']) for (const [id, value] of retained[key]) memory[key].set(id, value);
    memory.client.indices.exists = async ({index}) => memory.settings.has(index);
    assert.equal(retained.fixtureSha256, hash(fixtureBytes)); assert.equal(retained.frameSha256, input.frames[mode].sha256);
    const end = describeWorkerAttemptEnd(supervisor, ends[0]);
    assert.equal(end.role, role); assert.equal(end.status, 'quiescent'); assert.equal(end.rootResult, 'returned');
    assert.equal(end.acknowledgementAttempted, true); assert.equal(end.binding.blockNum, input.source.blockNum);
    assert.equal(end.binding.blockId, input.source.blockId); assert.equal(end.freshWrites.length, 1);
    assert.equal(end.freshWrites[0].id, retained.recordId); assert.equal(end.binding.admissionId, retained.admissionId);
    assert.throws(() => describeWorkerAttemptEnd(supervisor, structuredClone(end)), /Unissued or foreign/);
    const store = new ActionSourceAdmissionStore(memory.client, retained.chain, 1), admission = await store.resolve(retained.admissionId);
    const originalPayload = role === 'deserializer' ? Buffer.from(admission.source.frameHex, 'hex')
        : Buffer.from(admission.inventory.transactions[0].dispatch.canonicalJson);
    assert.equal(hash(originalPayload), end.descriptor.payloadSha256);
    const classification = mode === 'handoff' ? 'confirmed-handoff' : mode === 'empty' ? 'intentional-no-effect' : 'source-incomplete';
    if (mode !== 'handoff') {
        const value = (await store.readAttemptDisposition(retained.recordId)).observation;
        assert.equal(value.disposition, mode === 'empty' ? 'no-effects' : 'source-unprocessable');
        if (mode === 'missing') {assert.equal(value.reason, 'source-traces-missing'); assert.deepEqual(value.output, {kind: 'unresolved'});}
        assert.equal(value.work.transaction, null);
    }
    const loader = Object.assign(Object.create(HyperionModuleLoader.prototype), {handledActions: new Map(), plugins: []});
    const filters = {action_blacklist: new Set(), action_whitelist: new Set(), delta_blacklist: new Set(), delta_whitelist: new Set()};
    let canonicalId = input.source.blockId, lib = input.source.blockNum;
    const rpcCalls = [], master = Object.assign(Object.create(HyperionMaster.prototype), {chain: retained.chain, esClient: memory.client,
        conf: retained.config, cm: {filters}, mLoader: loader, protocolSourceProbes: new Map(),
        rpc: {v1: {chain: {get_info: async () => ({chain_id: Checksum256.from(input.source.chainId),
            head_block_num: UInt32.from(input.source.blockNum), last_irreversible_block_num: UInt32.from(lib)})}},
            call: async request => {rpcCalls.push(request); assert.equal(request.path, '/v1/chain/get_block');
                assert.deepEqual(request.params, {block_num_or_id: input.source.blockNum});
                return {block_num: input.source.blockNum, id: canonicalId, previous: input.source.previousBlockId};}}});
    const adjudicator = master.attemptAdjudicatorFor(supervisor);
    const associationIds = () => [...memory.documents.values()].map(x => x.document).filter(x => x.kind === 'manifest'
        && x.bundle_id.startsWith('h45actionassociation1:')).map(x => x.bundle_id);
    const guards = [];
    if (mode === 'handoff') {
        master.conf.indexer.disable_indexing = true;
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        assert.equal(associationIds().length, 0); guards.push('current-configuration');
        master.conf.indexer.disable_indexing = false;
        memory.settings.get(retained.targetName)['index.uuid'] = 'different-physical-target';
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        assert.equal(associationIds().length, 0); guards.push('physical-target-uuid');
        memory.settings.get(retained.targetName)['index.uuid'] = retained.targetUuid;
        canonicalId = 'f'.repeat(64);
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        assert.equal(associationIds().length, 0); guards.push('canonical-block-identity');
        canonicalId = input.source.blockId; lib--;
        // Builtin Antelope currently has no selected reversible source. Do not grant one from an RPC boolean.
        assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'unresolved'});
        assert.equal(associationIds().length, 0); guards.push('reversible-without-source-selection'); lib++;
        const originalSettings = memory.client.indices.getSettings;
        let entered, release;
        const enteredRead = new Promise(resolve => {entered = resolve;}), releasedRead = new Promise(resolve => {release = resolve;});
        memory.client.indices.getSettings = async request => {
            const result = await originalSettings(request); entered(); await releasedRead; return result;
        };
        const pending = adjudicator.adjudicate(ends[0]); pending.catch(() => {});
        await enteredRead; master.conf.indexer.disable_indexing = true; release();
        assert.deepEqual(await pending, {state: 'unresolved'}); assert.equal(associationIds().length, 0);
        memory.client.indices.getSettings = originalSettings; master.conf.indexer.disable_indexing = false;
        guards.push('configuration-changed-during-actual-target-read');
    }
    rpcCalls.length = 0;
    assert.deepEqual(await adjudicator.adjudicate(ends[0]), {state: 'associated', id: expectAssociationId()});
    function expectAssociationId() {
        const ids = associationIds();
        assert.equal(ids.length, 1); return ids[0];
    }
    const association = (await store.readAttemptAssociation(expectAssociationId())).observation;
    assert.equal(association.end.attemptId, end.attemptId); assert.equal(association.end.incarnation, end.incarnation);
    assert.equal(association.sourceChecked, true); assert.equal(association.brokerSettlement, 'unknown');
    assert.deepEqual(association.results, [{id: retained.recordId, classification}]); assert.equal(rpcCalls.length, 1);
    const receiptAt = events.findIndex(x => x.event === 'qualification_write_receipt');
    const observedAt = events.findIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'observe');
    const ackAt = events.findIndex(x => x.event === 'qualification_ack');
    const endAt = events.findIndex(x => x.event === 'worker_attempt_request' && x.payload?.operation === 'end');
    assert(receiptAt >= 0 && observedAt > receiptAt && ackAt > observedAt && endAt > ackAt);
    child.send({event: 'qualification_done'}); await until(() => exited, 'Owned native child exits');
    assert.equal(exitCode, 0); assert.equal(stderr, '');
    console.log(JSON.stringify({passed: true, mode, runtime: retained.runtime, originalAntelopeCallbacks: true,
        builtinNativeAddon: true, actualMasterAdjudicator: true, samePhysicalFreshReceiptAndEnd: true,
        classification, guards, sourceSha256: retained.frameSha256, fixtureSha256: retained.fixtureSha256,
        fixtureSourceSha256: hash(readFileSync(new URL('./antelope-attempt-worker.mjs', import.meta.url))), producer: retained.producer,
        executableSha256: retained.executableSha256, sourceCheckedAssociation: association.results,
        brokerSettlement: 'unknown', controlledSourceStorageRpcTransport: true, capacityAuthority: false, releaseQualified: false}));
} finally {
    if (!exited) {child.send({event: 'qualification_done'}); child.process.kill(); await until(() => exited, 'Failed-case child cleanup').catch(() => {});}
    supervisor.stop();
}
