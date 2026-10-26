import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';

async function runNativeCase(worker: string, mode: string, ...flags: string[]) {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL(worker, import.meta.url)), mode, ...flags],
    {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (process.env.HYPERION_PROOF_DEMAND_EVIDENCE_DIR) appendFileSync(resolve(process.env.HYPERION_PROOF_DEMAND_EVIDENCE_DIR,
        'native-case-results.jsonl'), JSON.stringify({mode, flags, pid: child.pid,
            runtimeRequested: process.env.HYPERION_NATIVE_NODE ?? 'node', code, stdout, stderr}) + '\n');
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

function runOriginalWireNativeCase(mode: string, ...flags: string[]) {
    return runNativeCase('./action-attempt-managed-wire-ipc.mjs', mode, ...flags);
}

test('native receipt capture copies the checked view without conversion or layout hooks', async () => {
    const result = await runNativeCase('./action-proof-demand-copy-worker.mjs', 'payload-copy');
    expect(result).toMatchObject({passed: true, hooks: 0, originalPayloadBytes: 2,
        redirectedBytesNeverCopied: 128 * 1024, fullWorkerQualification: false,
        cases: ['ordinary-offset-buffer', 'own-conversion-buffer', 'inherited-conversion-view', 'inherited-layout-view']});
}, 10_000);

test('the same held original Wire DS input yields one verified accounting transition', async () => {
    const result = await runOriginalWireNativeCase('handoff-held-confirm', '--shadow-transition');
    expect(result).toMatchObject({passed: true,
        mode: 'handoff-held-confirm', shadowTransition: true, managedParentEnd: true,
        heldPublishBeforeObservation: true, writeBeforeAckBeforeEnd: true,
        verifiedDsTransitionCallbacks: 1, classification: 'confirmed-handoff',
        brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);

for (const flag of ['', '--receipt-registration-holds', '--receipt-late-capture', '--receipt-late-binding', '--receipt-worker-unavailable'])
test(`the original native consume callback automatically enrolls custody before DS cargo entry ${flag}`, async () => {
    const result = await runOriginalWireNativeCase('handoff-held-confirm', '--receipt-bridge', ...(flag ? [flag] : []));
    expect(result).toMatchObject({passed: true, receiptBridge: true, originalAckCount: 1,
        brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);

test('missing original header bytes stay unknown and charged after the verified Wire end', async () => {
    const result = await runOriginalWireNativeCase('handoff-held-confirm', '--shadow-missing-headers');
    expect(result).toMatchObject({passed: true,
        missingHeaderAccounting: true, verifiedDsTransitionCallbacks: 1,
        accountingBefore: {accounting: 'incomplete', pendingDemands: 1, knownPendingBytes: 1369, unknownPendingHeaders: 1},
        accountingAfter: {accounting: 'incomplete', pendingDemands: 1, resolvedDemands: 0,
            knownPendingBytes: 1369, unknownPendingHeaders: 1},
        originalAckCount: 1, brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);

for (const mode of ['handoff-late-source-manifest', 'handoff-unknown-association'])
    test(`original Wire ${mode} cannot issue a transition until a fresh current reassertion`, async () => {
        const result = await runOriginalWireNativeCase(mode, '--shadow-transition');
        expect(result).toMatchObject({passed: true, mode, shadowTransition: true, verifiedDsTransitionCallbacks: 1,
            originalAckCount: 1, brokerSettlement: 'unknown', fullWorkerQualification: false});
        if (mode === 'handoff-late-source-manifest') expect(result).toMatchObject({lateAuthorityRejected: true,
            transitionCallbacksBeforeRecovery: 0, retainedRecordInspectionOnly: true, freshReassertionReceiptRequired: true});
        else expect(result).toMatchObject({unknownAssociationWrite: true, primaryVisibleInspectionOnly: true,
            restartCannotReissueEnd: true, freshRetryReceiptRequired: true});
    }, 45_000);

test('shadow accounting retains the actual held Wire input until its original verified transition', async () => {
    const result = await runOriginalWireNativeCase('handoff-held-confirm', '--shadow-accounting');
    expect(result).toMatchObject({passed: true,
        shadowAccounting: true, heldPublishBeforeObservation: true, verifiedDsTransitionCallbacks: 1,
        accountingBefore: {observationOnly: true, retainedDemands: 1, pendingDemands: 1,
            resolvedDemands: 0, unknownPendingHeaders: 0},
        accountingAfter: {observationOnly: true, retainedDemands: 1, pendingDemands: 0,
            resolvedDemands: 1, knownPendingBytes: 0, unknownPendingHeaders: 0},
        originalAckCount: 1, brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);
