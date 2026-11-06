/** Native bundle CAS with controlled ES transport; no live broker or Wire release qualification. */
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {ProofConsumerScope, currentProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
import {ImmutableProtocolBundleStore, assertFreshBundlePrepare} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {createWireBrokerRecoveryControl, recordWireBrokerHandoffReceipt, awaitWireBrokerReceiptRelease,
    releaseWireBrokerReceipt, wireBrokerRecoveryDigest} from '../../scripts/qualification/portable-state-broker-recovery.mjs';

const output = realpathSync(mkdtempSync(join(tmpdir(), 'hapi319-native-receipts-')));
const configFile = join(output, 'chain.json'), chain = 'hyp-p191-abcdef012345';
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1', blockId = 'b'.repeat(64), id = 'h45actionhandoff1:' + 'c'.repeat(64);
writeFileSync(configFile, JSON.stringify({settings: {chain, protocol: {profileId}}}));
mkdirSync(join(output, 'observer/master'), {recursive: true});
const {control} = createWireBrokerRecoveryControl({output, configFile, chain,
    source: {chainId, profileId, endBlock: 1480, records: Array.from({length: 33}, () => ({blockId}))}, frameSha256: 'a'.repeat(64)});
const context = new AsyncLocalStorage(), memory = frontierMemoryClient(1), events = [];
const scopes = [new ProofConsumerScope('original-held'), new ProofConsumerScope('actual-redelivery'), new ProofConsumerScope('partial-retry')];
const record = {schemaVersion: 1, payloadJson: JSON.stringify({source: {chainId, blockNum: 33, blockId}, action: 'controlled-handoff'})};
let originalReturned = false, released = false, drained = false, original, draining;
try {
    for (const method of ['create', 'index']) {
        const transport = memory.client[method];
        memory.client[method] = async function (request, ...args) {
            const response = await transport.call(this, request, ...args);
            if (request.id !== id) return response;
            const current = context.getStore(), scope = currentProofConsumerScope(true).snapshot();
            const receipt = {schemaVersion: 1, runId: control.runId, controlSha256: wireBrokerRecoveryDigest(control),
                role: 'ds_pool_worker', workerId: '11', pid: process.pid, parentPid: process.ppid,
                source: {chainId, blockNum: 33, blockId}, originalFrameSha256: control.frameSha256,
                admissionId: 'h45actionadmission1:' + 'd'.repeat(64), traceOrdinal: 0, payloadSha256: 'e'.repeat(64),
                redelivered: current.redelivered, scope, recordId: id, method, request, response,
                attempt: {mode: 'managed', masterEnd: null, scope, binding: {admissionId: 'h45actionadmission1:' + 'd'.repeat(64),
                    traceOrdinal: 0, blockNum: 33, blockId}, descriptor: {payloadSha256: 'e'.repeat(64)}}};
            if (recordWireBrokerHandoffReceipt(control, receipt, (event, value) => events.push({event, ...structuredClone(value)})) === 'original')
                await awaitWireBrokerReceiptRelease(control);
            return response;
        };
    }
    const store = new ImmutableProtocolBundleStore(memory.client, chain, 1, 'action-source-admission', 'history-source-admission-v1');
    original = context.run({redelivered: false}, () => scopes[0].run(async () => {
        const proof = await store.prepare(id, record); originalReturned = true; return proof;
    }));
    void original.catch(() => {});
    const until = performance.now() + 2000;
    while (!existsSync(join(output, 'broker-recovery/held-receipt.json'))) {
        assert.ok(performance.now() < until, 'original actual manifest return was not held'); await pause(5);
    }
    draining = scopes[0].closeAndDrain().then(() => {drained = true;});
    assert.equal(originalReturned, false); assert.equal(scopes[0].snapshot().state, 'fenced');
    await context.run({redelivered: true}, () => scopes[1].run(async () => {
        const proof = await store.prepare(id, record);
        assert.throws(() => assertFreshBundlePrepare(store, {...proof}, id, proof.digest));
        assert.equal(assertFreshBundlePrepare(store, proof, id, proof.digest), scopes[1]);
    }));
    assert.equal(originalReturned, false); assert.equal(drained, false);
    const successful = events.filter(value => value.recordId === id);
    assert.equal(successful.length, 1); assert.equal(successful[0].redelivered, true);
    assert.equal(successful[0].method, 'index'); assert.equal(successful[0].response.result, 'updated');
    assert.deepEqual(successful[0].response._shards, {total: 2, successful: 2, failed: 0});
    assert.ok(memory.calls.some(value => value.method === 'index' && value.request.id === id
        && Number.isSafeInteger(value.request.if_seq_no) && value.request.if_primary_term === 1));
    memory.faults.receipt = (response, request) => request.id === id
        ? {...response, _shards: {total: 2, successful: 1, failed: 1}} : response;
    await assert.rejects(context.run({redelivered: true}, () => scopes[2].run(() => store.prepare(id, record))),
        /Incomplete ABI observation durable write receipt/);
    assert.equal(events.length, 2); assert.equal(events[1].response._shards.successful, 1);
    releaseWireBrokerReceipt(control); released = true; await draining;
    await assert.rejects(original); assert.equal(originalReturned, false); assert.equal(drained, true);
    console.log(JSON.stringify({passed: true, node: process.version, controlledEsTransport: true,
        originalManifestHeld: true, genuineCasPath: true, separateFreshScope: true,
        partialReceiptRejectedByOriginalStore: true, originalStillFenced: true, fullWorkerQualification: false}));
} finally {
    if (!released) releaseWireBrokerReceipt(control);
    await draining; if (original) await original.catch(() => {});
    for (const scope of scopes) await scope.closeAndDrain();
    assert.equal(dirname(output), realpathSync(tmpdir())); assert.ok(basename(output).startsWith('hapi319-native-receipts-'));
    rmSync(output, {recursive: true, force: true});
}
