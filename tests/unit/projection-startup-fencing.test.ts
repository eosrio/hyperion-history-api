import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['retry', 'success', 'foreign-fence', 'held-child', 'retire', 'disconnect', 'stop', 'lost-end', 'stale-end',
    'retire-after-end', 'ordinary-error', 'undefined-error', 'code-shaped-error', 'forged-error', 'exhaustion'])
test(`native projection initialization preserves recovery and revocation: ${scenario}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./projection-startup-fencing.mjs', import.meta.url)), scenario],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout: stdout.slice(-12000), stderr}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, scenario,
        physicalWorkers: 1, postFenceOldBackendCalls: 0, capacityAuthority: false, fullWorkerQualification: false});
}, 20000);
