import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('native worker paired opening retains reader/scope/source/window/native-byte and physical-drain controls', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-worker-pair.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 90_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: 0, stderr: ''});
}, 95_000);

test('actual emitted DS opens original Wire source once while preserving confirmed bytes and source ACK fences', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-consumer-worker.mjs', import.meta.url)), '--measure-proof-pair'],
    {stdout: 'pipe', stderr: 'pipe', timeout: 150_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: 0, stderr: ''});
    const measurement = stdout.split('\n').find(line => line.startsWith('{"scenario":"actual-ds-original-wire-proof-pair"'));
    expect(JSON.parse(measurement!)).toMatchObject({businessOraclesPassed: true, expectedOpeningWalks: 1,
        actualPinnedClientHttpDocumentGets: true, controlledImmutableCasStorage: true, liveQualification: false});
}, 155_000);
