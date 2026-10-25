import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const owner of ['main', 'handoff']) for (const fault of ['held-proof', 'failed-proof', 'cancelled-proof', 'cancelled-open']) {
    const mode = `${owner}-${fault}`;
    test(`original managed Wire callback retains required proof read: ${mode}`, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./action-attempt-retained-read.mjs', import.meta.url)), mode],
        {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
        const [code, stdout, stderr] = await Promise.all([child.exited,
            new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, mode,
            originalWireCallbacks: true, actualRetainedControlRead: true,
            unrelatedWorkerAssociated: true, originalReadSettledBeforeEnd: true,
            capacityAuthority: false, fullWorkerQualification: false});
    }, 65_000);
}
