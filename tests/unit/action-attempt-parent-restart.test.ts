import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['main', 'handoff']) test(`actual parent restart cannot reconstruct the original Wire ${scenario} attempt`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-parent-restart.mjs', import.meta.url)), scenario],
    {stdout: 'pipe', stderr: 'pipe', timeout: 60_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16_000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, scenario,
        actualParentExit: {signal: 'SIGKILL'}, originalWorkerExitedBeforeParent: true,
        originalResultRetained: true, priorEndNotReissued: true, newReadOnlyAttemptUnresolved: true,
        newFreshConditionalWriteAssociated: true, brokerSettlement: 'unknown', controlledBackend: true,
        liveRestartQualification: false});
}, 65_000);
