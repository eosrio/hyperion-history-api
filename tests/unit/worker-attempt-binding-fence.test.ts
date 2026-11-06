import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('native binding ACK/fence races preserve the original managed attempt end', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--test',
        fileURLToPath(new URL('./worker-attempt-binding-fence.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 10_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout}).toMatchObject({code: 0, stderr: ''});
}, 15_000);
