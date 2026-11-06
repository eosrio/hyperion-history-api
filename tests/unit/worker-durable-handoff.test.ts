import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('actual worker durable handoffs preserve confirmation and original ACK ownership', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--test', '--test-reporter=tap',
        fileURLToPath(new URL('./worker-durable-handoff.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toMatchObject({code: 0, stderr: ''});
    expect(stdout).toContain('# fail 0');
}, 20_000);
