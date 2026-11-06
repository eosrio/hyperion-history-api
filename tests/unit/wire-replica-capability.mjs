/** Native process/socket controls with a closed Docker test double; no service qualification. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync, realpathSync, renameSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {captureOwnedWireReplica, describeOwnedWireReplica, describeOwnedWireReplicaRestart, restartOwnedWireReplica}
    from '../../scripts/qualification/owned-wire-replica.mjs';
import {replicaInspectionFixture} from './wire-replica-inspection.mjs';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';

assertNativeQualificationRuntime(); assert.equal(process.platform, 'linux');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'h45-replica-capability-'))), socket = join(directory, 'docker.sock');
const oldHost = process.env.DOCKER_HOST, oldContext = process.env.DOCKER_CONTEXT;
const children = [], results = []; let server;
async function openSocket() {
    server = createServer(connection => connection.destroy()); server.listen(socket); await once(server, 'listening');
}
try {
    await openSocket(); process.env.DOCKER_HOST = 'unix://' + socket; delete process.env.DOCKER_CONTEXT;
    for (let index = 0; index < 5; index++) {
        const child = spawn(process.execPath, ['-e', "process.on('message',()=>{process.title='h45-replica-control-changed';process.send('changed')});process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
            {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
        children.push(child); await once(child.stdout, 'data');
    }
    for (const scenario of ['copied-token', 'changed-process', 'changed-command', 'changed-daemon', 'changed-budget', 'shared-volume', 'changed-peer',
        'changed-socket', 'single-use', 'restart-failure', 'changed-after-restart', 'exited-process']) {
        const input = replicaInspectionFixture(), target = input.core.nodes[1].containerId;
        input.container.State.Pid = children[1].pid;
        const peers = input.core.nodes.filter(node => node.containerId !== target).map((node, index) => ({
            ...structuredClone(input.container), Id: node.containerId, Name: '/' + node.name,
            State: {Running: true, Status: 'running', Pid: children[index === 0 ? 0 : 2].pid, StartedAt: '2026-10-25T00:00:00.000Z'}}));
        peers.push({...structuredClone(input.container), Id: input.core.broker.containerId, Name: '/owned-broker',
            State: {Running: true, Status: 'running', Pid: children[3].pid, StartedAt: '2026-10-25T00:00:00.000Z'}});
        let daemonId = 'owned-daemon', restarts = 0;
        const docker = args => {
            if (args[0] === 'info') return JSON.stringify({ID: daemonId, Name: 'controlled', DockerRootDir: input.daemon.root, ServerVersion: 'controlled'});
            if (args[0] === 'inspect') return JSON.stringify([args[1] === target ? input.container : peers.find(peer => peer.Id === args[1])]);
            if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([input.volume]);
            if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([input.network]);
            if (args[0] === 'ps') return input.users.join('\n');
            assert.deepEqual(args, ['restart', '--timeout', '0', target]); restarts++;
            if (scenario === 'restart-failure') throw Error('controlled unknown restart outcome');
            if (scenario === 'changed-after-restart') peers[0].State.StartedAt = '2026-10-25T00:02:00.000Z';
            input.container.State.Pid = children[4].pid; input.container.State.StartedAt = '2026-10-25T00:01:00.000Z'; return target;
        };
        const token = captureOwnedWireReplica(input.core, docker), snapshot = describeOwnedWireReplica(token);
        if (scenario === 'copied-token') {
            for (const copy of [structuredClone(token), snapshot]) {
                assert.throws(() => restartOwnedWireReplica(copy), /unissued/);
                assert.throws(() => describeOwnedWireReplicaRestart(copy), /unissued/);
            }
            assert.equal(restarts, 0);
        } else {
            if (scenario === 'changed-process') input.container.State.Pid = children[4].pid;
            if (scenario === 'changed-command') {const changed = once(children[1], 'message'); children[1].send('change'); await changed;}
            if (scenario === 'changed-daemon') daemonId = 'replacement-daemon';
            if (scenario === 'changed-budget') input.container.HostConfig.Memory *= 2;
            if (scenario === 'shared-volume') input.users.push('5'.repeat(64));
            if (scenario === 'changed-peer') peers[0].Config.Labels['io.eosrio.run'] = 'foreign';
            if (scenario === 'changed-socket') {
                renameSync(socket, socket + '.retired'); await new Promise(done => server.close(done)); await openSocket();
            }
            if (scenario === 'exited-process') {const exit = once(children[1], 'exit'); children[1].kill('SIGTERM'); await exit;}
            if (scenario === 'single-use') {
                const receipt = restartOwnedWireReplica(token), observed = describeOwnedWireReplicaRestart(receipt);
                assert.equal(restarts, 1); assert.deepEqual(observed.before, snapshot);
                assert.notEqual(observed.before.process.pid, observed.after.process.pid);
                assert.equal(observed.durabilityAuthority, false);
                assert.throws(() => describeOwnedWireReplicaRestart(structuredClone(receipt)), /unissued/);
            } else if (['restart-failure', 'changed-after-restart'].includes(scenario)) {
                let error; try {restartOwnedWireReplica(token);} catch (caught) {error = caught;}
                assert.ok(error); assert.equal(restarts, 1); assert.equal(error.replicaRestartAttempt.mutationAttempted, true);
                assert.equal(error.replicaRestartAttempt.restartVerified, false); assert.equal(error.replicaRestartAttempt.durabilityAuthority, false);
                assert.throws(() => describeOwnedWireReplicaRestart(error.replicaRestartAttempt), /unissued/);
            } else {assert.throws(() => restartOwnedWireReplica(token)); assert.equal(restarts, 0);}
            assert.throws(() => restartOwnedWireReplica(token), /consumed/);
        }
        results.push({scenario, passed: true, interceptedRestarts: restarts, realDockerCalls: 0});
    }
} finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit')));
    if (server?.listening) await new Promise(done => server.close(done));
    if (oldHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldHost;
    if (oldContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = oldContext;
    assert.equal(dirname(directory), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('h45-replica-capability-'));
    rmSync(directory, {recursive: true, force: true});
}
assert.equal(results.length, 12);
console.log(JSON.stringify({passed: true, node: process.version, scenarios: results, physicalChildren: children.length,
    childExits: children.map(child => ({pid: child.pid, code: child.exitCode, signal: child.signalCode})), realDockerCalls: 0, serviceQualification: false}));
