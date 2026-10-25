import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['handoff', 'empty', 'missing']) test('original builtin Antelope attempt has source-bound ' + mode + ' evidence', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./antelope-attempts.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({passed: true, mode, originalAntelopeCallbacks: true, builtinNativeAddon: true,
        actualMasterAdjudicator: true, samePhysicalFreshReceiptAndEnd: true, brokerSettlement: 'unknown',
        controlledSourceStorageRpcTransport: true, capacityAuthority: false, releaseQualified: false});
    expect(result.producer).toMatchObject({protocolId: 'antelope', profileId: 'antelope-default-v1'});
    expect(result.runtime.node).toMatch(/^v(?:24|26)\./);
    expect(result.runtime.executableSha256).toMatch(/^[0-9a-f]{64}$/);
    if (mode === 'handoff') expect(result.guards).toEqual(['current-configuration', 'physical-target-uuid',
        'canonical-block-identity', 'reversible-without-source-selection', 'configuration-changed-during-actual-target-read']);
}, 35_000);
