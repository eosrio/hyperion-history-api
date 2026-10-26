import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('emitted native API, cache and current stream consumers use original Wire authority with inactive installation', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./protocol-native-api.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 65000, env: process.env});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout: stdout.slice(-5000), stderr}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, originalNative: [33, 122, 397],
        schema1Compatibility: 'separate existing API runners', nativeActivation: false, fullWorkerQualification: false,
        transportQualification: false, nativeValues: true, exactEnvelopes: true, cacheCapsules: true, ambiguousDowngrade: true,
        currentStreams: true, streamCancellation: true, sourceRevocation: true, rawHistory: true, unmarkedNativeRefused: true,
        responseFences: true, streamResponseFences: true});
}, 70000);
