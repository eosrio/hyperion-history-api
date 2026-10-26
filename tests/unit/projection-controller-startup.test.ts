import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const stage of ['connect', 'initialize', 'initialize-retained', 'initialize-error', 'initialize-foreign', 'initialize-mutating',
    'frame-read', 'frame-control', 'diagnostic-failure', 'bounded'])
test(`native original projection controller startup: ${stage}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./projection-controller-startup.mjs', import.meta.url)), stage],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout: stdout.slice(-12000), stderr}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, stage,
        originalControllerAndSource: true, noPostFenceEffects: true, fullWorkerQualification: false});
}, 20000);
