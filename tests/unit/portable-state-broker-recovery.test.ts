import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ProofConsumerScope} from '../../src/indexer/protocol/proof-consumer-scope.js';
import {parsePortableWorkerArguments, validatePortableWorkerOptions} from '../../scripts/qualification/portable-state-worker.ts';
import {assertWireBrokerInspection, describeOwnedWireBroker, describeOwnedWireBrokerRestart, restartOwnedWireBroker} from '../../scripts/qualification/owned-wire-broker.mjs';
import {createWireBrokerRecoveryControl, readWireBrokerRecoveryControl, releaseWireBrokerReceipt,
    awaitWireBrokerReceiptRelease, assertWireBrokerHeldReceipt, wireBrokerRecoveryDigest,
    auditWireBrokerSourceCounterWindows, describeIssuedWireBrokerControl,
    assertWireBrokerHeldQueues} from '../../scripts/qualification/portable-state-broker-recovery.mjs';

const origin = 'http://127.0.0.1:58271', profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const chainId = '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d';
test('broker restart requires explicit native authority and excludes CPU capture and every other fault', () => {
    const args = ['state', 'plan', 'output'];
    expect(parsePortableWorkerArguments([...args, '--native', '--authority-rpc', origin, '--broker-recovery']).options)
        .toEqual({native: true, authorityRpc: origin, brokerRecovery: true});
    for (const options of [{brokerRecovery: true}, {native: true, brokerRecovery: true}, {brokerRecovery: 'true'},
        ...['profile', 'workerRecovery', 'masterRecovery', 'readerRecovery'].map(key =>
            ({native: true, authorityRpc: origin, brokerRecovery: true, [key]: true}))])
        expect(() => validatePortableWorkerOptions(options)).toThrow();
    expect(() => parsePortableWorkerArguments([...args, '--broker-recovery'])).toThrow();
});

async function fixture(run: (value: any) => Promise<void>) {
    const output = realpathSync(mkdtempSync(join(tmpdir(), 'hyperion-wire-broker-')));
    const configFile = join(output, 'chain.json'), observerDirectory = join(output, 'observer/master'), chain = 'hyp-p191-abcdef012345';
    mkdirSync(observerDirectory, {recursive: true});
    const config = {settings: {chain, protocol: {profileId}}}; writeFileSync(configFile, JSON.stringify(config));
    const selected = createWireBrokerRecoveryControl({output, configFile, chain, source: {chainId, profileId, endBlock: 1480,
        records: Array.from({length: 33}, () => ({blockId: 'b'.repeat(64)}))}, frameSha256: 'a'.repeat(64)});
    try {await run({...selected, output, configFile, observerDirectory, chain, config});}
    finally {
        expect(dirname(output)).toBe(realpathSync(tmpdir())); expect(basename(output).startsWith('hyperion-wire-broker-')).toBe(true);
        rmSync(output, {recursive: true, force: true});
    }
}
test('broker control binds the unchanged config, output, observer, chain, profile and default ancestry', async () => fixture(async value => {
    expect(readWireBrokerRecoveryControl(value.file, value)).toEqual(value.control);
    expect(describeIssuedWireBrokerControl(value.control)).toEqual(value.control);
    expect(() => describeIssuedWireBrokerControl(structuredClone(value.control))).toThrow('unissued');
    for (const patch of [{chain: 'other'}, {configFile: join(value.output, 'other.json')},
        {observerDirectory: value.output}]) expect(() => readWireBrokerRecoveryControl(value.file, {...value, ...patch})).toThrow();
    expect(() => releaseWireBrokerReceipt(structuredClone(value.control))).toThrow('unissued');
    writeFileSync(value.configFile, JSON.stringify({...value.config, settings: {...value.config.settings,
        protocol_abi_coordination: {recovery_window_blocks: 512}}}));
    expect(() => readWireBrokerRecoveryControl(value.file, value)).toThrow();
    expect(() => describeIssuedWireBrokerControl(value.control)).toThrow();
}));
test('an issued control cannot authorize resumption after its retained boundary was edited', async () => fixture(async value => {
    writeFileSync(value.file, JSON.stringify({...value.control, blockNum: 34}));
    expect(() => describeIssuedWireBrokerControl(value.control)).toThrow();
}));
test('fencing a real scope cannot release the held receipt, drain its original root or run post-receipt effects', async () => fixture(async ({control}) => {
    const scope = new ProofConsumerScope('broker-receipt-component-control');
    let returned = false, drained = false, fresh = 0, ack = 0;
    const root = scope.run(async () => {
        await scope.operation(() => awaitWireBrokerReceiptRelease(control));
        returned = true; scope.signal.throwIfAborted(); fresh++; ack++;
    });
    void root.catch(() => {});
    const end = scope.closeAndDrain().then(() => {drained = true;});
    try {
        await pause(120);
        expect(scope.snapshot()).toEqual({id: scope.id, state: 'fenced', pendingOperations: 1});
        expect(returned).toBe(false); expect(drained).toBe(false); expect(fresh).toBe(0); expect(ack).toBe(0);
    } finally {releaseWireBrokerReceipt(control); await end;}
    await expect(root).rejects.toThrow(); expect(returned).toBe(true); expect(drained).toBe(true);
    expect(scope.snapshot().pendingOperations).toBe(0); expect(fresh).toBe(0); expect(ack).toBe(0);
}));
test('a release from another run rejects the held await instead of acknowledging it', async () => fixture(async ({control, output}) => {
    writeFileSync(join(output, 'broker-recovery/release-receipt.json'), JSON.stringify({runId: 'other', controlSha256: wireBrokerRecoveryDigest(control)}));
    await expect(awaitWireBrokerReceiptRelease(control)).rejects.toThrow();
}));

function brokerFixture() {
    const run = 'abcdef012345', network = 'hyp-es955-replicas-' + run, name = network + '-rabbit', cid = 'd'.repeat(64);
    const labels = {'io.eosrio.qualifier': 'es198-replicas', 'io.eosrio.run': run};
    const bindings = {'5672/tcp': [{HostIp: '127.0.0.1', HostPort: '39001'}], '15672/tcp': [{HostIp: '127.0.0.1', HostPort: '39002'}]};
    const core = {run, network, rabbitImage: 'rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef',
        nodes: [{containerId: 'a'.repeat(64)}, {containerId: 'b'.repeat(64)}, {containerId: 'c'.repeat(64)}],
        broker: {name, containerId: cid, volume: name + '-data', url: 'amqp://qualifier:qualifier-test-only@127.0.0.1:39001',
            managementUrl: 'http://127.0.0.1:39002', pinnedPorts: {amqp: 39001, management: 39002}}};
    const inspected = {Id: cid, Name: '/' + name, Config: {Image: core.rabbitImage, Labels: labels},
        State: {Running: true, Status: 'running', Pid: 100, StartedAt: '2026-10-25T07:00:00.000Z'},
        HostConfig: {NetworkMode: network, Privileged: false, Memory: 1073741824, NanoCpus: 1000000000, PortBindings: structuredClone(bindings)},
        NetworkSettings: {Ports: bindings, Networks: {[network]: {}}},
        Mounts: [{Type: 'volume', Name: name + '-data', Destination: '/var/lib/rabbitmq', RW: true}]};
    return {core, inspected, volume: {Name: name + '-data', Labels: labels}, users: [cid],
        network: {Name: network, Labels: labels, Containers: Object.fromEntries([...core.nodes.map(node => node.containerId), cid].map(id => [id, {}]))}};
}
test('restart validation rejects foreign resources, floating ports, shared storage and changed service budgets', () => {
    const inspect = (value: any) => assertWireBrokerInspection(value.core, value.inspected, value.volume, value.users, value.network);
    expect(inspect(brokerFixture()).containerId).toBe('d'.repeat(64));
    for (const mutate of [
        (v: any) => {v.inspected.Id = 'e'.repeat(64);},
        (v: any) => {v.inspected.Config.Labels['io.eosrio.run'] = 'foreign';},
        (v: any) => {v.inspected.Config.Image = 'rabbitmq:latest';},
        (v: any) => {v.inspected.HostConfig.PortBindings['5672/tcp'][0].HostPort = '';},
        (v: any) => {v.inspected.NetworkSettings.Ports['5672/tcp'][0].HostIp = '0.0.0.0';},
        (v: any) => {v.core.broker.pinnedPorts.management = 39001;},
        (v: any) => {v.inspected.HostConfig.Memory *= 2;},
        (v: any) => {v.inspected.HostConfig.Privileged = true;},
        (v: any) => {v.inspected.State.Running = false;},
        (v: any) => {v.inspected.Mounts[0].Name = 'foreign';},
        (v: any) => {v.volume.Name = 'foreign';},
        (v: any) => {v.users.push('e'.repeat(64));},
        (v: any) => {delete v.network.Containers[v.core.broker.containerId];}
    ]) {const value = brokerFixture(); mutate(value); expect(() => inspect(value)).toThrow();}
    for (const description of [{kind: 'owned-wire-broker-census'}, inspect(brokerFixture())]) {
        expect(() => describeOwnedWireBroker(description)).toThrow('unissued');
        expect(() => restartOwnedWireBroker(description)).toThrow('unissued');
        expect(() => describeOwnedWireBrokerRestart(description)).toThrow('unissued');
    }
    expect(() => describeOwnedWireBrokerRestart({kind: 'owned-wire-broker-restart-observed', run: 'abcdef012345',
        before: inspect(brokerFixture()), after: inspect(brokerFixture()), brokerSettlement: 'unknown'})).toThrow('unissued');
});

test('held receipt cannot substitute a different attempt, source, phase or incomplete write response', async () => fixture(async ({control, chain}) => {
    const recordId = 'h45actionhandoff1:' + 'c'.repeat(64), admissionId = 'h45actionadmission1:' + 'd'.repeat(64);
    const scope = {id: 'scope', state: 'open', pendingOperations: 0};
    const held = {schemaVersion: 1, runId: control.runId, controlSha256: wireBrokerRecoveryDigest(control), role: 'ds_pool_worker',
        source: {chainId, blockNum: 33, blockId: control.blockId}, originalFrameSha256: control.frameSha256,
        admissionId, traceOrdinal: 0, payloadSha256: 'e'.repeat(64), redelivered: false, pid: 10, parentPid: 9,
        attempt: {mode: 'managed', masterEnd: null, scope, binding: {admissionId, traceOrdinal: 0, blockNum: 33, blockId: control.blockId},
            descriptor: {payloadSha256: 'e'.repeat(64)}}, scope, recordId, method: 'create',
        request: {index: chain + '-history-source-admission-v1', id: recordId, document: {kind: 'manifest', bundle_id: recordId},
            wait_for_active_shards: 'all', pipeline: '_none', refresh: false},
        response: {_id: recordId, _index: chain + '-history-source-admission-v1', result: 'created', _shards: {total: 2, successful: 2, failed: 0}}};
    expect(assertWireBrokerHeldReceipt(control, held)).toBe(held);
    for (const mutate of [
        (v: any) => {v.source.blockNum = 34;}, (v: any) => {v.scope.state = 'fenced';},
        (v: any) => {v.attempt.binding.admissionId = 'other';}, (v: any) => {v.attempt.masterEnd = {};},
        (v: any) => {v.response._shards.successful = 1;},
        (v: any) => {v.response._shards.total = 1; v.response._shards.successful = 1;},
        (v: any) => {v.request.wait_for_active_shards = '1';},
        (v: any) => {v.method = 'get';}, (v: any) => {v.request.document.kind = 'chunk';},
        (v: any) => {v.originalFrameSha256 = 'f'.repeat(64);}
    ]) {const value = structuredClone(held); mutate(value); expect(() => assertWireBrokerHeldReceipt(control, value)).toThrow();}
}));

test('source counters must reconcile independently on each real broker incarnation', () => {
    const chain = 'hyp-p191-abcdef012345', source = (count: number) => [{name: chain + ':live_blocks', ack: count,
        delivered: count, redelivered: 0, ready: 0, unacked: 0, messages: 0}];
    const value = {chain, through: 1480, before: source(33), after: source(1447), restart: {
        kind: 'owned-wire-broker-restart-observed', before: {broker: {containerId: 'a'.repeat(64), startedAt: 'before'},
            process: {pid: 100, startTicks: '1000'}}, after: {broker: {containerId: 'a'.repeat(64), startedAt: 'after'},
            process: {pid: 200, startTicks: '2000'}}}};
    const result = auditWireBrokerSourceCounterWindows(value);
    expect(result.before.expectedDeliveries).toBe(33); expect(result.after.expectedDeliveries).toBe(1447);
    expect(result.brokerSettlement).toBe('unknown'); expect(result.sourceAuthority).toBe(false); expect(result.capacityAcceptance).toBe(false);
    for (const mutate of [
        (v: any) => {v.after = source(1480);}, (v: any) => {v.after = source(0);},
        (v: any) => {v.before = source(0);}, (v: any) => {v.after[0].unacked = 1;},
        (v: any) => {v.restart.after.broker.startedAt = 'before';},
        (v: any) => {v.restart.after.process = v.restart.before.process;}
    ]) {const changed = structuredClone(value); mutate(changed); expect(() => auditWireBrokerSourceCounterWindows(changed)).toThrow();}
});

test('the held cut permits only its original DS queue to remain pending before unchanged oracles', () => {
    const chain = 'hyp-p191-abcdef012345';
    const queues = () => [
        {name: chain + ':live_blocks', delivered: 33, ack: 33, consumers: 1, ready: 0, unacked: 0, messages: 0},
        {name: chain + ':ds_pool:1', delivered: 40, ack: 38, consumers: 1, ready: 0, unacked: 2, messages: 2},
        {name: chain + ':index_actions:1', consumers: 1, ready: 0, unacked: 0, messages: 0}];
    expect(() => assertWireBrokerHeldQueues(chain, queues())).not.toThrow();
    for (const mutate of [
        (v: any[]) => {v[0].ack = 0;}, (v: any[]) => {v[0].unacked = 1; v[0].messages = 1;},
        (v: any[]) => {v[1].unacked = 0; v[1].messages = 0;}, (v: any[]) => {v[1].consumers = 0;},
        (v: any[]) => {v[1].ready = 1;}, (v: any[]) => {v[1].messages = 0;},
        (v: any[]) => {v[2].unacked = 1; v[2].messages = 1;}, (v: any[]) => {v[2].name = 'foreign:index_actions:1';},
        (v: any[]) => {v.push({...v[1]});}, (v: any[]) => {v.splice(0, 1);}, (v: any[]) => {v.splice(1, 1);}
    ]) {const changed = queues(); mutate(changed); expect(() => assertWireBrokerHeldQueues(chain, changed)).toThrow();}
});

test('native broker error observations preserve original unhandled exits and existing handlers', async () => {
    const script = fileURLToPath(new URL('./wire-broker-channel-errors.mjs', import.meta.url));
    for (const [mode, expectedCode, expectedOutput] of [
        ['baseline', 1, ''],
        ['ordinary-listener', 0, 'channel-error\n{"returnedAfterError":true,"handled":0,"originalErrorListeners":0}\n'],
        ['observed', 1, 'channel-error\n'],
        ['handled', 0, 'channel-error\n{"returnedAfterError":true,"handled":1,"originalErrorListeners":1}\n']
    ] as const) {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', script, mode],
            {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({mode, code, stdout}).toEqual({mode, code: expectedCode, stdout: expectedOutput});
        if (expectedCode === 1) expect(stderr).toContain('Error: constructed-owned-broker-channel-error');
        else expect(stderr).toBe('');
    }
});
