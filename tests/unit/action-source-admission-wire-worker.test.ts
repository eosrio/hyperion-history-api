import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const profileId of ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1']) {
    test(`emitted Wire admission preserves complete grouped effects and isolates raw fallback for ${profileId}`, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./action-source-admission-wire-worker.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 30_000, env: {...process.env, HYPERION_WIRE_PROFILE: profileId}});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-12_000)}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, profileId,
            fixture: 'emitted-wire-provider-controlled-transport', consensusValidation: false, liveTransportQualification: false,
            sourceDerivedMembership: true, certifiedOrigins: true, exactConfirmedBytes: true, rawFallbackIncomplete: true,
            unrelatedContinues: true, nativeAddonResolutions: 0});
    }, 35_000);
}
