/** Qualification-only custody oracle for one real Wire worker exit and broker redelivery. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

export const wireRecoveryExitCode = 86;
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const publicationMembership = new WeakMap();
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function bounded(file, maximum) {
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum, 'invalid recovery evidence file');
    const bytes = readFileSync(file); assert.equal(bytes.length, stat.size); return bytes;
}
function durableNew(file, value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    assert.ok(bytes.length <= 128 * 1024, 'recovery marker exceeds bound');
    const fd = openSync(file, 'wx');
    try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
    if (process.platform !== 'win32') {
        const directory = openSync(dirname(file), 'r');
        try {fsyncSync(directory);} finally {closeSync(directory);}
    }
}
export function createWireRecoveryControl({output, configFile, chain, source, frameSha256}) {
    assert.equal(realpathSync(output), resolve(output)); assert.equal(resolve(configFile), join(output, 'chain.json'));
    assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
    assert.equal(source.chainId, chainId); assert.equal(source.profileId, profileId); assert.equal(source.endBlock, 1480);
    assert.match(frameSha256, /^[0-9a-f]{64}$/);
    const directory = join(output, 'attempt-recovery'); mkdirSync(directory);
    const control = {schemaVersion: 1, runId: randomUUID(), output, configFile, chain, chainId, profileId,
        blockNum: 33, blockId: source.records[32].blockId, frameSha256,
        configSha256: sha(bounded(configFile, 1024 * 1024)), exitCode: wireRecoveryExitCode};
    const file = join(directory, 'control.json'); durableNew(file, control); return {file, control};
}
export function readWireRecoveryControl(file, {observerDirectory, configFile, chain}) {
    const observer = realpathSync(observerDirectory), output = dirname(dirname(observer));
    assert.equal(observer, join(output, 'observer', 'master'));
    assert.equal(resolve(file), join(output, 'attempt-recovery', 'control.json'));
    assert.equal(realpathSync(dirname(file)), dirname(resolve(file)));
    const control = JSON.parse(bounded(file, 16384).toString());
    assert.equal(control.schemaVersion, 1); assert.match(control.runId, /^[a-f0-9-]{36}$/);
    assert.equal(control.output, output); assert.equal(control.chain, chain); assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
    assert.equal(control.configFile, resolve(configFile)); assert.equal(control.configFile, join(output, 'chain.json'));
    assert.equal(control.configSha256, sha(bounded(configFile, 1024 * 1024)));
    assert.equal(control.chainId, chainId); assert.equal(control.profileId, profileId);
    assert.equal(control.blockNum, 33); assert.match(control.blockId, /^[0-9a-f]{64}$/);
    assert.match(control.frameSha256, /^[0-9a-f]{64}$/); assert.equal(control.exitCode, wireRecoveryExitCode);
    const config = JSON.parse(bounded(configFile, 1024 * 1024).toString());
    assert.equal(config.settings.chain, chain); assert.equal(config.settings.protocol.profileId, profileId);
    assert.equal(config.settings.protocol_abi_coordination?.recovery_window_blocks, undefined);
    return control;
}
export function createWireRecoveryRecorder(control) {
    let fd, bytes = 0, sequence = 0;
    return (event, value) => {
        const line = Buffer.from(JSON.stringify({event, ...value, sequence: ++sequence,
            runId: control.runId, pid: process.pid, parentPid: process.ppid, at: Date.now()}) + '\n');
        bytes += line.length;
        assert.ok(sequence <= 4096 && bytes <= 8 * 1024 * 1024, 'recovery observer budget exceeded');
        fd ??= openSync(join(control.output, 'attempt-recovery', 'process-' + process.pid + '.jsonl'), 'wx');
        writeFileSync(fd, line); fsyncSync(fd);
    };
}
/** A single exclusive marker lets the normal master replace the worker; later deliveries never exit. */
export function exitWireWorkerBeforeAck(control, snapshot) {
    assert.equal(snapshot.role, 'ds_pool_worker'); assert.equal(snapshot.source.blockNum, control.blockNum);
    assert.equal(snapshot.source.blockId, control.blockId); assert.equal(snapshot.source.chainId, control.chainId);
    assert.equal(snapshot.originalFrameSha256, control.frameSha256); assert.equal(snapshot.redelivered, false);
    assert.equal(snapshot.attempt.mode, 'managed'); assert.equal(snapshot.attempt.masterEnd, null);
    assert.match(snapshot.freshId, /^h45actionhandoff1:[a-f0-9]{64}$/);
    assert.equal(snapshot.attempt.descriptor.payloadSha256, snapshot.payloadSha256);
    try {durableNew(join(control.output, 'attempt-recovery', 'fault.json'), {schemaVersion: 1, runId: control.runId,
        controlSha256: sha(Buffer.from(JSON.stringify(control))), ...snapshot,
        pid: process.pid, parentPid: process.ppid, at: Date.now(), exitCode: wireRecoveryExitCode});}
    catch (error) {if (error.code === 'EEXIST') return false; throw error;}
    process.exit(wireRecoveryExitCode);
}
export function readWireRecoveryEvidence(control) {
    const directory = join(control.output, 'attempt-recovery');
    const names = readdirSync(directory);
    assert.ok(names.length <= 66 && names.every(name => ['control.json', 'fault.json'].includes(name)
        || /^process-[1-9][0-9]*\.jsonl$/.test(name)), 'unowned recovery file');
    const marker = JSON.parse(bounded(join(directory, 'fault.json'), 128 * 1024).toString()), events = [];
    let bytes = 0;
    for (const name of names.filter(name => name.startsWith('process-'))) {
        const contents = bounded(join(directory, name), 8 * 1024 * 1024); bytes += contents.length;
        assert.ok(bytes <= 64 * 1024 * 1024); assert.equal(contents.at(-1), 10, 'truncated recovery observation');
        const rows = contents.toString().trimEnd().split('\n').map(line => JSON.parse(line));
        for (const [index, row] of rows.entries()) {
            assert.equal(row.sequence, index + 1); assert.equal(row.pid, Number(name.slice(8, -6)));
            assert.equal(row.runId, control.runId); events.push(row);
        }
    }
    return {marker, events};
}
export async function auditWireAttemptRecovery({control, marker, events, queues, masterPid, store}) {
    assert.equal(marker.runId, control.runId); assert.equal(marker.parentPid, masterPid);
    assert.equal(marker.controlSha256, sha(Buffer.from(JSON.stringify(control))));
    assert.equal(marker.exitCode, wireRecoveryExitCode); assert.equal(marker.source.blockNum, 33);
    assert.equal(marker.source.blockId, control.blockId); assert.equal(marker.source.chainId, control.chainId);
    assert.equal(marker.originalFrameSha256, control.frameSha256);
    const original = events.filter(row => row.event === 'end' && row.pid === masterPid
        && row.end.attemptId === marker.attempt.attemptId);
    assert.equal(original.length, 1, 'actual master must observe one unresolved original physical end');
    const ended = original[0].end;
    assert.equal(ended.status, 'process-exited-unresolved'); assert.equal(ended.rootResult, 'unknown');
    assert.equal(ended.acknowledgementAttempted, null);
    assert.deepEqual(ended.descriptor, marker.attempt.descriptor);
    assert.deepEqual(ended.binding, marker.attempt.binding);
    assert.equal(ended.freshWrites.length, 1); assert.equal(ended.freshWrites[0].id, marker.freshId);
    const originalResults = events.filter(row => row.event === 'adjudicated' && row.end.attemptId === ended.attemptId);
    assert.equal(originalResults.length, 1); assert.deepEqual(originalResults[0].result, {state: 'unresolved'});
    const originalId = 'h45actionassociation1:' + sha(JSON.stringify([ended.epoch, ended.incarnation, ended.attemptId]));
    await assert.rejects(() => store.readAttemptAssociation(originalId),
        error => error.name === 'ImmutableProtocolBundleReadError' && error.code === 'missing' && error.recordId === originalId);
    assert.equal(events.filter(row => row.event === 'ack-sent' && row.pid === marker.pid).length, 0);
    const retries = events.filter(row => row.event === 'ack-sent' && row.pid !== marker.pid
        && row.payloadSha256 === marker.payloadSha256 && row.admissionId === marker.admissionId
        && row.traceOrdinal === marker.traceOrdinal && row.redelivered === true);
    assert.equal(retries.length, 1, 'one actual broker redelivery must ACK through the replacement worker');
    const retry = retries[0];
    assert.equal(retry.parentPid, masterPid); assert.equal(retry.workerId, marker.workerId);
    assert.ok([marker.pid, retry.pid, masterPid].every(pid => Number.isSafeInteger(pid) && pid > 0));
    assert.equal(new Set([marker.pid, retry.pid, masterPid]).size, 3);
    const replacements = events.filter(row => row.event === 'adjudicated' && row.pid === masterPid
        && row.end.attemptId === retry.attempt.attemptId && row.result.state === 'associated');
    assert.equal(replacements.length, 1, 'replacement needs its own real master adjudication');
    const replacement = replacements[0], fresh = replacement.end;
    assert.equal(fresh.status, 'quiescent'); assert.equal(fresh.rootResult, 'returned'); assert.equal(fresh.acknowledgementAttempted, true);
    assert.notEqual(fresh.attemptId, ended.attemptId); assert.notEqual(fresh.incarnation, ended.incarnation);
    assert.equal(fresh.epoch, ended.epoch); assert.equal(fresh.role, ended.role);
    assert.equal(fresh.freshWriteOverflow, false);
    assert.equal(fresh.descriptor.payloadSha256, ended.descriptor.payloadSha256);
    assert.equal(fresh.descriptor.headersSha256, ended.descriptor.headersSha256);
    for (const key of ['receiptId', 'consumerId', 'publisherId']) assert.notEqual(fresh.descriptor[key], ended.descriptor[key]);
    assert.deepEqual(fresh.binding, ended.binding);
    assert.deepEqual(fresh.freshWrites, ended.freshWrites, 'same semantic handoff needs a fresh acknowledged write in the replacement');
    const saved = await store.readAttemptAssociation(replacement.result.id);
    assert.deepEqual(saved.observation.end, fresh); assert.equal(saved.observation.brokerSettlement, 'unknown');
    assert.deepEqual(saved.observation.results, [{id: marker.freshId, classification: 'confirmed-handoff'}]);
    const queue = queues.find(row => row.name === control.chain + ':ds_pool:1');
    assert.ok(queue && queue.redelivered >= 1 && queue.ready === 0 && queue.unacked === 0);
    assert.equal(queue.delivered, queue.ack + queue.redelivered, 'broker ACK accounting must include every real redelivery');
    const receipt = Object.freeze({schemaVersion: 1, outcome: 'real-worker-exit-and-redelivery', marker, originalEnd: ended,
        replacement: retry, association: saved, broker: queue,
        releaseQualified: false, parentRestartQualified: false, forkQualified: false, fullReplayQualified: false});
    publicationMembership.set(receipt, Object.freeze({admissionId: marker.admissionId, planId: ended.binding.planId,
        traceOrdinal: marker.traceOrdinal, blockNum: marker.source.blockNum, blockId: marker.source.blockId,
        owners: Object.freeze([marker.pid, retry.pid])}));
    return receipt;
}
/** Only this run's completed recovery audit can declare the two expected publication owners. */
export function wireRecoveryPublicationOwners(receipt, context) {
    if (receipt === undefined) return undefined;
    const membership = publicationMembership.get(receipt);
    assert.ok(membership, 'unissued worker recovery publication evidence');
    return ['admissionId', 'planId', 'traceOrdinal', 'blockNum', 'blockId'].every(key => context[key] === membership[key])
        ? membership.owners : undefined;
}
/** Validate every raw exit before making a detached view for the existing zero-failure shutdown oracle. */
export function wireRecoveryShutdownRows(rows, marker, masterPid, exitCode, signal) {
    assert.equal(marker.parentPid, masterPid); assert.equal(exitCode, 1); assert.equal(signal, null);
    const shutdowns = rows.filter(row => row.kind === 'shutdown' && row.pid === masterPid);
    assert.equal(shutdowns.length, 1); const shutdown = shutdowns[0];
    assert.equal(shutdown.success, false); assert.deepEqual(shutdown.forced, []); assert.deepEqual(shutdown.unresolved, []);
    assert.equal(shutdown.children, shutdown.exited);
    assert.deepEqual(shutdown.failedChildren.map(row => ({pid: row.pid, code: row.code, signal: row.signal})),
        [{pid: marker.pid, code: wireRecoveryExitCode, signal: null}]);
    const starts = rows.filter(row => row.kind === 'start');
    const forks = rows.filter(row => row.kind === 'worker_fork');
    const expected = new Set([masterPid, ...forks.map(row => row.childPid)]);
    assert.equal(expected.size, forks.length + 1); assert.equal(starts.length, expected.size);
    assert.equal(new Set(starts.map(row => row.pid)).size, starts.length);
    for (const start of starts) {
        assert.ok(expected.has(start.pid), 'untracked recovery process');
        if (start.pid !== masterPid) assert.equal(start.parentPid, forks.find(row => row.childPid === start.pid)?.pid);
    }
    assert.equal(rows.filter(row => row.kind === 'exit').length, starts.length);
    assert.equal(rows.filter(row => row.kind === 'worker_exit').length, forks.length);
    assert.equal(starts.filter(row => row.pid === marker.pid && row.parentPid === masterPid && row.role === 'ds_pool_worker').length, 1);
    assert.equal(rows.filter(row => row.kind === 'worker_exit' && row.childPid === marker.pid
        && row.code === wireRecoveryExitCode && row.signal === null).length, 1);
    assert.equal(rows.filter(row => ['observer_error', 'shutdown_force_child', 'shutdown_late_child'].includes(row.kind)).length, 0);
    for (const start of starts) {
        const exits = rows.filter(row => row.kind === 'exit' && row.pid === start.pid); assert.equal(exits.length, 1);
        assert.equal(exits[0].code, start.pid === marker.pid ? wireRecoveryExitCode : start.pid === masterPid ? 1 : 0);
        assert.equal(exits[0].droppedRecords, 0);
        assert.equal(exits[0].profileState, 'disabled');
        const childExit = shutdown.childExits.filter(row => row.pid === start.pid);
        if (start.pid !== masterPid) {
            assert.equal(childExit.length, 1); assert.equal(childExit[0].code, start.pid === marker.pid ? wireRecoveryExitCode : 0);
            assert.equal(childExit[0].signal, null);
        }
        if (start.pid !== marker.pid) {
            const flushes = rows.filter(row => row.kind === 'flush' && row.pid === start.pid); assert.equal(flushes.length, 1);
            assert.equal(flushes[0].success, true); assert.equal(flushes[0].droppedRecords, 0);
        }
    }
    const verified = copy(rows);
    for (const row of verified) {
        if (row.kind === 'exit' && [marker.pid, masterPid].includes(row.pid)) row.code = 0;
        if (row.kind === 'worker_exit' && row.childPid === marker.pid) row.code = 0;
        if (row.kind === 'shutdown' && row.pid === masterPid) {
            row.success = true; row.failedChildren = [];
            row.childExits.find(child => child.pid === marker.pid).code = 0;
        }
    }
    return verified;
}
