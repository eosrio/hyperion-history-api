import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['main','main-held-write','main-failed-write','main-ack-throws','ds','contract','handoff']) test(`original Wire ${mode} callback reaches the managed native parent adjudicator`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    if (mode === 'main-failed-write') {
        expect(result).toMatchObject({passed: true, mode, managedParentEnd: true,
            failedWriteNoAck: true, noFreshWriteOrAssociation: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        return;
    }
    if (mode === 'main-ack-throws') {
        expect(result).toMatchObject({passed: true, mode, managedParentEnd: true,
            durableResultBeforeAckAttempt: true, originalAckCount: 0,
            acknowledgementAttempted: true, noAssociation: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        return;
    }
    expect(result).toMatchObject({passed: true,
        mode, managedParentEnd: true, writeBeforeAckBeforeEnd: true, originalAckCount: 1,
        classification: mode === 'main' || mode === 'main-held-write' ? 'source-incomplete'
            : mode === 'ds' ? 'intentional-no-effect' : mode === 'contract' ? 'contract-incomplete' : 'confirmed-handoff',
        brokerSettlement: 'unknown', fullWorkerQualification: false});
    if (mode === 'main-held-write') expect(result).toMatchObject({heldWriteBeforeObservation: true});
}, 45_000);
