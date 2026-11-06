import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('native action refresh keeps replica readiness, raw receipts and the original deadline', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--test',
        fileURLToPath(new URL('./portable-action-refresh.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toMatchObject({code: 0});
}, 15000);
