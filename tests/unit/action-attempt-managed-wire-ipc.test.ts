import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['main','main-held-write','main-failed-write','main-ack-throws','main-held-operation','main-held-end','main-failed-end',
    'main-held-adjudication','main-unknown-association','ds','contract','handoff',
    'handoff-held-confirm','handoff-failed-confirm','handoff-held-drain','handoff-failed-drain']) test(`original Wire ${mode} callback reaches the managed native parent adjudicator`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-managed-wire-ipc.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 40_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    if (mode === 'main-failed-end') {
        expect(result).toMatchObject({passed: true, mode, managedParentEnd: true,
            durableResultAndAckBeforeMissingEnd: true, authenticatedQuiescentEnd: false,
            endOnlyAtObservedExit: true, noAssociation: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        return;
    }
    if (mode === 'main-failed-write') {
        expect(result).toMatchObject({passed: true, mode, managedParentEnd: true,
            failedWriteNoAck: true, noFreshWriteOrAssociation: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        return;
    }
    if (mode === 'handoff-failed-confirm' || mode === 'handoff-failed-drain') {
        expect(result).toMatchObject({passed: true, mode, managedParentEnd: true,
            failedConfirmNoAck: mode === 'handoff-failed-confirm',
            confirmedButFailedDrainNoAck: mode === 'handoff-failed-drain',
            noFreshWriteOrAssociation: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        return;
    }
    if (mode === 'main-ack-throws') {
        expect(result).toMatchObject({passed: true, mode, managedParentEnd: true,
            durableResultBeforeAckAttempt: true, originalAckCount: 0,
            acknowledgementAttempted: true, noAssociation: true,
            brokerSettlement: 'unknown', fullWorkerQualification: false});
        return;
    }
    expect(result).toMatchObject({passed: true,
        mode, managedParentEnd: true, writeBeforeAckBeforeEnd: true, originalAckCount: 1,
        classification: mode.startsWith('main') ? 'source-incomplete'
            : mode === 'ds' ? 'intentional-no-effect' : mode === 'contract' ? 'contract-incomplete' : 'confirmed-handoff',
        brokerSettlement: 'unknown', fullWorkerQualification: false});
    if (mode === 'main-held-write') expect(result).toMatchObject({heldWriteBeforeObservation: true});
    if (mode === 'main-held-operation') expect(result).toMatchObject({heldOperationAcrossAckAndRoot: true});
    if (mode === 'main-held-end') expect(result).toMatchObject({heldEndBeforeAssociation: true});
    if (mode === 'main-held-adjudication') expect(result).toMatchObject({heldAdjudicationBeforePersistence: true,
        unrelatedWorkerProgressDuringHold: true});
    if (mode === 'main-unknown-association') expect(result).toMatchObject({unknownAssociationWrite: true,
        failedAdjudicationIsolated: true, unrelatedWorkerProgressDuringFailure: true,
        primaryVisibleInspectionOnly: true, restartCannotReissueEnd: true, freshRetryReceiptRequired: true});
    if (mode === 'handoff-held-confirm' || mode === 'handoff-held-drain')
        expect(result).toMatchObject({heldPublishBeforeObservation: true});
}, 45_000);
