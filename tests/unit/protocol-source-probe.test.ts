import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('the ordered physical reader rejects an old reversible source after a queued replacement fork', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-source-probe-worker.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout}).toMatchObject({code: 0, stderr: '', stdout: 'physical fork probe passed\n'});
}, 20_000);
