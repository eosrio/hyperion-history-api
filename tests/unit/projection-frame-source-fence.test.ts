import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['owned', 'ordinary', 'foreign', 'copied'])
test(`native late projection source fence preserves error authority: ${scenario}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL(process.env.HYPERION_NATIVE_SOURCE_PROFILE === 'stateful-all-cbfb-root-native-wire34-linux-engineering-v1' ? './wire34-cbfb-projection-frame-source-fence.mjs' : './projection-frame-source-fence.mjs', import.meta.url)), scenario],
    {stdout: 'pipe', stderr: 'pipe', timeout: 20000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout: stdout.slice(-12000), stderr}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, scenario,
        originalSourceAndManagedFrame: true, originalRevalidationCallback: true, noPostFenceSourceIO: true,
        authenticDrainedEnd: true, fullWorkerQualification: false});
}, 25000);
