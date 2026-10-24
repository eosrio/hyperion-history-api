/** Actual isolated Linux process groups; no Hyperion services or chain authority. */
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {captureOwnedMasterGroup, terminateOwnedMasterGroup, describeOwnedMasterGroupExit}
    from '../../scripts/qualification/owned-master-process-group.mjs';

assert.equal(process.platform, 'linux');
assert.ok(!process.versions.bun && /^(24|26)\./.test(process.versions.node));
const self = fileURLToPath(import.meta.url), mode = process.argv[2] ?? 'controller';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
    const end = Date.now() + 5000;
    while (!predicate()) {assert.ok(Date.now() < end, label); await pause(10);}
}
if (mode === 'leaf') {
    process.send({event: 'ready', pid: process.pid});
    setInterval(() => {}, 1000);
} else if (mode === 'master') {
    const boot = {executable: process.execPath, execArgv: [...process.execArgv], argv: [...process.argv]};
    process.title = 'hapi-owned-master-fixture';
    const start = () => {
        const child = fork(self, ['leaf'], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
        child.once('message', message => {assert.equal(message.pid, child.pid); process.send({event: 'child', pid: child.pid, boot});});
    };
    start();
    process.on('message', message => {if (message?.event === 'new-child') start();});
    setInterval(() => {}, 1000);
} else {
    assert.equal(mode, 'controller');
    const temporary = realpathSync(tmpdir()), directory = mkdtempSync(join(temporary, 'hyperion-master-process-group-'));
    const child = fork(self, ['master'], {cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    const children = [], rows = [{kind: 'start', pid: child.pid, parentPid: process.pid}];
    const closed = new Promise(resolve => child.once('close', resolve));
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => {stdout += bytes; assert.ok(stdout.length < 32768);});
    child.stderr.on('data', bytes => {stderr += bytes; assert.ok(stderr.length < 32768);});
    child.on('message', message => {
        assert.equal(message.event, 'child'); assert.ok(Number.isSafeInteger(message.pid) && message.pid > 0);
        Object.assign(rows[0], message.boot);
        children.push(message.pid);
        rows.push({kind: 'start', pid: message.pid, parentPid: child.pid}, {kind: 'worker_fork', pid: child.pid, childPid: message.pid});
    });
    try {
        await until(() => children.length === 1, 'first isolated child ready');
        assert.throws(() => captureOwnedMasterGroup(child, directory, rows.slice(0, 1), 'hapi-owned-master-fixture'), /unobserved process/);
        assert.throws(() => captureOwnedMasterGroup(child, directory, rows, 'other-master'), /title differs/);
        const initial = captureOwnedMasterGroup(child, directory, rows, 'hapi-owned-master-fixture');
        child.send({event: 'new-child'});
        await until(() => children.length === 2, 'second isolated child ready');
        await assert.rejects(terminateOwnedMasterGroup(initial), /group changed after census/);
        assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
        for (const pid of children) process.kill(pid, 0);
        const current = captureOwnedMasterGroup(child, directory, rows, 'hapi-owned-master-fixture');
        await assert.rejects(terminateOwnedMasterGroup(structuredClone(current)), /unissued or consumed/);
        const receipt = await terminateOwnedMasterGroup(current), value = describeOwnedMasterGroupExit(receipt);
        assert.equal(value.root.pid, child.pid); assert.equal(value.members.length, 3);
        assert.deepEqual(value.outcome, {code: null, signal: 'SIGKILL'});
        assert.equal(value.brokerSettlement, 'unknown'); assert.equal(value.sourceCoverageQualified, false);
        assert.throws(() => describeOwnedMasterGroupExit(structuredClone(receipt)), /unissued/);
        await assert.rejects(terminateOwnedMasterGroup(current), /unissued or consumed/);
        assert.equal(stdout, ''); assert.equal(stderr, '');
        console.log(JSON.stringify({passed: true, native: process.version, members: 3,
            unobservedMemberRejected: true, changedGroupRejected: true, copiedCensusRejected: true, configuredTitleVerified: true,
            actualGroupExit: value.outcome, allOwnedIdentitiesGone: true, copiedExitRejected: true,
            brokerSettlement: 'unknown', productionMasterQualified: false}));
    } finally {
        if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
        await Promise.race([closed, pause(5000)]);
        assert.equal(dirname(realpathSync(directory)), temporary);
        assert.ok(basename(directory).startsWith('hyperion-master-process-group-'));
        rmSync(directory, {recursive: true, force: true});
    }
}
