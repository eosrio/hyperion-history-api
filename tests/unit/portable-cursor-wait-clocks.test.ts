import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('native cursor clock controls exercise the actual held/rejected wait without services', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--experimental-strip-types', '--test', '--test-timeout=10000',
        fileURLToPath(new URL('./portable-cursor-wait-clocks.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toMatchObject({code: 0});
    expect(stdout).toContain('tests 7'); expect(stdout).toContain('fail 0');
}, 20000);
