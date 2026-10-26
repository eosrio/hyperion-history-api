import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

async function native(script: string, mode?: string) {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL(script, import.meta.url)), ...(mode ? [mode] : [])],
    {stdout: 'pipe', stderr: 'pipe', timeout: 20000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
}

test.each(['projection', 'cleanup-error', 'copied-error', 'primitive', 'sink-failure', 'ds', 'legacy'])(
    'original failure path preserves exit and exact error custody: %s', async mode => {
        expect(await native('./worker-failure-lineage.mjs', mode)).toMatchObject({
            passed: true, scenario: mode, originalExitCode: mode === 'legacy' ? 0 : 1,
            controlledServices: true, faultMembership: false});
    }, 25000);

test('original master delay and real cluster callbacks retain exact replacement lineage', async () => {
    expect(await native('./worker-failure-replacement.mjs')).toMatchObject({passed: true,
        originalExit: 1, replacementExit: 0, actualClusterCallbacks: true, originalRelaunchDelayMs: 5000, faultMembership: false});
}, 25000);

test('controlled return/promise/copy/budget controls cannot create a root association', async () => {
    expect(await native('./worker-failure-controls.mjs')).toMatchObject({passed: true,
        controlledCallbacksOnly: true, physicalFaultEvidence: false});
}, 25000);

test('original scope assimilates thenables and getter failures once with unchanged outcomes', async () => {
    expect(await native('./worker-failure-thenable.mjs')).toMatchObject({passed: true,
        controlledLocalOnly: true, productionAuthority: false});
}, 25000);
