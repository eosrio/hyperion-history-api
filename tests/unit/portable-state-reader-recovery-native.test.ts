import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['unchanged', 'copied-snapshot', 'copied-receipt', 'consumed-snapshot', 'wrong-run', 'changed-title', 'extra-failure'])
test.skipIf(process.platform !== 'linux')(`native reader recovery controller preserves scope: ${scenario}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./portable-state-reader-recovery-native.mjs', import.meta.url)), scenario],
    {stdout: 'pipe', stderr: 'pipe', timeout: 25000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, scenario,
        realNativeIpcAndProcesses: true, controlledParentState: true, capacityAuthority: false, productionHandoverQualified: false});
}, 30000);
