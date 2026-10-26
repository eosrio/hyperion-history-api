import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('the same held original Wire DS input yields one verified accounting transition', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)),
        'handoff-held-confirm', '--shadow-transition'], {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-6000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true,
        mode: 'handoff-held-confirm', shadowTransition: true, managedParentEnd: true,
        heldPublishBeforeObservation: true, writeBeforeAckBeforeEnd: true,
        verifiedDsTransitionCallbacks: 1, classification: 'confirmed-handoff',
        brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);

test('missing original header bytes stay unknown and charged after the verified Wire end', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)),
        'handoff-held-confirm', '--shadow-missing-headers'], {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true,
        missingHeaderAccounting: true, verifiedDsTransitionCallbacks: 1,
        accountingBefore: {accounting: 'incomplete', pendingDemands: 1, knownPendingBytes: 1369, unknownPendingHeaders: 1},
        accountingAfter: {accounting: 'incomplete', pendingDemands: 1, resolvedDemands: 0,
            knownPendingBytes: 1369, unknownPendingHeaders: 1},
        originalAckCount: 1, brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);

for (const mode of ['handoff-late-source-manifest', 'handoff-unknown-association'])
    test(`original Wire ${mode} cannot issue a transition until a fresh current reassertion`, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)), mode, '--shadow-transition'],
        {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
        const [code, stdout, stderr] = await Promise.all([child.exited,
            new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
        expect(result).toMatchObject({passed: true, mode, shadowTransition: true, verifiedDsTransitionCallbacks: 1,
            originalAckCount: 1,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        if (mode === 'handoff-late-source-manifest') expect(result).toMatchObject({lateAuthorityRejected: true,
            transitionCallbacksBeforeRecovery: 0, retainedRecordInspectionOnly: true, freshReassertionReceiptRequired: true});
        else expect(result).toMatchObject({unknownAssociationWrite: true, primaryVisibleInspectionOnly: true,
            restartCannotReissueEnd: true, freshRetryReceiptRequired: true});
    }, 45_000);

test('shadow accounting retains the actual held Wire input until its original verified transition', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)),
        'handoff-held-confirm', '--shadow-accounting'], {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true,
        shadowAccounting: true, heldPublishBeforeObservation: true, verifiedDsTransitionCallbacks: 1,
        accountingBefore: {observationOnly: true, retainedDemands: 1, pendingDemands: 1,
            resolvedDemands: 0, unknownPendingHeaders: 0},
        accountingAfter: {observationOnly: true, retainedDemands: 1, pendingDemands: 0,
            resolvedDemands: 1, knownPendingBytes: 0, unknownPendingHeaders: 0},
        originalAckCount: 1, brokerSettlement: 'unknown', fullWorkerQualification: false});
}, 45_000);
