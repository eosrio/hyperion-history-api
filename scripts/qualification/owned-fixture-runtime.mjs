/** Shared native Linux identity reads for qualification-owned services. No restart authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readlinkSync, realpathSync} from 'node:fs';
import {parseLinuxProcessStat} from './owned-master-process-group.mjs';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';

export function captureOwnedFixtureProcess(pid) {
    assertNativeQualificationRuntime(); assert.equal(process.platform, 'linux');
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const first = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
    const command = readFileSync(`/proc/${pid}/cmdline`);
    assert.ok(command.length > 0 && command.length <= 65536 && command.at(-1) === 0);
    const executable = readlinkSync(`/proc/${pid}/exe`);
    const second = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
    const {state: firstState, ...birth} = first, {state: secondState, ...secondBirth} = second;
    assert.ok(!['Z', 'X'].includes(firstState) && !['Z', 'X'].includes(secondState));
    assert.deepEqual(secondBirth, birth, 'service process changed during capture');
    return {...birth, executable, commandSha256: createHash('sha256').update(command).digest('hex')};
}

export function captureOwnedFixtureDaemon(docker) {
    assertNativeQualificationRuntime(); assert.equal(process.platform, 'linux');
    const endpoint = process.env.DOCKER_HOST;
    assert.ok(!process.env.DOCKER_CONTEXT, 'Docker context must not override the explicit private socket');
    assert.ok(typeof endpoint === 'string' && endpoint.startsWith('unix:///'), 'restart requires an explicit local Docker socket');
    const path = endpoint.slice('unix://'.length), stat = lstatSync(path);
    assert.ok(stat.isSocket() && !stat.isSymbolicLink()); assert.equal(realpathSync(path), path);
    const daemon = JSON.parse(docker(['info', '--format', '{{json .}}']));
    assert.ok(typeof daemon.ID === 'string' && daemon.ID.length > 0);
    return {endpoint, socketDevice: stat.dev, socketInode: stat.ino, id: daemon.ID,
        name: daemon.Name, root: daemon.DockerRootDir, version: daemon.ServerVersion};
}
