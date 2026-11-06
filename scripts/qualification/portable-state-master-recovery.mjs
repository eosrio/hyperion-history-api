/** Owned Wire master crash/relaunch observations. These receipts authorize fixture replay only. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {boundedRecoveryFile, durableRecoveryFile, createRecoveryRecorder, readRecoveryRecords} from './recovery-custody.mjs';
import {captureOwnedMasterGroup, terminateOwnedMasterGroup, describeOwnedMasterGroupExit} from './owned-master-process-group.mjs';
import {actionHistoryImmutableJson} from '../../build/indexer/history/action-history-manifest.js';
import {assertWireRecoveryEnd as selectedEnd, auditWireRecoveryEnd as durableEnd} from './wire-recovery-end-audit.mjs';

const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const controls = new WeakSet(), crashes = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(actionHistoryImmutableJson(value));
const associationId = end => 'h45actionassociation1:' + digest([end.epoch, end.incarnation, end.attemptId]);
const directory = control => join(control.output, 'master-recovery');
const missingAssociation = (store, end) => assert.rejects(() => store.readAttemptAssociation(associationId(end)),
    error => error.name === 'ImmutableProtocolBundleReadError' && error.code === 'missing' && error.recordId === associationId(end));

export function createWireMasterRestartControl({output, configFile, chain, source, frameSha256, resumeFrameSha256}) {
    assert.equal(realpathSync(output), resolve(output)); assert.equal(resolve(configFile), join(output, 'chain.json'));
    assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
    assert.equal(source.chainId, chainId); assert.equal(source.profileId, profileId); assert.equal(source.endBlock, 1480);
    assert.match(frameSha256, /^[0-9a-f]{64}$/);
    assert.match(resumeFrameSha256, /^[0-9a-f]{64}$/);
    const config = JSON.parse(boundedRecoveryFile(configFile, 1024 * 1024).toString());
    mkdirSync(join(output, 'master-recovery'));
    const control = Object.freeze({schemaVersion: 1, kind: 'wire-master-restart', runId: randomUUID(), output, configFile, chain,
        chainId, profileId, blockNum: 33, blockId: source.records[32].blockId, traceOrdinal: 0, frameSha256,
        resumeBlockNum: 34, resumeBlockId: source.records[33].blockId, resumeFrameSha256,
        configSha256: hash(boundedRecoveryFile(configFile, 1024 * 1024)), masterTitle: `${config.settings.process_prefix || 'hyp'}-${chain}-master`});
    const file = join(directory(control), 'control.json'); durableRecoveryFile(file, control); controls.add(control);
    return {file, control};
}
export function readWireMasterRestartControl(file, {observerDirectory, configFile, chain, phase}) {
    assert.ok(['before', 'after'].includes(phase));
    const observer = realpathSync(observerDirectory), output = dirname(dirname(observer));
    assert.equal(observer, join(output, 'observer', phase === 'before' ? 'master' : 'master-restarted'));
    assert.equal(resolve(file), join(output, 'master-recovery', 'control.json'));
    assert.equal(realpathSync(dirname(file)), dirname(resolve(file)));
    const control = JSON.parse(boundedRecoveryFile(file, 16384).toString());
    assert.equal(control.schemaVersion, 1); assert.equal(control.kind, 'wire-master-restart'); assert.match(control.runId, /^[a-f0-9-]{36}$/);
    assert.equal(control.output, output); assert.equal(control.chain, chain); assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
    assert.equal(control.configFile, resolve(configFile)); assert.equal(control.configFile, join(output, 'chain.json'));
    assert.equal(control.configSha256, hash(boundedRecoveryFile(configFile, 1024 * 1024)));
    assert.equal(control.chainId, chainId); assert.equal(control.profileId, profileId);
    assert.equal(control.blockNum, 33); assert.equal(control.traceOrdinal, 0); assert.match(control.blockId, /^[0-9a-f]{64}$/);
    assert.match(control.frameSha256, /^[0-9a-f]{64}$/);
    assert.equal(control.resumeBlockNum, 34); assert.match(control.resumeBlockId, /^[0-9a-f]{64}$/);
    assert.match(control.resumeFrameSha256, /^[0-9a-f]{64}$/);
    const config = JSON.parse(boundedRecoveryFile(configFile, 1024 * 1024).toString());
    assert.equal(config.settings.chain, chain); assert.equal(config.settings.protocol.profileId, profileId);
    assert.equal(control.masterTitle, `${config.settings.process_prefix || 'hyp'}-${chain}-master`);
    assert.equal(config.settings.protocol_abi_coordination?.recovery_window_blocks, undefined);
    return control;
}
export const createWireMasterRecorder = control => createRecoveryRecorder(directory(control), control.runId);
export function holdWireMasterEnd(control, end, workerPid, workerId) {
    selectedEnd(control, end);
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0 && workerPid !== process.pid);
    const marker = {schemaVersion: 1, runId: control.runId, controlSha256: digest(control),
        masterPid: process.pid, parentPid: process.ppid, masterTitle: process.title, workerPid, workerId, end, at: Date.now()};
    try {durableRecoveryFile(join(directory(control), 'held-end.json'), marker); return true;}
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = readWireMasterRestartEvidence(control).marker;
        return previous.masterPid === process.pid && associationId(previous.end) === associationId(end);
    }
}
export function readWireMasterRestartEvidence(control) {
    return {marker: JSON.parse(boundedRecoveryFile(join(directory(control), 'held-end.json'), 128 * 1024).toString()),
        events: readRecoveryRecords(directory(control), control.runId, ['control.json', 'held-end.json'])};
}
export async function inspectWireMasterCheckpoint({control, masterPid, store, queues}) {
    assert.ok(controls.has(control), 'unissued master restart control');
    assert.deepEqual(JSON.parse(boundedRecoveryFile(join(directory(control), 'control.json'), 16384).toString()), control);
    const {marker, events} = readWireMasterRestartEvidence(control);
    assert.equal(marker.schemaVersion, 1); assert.equal(marker.runId, control.runId); assert.equal(marker.controlSha256, digest(control));
    assert.equal(marker.masterPid, masterPid); assert.equal(marker.parentPid, process.pid);
    assert.equal(marker.masterTitle, control.masterTitle);
    const observed = events.filter(row => row.event === 'held' && row.pid === masterPid);
    assert.equal(observed.length, 1); assert.deepEqual(observed[0].end, marker.end); assert.equal(observed[0].workerPid, marker.workerPid);
    assert.equal(events.filter(row => row.event === 'adjudicated' && associationId(row.end) === associationId(marker.end)).length, 0);
    const record = await durableEnd(control, marker.end, store); await missingAssociation(store, marker.end);
    assert.ok(queues.length > 0 && queues.every(row => row.name.startsWith(control.chain + ':')
        && row.ready === 0 && row.unacked === 0 && row.messages === 0 && row.redelivered === 0));
    const sourceQueue = queues.find(row => row.name === control.chain + ':live_blocks'), dsQueue = queues.find(row => row.name === control.chain + ':ds_pool:1');
    assert.ok(sourceQueue && dsQueue); assert.equal(sourceQueue.delivered, 33); assert.equal(sourceQueue.ack, 33);
    assert.ok(dsQueue.delivered > 0); assert.equal(dsQueue.delivered, dsQueue.ack);
    return {marker, record, associationId: associationId(marker.end), brokerCounters: {source: sourceQueue, ds: dsQueue}, brokerSettlement: 'unknown'};
}
export async function crashWireMaster({control, child, rows, store, queues}) {
    const checkpoint = await inspectWireMasterCheckpoint({control, masterPid: child.pid, store, queues});
    const token = captureOwnedMasterGroup(child, control.output, rows, control.masterTitle);
    // The original callback's physical owner must be in this exact, currently live process group.
    assert.equal(rows.filter(row => row.kind === 'start' && row.pid === checkpoint.marker.workerPid
        && row.parentPid === child.pid && row.role === 'ds_pool_worker').length, 1);
    const exit = await terminateOwnedMasterGroup(token), fence = describeOwnedMasterGroupExit(exit);
    assert.ok(fence.members.some(value => value.pid === checkpoint.marker.workerPid));
    const receipt = Object.freeze({schemaVersion: 1, kind: 'wire-master-crash-observed', runId: control.runId});
    crashes.set(receipt, {control, checkpoint: structuredClone(checkpoint), fence: structuredClone(fence)}); return receipt;
}
export function describeWireMasterCrash(receipt) {
    const value = crashes.get(receipt); assert.ok(value, 'unissued Wire master crash receipt');
    return structuredClone(value);
}
/** Resume uses the coordinator's next block; no old physical event can substitute for the new epoch. */
export function wireMasterResumedEvents(receipt, newMasterPid, events) {
    const {control, fence} = describeWireMasterCrash(receipt);
    assert.ok(Number.isSafeInteger(newMasterPid) && newMasterPid > 0 && newMasterPid !== fence.root.pid);
    const starts = events.filter(row => row.kind === 'start');
    assert.equal(new Set(starts.map(row => row.pid)).size, starts.length);
    assert.equal(starts.filter(row => row.pid === newMasterPid && row.parentPid === fence.root.parentPid).length, 1);
    const group = root => new Set([root, ...starts.filter(row => row.parentPid === root).map(row => row.pid)]);
    const before = group(fence.root.pid), after = group(newMasterPid);
    assert.ok([...before].every(pid => !after.has(pid)));
    for (const event of events.filter(row => row.kind === 'native_boundary' && row.blockNum === control.resumeBlockNum))
        assert.ok(after.has(event.pid), 'old or unowned native event in the resumed block');
    const current = events.filter(row => after.has(row.pid));
    assert.ok(current.some(row => row.kind === 'native_boundary'
        && row.event === 'native_prepare_readback' && row.blockNum === control.resumeBlockNum));
    return current;
}
export async function auditWireMasterRestart({receipt, newMasterPid, rows, store, queues}) {
    const {control, checkpoint, fence} = describeWireMasterCrash(receipt), old = checkpoint.marker.end;
    assert.ok(Number.isSafeInteger(newMasterPid) && newMasterPid > 0 && newMasterPid !== fence.root.pid);
    const {events} = readWireMasterRestartEvidence(control);
    const probes = events.filter(row => row.event === 'prior-end-probe' && row.pid === newMasterPid);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].oldAssociationId, associationId(old)); assert.equal(probes[0].outcome, 'rejected');
    assert.equal(probes[0].error?.name, 'Error'); assert.equal(probes[0].error.message, 'Unissued or foreign worker end evidence');
    const associated = events.filter(row => row.event === 'adjudicated' && row.pid === newMasterPid
        && row.end.binding.blockNum === control.resumeBlockNum && row.end.binding.traceOrdinal === control.traceOrdinal
        && row.result.state === 'associated');
    assert.equal(associated.length, 1); const current = associated[0], fresh = current.end;
    assert.notEqual(fresh.epoch, old.epoch); assert.notEqual(fresh.incarnation, old.incarnation); assert.notEqual(fresh.attemptId, old.attemptId);
    assert.equal(probes[0].newEpoch, fresh.epoch);
    const ends = events.filter(row => row.event === 'end' && row.pid === newMasterPid && associationId(row.end) === associationId(fresh));
    assert.equal(ends.length, 1); assert.deepEqual(ends[0].end, fresh);
    const newWorker = ends[0].workerPid; assert.ok(!fence.members.some(value => value.pid === newWorker));
    assert.equal(rows.filter(row => row.kind === 'start' && row.pid === newWorker && row.parentPid === newMasterPid
        && row.role === 'ds_pool_worker').length, 1);
    const retained = await durableEnd(control, old, store), replacement = await durableEnd(control, fresh, store, true);
    assert.deepEqual(retained, checkpoint.record); assert.notEqual(replacement.admissionId, retained.admissionId);
    await missingAssociation(store, old);
    const saved = await store.readAttemptAssociation(current.result.id);
    assert.equal(saved.id, associationId(fresh)); assert.deepEqual(saved.observation.end, fresh);
    assert.equal(saved.observation.brokerSettlement, 'unknown'); assert.equal(saved.observation.sourceChecked, true);
    assert.deepEqual(saved.observation.results, [{id: fresh.freshWrites[0].id, classification: 'confirmed-handoff'}]);
    assert.ok(queues.length > 0 && queues.every(row => row.name.startsWith(control.chain + ':')
        && row.ready === 0 && row.unacked === 0 && row.messages === 0 && row.redelivered === 0));
    const sourceQueue = queues.find(row => row.name === control.chain + ':live_blocks'), dsQueue = queues.find(row => row.name === control.chain + ':ds_pool:1');
    assert.ok(sourceQueue && dsQueue); assert.equal(sourceQueue.delivered, 34); assert.equal(sourceQueue.ack, 34);
    assert.ok(dsQueue.delivered > checkpoint.brokerCounters.ds.delivered); assert.equal(dsQueue.delivered, dsQueue.ack);
    return {kind: 'production-master-restart-observed', checkpoint, fence, newMasterPid, newWorkerPid: newWorker,
        rejectedPriorEnd: probes[0], replacementRecord: replacement, association: saved, brokerCounters: {source: sourceQueue, ds: dsQueue},
        brokerSettlement: 'unknown', fullReplayQualified: false, forkQualified: false};
}
