import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['lifecycle', 'no-effects', 'traces-disabled', 'empty-vector']) test(`original Wire attempt observations retain truthful ${mode} work before ACK`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./action-attempt-disposition-worker.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 30_000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true, mode, controlledBrokerStorage: true, fullWorkerQualification: false});
}, 35_000);
