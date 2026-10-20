import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('controlled production prototypes retain source, stage complete action batches and isolate incomplete work', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./action-source-admission-worker-fixture.ts', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-10_000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true,
        fixture: 'source-prototype-controlled-codec-client-channels', nativeQualification: false, consensusValidation: false,
        checks: ['reader-retention-and-original-schema', 'complete-staging-byte-equality', 'confirmed-original-owner-fanout',
            'empty-and-excluded-membership', 'invalid-output-scoped-incomplete', 'hook-failure-and-unrelated-progress',
            'grouping-hook-corruption-and-unrelated-progress', 'post-hook-normalization-corruption-and-unrelated-progress',
            'main-source-delivery-snapshot-during-awaits', 'pool-delivery-snapshot-during-awaits',
            'wrong-body-and-headers-before-effects', 'original-channel-and-return-fences', 'uppercase-native-source-shape']});
}, 35_000);
