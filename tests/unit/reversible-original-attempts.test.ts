import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['baseline', 'revoke', 'late-rpc']) test('actual reversible native worker source survives ' + mode + ' control', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./reversible-original-attempts.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-20000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({passed: true, mode, actualMasterCoordinator: true, originalSeparateNativeWorkers: true,
        realReversibleReaderProbe: true, sourcePayloadUnchanged: true, constructedReversibleEnvelopesAndTransports: true,
        capacityAuthority: false, releaseQualified: false});
    expect(result.processes).toHaveLength(4);
    expect(result.processes.every((p: any) => p.exitCode === 0 && /^v(?:24|26)\./.test(p.node))).toBe(true);
    if (mode === 'revoke') expect(result.revoked).toMatchObject({peerAssociatedBeforeOriginalSettlement: true,
        conditionalWrites: 1, currentConfigurationAndTargetLateReadsRejected: true,
        recoveredOriginalDelivery: {sameCapturedSource: true, associatedBeforeOriginalSettlement: true,
            end: {binding: {blockNum: 33}, rootResult: 'returned', status: 'quiescent', acknowledgementAttempted: true}},
        oldEnd: {rootResult: 'threw', acknowledgementAttempted: false, status: 'quiescent'}});
    if (mode === 'late-rpc') expect(result.lateRpc).toMatchObject({oldCanonicalObservationRejected: true,
        sourceStillHasSameCanonicalBlockIdentity: true, oldEndUnresolvedAfterReplacement: true});
}, 35_000);
