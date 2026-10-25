import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['unchanged', 'advance-anchor', 'advance-block', 'refresh-block', 'offline', 'replace-anchor',
    'replace-block', 'retire-block', 'disconnect-block', 'withdraw-block', 'regress-block', 'conflict-block', 'shutdown-block', 'unlisted-block',
    'source-steady-block', 'source-advance-block', 'source-replaced-block', 'source-revoked-block', 'source-generation-block', 'source-missing-initial',
    'coordinator-fork-block', 'coordinator-revoked-block', 'advanced-regress', 'advanced-conflict', 'advance-twice', 'advanced-refresh'])
test(`native canonical RPC completion preserves current reader authority: ${scenario}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-canonical-reader-fencing.mjs', import.meta.url)), scenario],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, scenario, actualMasterCallback: true,
        nativeReaderIdentities: true, controlledRpcAndHandover: true, controlledSourceLifecycle: true,
        capacityAuthority: false, fullWorkerQualification: false});
}, 20000);
