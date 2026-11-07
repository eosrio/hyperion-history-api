import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('backlog observer uses original emitted receipt, proof, publisher and reader credit methods', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./wire-backlog-prototype.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 20000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr: code ? stderr : undefined}).toEqual({code: 0, stderr: undefined});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, originalPrototypeCalls: true,
        originalProofContext: true, confirmAloneHeld: true, originalConfirmAndDrain: true,
        unchangedOriginalCreditFenceAndError: true, controlledLocalOnly: true, physicalOrWireCapture: false});
}, 25000);
