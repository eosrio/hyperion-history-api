/** Qualification-only capability to restart the exact owned secondary Elasticsearch data node. */
import assert from 'node:assert/strict';
import {posix} from 'node:path';
import {captureOwnedFixtureDaemon, captureOwnedFixtureProcess} from './owned-fixture-runtime.mjs';

const captured = new WeakMap(), restarted = new WeakMap();
const image = 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
const labels = (value, run) => {
    assert.equal(value?.['io.eosrio.qualifier'], 'es198-replicas'); assert.equal(value?.['io.eosrio.run'], run);
};
const lines = text => text.split(/\r?\n/).filter(Boolean).sort();

/** Validate observed data without issuing a restart capability. */
export function assertWireReplicaInspection({core, container, volume, users, network, daemon}) {
    assert.match(core.run, /^[a-f0-9]{12}$/); assert.equal(core.network, 'hyp-es955-replicas-' + core.run);
    assert.equal(core.clusterName, 'hyperion-es198-' + core.run); assert.equal(core.esImage, image);
    assert.equal(core.indexingPressureLimitMb, 64); assert.equal(core.nodes.length, 3);
    assert.deepEqual(core.nodes.map(node => node.name), ['a', 'b', 'witness'].map(suffix => core.network + '-' + suffix));
    assert.deepEqual(core.nodes.map(node => node.role), ['data', 'data', 'master']);
    const target = core.nodes[1]; assert.equal(target.volume, target.name + '-data');
    assert.match(target.containerId, /^[a-f0-9]{64}$/);
    assert.equal(container.Id, target.containerId); assert.equal(container.Name, '/' + target.name);
    assert.equal(container.Config.Image, image); labels(container.Config.Labels, core.run);
    assert.equal(container.State.Running, true); assert.equal(container.State.Status, 'running');
    assert.ok(Number.isSafeInteger(container.State.Pid) && container.State.Pid > 1);
    assert.ok(Number.isFinite(Date.parse(container.State.StartedAt)));
    assert.equal(container.HostConfig.NetworkMode, core.network); assert.equal(container.HostConfig.Privileged, false);
    assert.equal(container.HostConfig.Memory, 3 * 1024 ** 3); assert.equal(container.HostConfig.NanoCpus, 2_000_000_000);
    const url = new URL(target.url), port = target.pinnedHttpPort;
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.pathname, '/');
    assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.ok(Number.isSafeInteger(port) && port > 1024 && port <= 65535); assert.equal(url.port, String(port));
    const binding = [{HostIp: '127.0.0.1', HostPort: String(port)}];
    assert.deepEqual(container.HostConfig.PortBindings, {'9200/tcp': binding});
    assert.deepEqual(container.NetworkSettings.Ports['9200/tcp'], binding);
    for (const [key, value] of Object.entries(container.NetworkSettings.Ports)) if (key !== '9200/tcp') assert.equal(value, null);
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [core.network]);
    const expectedEnv = {'cluster.name': core.clusterName, 'node.name': target.name, 'node.roles': 'master,data,ingest',
        'discovery.seed_hosts': core.nodes.map(node => node.name).join(','), 'cluster.initial_master_nodes': core.nodes.map(node => node.name).join(','),
        'xpack.security.enabled': 'false', 'xpack.security.autoconfiguration.enabled': 'false', 'xpack.ml.enabled': 'false',
        'ingest.geoip.downloader.enabled': 'false', 'indexing_pressure.memory.limit': '64mb',
        'cluster.routing.allocation.disk.watermark.low': '20gb', 'cluster.routing.allocation.disk.watermark.high': '10gb',
        'cluster.routing.allocation.disk.watermark.flood_stage': '5gb', ES_JAVA_OPTS: '-Xms1g -Xmx1g'};
    assert.ok(Array.isArray(container.Config.Env));
    for (const [key, value] of Object.entries(expectedEnv))
        assert.deepEqual(container.Config.Env.filter(entry => entry.startsWith(key + '=')), [key + '=' + value]);
    assert.equal(container.Mounts.length, 1);
    assert.deepEqual({Type: container.Mounts[0].Type, Name: container.Mounts[0].Name,
        Destination: container.Mounts[0].Destination, RW: container.Mounts[0].RW},
    {Type: 'volume', Name: target.volume, Destination: '/usr/share/elasticsearch/data', RW: true});
    assert.equal(volume.Name, target.volume); labels(volume.Labels, core.run);
    assert.equal(volume.Driver, 'local'); assert.equal(volume.Scope, 'local');
    assert.ok(volume.Options === null || typeof volume.Options === 'object' && Object.keys(volume.Options).length === 0);
    assert.ok(typeof daemon.root === 'string' && daemon.root.startsWith('/'));
    assert.equal(volume.Mountpoint, posix.join(daemon.root, 'volumes', target.volume, '_data'));
    assert.deepEqual(users, [target.containerId], 'replica data must have exactly its owned consumer');
    assert.equal(network.Name, core.network); labels(network.Labels, core.run);
    const peers = Object.keys(network.Containers).sort(), required = [...core.nodes.map(node => node.containerId), core.broker.containerId];
    assert.equal(new Set(required).size, 4); required.forEach(cid => assert.match(cid, /^[a-f0-9]{64}$/));
    assert.ok(peers.length <= 32 && required.every(cid => peers.includes(cid)));
    return {containerId: target.containerId, name: target.name, volume: target.volume,
        image, startedAt: container.State.StartedAt, pid: container.State.Pid, networkPeers: peers};
}

function inspect(core, docker) {
    const daemon = captureOwnedFixtureDaemon(docker), target = core.nodes[1];
    const container = JSON.parse(docker(['inspect', target.containerId]))[0];
    const volume = JSON.parse(docker(['volume', 'inspect', target.volume]))[0];
    const users = lines(docker(['ps', '-a', '--no-trunc', '--filter', 'volume=' + target.volume, '--format', '{{.ID}}']));
    const network = JSON.parse(docker(['network', 'inspect', core.network]))[0];
    const replica = assertWireReplicaInspection({core, container, volume, users, network, daemon});
    const peers = replica.networkPeers.filter(cid => cid !== replica.containerId).map(cid => {
        assert.match(cid, /^[a-f0-9]{64}$/);
        const member = JSON.parse(docker(['inspect', cid]))[0];
        assert.equal(member.Id, cid); assert.equal(member.Config.Labels?.['io.eosrio.run'], core.run);
        assert.ok(['es198-replicas', 'es198-workers'].includes(member.Config.Labels?.['io.eosrio.qualifier']));
        assert.equal(member.State.Running, true); assert.equal(member.State.Status, 'running');
        return {containerId: cid, config: member.Config, hostConfig: member.HostConfig, mounts: member.Mounts,
            ports: member.NetworkSettings.Ports, networks: Object.keys(member.NetworkSettings.Networks),
            startedAt: member.State.StartedAt, process: captureOwnedFixtureProcess(member.State.Pid)};
    });
    return {replica, process: captureOwnedFixtureProcess(replica.pid), daemon, peers};
}

export function captureOwnedWireReplica(core, docker) {
    const snapshot = inspect(core, docker), token = Object.freeze({kind: 'owned-wire-replica-census'});
    captured.set(token, {core: structuredClone(core), docker, snapshot}); return token;
}
export function describeOwnedWireReplica(token) {
    const value = captured.get(token); assert.ok(value, 'unissued or consumed replica census');
    return structuredClone(value.snapshot);
}
export function restartOwnedWireReplica(token) {
    const value = captured.get(token); assert.ok(value, 'unissued or consumed replica census'); captured.delete(token);
    const before = inspect(value.core, value.docker); assert.deepEqual(before, value.snapshot, 'owned replica or peers changed before restart');
    const diagnostic = {command: ['restart', '--timeout', '0', before.replica.containerId], before,
        mutationAttempted: true, restartVerified: false, durabilityAuthority: false};
    try {
        const result = value.docker(diagnostic.command); diagnostic.returned = result; assert.equal(result, before.replica.containerId);
        const after = inspect(value.core, value.docker); diagnostic.after = after;
        assert.deepEqual(after.daemon, before.daemon); assert.deepEqual(after.peers, before.peers, 'unrelated fixture service changed');
        const {startedAt: _beforeStarted, pid: _beforePid, ...original} = before.replica;
        const {startedAt: _afterStarted, pid: _afterPid, ...current} = after.replica;
        assert.deepEqual(current, original); assert.notEqual(after.replica.startedAt, before.replica.startedAt);
        assert.ok(after.process.pid !== before.process.pid || after.process.startTicks !== before.process.startTicks);
        const receipt = Object.freeze({kind: 'owned-wire-replica-restart-observed', run: value.core.run, before, after,
            storageAvailability: 'unverified', durabilityAuthority: false});
        restarted.set(receipt, structuredClone(receipt)); return receipt;
    } catch (error) {error.replicaRestartAttempt = diagnostic; throw error;}
}
export function describeOwnedWireReplicaRestart(receipt) {
    const value = restarted.get(receipt); assert.ok(value, 'unissued replica restart receipt'); return structuredClone(value);
}
