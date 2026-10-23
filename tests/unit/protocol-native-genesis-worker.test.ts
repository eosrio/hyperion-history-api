import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('actual Wire native genesis crosses the production parser, canonical proof and projection checkpoint seams', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-genesis-worker.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 30000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-3000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, originalCapture: true,
        nativeGenesis: true, parserAckAfterDurability: true, checkpoint: 4, fullWorkerQualification: false});
}, 35000);
