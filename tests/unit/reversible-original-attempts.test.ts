import {expect, test} from 'bun:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

for (const sourceFamily of ['wire', 'antelope']) for (const mode of ['baseline', 'revoke', 'late-rpc'])
test('actual reversible native ' + sourceFamily + ' worker source survives ' + mode + ' control', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hyperion-reversible-evidence-')), node = process.env.HYPERION_NATIVE_NODE ?? 'node';
    try {
        const evidence = join(directory, mode + '.json');
        const child = Bun.spawn([node, fileURLToPath(new URL('./reversible-original-attempts.mjs', import.meta.url)), mode, evidence, sourceFamily],
            {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-20000)}).toMatchObject({code: 0, stderr: ''});
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
        expect(result).toMatchObject({passed: true, mode, sourceFamily, actualMasterCoordinator: true, originalSeparateNativeWorkers: true,
            realReversibleReaderProbe: true, sourcePayloadUnchanged: true, constructedReversibleEnvelopesAndTransports: true,
            capacityAuthority: false, releaseQualified: false});
        expect(result.processes).toHaveLength(4);
        expect(result.processes.every((p: any) => p.exitCode === 0 && /^v(?:24|26)\./.test(p.node))).toBe(true);
        if (sourceFamily === 'antelope') expect(result.sourceNoEffects).toMatchObject({originalEncodedEmptyTraceVector: true,
            sourceBoundRetainedInput: true, end: {binding: {blockNum: 1}, rootResult: 'returned', status: 'quiescent'}});
        if (mode === 'revoke') expect(result.revoked).toMatchObject({peerAssociatedBeforeOriginalSettlement: true,
            conditionalWrites: 1, currentConfigurationAndTargetLateReadsRejected: true,
            recoveredOriginalDelivery: {sameCapturedSource: true, associatedBeforeOriginalSettlement: true,
                end: {binding: {blockNum: sourceFamily === 'wire' ? 33 : 2}, rootResult: 'returned', status: 'quiescent', acknowledgementAttempted: true}},
            oldEnd: {rootResult: 'threw', acknowledgementAttempted: false, status: 'quiescent'}});
        if (mode === 'late-rpc') expect(result.lateRpc).toMatchObject({oldCanonicalObservationRejected: true,
            sourceStillHasSameCanonicalBlockIdentity: true, oldEndUnresolvedAfterReplacement: true});
        const check = Bun.spawn([node, fileURLToPath(new URL('./reversible-worker-report-check.mjs', import.meta.url)), evidence],
            {stdout: 'pipe', stderr: 'pipe', timeout: 10_000});
        const [checked, output, errors] = await Promise.all([check.exited, new Response(check.stdout).text(), new Response(check.stderr).text()]);
        expect({code: checked, stdout: output.slice(-12000), stderr: errors}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(output.trim())).toMatchObject({passed: true, mode, originalEvidencePassed: true,
            originalStoreAndNativePartsUnchanged: true, originalProcessesRerun: false, coldWrites: 0, capacityAuthority: false, releaseQualified: false});
    } finally {
        assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, {recursive: true, force: true});
    }
}, 35_000);
