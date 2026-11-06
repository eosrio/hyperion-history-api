import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('native existing worker control and Fastify final publication fence stateful owner responses', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./stateful-host-native.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 60000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    const result = JSON.parse(stdout); expect(result.cases).toBe(12); expect(result.actualFastifyInject).toBe(true);
    expect(result.existingWorkerProbeMethod).toBe(true); expect(result.managedLifecycle).toBe(true);
    expect(result.exactSocketAndWorker).toBe(true); expect(result.finalOnSendFencing).toBe(true);
    expect(result.sharedHeaders).toBe(true); expect(result.serializationBudget).toBe(true);
    expect(result.heldDeadlineFenced).toBe(true); expect(result.requestAbortFenced).toBe(true);
    expect(result.originalFrameFencePreserved).toBe(true); expect(result.freshFrameReconciled).toBe(true);
    expect(result.monotonicSerializationDeadline).toBe(true); expect(result.requestStartDeadline).toBe(true);
    expect(result.services).toBe(false); expect(result.physicalWireMongoQualification).toBe(false); expect(result.originalAtomicHttpParity).toBe(false);
}, 65000);
