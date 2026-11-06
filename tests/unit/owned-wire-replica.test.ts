import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {assertWireReplicaInspection, describeOwnedWireReplica, describeOwnedWireReplicaRestart, restartOwnedWireReplica}
    from '../../scripts/qualification/owned-wire-replica.mjs';

import {replicaInspectionFixture as fixture} from './wire-replica-inspection.mjs';


test('replica restart census identifies only the owned secondary data node at the fixed source budget', () => {
    const input = fixture(), result = assertWireReplicaInspection(input);
    expect(result).toMatchObject({containerId: input.core.nodes[1].containerId, name: input.core.nodes[1].name,
        volume: input.core.nodes[1].volume, pid: 101, startedAt: '2026-10-25T00:00:00.000Z'});
    for (const mutate of [
        (v: any) => {v.container.Id = v.core.nodes[0].containerId;},
        (v: any) => {v.core.nodes[1].role = 'master';},
        (v: any) => {v.container.Config.Image = 'unqualified:latest';},
        (v: any) => {v.container.HostConfig.Memory *= 2;},
        (v: any) => {v.container.HostConfig.PortBindings['9200/tcp'][0].HostIp = '0.0.0.0';},
        (v: any) => {delete v.core.nodes[1].pinnedHttpPort;},
        (v: any) => {v.volume.Options = {device: '/incumbent', type: 'none', o: 'bind'};},
        (v: any) => {v.users.push('5'.repeat(64));},
        (v: any) => {v.container.Config.Env.push('indexing_pressure.memory.limit=128mb');},
        (v: any) => {v.container.State.Pid = 0;}
    ]) {const changed = fixture(); mutate(changed); expect(() => assertWireReplicaInspection(changed)).toThrow();}
});

test('valid inspection JSON and copied restart descriptions cannot issue or consume restart authority', () => {
    for (const value of [fixture(), assertWireReplicaInspection(fixture()), {kind: 'owned-wire-replica-census'}]) {
        expect(() => describeOwnedWireReplica(value)).toThrow('unissued');
        expect(() => restartOwnedWireReplica(value)).toThrow('unissued');
        expect(() => describeOwnedWireReplicaRestart(value)).toThrow('unissued');
    }
});

test.skipIf(process.platform !== 'linux')('native socket and process changes consume restart tokens before any mutation', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./wire-replica-capability.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(stderr).toBe('');
    const result = JSON.parse(stdout); expect(result.passed).toBe(true); expect(result.scenarios).toHaveLength(12);
    expect(result.realDockerCalls).toBe(0); expect(result.serviceQualification).toBe(false);
});
