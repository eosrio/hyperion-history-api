import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('core state routes delegate to a ready plugin projection through the owner-v2 host', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./legacy-state-routes-native.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 60000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({cases: 6, delegatedThroughOwnerHost: true, cacheBypassed: true,
        completeKindRoute: true, unbackedRoutesRefuse: true, lagBoundRequired: true});
}, 65000);
