import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const profileId of ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1']) {
    test(`unready extension projections cannot serve cache or state for ${profileId}`, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./protocol-projection-readiness.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 15000, env: {...process.env, HYPERION_WIRE_PROFILE: profileId}});
        const [code, stdout, stderr] = await Promise.all([child.exited,
            new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stdout: stdout.slice(-5000), stderr}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, profileId,
            guardedRoutes: 10, poisonedCache: true, disabledFeatures: true, retainedAntelopeHistory: true});
    }, 20000);
}
