import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('actual MainDS retains native source evidence before the original channel ACK', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./protocol-native-observation-worker.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 30000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-3000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, journalBeforeAck: true,
        nativeActivation: false, fullWorkerQualification: false});
}, 35000);
