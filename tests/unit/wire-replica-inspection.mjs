export function replicaInspectionFixture() {
    const run = 'abcdef012345', network = 'hyp-es955-replicas-' + run;
    const labels = {'io.eosrio.qualifier': 'es198-replicas', 'io.eosrio.run': run};
    const nodes = ['a', 'b', 'witness'].map((suffix, index) => ({name: network + '-' + suffix,
        role: index < 2 ? 'data' : 'master', containerId: String(index + 1).repeat(64),
        volume: network + '-' + suffix + '-data', url: 'http://127.0.0.1:' + (49001 + index), pinnedHttpPort: 49001 + index}));
    const image = 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
    const core = {run, network, clusterName: 'hyperion-es198-' + run, indexingPressureLimitMb: 64, esImage: image,
        nodes, broker: {containerId: '4'.repeat(64)}};
    const target = nodes[1], binding = [{HostIp: '127.0.0.1', HostPort: String(target.pinnedHttpPort)}];
    const env = {'cluster.name': core.clusterName, 'node.name': target.name, 'node.roles': 'master,data,ingest',
        'discovery.seed_hosts': nodes.map(node => node.name).join(','), 'cluster.initial_master_nodes': nodes.map(node => node.name).join(','),
        'xpack.security.enabled': 'false', 'xpack.security.autoconfiguration.enabled': 'false', 'xpack.ml.enabled': 'false',
        'ingest.geoip.downloader.enabled': 'false', 'indexing_pressure.memory.limit': '64mb',
        'cluster.routing.allocation.disk.watermark.low': '20gb', 'cluster.routing.allocation.disk.watermark.high': '10gb',
        'cluster.routing.allocation.disk.watermark.flood_stage': '5gb', ES_JAVA_OPTS: '-Xms1g -Xmx1g'};
    return {core, container: {Id: target.containerId, Name: '/' + target.name,
        Config: {Image: image, Labels: labels, Env: Object.entries(env).map(([key, value]) => key + '=' + value)},
        State: {Running: true, Status: 'running', Pid: 101, StartedAt: '2026-10-25T00:00:00.000Z'},
        HostConfig: {NetworkMode: network, Privileged: false, Memory: 3 * 1024 ** 3, NanoCpus: 2_000_000_000,
            PortBindings: {'9200/tcp': binding}},
        NetworkSettings: {Networks: {[network]: {}}, Ports: {'9200/tcp': binding, '9300/tcp': null}},
        Mounts: [{Type: 'volume', Name: target.volume, Destination: '/usr/share/elasticsearch/data', RW: true}]},
        volume: {Name: target.volume, Labels: labels, Driver: 'local', Scope: 'local', Options: null,
            Mountpoint: '/private/docker/volumes/' + target.volume + '/_data'},
        users: [target.containerId], network: {Name: network, Labels: labels,
            Containers: Object.fromEntries([...nodes.map(node => node.containerId), core.broker.containerId].map(id => [id, {}]))},
        daemon: {root: '/private/docker'}};
}
