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


test.skipIf(process.platform !== 'linux' || process.env.HYPERION_NATIVE_SOURCE_PROFILE !== 'stateful-all-cbfb-root-native-wire34-linux-engineering-v1')(
    'actual emitted DS recovers a historical publication gap without replaying hooks, effects or ACKs', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-consumer-worker.mjs', import.meta.url)), '--worker-proof-recovery'],
    {stdout: 'pipe', stderr: 'pipe', timeout: 150_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: 0, stderr: ''});
    const result = stdout.split('\n').find(line => line.startsWith('{"passed":true'));
    const observed = JSON.parse(result!);
    expect(observed).toMatchObject({passed: true, workerProofRecovery: true, recoveryObserved: true, recoveryHooks: 1,
        originalWireSource: true, sourceAdmission: true, exactConfirmedBytes: true, unknownAbiIndependent: true,
        finalConfirmRevocationFenced: true, fullWorkerQualification: false});
    expect(observed.missingReads).toBeGreaterThan(0);
    expect(observed.historicalAddressReads).toBeGreaterThan(0);
    expect(observed.consumerOracleReads).toBeGreaterThan(0);
    expect(observed.consumerMissingReads).toBeGreaterThan(0);
    expect(observed.independentProducerStateReads).toBeGreaterThan(0);
}, 155_000);
