/** Bounded custody for the original block-33 handoff receipt and one owned broker restart. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {errorMonitor} from 'node:events';
import {mkdirSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {boundedRecoveryFile, durableRecoveryFile, createRecoveryRecorder, readRecoveryRecords} from './recovery-custody.mjs';
import {auditWireRecoveryEnd, wireRecoveryAssociationId} from './wire-recovery-end-audit.mjs';

const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const controls = new WeakSet();
const publicationMembership = new WeakMap();
export const wireBrokerRecoveryDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = control => join(control.output, 'broker-recovery');

export function createWireBrokerRecoveryControl({output, configFile, chain, source, frameSha256}) {
    assert.equal(realpathSync(output), resolve(output)); assert.equal(resolve(configFile), join(output, 'chain.json'));
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/);
    assert.equal(source.chainId, chainId); assert.equal(source.profileId, profileId); assert.equal(source.endBlock, 1480);
    assert.match(frameSha256, /^[a-f0-9]{64}$/); assert.match(source.records[32].blockId, /^[a-f0-9]{64}$/);
    const control = Object.freeze({schemaVersion: 1, kind: 'wire-broker-restart', runId: randomUUID(),
        output, configFile: resolve(configFile), configSha256: wireBrokerRecoveryDigest(boundedRecoveryFile(configFile, 1024 * 1024).toString()),
        chain, chainId, profileId, blockNum: 33, blockId: source.records[32].blockId, traceOrdinal: 0, frameSha256});
    mkdirSync(directory(control)); const file = join(directory(control), 'control.json');
    durableRecoveryFile(file, control); controls.add(control); return {file, control};
}
export function readWireBrokerRecoveryControl(file, {observerDirectory, chain, configFile}) {
    const observer = realpathSync(observerDirectory), output = dirname(dirname(observer));
    assert.equal(observer, join(output, 'observer/master'));
    assert.equal(resolve(file), join(output, 'broker-recovery/control.json'));
    assert.equal(realpathSync(dirname(file)), dirname(resolve(file)));
    const control = JSON.parse(boundedRecoveryFile(file, 16384).toString());
    assert.equal(control.schemaVersion, 1); assert.equal(control.kind, 'wire-broker-restart');
    assert.match(control.runId, /^[a-f0-9-]{36}$/);
    assert.equal(control.output, output); assert.equal(control.configFile, resolve(configFile));
    assert.equal(control.configFile, join(output, 'chain.json')); assert.equal(control.chain, chain);
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/);
    assert.equal(control.chainId, chainId); assert.equal(control.profileId, profileId);
    assert.equal(control.blockNum, 33); assert.equal(control.traceOrdinal, 0);
    assert.match(control.blockId, /^[a-f0-9]{64}$/); assert.match(control.frameSha256, /^[a-f0-9]{64}$/);
    const configBytes = boundedRecoveryFile(configFile, 1024 * 1024).toString(), config = JSON.parse(configBytes);
    assert.equal(control.configSha256, wireBrokerRecoveryDigest(configBytes));
    assert.equal(config.settings.chain, chain); assert.equal(config.settings.protocol.profileId, profileId);
    assert.equal(config.settings.protocol_abi_coordination?.recovery_window_blocks, undefined);
    return control;
}
export const createWireBrokerRecorder = control => createRecoveryRecorder(directory(control), control.runId);
export function describeIssuedWireBrokerControl(control) {
    assert.ok(controls.has(control), 'unissued broker recovery control');
    assert.deepEqual(JSON.parse(boundedRecoveryFile(join(directory(control), 'control.json'), 16384).toString()), control);
    assert.equal(wireBrokerRecoveryDigest(boundedRecoveryFile(control.configFile, 1024 * 1024).toString()), control.configSha256);
    return structuredClone(control);
}
/** An observer must preserve both the original handled-error path and native unhandled-error exit. */
export function observeWireBrokerChannelEvents(channel, kind, record) {
    assert.ok(['consumer', 'publisher'].includes(kind));
    channel.once('close', () => record('channel-close', {kind, workerId: process.env.worker_id}));
    channel.once(errorMonitor, error => record('channel-error', {kind, error: String(error).slice(0, 4096)}));
}
export function readWireBrokerRecoveryEvidence(control) {
    return {held: JSON.parse(boundedRecoveryFile(join(directory(control), 'held-receipt.json'), 128 * 1024).toString()),
        events: readRecoveryRecords(directory(control), control.runId, ['control.json', 'held-receipt.json', 'release-receipt.json'])};
}
function assertWireBrokerHandoffReceipt(control, held) {
    assert.equal(held.schemaVersion, 1);
    assert.equal(held.runId, control.runId); assert.equal(held.controlSha256, wireBrokerRecoveryDigest(control));
    assert.equal(held.role, 'ds_pool_worker'); assert.equal(held.source.blockNum, control.blockNum);
    assert.equal(held.source.blockId, control.blockId); assert.equal(held.source.chainId, control.chainId);
    assert.equal(held.originalFrameSha256, control.frameSha256); assert.equal(held.admissionId, held.attempt.binding.admissionId);
    assert.equal(held.traceOrdinal, control.traceOrdinal); assert.equal(held.attempt.binding.traceOrdinal, control.traceOrdinal);
    assert.equal(held.attempt.binding.blockNum, control.blockNum); assert.equal(held.attempt.binding.blockId, control.blockId);
    assert.equal(held.payloadSha256, held.attempt.descriptor.payloadSha256);
    assert.equal(held.attempt.mode, 'managed'); assert.equal(held.attempt.masterEnd, null);
    // The awaited store call belongs to the still-running root; counts alone never issue an end.
    assert.equal(held.scope.state, 'open'); assert.ok(Number.isSafeInteger(held.scope.pendingOperations) && held.scope.pendingOperations >= 0);
    assert.deepEqual(held.scope, held.attempt.scope); assert.match(held.recordId, /^h45actionhandoff1:[a-f0-9]{64}$/);
    assert.equal(held.request.index, control.chain + '-history-source-admission-v1');
    assert.equal(held.request.id, held.recordId); assert.equal(held.request.document.kind, 'manifest');
    assert.equal(held.request.document.bundle_id, held.recordId); assert.equal(held.request.wait_for_active_shards, 'all');
    assert.equal(held.request.pipeline, '_none'); assert.equal(held.request.refresh, false);
    assert.ok(['create', 'index'].includes(held.method));
    assert.ok(Number.isSafeInteger(held.pid) && held.pid > 0 && Number.isSafeInteger(held.parentPid) && held.parentPid > 0);
    assert.equal(held.response._id, held.recordId); assert.equal(held.response._index, held.request.index);
    assert.equal(held.response.result, held.method === 'create' ? 'created' : 'updated');
    assert.ok(held.response._shards.total === 2 && held.response._shards.failed === 0
        && held.response._shards.successful === held.response._shards.total);
    return held;
}
export function assertWireBrokerHeldReceipt(control, held) {
    assert.equal(held.redelivered, false); return assertWireBrokerHandoffReceipt(control, held);
}
/** Record the original cut or observe a later real transport return without replacing it. */
export function recordWireBrokerHandoffReceipt(control, receipt, record) {
    const file = join(directory(control), 'held-receipt.json');
    const original = () => {
        try {return JSON.parse(boundedRecoveryFile(file, 128 * 1024).toString());}
        catch (error) {if (error.code === 'ENOENT') return undefined; throw error;}
    };
    const subsequent = prior => {
        // Validate the retained cut, not the new response. Its original store still validates that response.
        assertWireBrokerHeldReceipt(control, prior);
        record('handoff-retry-receipt-returned', receipt); return 'subsequent';
    };
    const prior = original(); if (prior !== undefined) return subsequent(prior);
    try {
        durableRecoveryFile(file, assertWireBrokerHeldReceipt(control, receipt));
        return 'original';
    } catch (error) {
        if (error.code === 'EEXIST') return subsequent(original());
        throw error;
    }
}
export function releaseWireBrokerReceipt(control) {
    assert.ok(controls.has(control), 'unissued broker recovery control');
    durableRecoveryFile(join(directory(control), 'release-receipt.json'), {runId: control.runId,
        controlSha256: wireBrokerRecoveryDigest(control), at: Date.now()});
}
/** No AbortSignal or cancellation race: the original awaited receipt remains owned until release/owner exit. */
export async function awaitWireBrokerReceiptRelease(control) {
    for (;;) {
        let release;
        try {release = JSON.parse(boundedRecoveryFile(join(directory(control), 'release-receipt.json'), 16384).toString());}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
        if (release) {
            assert.equal(release.runId, control.runId); assert.equal(release.controlSha256, wireBrokerRecoveryDigest(control));
            return;
        }
        await pause(50);
    }
}
/** The selected DS receipt stays pending; every other queue must drain before the original oracles run. */
export function assertWireBrokerHeldQueues(chain, rows) {
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/);
    assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 4096);
    assert.equal(new Set(rows.map(row => row.name)).size, rows.length);
    const held = rows.filter(row => row.name === chain + ':ds_pool:1'); assert.equal(held.length, 1);
    const source = rows.filter(row => row.name === chain + ':live_blocks'); assert.equal(source.length, 1);
    assert.equal(source[0].delivered, 33); assert.equal(source[0].ack, 33);
    for (const row of rows) {
        assert.ok(row.name.startsWith(chain + ':')); assert.equal(row.ready, 0);
        if (row === held[0]) {
            assert.equal(row.consumers, 1); assert.ok(Number.isSafeInteger(row.unacked) && row.unacked > 0);
            assert.equal(row.messages, row.unacked);
        } else {assert.equal(row.unacked, 0); assert.equal(row.messages, 0);}
    }
}
/** Read actual master observations and retained records; this issues no runtime evidence or ACK settlement. */
export async function auditWireBrokerAttemptRecovery({control, masterPid, store}) {
    describeIssuedWireBrokerControl(control);
    const {held, events} = readWireBrokerRecoveryEvidence(control);
    assertWireBrokerHeldReceipt(control, held); assert.equal(held.parentPid, masterPid);
    const one = (event, predicate) => {
        const rows = events.filter(row => row.event === event && predicate(row));
        assert.equal(rows.length, 1, 'expected one actual broker recovery ' + event); return rows[0];
    };
    const old = row => row.pid === held.pid && (row.attemptId ?? row.attempt?.attemptId) === held.attempt.attemptId;
    const cut = one('handoff-receipt-held', old), fence = one('held-attempt-fenced', old), release = one('handoff-receipt-released', old);
    assert.ok(cut.sequence < fence.sequence && fence.sequence < release.sequence);
    assert.equal(fence.returned, false); assert.equal(fence.scope.state, 'fenced'); assert.equal(fence.attempt.masterEnd, null);
    assert.equal(release.returned, false); assert.equal(release.ownerCurrent, false);
    assert.ok(events.some(row => row.event === 'channel-close' && row.pid === held.pid
        && row.sequence > fence.sequence && row.sequence < release.sequence));
    assert.equal(events.filter(row => row.pid === held.pid && ['fresh-observation-attempt', 'ack-intent', 'ack-sent'].includes(row.event)).length, 0);
    const original = one('end', row => row.pid === masterPid && row.end.attemptId === held.attempt.attemptId).end;
    assert.equal(original.role, held.role);
    assert.equal(original.status, 'quiescent'); assert.equal(original.rootResult, 'threw');
    assert.equal(original.acknowledgementAttempted, false); assert.equal(original.freshWriteOverflow, false);
    assert.deepEqual(original.freshWrites, []); assert.deepEqual(original.binding, held.attempt.binding);
    assert.deepEqual(original.descriptor, held.attempt.descriptor);
    const unresolved = one('adjudicated', row => row.pid === masterPid && row.end.attemptId === original.attemptId);
    assert.deepEqual(unresolved.end, original); assert.deepEqual(unresolved.result, {state: 'unresolved'});
    const originalId = wireRecoveryAssociationId(original);
    await assert.rejects(() => store.readAttemptAssociation(originalId), error => error.name === 'ImmutableProtocolBundleReadError'
        && error.code === 'missing' && error.recordId === originalId);
    const retry = one('ack-sent', row => row.pid !== held.pid && row.admissionId === held.admissionId && row.traceOrdinal === control.traceOrdinal);
    assert.equal(retry.redelivered, true); assert.equal(retry.parentPid, masterPid); assert.equal(retry.workerId, held.workerId);
    assert.equal(new Set([masterPid, held.pid, retry.pid]).size, 3);
    assert.equal(retry.payloadSha256, held.payloadSha256); assert.deepEqual(retry.attempt.binding, original.binding);
    assert.equal(retry.attempt.mode, 'managed'); assert.equal(retry.attempt.masterEnd, null);
    const sameRetry = row => row.pid === retry.pid && row.attempt?.attemptId === retry.attempt.attemptId;
    const receipt = one('handoff-retry-receipt-returned', sameRetry);
    assertWireBrokerHandoffReceipt(control, receipt); assert.equal(receipt.redelivered, true);
    assert.equal(receipt.parentPid, masterPid); assert.equal(receipt.workerId, held.workerId);
    assert.equal(receipt.method, 'index'); assert.equal(receipt.recordId, held.recordId);
    assert.deepEqual(receipt.request.document, held.request.document);
    assert.ok(Number.isSafeInteger(receipt.request.if_seq_no) && receipt.request.if_seq_no >= 0);
    assert.ok(Number.isSafeInteger(receipt.request.if_primary_term) && receipt.request.if_primary_term > 0);
    assert.deepEqual(receipt.attempt.descriptor, retry.attempt.descriptor);
    assert.deepEqual(receipt.attempt.binding, retry.attempt.binding);
    const observed = one('fresh-observation-return', row => sameRetry(row) && row.recordId === held.recordId);
    assert.deepEqual(observed.attempt.descriptor, retry.attempt.descriptor); assert.deepEqual(observed.attempt.binding, retry.attempt.binding);
    assert.equal(observed.accepted, true); assert.ok(receipt.sequence < observed.sequence && observed.sequence < retry.sequence);
    const result = one('adjudicated', row => row.pid === masterPid && row.end.attemptId === retry.attempt.attemptId);
    const end = one('end', row => row.pid === masterPid && row.end.attemptId === retry.attempt.attemptId).end;
    assert.deepEqual(result.end, end); assert.equal(result.result.state, 'associated');
    assert.notEqual(end.attemptId, original.attemptId); assert.notEqual(end.incarnation, original.incarnation);
    assert.equal(end.epoch, original.epoch); assert.deepEqual(end.binding, original.binding);
    assert.deepEqual(end.descriptor, retry.attempt.descriptor);
    assert.equal(end.descriptor.headersSha256, original.descriptor.headersSha256);
    for (const key of ['receiptId', 'consumerId', 'publisherId']) assert.notEqual(end.descriptor[key], original.descriptor[key]);
    const sourceReadback = await auditWireRecoveryEnd(control, end, store);
    assert.equal(sourceReadback.recordId, held.recordId);
    assert.equal(result.result.id, wireRecoveryAssociationId(end));
    const saved = await store.readAttemptAssociation(result.result.id);
    assert.deepEqual(saved.observation.end, end); assert.equal(saved.observation.sourceChecked, true);
    assert.equal(saved.observation.brokerSettlement, 'unknown');
    assert.deepEqual(saved.observation.results, [{id: held.recordId, classification: 'confirmed-handoff'}]);
    const audit = Object.freeze({outcome: 'owned-broker-restart-attempt-readback', originalEnd: original, retry, receipt,
        end, association: saved, sourceReadback, brokerSettlement: 'unknown', releaseQualified: false, capacityAcceptance: false});
    publicationMembership.set(audit, Object.freeze({...end.binding, owners: Object.freeze([held.pid, retry.pid])}));
    return audit;
}
/** Only the completed readback can identify duplicate publications for this exact original transaction. */
export function wireBrokerRecoveryPublicationOwners(receipt, context) {
    if (receipt === undefined) return undefined;
    const membership = publicationMembership.get(receipt); assert.ok(membership, 'unissued broker recovery publication evidence');
    return ['admissionId', 'planId', 'traceOrdinal', 'blockNum', 'blockId'].every(key => context[key] === membership[key])
        ? membership.owners : undefined;
}
/** Read-only counters are scoped to their observed process incarnation, never reconstructed as one broker total. */
export function auditWireBrokerSourceCounterWindows({chain, through, restart, before, after}) {
    assert.match(chain, /^hyp-p191-[a-f0-9]{12}$/); assert.ok(Number.isSafeInteger(through) && through > 33 && through <= 1480);
    assert.equal(restart.kind, 'owned-wire-broker-restart-observed');
    assert.equal(restart.before.broker.containerId, restart.after.broker.containerId);
    assert.notEqual(restart.before.broker.startedAt, restart.after.broker.startedAt);
    assert.ok(restart.before.process.pid !== restart.after.process.pid || restart.before.process.startTicks !== restart.after.process.startTicks);
    const window = (rows, identity, expected) => {
        assert.ok(rows.length > 0 && rows.length <= 4096);
        const selected = rows.filter(row => row.name === chain + ':live_blocks'); assert.equal(selected.length, 1);
        const row = selected[0];
        assert.equal(row.ack, expected); assert.equal(row.delivered, expected); assert.equal(row.redelivered, 0);
        assert.equal(row.ready, 0); assert.equal(row.unacked, 0); assert.equal(row.messages, 0);
        return {containerId: identity.broker.containerId, startedAt: identity.broker.startedAt,
            process: identity.process, expectedDeliveries: expected, sourceQueue: structuredClone(row)};
    };
    return {before: window(before, restart.before, 33), after: window(after, restart.after, through - 33),
        brokerSettlement: 'unknown', sourceAuthority: false, capacityAcceptance: false};
}
