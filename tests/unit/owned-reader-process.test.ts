import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['unchanged', 'wrong-directory', 'wrong-title', 'changed-title', 'disconnected', 'copied-token',
    'copied-receipt', 'consumed-token', 'disabled'])
test.skipIf(process.platform !== 'linux')(`native owned reader fault preserves ownership: ${scenario}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./owned-reader-process.mjs', import.meta.url)), scenario],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim())).toMatchObject({passed: true, scenario, actualNativeReader: true,
        masterPreserved: true, capacityAuthority: false, productionHandoverQualified: false});
}, 20000);
