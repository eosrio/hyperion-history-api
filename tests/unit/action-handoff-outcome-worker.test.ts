import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('original installed Wire DS work persists confirmed handoff before its original ACK', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-handoff-outcome-worker.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, originalBlocks: 39, lifecycleCases: [
        'confirm-drain-write-ack',
        'fresh-ticket-round-robin-retry',
        'opaque-and-routing-negatives',
        'changed-root-conflict',
        'unknown-primary-visible-no-ack-fresh-repair',
        'final-io-error-bypasses-contract-catch-unrelated-progress',
        'original-two-effect-partial-confirm-no-outcome',
        'consumer-change-across-outcome-write-no-ack',
        'publisher-change-across-outcome-write-no-ack',
        'configuration-change-across-outcome-write-no-ack',
        'target-change-across-outcome-write-no-ack',
        'configuration-change-during-last-target-check-no-ack',
        'original-caller-mutation-retains-sent-outcome-hashes',
        'record-count-and-sum-before-copies',
        'abort-across-outcome-write-rejects',
        'four-operation-leases-fifth-refusal-failure-release',
        'operator-disabled-indexing-no-success-outcome',
        'operator-excluded-original-work-no-success-outcome',
        'constructed-contract-hook-incomplete-isolated-no-success-outcome',
        'original-contract-proof-revoked-across-outcome-write-no-ack',
    ],
        normalInstalledNativeProvider: true, originalArchiveSha256: '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7',
        outcomeBeforeOriginalAck: true, confirmDrainWriteAckOrder: ['confirm', 'drain', 'outcome-write', 'outcome-receipt', 'source-ack'], controlledBrokerStorage: true, fullWorkerQualification: false});
}, 35_000);
