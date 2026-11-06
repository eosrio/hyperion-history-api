/** Qualification-only Linux fence. An exit receipt proves process death, never durable effects or broker settlement. */
import assert from 'node:assert/strict';
import {ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, readlinkSync, realpathSync} from 'node:fs';

const captured = new WeakMap(), exited = new WeakMap();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');

export function parseLinuxProcessStat(text, expectedPid) {
    assert.ok(typeof text === 'string' && text.length > 0 && text.length <= 16384);
    assert.ok(Number.isSafeInteger(expectedPid) && expectedPid > 0);
    const opening = text.indexOf(' ('), closing = text.lastIndexOf(') ');
    assert.ok(opening > 0 && closing > opening);
    assert.equal(text.slice(0, opening), String(expectedPid));
    const fields = text.slice(closing + 2).trim().split(/\s+/);
    assert.ok(fields.length >= 20 && /^[A-Za-z]$/.test(fields[0]));
    for (const index of [1, 2, 3, 19]) assert.match(fields[index], /^(0|[1-9][0-9]*)$/);
    const numbers = fields.slice(1, 4).map(Number);
    assert.ok(numbers.every(Number.isSafeInteger));
    return {pid: expectedPid, state: fields[0], parentPid: numbers[0], group: numbers[1], session: numbers[2], startTicks: fields[19]};
}

function linux() {
    assert.equal(process.platform, 'linux', 'owned master group recovery requires Linux');
    assert.ok(!process.versions.bun && /^(24|26)\./.test(process.versions.node), 'owned master group recovery requires native Node 24/26');
}
function stat(pid) {
    try {return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);}
    catch (error) {if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error;}
}
function members(group) {
    const names = readdirSync('/proc'); assert.ok(names.length <= 65536, 'process census exceeds its bound');
    const found = [];
    for (const name of names) if (/^[1-9][0-9]*$/.test(name)) {
        const value = stat(Number(name));
        if (value?.group === group) found.push(value);
    }
    assert.ok(found.length <= 64, 'owned process group exceeds its bound');
    return found.sort((a, b) => a.pid - b.pid);
}
function sameBirth(left, right) {
    return left && right && left.pid === right.pid && left.startTicks === right.startTicks
        && left.group === right.group && left.session === right.session;
}

export function captureOwnedMasterGroup(child, directory, rows, expectedTitle) {
    linux();
    assert.ok(child instanceof ChildProcess && Number.isSafeInteger(child.pid) && child.pid > 0);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.equal(realpathSync(directory), directory);
    const root = stat(child.pid); assert.ok(root, 'owned master is not live');
    assert.match(root.startTicks, /^[1-9][0-9]*$/);
    assert.equal(root.parentPid, process.pid); assert.equal(root.group, child.pid); assert.equal(root.session, child.pid);
    assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), directory);
    assert.equal(realpathSync(`/proc/${child.pid}/exe`), realpathSync(process.execPath));
    const command = readFileSync(`/proc/${child.pid}/cmdline`);
    assert.ok(command.length <= 65536); assert.equal(command.at(-1), 0);
    assert.ok(Array.isArray(rows));
    const starts = rows.filter(row => row.kind === 'start'), forks = rows.filter(row => row.kind === 'worker_fork');
    assert.ok(starts.length > 0 && starts.length <= 64 && forks.length <= 63);
    assert.equal(starts.filter(row => row.pid === child.pid && row.parentPid === process.pid).length, 1);
    const boot = starts.find(row => row.pid === child.pid);
    assert.equal(boot.executable, process.execPath); assert.ok(Array.isArray(boot.execArgv) && Array.isArray(boot.argv));
    assert.deepEqual([boot.executable, ...boot.execArgv, ...boot.argv.slice(1)], child.spawnargs);
    if (expectedTitle === undefined) assert.deepEqual(command.toString().slice(0, -1).split('\0'), child.spawnargs);
    else {
        assert.ok(typeof expectedTitle === 'string' && expectedTitle.length > 0 && expectedTitle.length <= 256);
        assert.deepEqual(command.toString().split('\0').filter(Boolean), [expectedTitle], 'owned master title differs from its configured role');
    }
    assert.equal(new Set(starts.map(row => row.pid)).size, starts.length);
    const known = new Map(starts.map(row => [row.pid, row]));
    for (const fork of forks) {
        assert.ok(known.has(fork.pid) && known.has(fork.childPid));
        assert.equal(known.get(fork.childPid).parentPid, fork.pid);
    }
    const group = members(child.pid); assert.ok(group.some(value => sameBirth(value, root)));
    for (const value of group) {
        assert.ok(known.has(value.pid), `unobserved process ${value.pid} in owned master group`);
        assert.equal(value.parentPid, known.get(value.pid).parentPid);
        assert.equal(value.session, child.pid);
        assert.equal(realpathSync(`/proc/${value.pid}/exe`), realpathSync(process.execPath));
        assert.equal(readlinkSync(`/proc/${value.pid}/cwd`), directory);
        if (value.pid !== child.pid) assert.ok(forks.some(row => row.pid === value.parentPid && row.childPid === value.pid));
    }
    assert.ok(sameBirth(stat(child.pid), root), 'owned master changed during census');
    const token = Object.freeze(Object.create(null));
    captured.set(token, {child, directory, root, group, commandSha256: hash(command)});
    return token;
}

export async function terminateOwnedMasterGroup(token) {
    linux();
    const value = captured.get(token); assert.ok(value, 'unissued or consumed owned master census');
    const {child, root, group} = value;
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    assert.ok(sameBirth(stat(root.pid), root), 'owned master birth identity changed');
    const current = members(root.pid);
    assert.ok(current.some(item => sameBirth(item, root)));
    for (const item of current) assert.ok(group.some(previous => sameBirth(item, previous)), 'master group changed after census');
    assert.ok(sameBirth(stat(root.pid), root));
    captured.delete(token);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    process.kill(-root.pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    let outcome;
    void closed.then(value => {outcome = value;});
    while (Date.now() < deadline) {
        if (outcome && group.every(previous => !sameBirth(stat(previous.pid), previous))) break;
        await pause(10);
    }
    assert.deepEqual(outcome, {code: null, signal: 'SIGKILL'}, 'owned master did not close after the requested crash');
    assert.ok(group.every(previous => !sameBirth(stat(previous.pid), previous)), 'owned master process remained after the crash');
    assert.equal(members(root.pid).length, 0, 'owned master group retained an unobserved process after the crash');
    const receipt = Object.freeze(Object.create(null));
    exited.set(receipt, Object.freeze({kind: 'owned-linux-master-group-exit', directory: value.directory,
        root, members: group, commandSha256: value.commandSha256, outcome,
        brokerSettlement: 'unknown', sourceCoverageQualified: false}));
    return receipt;
}

export function describeOwnedMasterGroupExit(receipt) {
    const value = exited.get(receipt); assert.ok(value, 'unissued owned master exit receipt');
    return structuredClone(value);
}
