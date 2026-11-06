import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const distance of [256, 257]) test(`genuine queued Wire action is ${distance === 256 ? 'consumable at' : 'incomplete beyond'} the default ancestry edge ${distance}`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./protocol-native-lag-replay.mjs', import.meta.url)), `--queued-proof-boundary=${distance}`],
    {stdout: 'pipe', stderr: 'pipe', timeout: 90_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-6000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({
        scenario: 'current-queued-native-proof-boundary', passed: true, sourceDistance: distance,
        sourceHead: distance === 256 ? 289 : 290, queuedBlock: 33, defaultAncestryBlocks: 256,
        originalPayloadSha256: '52ff71eac764d107780fca90bfda9dc60808402adc5e760db91a12443d12365c',
        originalGlobalSequence: '41', recoveredPersistedAssociation: false,
        publishedActions: distance === 256 ? 1 : 0, sealed: distance === 256,
        retainedIncomplete: distance === 256 ? 0 : 1, consumerAcknowledgments: 1,
        acceptedOriginalEnd: true, controlledBrokerStorage: true, controlledLifecycleTransport: true,
        brokerSettlement: 'unknown', fullWorkerQualification: false, productionPerformanceQualified: false,
    });
}, 95_000);
