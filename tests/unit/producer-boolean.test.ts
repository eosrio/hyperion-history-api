import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('built-in producer handler normalizes only canonical numeric booleans, including captured Wire input', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./producer-boolean-worker-fixture.ts', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-5000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, actualHandler: true, capturedBlock: 337,
        canonicalCases: 4, malformedCases: 15, sourceUnchanged: true, nativeQualification: false});
}, 35_000);
