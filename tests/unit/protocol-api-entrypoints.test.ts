import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const profileId of ['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-7dede884-engineering-v1']) {
    test(`action routes and stream methods preserve canonical proof gates for ${profileId}`, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./protocol-api-entrypoints.mjs', import.meta.url))],
            {stdout: 'pipe', stderr: 'pipe', timeout: 40000, env: {...process.env, HYPERION_WIRE_PROFILE: profileId}});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stdout: stdout.slice(-5000), stderr}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, profileId, proofRoutes: 2, gatedRoutes: 4, decodedRequests: 16,
            liveActionProof: true, historicalActionProof: true, boundedOrderedLive: true, shardCleanup: true, decodedMembershipUnavailable: true,
            nodeKeyCache: true, rootStruct: true, primitiveRoots: true, timestampAction: true, standardCompaction: true, httpCancellation: true,
            awaitFence: true, cacheFence: true, rawStreams: true, metadataHidden: true,
            unqualifiedRowsUnavailable: true, transportQualification: false});
    }, 45000);
}
