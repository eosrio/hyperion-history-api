import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['reversible', 'abi-behind', 'anchor', 'current-confirm', 'retired-socket', 'retired-context', 'retired-checkpoint'])
    test('original reader keeps publication progress separate from ABI coverage: ' + mode, async () => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./reader-coordinator-resume.mjs', import.meta.url)), mode],
        {stdout: 'pipe', stderr: 'pipe', timeout: 10_000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stdout, stderr}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, mode, capacityAuthority: false, releaseQualified: false});
    }, 15_000);
