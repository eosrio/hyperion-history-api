import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('original emitted action service preserves order, errors, cancellation and physical drain', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--test',
        fileURLToPath(new URL('./native-action-service-timing.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 20000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, output: code ? stdout + stderr : undefined}).toEqual({code: 0, output: undefined});
}, 25000);
