import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('installed native Wire profile preserves independent original action source membership and exact profile identity', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-source-inventory-native.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12_000)}).toMatchObject({code: 0, stderr: ''});
    const report = JSON.parse(stdout.trim());
    expect(report).toMatchObject({passed: true, profileId: 'wire-sysio-6508c9e8-native-engineering-v1',
        installedNativeActivation: true, originalArchiveMembers: 1488, legacyProfilesNativeInactive: true,
        genesisIncomplete: true, syntheticLocatorIds: true, nativeAuthorizationQualification: false, fullWorkerQualification: false});
    expect(report.nativeActions.map((action: {blockNum: number}) => action.blockNum)).toEqual([33, 122, 397]);
    expect(report.controls).toHaveLength(24);
}, 35_000);
