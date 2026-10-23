import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('original Wire MainDS callback reaches the managed native parent adjudicator', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true,
        originalWireMainCallback: true, managedParentEnd: true, writeBeforeAckBeforeEnd: true, originalAckCount: 1,
        classification: 'source-incomplete', brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);
