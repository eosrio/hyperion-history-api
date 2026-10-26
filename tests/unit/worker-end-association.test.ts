import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test.each(['invalid-binding', 'invalid-descriptor', 'invalid-operation', 'invalid-summary', 'invalid-root-result',
    'invalid-ack', 'late-failure', 'valid', 'lost-reply', 'mutating-sink', 'sink-failure'])(
    'native original end association remains unchanged and observable: %s', async mode => {
        const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./worker-end-association.mjs', import.meta.url)), mode],
        {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr}).toEqual({code: 0, stderr: ''});
        expect(JSON.parse(stdout)).toMatchObject({passed: true, mode, actualManagedIpc: true,
            originalRunRejectionPreserved: true, productionCauseIdentified: false, fullWorkerQualification: false});
    }, 20000);

test('end observation preserves original callbacks, getters and explicit failed-capture bounds', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-end-controls.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(JSON.parse(stdout)).toMatchObject({passed: true, originalOutcomesPreserved: true,
        omittedFailuresExplicit: true, controlledCallbacksOnly: true, productionAuthority: false});
}, 15000);

test('malformed end summaries never retain issued credentials in diagnostic operands', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-end-privacy.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(JSON.parse(stdout)).toMatchObject({passed: true, variants: 23, issuedCredentialsExcluded: true,
        originalOutcomesPreserved: true, controlledCallbacksOnly: true, productionAuthority: false});
}, 15000);
