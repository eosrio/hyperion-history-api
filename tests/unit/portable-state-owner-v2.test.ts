import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('native emitted mixed source and owner repair preserve raw KV and exact candidate custody', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./portable-state-owner-v2.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 60000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    const result = JSON.parse(stdout);
    expect(result.cases).toBe(6); expect(result.actualEmittedSource).toBe(true); expect(result.actualOwnerRuntime).toBe(true);
    expect(result.immutableCandidateCustody).toBe(true); expect(result.applyBeforeRetireRecovered).toBe(true);
    expect(result.selectedActionsAndKv).toBe(true); expect(result.scopeInvented).toBe(false); expect(result.reducerRerun).toBe(false);
    expect(result.unknownAdmissionFenced).toBe(true); expect(result.unknownAdmissionColdRepaired).toBe(true);
    expect(result.coherentNormalInflightEligible).toBe(true);
    expect(result.services).toBe(false); expect(result.productionWorkerControl).toBe(false); expect(result.physicalDomainParity).toBe(false);
}, 65000);
