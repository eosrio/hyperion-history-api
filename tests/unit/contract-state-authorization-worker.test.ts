import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('emitted producer requires operator opt-in and preserves explicit plugin dependencies', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./contract-state-authorization-worker.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-10_000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true,
        fixture: 'emitted-contract-state-authorization-controlled-publication', profileId: 'wire-sysio-7dede884-engineering-v1',
        checks: ['denied-opt-in-selection-and-zero-effects', 'explicit-plugin-dependency-authorization', 'authorized-queue-rotation',
            'legacy-and-protocol-metadata-byte-contract'], nativeAddonResolutions: 0, networkAttempts: 0,
        nativeDatabase: false, liveTransportQualification: false});
}, 20_000);
