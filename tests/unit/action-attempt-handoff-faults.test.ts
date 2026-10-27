import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['held-write', 'failed-write', 'lost-receipt', 'ack-throws']) {
    test(`original managed DS handoff preserves write and ACK failures: ${mode}`, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./action-attempt-handoff-faults.mjs', import.meta.url)), mode],
        {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
        const [code, stdout, stderr] = await Promise.all([child.exited,
            new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, mode,
            originalWireDsCallback: true, originalPublicationConfirmed: true, unrelatedWorkerAssociated: true,
            noAssociationOnFailure: mode !== 'held-write', originalWriteAckEndOrder: mode === 'held-write',
            failedCoreWriteNoAck: mode === 'failed-write' || mode === 'lost-receipt',
            primaryVisibleInspectionOnly: mode === 'lost-receipt', freshConditionalRetryRequired: mode === 'lost-receipt',
            ackAttemptWithoutReturn: mode === 'ack-throws',
            brokerSettlement: 'unknown', capacityAuthority: false, fullWorkerQualification: false});
    }, 65_000);
}
