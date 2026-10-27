import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['components', 'facts', 'source-mode', 'master-source']) test('builtin Antelope source capability: ' + mode, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./antelope-source-provider.mjs', import.meta.url)), mode],
        {stdout: 'pipe', stderr: 'pipe', timeout: 10_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout: stdout.slice(-12000), stderr}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim())).toMatchObject({passed: true, mode, builtinAntelope: true,
        constructedControls: true, sourceAuthority: false, capacityAuthority: false, releaseQualified: false});
}, 15_000);
