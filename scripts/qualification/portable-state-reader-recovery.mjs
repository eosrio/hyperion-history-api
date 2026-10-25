/** Owned, same-master reader handover. Receipts grant fixture sequencing only, never runtime capacity. */
import assert from 'node:assert/strict';
import {ChildProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, readlinkSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {boundedRecoveryFile, durableRecoveryFile, createRecoveryRecorder, readRecoveryRecords} from './recovery-custody.mjs';
import {parseLinuxProcessStat} from './owned-master-process-group.mjs';
import {actionHistoryImmutableJson} from '../../build/indexer/history/action-history-manifest.js';
import {assertWireRecoveryEnd, auditWireRecoveryEnd, wireRecoveryAssociationId} from './wire-recovery-end-audit.mjs';

const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const controls = new WeakSet(), snapshots = new WeakMap(), crashes = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(actionHistoryImmutableJson(value));
const directory = control => join(control.output, 'reader-recovery');
const uuid = /^[0-9a-f-]{36}$/, hex = /^[0-9a-f]{64}$/;

export function createWireReaderRecoveryControl({output, configFile, chain, source, frameSha256, resumeFrameSha256}) {
    assert.equal(realpathSync(output), resolve(output)); assert.equal(resolve(configFile), join(output, 'chain.json'));
    assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/); assert.equal(source.chainId, chainId);
    assert.equal(source.profileId, profileId); assert.equal(source.endBlock, 1480);
    assert.match(frameSha256, hex); assert.match(resumeFrameSha256, hex);
    const config = JSON.parse(boundedRecoveryFile(configFile, 1024 * 1024).toString());
    mkdirSync(join(output, 'reader-recovery'));
    const control = Object.freeze({schemaVersion: 1, kind: 'wire-reader-handover', runId: randomUUID(), output, configFile, chain,
        chainId, profileId, blockNum: 33, blockId: source.records[32].blockId, traceOrdinal: 0, frameSha256,
        resumeBlockNum: 34, resumeBlockId: source.records[33].blockId, resumeFrameSha256,
        configSha256: hash(boundedRecoveryFile(configFile, 1024 * 1024)),
        titlePrefix: `${config.settings.process_prefix || 'hyp'}-${chain}`, readerRole: 'continuous_reader'});
    const file = join(directory(control), 'control.json'); durableRecoveryFile(file, control); controls.add(control);
    return {file, control};
}
export function readWireReaderRecoveryControl(file, {observerDirectory, configFile, chain}) {
    const observer = realpathSync(observerDirectory), output = dirname(dirname(observer));
    assert.equal(observer, join(output, 'observer/master')); assert.equal(resolve(file), join(output, 'reader-recovery/control.json'));
    assert.equal(realpathSync(dirname(file)), dirname(resolve(file)));
    const control = JSON.parse(boundedRecoveryFile(file, 16384).toString());
    assert.equal(control.schemaVersion, 1); assert.equal(control.kind, 'wire-reader-handover'); assert.match(control.runId, uuid);
    assert.equal(control.output, output); assert.equal(control.chain, chain); assert.match(chain, /^hyp-p191-[0-9a-f]{12}$/);
    assert.equal(control.configFile, resolve(configFile)); assert.equal(control.configFile, join(output, 'chain.json'));
    assert.equal(control.configSha256, hash(boundedRecoveryFile(configFile, 1024 * 1024)));
    assert.equal(control.chainId, chainId); assert.equal(control.profileId, profileId);
    assert.equal(control.blockNum, 33); assert.equal(control.resumeBlockNum, 34); assert.equal(control.traceOrdinal, 0);
    for (const key of ['blockId', 'resumeBlockId', 'frameSha256', 'resumeFrameSha256']) assert.match(control[key], hex);
    const config = JSON.parse(boundedRecoveryFile(configFile, 1024 * 1024).toString());
    assert.equal(config.settings.chain, chain); assert.equal(config.settings.protocol.profileId, profileId);
    assert.equal(control.titlePrefix, `${config.settings.process_prefix || 'hyp'}-${chain}`);
    assert.equal(control.readerRole, 'continuous_reader');
    assert.equal(config.settings.protocol_abi_coordination?.recovery_window_blocks, undefined);
    return control;
}
export const createWireReaderRecorder = control => createRecoveryRecorder(directory(control), control.runId);
export const wireReaderControlDigest = control => digest(control);
export function readWireReaderRecoveryEvidence(control) {
    return {held: JSON.parse(boundedRecoveryFile(join(directory(control), 'held.json'), 128 * 1024).toString()),
        events: readRecoveryRecords(directory(control), control.runId, ['control.json', 'held.json', 'snapshot.json', 'fault.json',
            'held-rpc-response.json', 'old-association-absence.json'])};
}

function birth(pid) {
    try {return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);}
    catch (error) {if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error;}
}
const sameBirth = (a, b) => a && b && a.pid === b.pid && a.startTicks === b.startTicks
    && a.parentPid === b.parentPid && a.group === b.group && a.session === b.session;
function masterIdentity(child, control) {
    assert.equal(process.platform, 'linux'); assert.ok(!process.versions.bun && /^(24|26)\./.test(process.versions.node));
    assert.ok(child instanceof ChildProcess && child.connected && !child.killed);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const current = birth(child.pid); assert.ok(current && current.state !== 'Z');
    assert.equal(current.parentPid, process.pid); assert.equal(current.group, child.pid); assert.equal(current.session, child.pid);
    assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), control.output);
    assert.equal(realpathSync(`/proc/${child.pid}/exe`), realpathSync(process.execPath));
    const command = readFileSync(`/proc/${child.pid}/cmdline`); assert.ok(command.length <= 65536 && command.at(-1) === 0);
    assert.deepEqual(command.toString().split('\0').filter(Boolean), [control.titlePrefix + '-master']);
    return current;
}
function request(child, control, operation, snapshotId) {
    assert.ok(controls.has(control), 'unissued reader recovery control');
    assert.deepEqual(JSON.parse(boundedRecoveryFile(join(directory(control), 'control.json'), 16384).toString()), control);
    const before = masterIdentity(child, control), mId = randomUUID();
    return new Promise((done, reject) => {
        let settled = false;
        const finish = (error, value) => {if (settled) return; settled = true; clearTimeout(timer); child.removeListener('message', onMessage);
            child.removeListener('exit', onExit); child.removeListener('disconnect', onDisconnect); error ? reject(error) : done({mId, value, before});};
        const onExit = () => finish(new Error('Original master exited during reader recovery control'));
        const onDisconnect = () => finish(new Error('Original master disconnected during reader recovery control'));
        const onMessage = message => {
            if (message?.event !== 'qualifier_reader_reply' || message.mId !== mId) return;
            try {
                assert.equal(message.runId, control.runId); assert.equal(message.operation, operation);
                assert.equal(message.pid, child.pid); assert.equal(message.parentPid, process.pid);
                assert.ok(sameBirth(masterIdentity(child, control), before), 'master identity changed during reader reply');
                assert.equal(message.ok, true, typeof message.error === 'string' ? message.error.slice(0, 4096) : 'reader control refused');
                assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 128 * 1024);
                finish(null, message.value);
            } catch (error) {finish(error);}
        };
        const timer = setTimeout(() => finish(new Error('Reader recovery control timed out')), 5000);
        child.on('message', onMessage); child.once('exit', onExit); child.once('disconnect', onDisconnect);
        child.send({event: 'qualifier_reader_request', mId, runId: control.runId, operation,
            ...(snapshotId ? {snapshotId} : {})}, error => {if (error) finish(error);});
    });
}
export async function snapshotWireReader({control, child, rows}) {
    const response = await request(child, control, 'snapshot'), value = response.value;
    assert.equal(value.kind, 'held-reader-rpc'); assert.equal(value.masterPid, child.pid);
    assertWireRecoveryEnd(control, value.end);
    assert.match(value.readerSessionId, uuid); assert.match(value.generation, uuid);
    assert.ok(Number.isSafeInteger(value.readBlockNum) && value.readBlockNum >= control.blockNum);
    assert.match(value.response.blockId, hex);
    const fence = value.census, reader = birth(fence.reader.pid);
    assert.equal(fence.directory, control.output); assert.ok(sameBirth(fence.parent, response.before));
    assert.ok(sameBirth(reader, fence.reader), 'original reader changed after its native IPC snapshot');
    assert.equal(reader.parentPid, child.pid); assert.equal(reader.group, child.pid); assert.equal(reader.session, child.pid);
    assert.equal(readlinkSync(`/proc/${reader.pid}/cwd`), control.output);
    assert.equal(realpathSync(`/proc/${reader.pid}/exe`), realpathSync(process.execPath));
    assert.equal(fence.expectedTitle, `${control.titlePrefix}-${control.readerRole}:${value.readerId}`);
    assert.equal(hash(readFileSync(`/proc/${reader.pid}/cmdline`)), fence.commandSha256);
    assert.equal(rows.filter(row => row.kind === 'start' && row.pid === reader.pid && row.parentPid === child.pid
        && row.role === control.readerRole).length, 1);
    assert.equal(rows.filter(row => row.kind === 'worker_fork' && row.pid === child.pid && row.childPid === reader.pid).length, 1);
    const token = Object.freeze(Object.create(null)); snapshots.set(token, {control, child, snapshotId: response.mId,
        identity: response.before, value: structuredClone(value)}); return token;
}
export function describeWireReaderSnapshot(token) {
    const value = snapshots.get(token); assert.ok(value, 'unissued or consumed reader snapshot'); return structuredClone(value.value);
}
export async function crashWireReader(token) {
    const value = snapshots.get(token); assert.ok(value, 'unissued or consumed reader snapshot'); snapshots.delete(token);
    assert.ok(sameBirth(masterIdentity(value.child, value.control), value.identity));
    const response = await request(value.child, value.control, 'terminate', value.snapshotId), fence = response.value;
    assert.equal(fence.kind, 'owned-linux-reader-exit'); assert.deepEqual(fence.outcome, {code: null, signal: 'SIGKILL'});
    assert.deepEqual(fence.reader, value.value.census.reader); assert.deepEqual(fence.parent, value.value.census.parent);
    assert.equal(fence.directory, value.control.output); assert.equal(fence.commandSha256, value.value.census.commandSha256);
    assert.equal(fence.expectedTitle, value.value.census.expectedTitle); assert.equal(fence.brokerSettlement, 'unknown');
    assert.equal(fence.sourceCoverageQualified, false); assert.ok(!sameBirth(birth(fence.reader.pid), fence.reader));
    assert.ok(sameBirth(masterIdentity(value.child, value.control), value.identity));
    const receipt = Object.freeze(Object.create(null)); crashes.set(receipt, {...value, fence: structuredClone(fence), released: false}); return receipt;
}
export function describeWireReaderCrash(receipt) {
    const value = crashes.get(receipt); assert.ok(value, 'unissued reader crash receipt');
    return structuredClone({control: value.control, snapshot: value.value, fence: value.fence, snapshotId: value.snapshotId});
}
export async function wireReaderStatus(receipt) {
    const value = crashes.get(receipt); assert.ok(value, 'unissued reader crash receipt');
    const response = await request(value.child, value.control, 'status', value.snapshotId);
    assert.equal(response.value.masterPid, value.child.pid); return structuredClone(response.value);
}
export async function releaseWireReaderRpc(receipt) {
    const value = crashes.get(receipt); assert.ok(value && !value.released, 'unissued or released reader crash receipt');
    const response = await request(value.child, value.control, 'release', value.snapshotId);
    assert.equal(response.value.released, true); value.released = true;
}

export function wireReaderResumedEvents(receipt, masterPid, rows) {
    const {control, fence, snapshot} = describeWireReaderCrash(receipt);
    assert.equal(masterPid, fence.parent.pid);
    const starts = rows.filter(row => row.kind === 'start'); assert.equal(new Set(starts.map(row => row.pid)).size, starts.length);
    assert.equal(starts.filter(row => row.pid === masterPid && row.parentPid === process.pid).length, 1);
    const readers = starts.filter(row => row.role === control.readerRole && row.parentPid === masterPid);
    assert.equal(readers.length, 2); assert.equal(readers.filter(row => row.pid === fence.reader.pid).length, 1);
    const fresh = readers.find(row => row.pid !== fence.reader.pid); assert.ok(fresh);
    assert.equal(rows.filter(row => row.kind === 'worker_fork' && row.pid === masterPid && row.childPid === fresh.pid).length, 1);
    for (const row of rows.filter(row => row.kind === 'native_boundary' && row.blockNum === control.resumeBlockNum))
        assert.notEqual(row.pid, fence.reader.pid, 'retired reader produced resumed source evidence');
    return rows;
}

async function missingAssociationWithResponse(store, es, end) {
    const reads = [], get = es.get;
    es.get = async function (input, options) {
        try {
            const result = await get.call(this, input, {...options, meta: true});
            assert.ok(Number.isSafeInteger(result.statusCode) && result.body, 'missing original GET transport metadata');
            reads.push({request: structuredClone(input), status: result.statusCode, body: result.body, headers: result.headers});
            return options?.meta ? result : result.body;
        }
        catch (error) {reads.push({request: structuredClone(input), status: error?.meta?.statusCode, body: error?.meta?.body}); throw error;}
    };
    let typed;
    try {
        await assert.rejects(() => store.readAttemptAssociation(wireRecoveryAssociationId(end)), error => {
            typed = {name: error.name, code: error.code, recordId: error.recordId};
            return error.name === 'ImmutableProtocolBundleReadError' && error.code === 'missing' && error.recordId === wireRecoveryAssociationId(end);
        });
    } finally {es.get = get;}
    assert.ok(reads.length > 0 && reads.length <= 32);
    assert.ok(reads.some(row => row.status === 404 && row.body?.found === false && row.body._id === row.request.id),
        'typed absence lacks the original Elasticsearch missing-document response');
    return {id: wireRecoveryAssociationId(end), typed, reads};
}
export async function auditWireReaderHandover({receipt, masterPid, rows, store, selections, es, queues}) {
    const {control, fence, snapshot, snapshotId} = describeWireReaderCrash(receipt), value = crashes.get(receipt);
    assert.equal(value.released, true); assert.ok(sameBirth(masterIdentity(value.child, control), value.identity));
    wireReaderResumedEvents(receipt, masterPid, rows);
    const {held, events} = readWireReaderRecoveryEvidence(control);
    assert.equal(held.runId, control.runId); assert.equal(held.masterPid, masterPid); assert.deepEqual(held.end, snapshot.end);
    const old = snapshot.end, rejected = events.filter(row => row.event === 'adjudication-rejected'
        && row.pid === masterPid && wireRecoveryAssociationId(row.end) === wireRecoveryAssociationId(old));
    assert.equal(rejected.length, 1); assert.equal(rejected[0].error?.message, 'Current live SHIP irreversible anchor is unavailable');
    assert.equal(events.filter(row => row.event === 'adjudicated' && wireRecoveryAssociationId(row.end) === wireRecoveryAssociationId(old)).length, 0);
    const faults = events.filter(row => row.event === 'reader-exited' && row.pid === masterPid);
    assert.equal(faults.length, 1); assert.deepEqual(faults[0].fence, fence); assert.equal(faults[0].snapshotId, snapshotId);
    const current = events.filter(row => row.event === 'adjudicated' && row.pid === masterPid
        && row.end.binding.blockNum === control.resumeBlockNum && row.end.binding.traceOrdinal === control.traceOrdinal && row.result.state === 'associated');
    assert.equal(current.length, 1); const fresh = current[0].end;
    assert.notEqual(fresh.attemptId, old.attemptId); assert.equal(fresh.epoch, old.epoch, 'same master must retain its supervisor epoch');
    const originalSelection = await selections.readSelection(old.binding.selectionId);
    const currentSelection = await selections.readSelection(fresh.binding.selectionId);
    assert.equal(originalSelection.selection.readerSessionId, snapshot.readerSessionId);
    assert.notEqual(currentSelection.selection.readerSessionId, originalSelection.selection.readerSessionId);
    const retained = await auditWireRecoveryEnd(control, old, store), replacement = await auditWireRecoveryEnd(control, fresh, store, true);
    assert.notEqual(retained.admissionId, replacement.admissionId);
    const absence = await missingAssociationWithResponse(store, es, old);
    const association = await store.readAttemptAssociation(current[0].result.id);
    assert.equal(association.id, wireRecoveryAssociationId(fresh)); assert.deepEqual(association.observation.end, fresh);
    assert.equal(association.observation.sourceChecked, true); assert.equal(association.observation.brokerSettlement, 'unknown');
    const status = await wireReaderStatus(receipt); assert.ok(status.replacement);
    assert.equal(status.replacement.readerSessionId, currentSelection.selection.readerSessionId);
    assert.ok(queues.length > 0 && queues.every(row => row.name.startsWith(control.chain + ':')
        && row.ready === 0 && row.unacked === 0 && row.messages === 0 && row.redelivered === 0));
    const sourceQueue = queues.find(row => row.name === control.chain + ':live_blocks');
    assert.ok(sourceQueue); assert.equal(sourceQueue.delivered, 34); assert.equal(sourceQueue.ack, 34);
    return {kind: 'same-master-reader-handover-observed', masterPid, snapshot, fence, rejected: rejected[0],
        retained, replacement, association, absence, originalSelection, currentSelection, currentReader: status.replacement, brokerCounters: queues,
        brokerSettlement: 'unknown', fullReplayQualified: false, forkQualified: false};
}

/** Only the independently fenced intentional child is excluded from the detached normal-shutdown oracle input. */
export function wireReaderShutdownRows(rows, receipt, masterPid, exitCode, signal) {
    const {control, fence} = describeWireReaderCrash(receipt), old = fence.reader.pid;
    assert.equal(fence.parent.pid, masterPid); assert.equal(exitCode, 1); assert.equal(signal, null);
    const starts = rows.filter(row => row.kind === 'start'), forks = rows.filter(row => row.kind === 'worker_fork');
    assert.equal(new Set(starts.map(row => row.pid)).size, starts.length);
    assert.equal(new Set(forks.map(row => row.childPid)).size, forks.length);
    assert.equal(starts.length, forks.length + 1);
    assert.equal(starts.filter(row => row.pid === masterPid).length, 1);
    for (const row of starts) if (row.pid !== masterPid)
        assert.equal(forks.filter(fork => fork.pid === row.parentPid && fork.childPid === row.pid).length, 1);
    assert.equal(starts.filter(row => row.pid === old && row.parentPid === masterPid && row.role === control.readerRole).length, 1);
    assert.equal(starts.filter(row => row.parentPid === masterPid && row.role === control.readerRole).length, 2);
    assert.equal(rows.filter(row => ['observer_error', 'shutdown_force_child', 'shutdown_late_child'].includes(row.kind)).length, 0);
    assert.equal(rows.filter(row => row.pid === old && ['exit', 'flush', 'shutdown', 'profile_saved', 'profile_started'].includes(row.kind)).length, 0,
        'the SIGKILL child cannot invent normal exit or flush evidence');
    const childExits = rows.filter(row => row.kind === 'worker_exit'); assert.equal(childExits.length, forks.length);
    for (const fork of forks) {
        const exits = childExits.filter(row => row.pid === fork.pid && row.childPid === fork.childPid);
        assert.equal(exits.length, 1); assert.deepEqual({code: exits[0].code, signal: exits[0].signal},
            fork.childPid === old ? {code: null, signal: 'SIGKILL'} : {code: 0, signal: null});
    }
    const shutdowns = rows.filter(row => row.kind === 'shutdown' && row.pid === masterPid);
    assert.equal(shutdowns.length, 1); const shutdown = shutdowns[0];
    assert.equal(shutdown.success, false); assert.deepEqual(shutdown.forced, []); assert.deepEqual(shutdown.unresolved, []);
    assert.equal(shutdown.children, forks.length); assert.equal(shutdown.exited, forks.length);
    assert.deepEqual(shutdown.failedChildren.map(row => ({pid: row.pid, code: row.code, signal: row.signal})),
        [{pid: old, code: null, signal: 'SIGKILL'}]);
    assert.equal(shutdown.childExits.length, forks.length);
    for (const start of starts.filter(row => row.pid !== old)) {
        const exits = rows.filter(row => row.kind === 'exit' && row.pid === start.pid), flushes = rows.filter(row => row.kind === 'flush' && row.pid === start.pid);
        assert.equal(exits.length, 1); assert.equal(exits[0].code, start.pid === masterPid ? 1 : 0);
        assert.equal(exits[0].droppedRecords, 0); assert.equal(exits[0].profileState, 'disabled');
        assert.equal(flushes.length, 1); assert.equal(flushes[0].success, true); assert.equal(flushes[0].droppedRecords, 0);
        assert.equal(flushes[0].profileState, 'disabled'); assert.equal(flushes[0].profilePath, null);
    }
    for (const row of shutdown.childExits) assert.deepEqual({code: row.code, signal: row.signal},
        row.pid === old ? {code: null, signal: 'SIGKILL'} : {code: 0, signal: null});
    const verified = structuredClone(rows.filter(row => row.pid !== old
        && !(row.kind === 'worker_fork' && row.childPid === old) && !(row.kind === 'worker_exit' && row.childPid === old)));
    for (const row of verified) {
        if (row.kind === 'exit' && row.pid === masterPid) row.code = 0;
        if (row.kind === 'shutdown' && row.pid === masterPid) {
            row.success = true; row.failedChildren = []; row.childExits = row.childExits.filter(child => child.pid !== old);
            row.children--; row.exited--;
        }
    }
    return verified;
}
