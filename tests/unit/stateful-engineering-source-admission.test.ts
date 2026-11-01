import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('native engineering source option checks exact artifacts and leaves the default path closed to overrides', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', fileURLToPath(new URL('./stateful-complete-kind-source-admission-native.mjs', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 60000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, error: code ? stderr : undefined}).toEqual({code: 0, error: undefined});
    const result = JSON.parse(stdout); expect(result.cases).toBe(42); expect(result.sealedEngineeringOption).toBe(true);
    expect(result.default716Preserved).toBe(true); expect(result.artifactAndSourceSetChecked).toBe(true);
    expect(result.unknownRevisionPackageTreeArtifactRefused).toBe(true); expect(result.defaultOverrideRefusedBeforeEffects).toBe(true);
    expect(result.services).toBe(false); expect(result.defaultDistributionQualified).toBe(false); expect(result.launchQualified).toBe(false);
}, 65000);
