import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('the actual master checks Wire canonical identities without decoding an Antelope block header', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-master-rpc.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    expect(JSON.parse(stdout).actualMasterCallback).toBe(true);
}, 15000);
