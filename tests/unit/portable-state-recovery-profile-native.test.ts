import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['profile', 'prefix-deadline']) test(`native recovery profiling control: ${mode}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./portable-state-recovery-profile-native.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-4000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({passed: true, mode, serviceExecution: false, fullQualification: false});
    expect([24, 26]).toContain(result.major);
}, 20_000);
