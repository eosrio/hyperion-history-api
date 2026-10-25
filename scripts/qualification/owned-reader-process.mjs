/** Fixture-only child fence. Process death proves neither durable effects nor broker settlement. */
import assert from 'node:assert/strict';
import cluster from 'node:cluster';
import {ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, readlinkSync, realpathSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import {parseLinuxProcessStat} from './owned-master-process-group.mjs';

const captured = new WeakMap(), exited = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
function enabled() {
    assert.equal(process.env.HYPERION_PORTABLE_NATIVE_QUALIFICATION, '1', 'reader fault requires explicit qualification');
    assert.equal(process.platform, 'linux', 'owned reader recovery requires Linux');
    assert.ok(!process.versions.bun && /^(24|26)\./.test(process.versions.node), 'owned reader recovery requires native Node24/26');
    assert.equal(cluster.isPrimary, true);
}
function stat(pid) {
    try {return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);}
    catch (error) {if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error;}
}
const sameBirth = (left, right) => left && right && left.pid === right.pid && left.startTicks === right.startTicks
    && left.parentPid === right.parentPid && left.group === right.group && left.session === right.session;
function command(pid) {
    const bytes = readFileSync(`/proc/${pid}/cmdline`);
    assert.ok(bytes.length > 0 && bytes.length <= 65536 && bytes.at(-1) === 0);
    return bytes;
}
function live(worker, directory, expectedTitle) {
    assert.ok(worker instanceof cluster.Worker && worker.process instanceof ChildProcess, 'native cluster reader required');
    assert.equal(worker.isConnected(), true, 'reader IPC is disconnected'); assert.equal(worker.isDead(), false);
    assert.equal(worker.process.exitCode, null); assert.equal(worker.process.signalCode, null);
    assert.equal(realpathSync(directory), directory); assert.equal(realpathSync(process.cwd()), directory);
    assert.ok(typeof expectedTitle === 'string' && expectedTitle.length > 0 && expectedTitle.length <= 256);
    const pid = worker.process.pid; assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    const reader = stat(pid), parent = stat(process.pid);
    assert.ok(reader && parent && reader.state !== 'Z' && parent.state !== 'Z', 'owned reader is not live');
    assert.equal(reader.parentPid, process.pid, 'reader belongs to another parent');
    assert.equal(reader.group, parent.group); assert.equal(reader.session, parent.session);
    assert.equal(readlinkSync(`/proc/${pid}/cwd`), directory);
    assert.equal(realpathSync(`/proc/${pid}/exe`), realpathSync(process.execPath));
    const bytes = command(pid);
    assert.deepEqual(bytes.toString().split('\0').filter(Boolean), [expectedTitle], 'owned reader title differs');
    return {reader, parent, commandSha256: hash(bytes), expectedTitle};
}
export function captureOwnedReader(worker, directory, expectedTitle) {
    enabled(); const identity = live(worker, directory, expectedTitle);
    assert.ok(sameBirth(stat(identity.reader.pid), identity.reader), 'reader birth changed during capture');
    const token = Object.freeze(Object.create(null)); captured.set(token, {worker, directory, ...identity}); return token;
}
export function describeOwnedReaderCensus(token) {
    const value = captured.get(token); assert.ok(value, 'unissued or consumed owned reader census');
    return structuredClone({directory: value.directory, reader: value.reader, parent: value.parent,
        expectedTitle: value.expectedTitle, commandSha256: value.commandSha256});
}
export async function terminateOwnedReader(token) {
    enabled(); const value = captured.get(token); assert.ok(value, 'unissued or consumed owned reader census');
    captured.delete(token);
    const current = live(value.worker, value.directory, value.expectedTitle);
    assert.ok(sameBirth(current.reader, value.reader) && sameBirth(current.parent, value.parent), 'owned reader birth changed');
    assert.equal(current.commandSha256, value.commandSha256, 'owned reader command changed');
    let outcome;
    const onExit = (code, signal) => {outcome = {code, signal};};
    value.worker.once('exit', onExit);
    try {
        assert.ok(sameBirth(stat(value.reader.pid), value.reader), 'owned reader changed before signal');
        assert.equal(value.worker.process.kill('SIGKILL'), true, 'owned reader signal was not sent');
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline && (!outcome || sameBirth(stat(value.reader.pid), value.reader))) await pause(10);
        assert.deepEqual(outcome, {code: null, signal: 'SIGKILL'}, 'owned reader did not exit after its requested fault');
        assert.ok(!sameBirth(stat(value.reader.pid), value.reader), 'owned reader remained after the fault');
        assert.ok(sameBirth(stat(process.pid), value.parent), 'master identity changed during reader fault');
        const receipt = Object.freeze(Object.create(null));
        exited.set(receipt, {kind: 'owned-linux-reader-exit', directory: value.directory, parent: value.parent,
            reader: value.reader, commandSha256: value.commandSha256, expectedTitle: value.expectedTitle, outcome,
            brokerSettlement: 'unknown', sourceCoverageQualified: false}); return receipt;
    } finally {value.worker.removeListener('exit', onExit);}
}
export function describeOwnedReaderExit(receipt) {
    const value = exited.get(receipt); assert.ok(value, 'unissued owned reader exit receipt'); return structuredClone(value);
}
