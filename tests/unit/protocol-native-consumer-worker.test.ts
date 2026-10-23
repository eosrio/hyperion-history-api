import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('emitted native workers preserve original Wire values through source admission, confirmed bytes, cache and stream fences', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-consumer-worker.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 150_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16_000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({passed: true, originalBlocks: 397, originalWireSource: true, sourceAdmission: true,
        installedNativeActivation: false, fullWorkerQualification: false, unknownAbiIndependent: true,
        tamperedOutputRawIncomplete: true, finalConfirmRevocationFenced: true, nativeAddonResolutions: 0});
    expect(result.nativeActions.map((action: any) => action.blockNum)).toEqual([33, 122, 397]);
}, 155_000);

test('emitted native worker isolates certified incomplete origins and preserves independent inline/grouped notifications', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-consumer-isolation.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12_000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, syntheticProtocol: true,
        incompleteOriginIsolated: true, certifiedNotificationGrouping: true, independentInlineOrigin: true,
        unknownAbiIndependent: true, tamperedNativeRawIncomplete: true, publicSerializationIsolated: true,
        finalCacheRevocationFenced: true, canonicalCapabilityDowngradeRefused: true,
        nativeAbiFallback: false, liveQualification: false});
}, 35_000);
