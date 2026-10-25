/** Qualification-only, single-use authority to restart the exact owned RabbitMQ container. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readlinkSync, realpathSync} from 'node:fs';
import {parseLinuxProcessStat} from './owned-master-process-group.mjs';
import {assertNativeQualificationRuntime} from './native-node-runtime.mjs';

const captured = new WeakMap(), restarted = new WeakMap();
const image = 'rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef';
const sha = value => createHash('sha256').update(value).digest('hex');
const lines = value => value.split(/\r?\n/).filter(Boolean).sort();
const labels = (value, run) => {
    assert.equal(value?.['io.eosrio.qualifier'], 'es198-replicas');
    assert.equal(value?.['io.eosrio.run'], run);
};

/** Data validation is deliberately separate from the privately issued restart capability. */
export function assertWireBrokerInspection(core, inspected, volume, users, network) {
    assert.match(core.run, /^[a-f0-9]{12}$/); assert.equal(core.network, 'hyp-es955-replicas-' + core.run);
    const broker = core.broker;
    assert.equal(core.rabbitImage, image); assert.equal(broker.name, core.network + '-rabbit');
    assert.equal(broker.volume, broker.name + '-data'); assert.match(broker.containerId, /^[a-f0-9]{64}$/);
    assert.equal(inspected.Id, broker.containerId); assert.equal(inspected.Name, '/' + broker.name);
    assert.equal(inspected.Config.Image, image); labels(inspected.Config.Labels, core.run);
    assert.equal(inspected.State.Running, true); assert.equal(inspected.State.Status, 'running');
    assert.ok(Number.isSafeInteger(inspected.State.Pid) && inspected.State.Pid > 1);
    assert.ok(Number.isFinite(Date.parse(inspected.State.StartedAt)));
    assert.equal(inspected.HostConfig.NetworkMode, core.network);
    assert.equal(inspected.HostConfig.Privileged, false);
    assert.equal(inspected.HostConfig.Memory, 1024 * 1024 * 1024); assert.equal(inspected.HostConfig.NanoCpus, 1_000_000_000);
    assert.deepEqual(Object.keys(inspected.HostConfig.PortBindings).sort(), ['15672/tcp', '5672/tcp']);
    const amqp = new URL(broker.url), management = new URL(broker.managementUrl);
    assert.equal(amqp.protocol, 'amqp:'); assert.equal(amqp.hostname, '127.0.0.1');
    assert.equal(amqp.username, 'qualifier'); assert.equal(amqp.password, 'qualifier-test-only');
    assert.ok(['', '/'].includes(amqp.pathname)); assert.equal(amqp.search, ''); assert.equal(amqp.hash, '');
    assert.equal(management.protocol, 'http:'); assert.equal(management.hostname, '127.0.0.1');
    assert.equal(management.username, ''); assert.equal(management.password, '');
    assert.equal(management.pathname, '/'); assert.equal(management.search, ''); assert.equal(management.hash, '');
    assert.notEqual(broker.pinnedPorts.amqp, broker.pinnedPorts.management);
    for (const [name, port, url] of [['amqp', '5672/tcp', amqp], ['management', '15672/tcp', management]]) {
        const selected = broker.pinnedPorts[name];
        assert.ok(Number.isSafeInteger(selected) && selected > 1024 && selected <= 65535);
        assert.equal(url.port, String(selected));
        const binding = [{HostIp: '127.0.0.1', HostPort: String(selected)}];
        assert.deepEqual(inspected.HostConfig.PortBindings[port], binding, 'restart requires explicit fixed host bindings');
        assert.deepEqual(inspected.NetworkSettings.Ports[port], binding);
    }
    assert.deepEqual(Object.keys(inspected.NetworkSettings.Networks), [core.network]);
    assert.equal(inspected.Mounts.length, 1);
    const mount = inspected.Mounts[0];
    assert.equal(mount.Type, 'volume'); assert.equal(mount.Name, broker.volume);
    assert.equal(mount.Destination, '/var/lib/rabbitmq'); assert.equal(mount.RW, true);
    assert.equal(volume.Name, broker.volume); labels(volume.Labels, core.run);
    assert.deepEqual(users, [broker.containerId], 'broker data must have exactly its owned consumer');
    assert.equal(network.Name, core.network); labels(network.Labels, core.run);
    const peers = Object.keys(network.Containers).sort();
    assert.ok(peers.length <= 32 && [...core.nodes.map(node => node.containerId), broker.containerId].every(cid => peers.includes(cid)));
    // Redis/Mongo may share the fixture network, but every actual member must carry the run label.
    return {containerId: broker.containerId, name: broker.name, volume: broker.volume,
        image, startedAt: inspected.State.StartedAt, pid: inspected.State.Pid, networkPeers: peers};
}

function processIdentity(pid) {
    const first = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
    const command = readFileSync(`/proc/${pid}/cmdline`);
    assert.ok(command.length > 0 && command.length <= 65536 && command.at(-1) === 0);
    const executable = readlinkSync(`/proc/${pid}/exe`);
    const second = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
    const {state: firstState, ...birth} = first, {state: secondState, ...secondBirth} = second;
    assert.ok(!['Z', 'X'].includes(firstState) && !['Z', 'X'].includes(secondState));
    assert.deepEqual(secondBirth, birth, 'broker process changed during capture');
    return {...birth, executable, commandSha256: sha(command)};
}

function inspect(core, docker) {
    assertNativeQualificationRuntime(); assert.equal(process.platform, 'linux');
    const endpoint = process.env.DOCKER_HOST;
    assert.ok(!process.env.DOCKER_CONTEXT, 'Docker context must not override the explicit private socket');
    assert.ok(typeof endpoint === 'string' && endpoint.startsWith('unix:///'), 'restart requires an explicit local Docker socket');
    const path = endpoint.slice('unix://'.length), stat = lstatSync(path);
    assert.ok(stat.isSocket() && !stat.isSymbolicLink()); assert.equal(realpathSync(path), path);
    const daemon = JSON.parse(docker(['info', '--format', '{{json .}}']));
    assert.ok(typeof daemon.ID === 'string' && daemon.ID.length > 0);
    const inspected = JSON.parse(docker(['inspect', core.broker.containerId]))[0];
    const volume = JSON.parse(docker(['volume', 'inspect', core.broker.volume]))[0];
    const users = lines(docker(['ps', '-a', '--no-trunc', '--filter', 'volume=' + core.broker.volume, '--format', '{{.ID}}']));
    const network = JSON.parse(docker(['network', 'inspect', core.network]))[0];
    const broker = assertWireBrokerInspection(core, inspected, volume, users, network);
    for (const cid of Object.keys(network.Containers)) {
        assert.match(cid, /^[a-f0-9]{64}$/);
        const member = JSON.parse(docker(['inspect', cid]))[0];
        assert.equal(member.Id, cid); assert.equal(member.Config.Labels?.['io.eosrio.run'], core.run);
        assert.ok(['es198-replicas', 'es198-workers'].includes(member.Config.Labels?.['io.eosrio.qualifier']));
    }
    return {broker, process: processIdentity(broker.pid),
        daemon: {endpoint, socketDevice: stat.dev, socketInode: stat.ino, id: daemon.ID,
            name: daemon.Name, root: daemon.DockerRootDir, version: daemon.ServerVersion}};
}

export function captureOwnedWireBroker(core, docker) {
    const snapshot = inspect(core, docker), token = Object.freeze({kind: 'owned-wire-broker-census'});
    captured.set(token, {core: structuredClone(core), docker, snapshot}); return token;
}
export function describeOwnedWireBroker(token) {
    const value = captured.get(token); assert.ok(value, 'unissued or consumed broker census');
    return structuredClone(value.snapshot);
}
export function restartOwnedWireBroker(token) {
    const value = captured.get(token); assert.ok(value, 'unissued or consumed broker census');
    captured.delete(token);
    const before = inspect(value.core, value.docker);
    assert.deepEqual(before, value.snapshot, 'owned broker or daemon changed before restart');
    // The command names one container ID, never a daemon, service, network, volume, label or wildcard.
    const result = value.docker(['restart', '--timeout', '0', before.broker.containerId]);
    assert.equal(result, before.broker.containerId);
    const after = inspect(value.core, value.docker);
    assert.deepEqual(after.daemon, before.daemon, 'fixture daemon changed during broker restart');
    assert.equal(after.broker.containerId, before.broker.containerId);
    assert.equal(after.broker.volume, before.broker.volume);
    assert.notEqual(after.broker.startedAt, before.broker.startedAt, 'broker container did not restart');
    assert.ok(after.process.pid !== before.process.pid || after.process.startTicks !== before.process.startTicks,
        'broker physical process birth did not change');
    const receipt = Object.freeze({kind: 'owned-wire-broker-restart-observed', run: value.core.run,
        before, after, brokerSettlement: 'unknown'});
    restarted.set(receipt, structuredClone(receipt)); return receipt;
}
/** A diagnostic JSON copy cannot authorize a source-stream transition. */
export function describeOwnedWireBrokerRestart(receipt) {
    const value = restarted.get(receipt); assert.ok(value, 'unissued broker restart receipt');
    return structuredClone(value);
}
