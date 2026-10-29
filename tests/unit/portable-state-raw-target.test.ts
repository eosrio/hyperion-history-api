import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('native emitted source admits original target references before missing capture and keeps owner/error fences', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./portable-state-raw-target.mjs', import.meta.url))],
    {stdout: 'pipe', stderr: 'pipe', timeout: 60000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    const result = JSON.parse(stdout);
    expect(result.cases).toBe(6); expect(result.actualEmittedSource).toBe(true);
    expect(result.beforeSelectionAdmission).toBe(true); expect(result.missingSelectionRefused).toBe(true);
    expect(result.unknownAdmissionStopsReads).toBe(true); expect(result.revokedOwnerRefused).toBe(true);
    expect(result.fencedBeforeAdmissionRefused).toBe(true); expect(result.heldAdmissionPhysicallyDrained).toBe(true);
    expect(result.services).toBe(false); expect(result.durableRawAdmission).toBe(false);
    expect(result.productionCompoundOwner).toBe(false); expect(result.fullParity).toBe(false);
}, 65000);
