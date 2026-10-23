import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const mode of ['scope', 'snapshot', 'end-identity', 'proof', 'publication', 'wire-cache', 'wire-roles',
    'wire-no-effects', 'wire-traces-disabled', 'projection', 'projection-fence', 'projection-admission-fence',
    'projection-init-fence', 'fork-and-expiry', 'target', 'source-continuations']) test(`actual attempt lifecycle preserves ${mode} ownership`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-attempt-quiescence-worker.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: mode.startsWith('wire-') ? 45_000 : 15_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (process.env.HYPERION_QUALIFICATION_OUTPUT) await Promise.all([
        Bun.write(`${process.env.HYPERION_QUALIFICATION_OUTPUT}/local-${mode}.stdout.log`, stdout),
        Bun.write(`${process.env.HYPERION_QUALIFICATION_OUTPUT}/local-${mode}.stderr.log`, stderr)]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true,
        mode, capacityAuthority: false, fullWorkerQualification: false});
}, 60_000);

for (const mode of ['retry', 'disconnect', 'unknown', 'main-ingress', 'headers', 'ds-unadmitted', 'shutdown']) test(`native worker IPC preserves ${mode} lifetime`, async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-attempt-ipc.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15_000});
    const [code, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (process.env.HYPERION_QUALIFICATION_OUTPUT) await Promise.all([
        Bun.write(`${process.env.HYPERION_QUALIFICATION_OUTPUT}/ipc-${mode}.stdout.log`, stdout),
        Bun.write(`${process.env.HYPERION_QUALIFICATION_OUTPUT}/ipc-${mode}.stderr.log`, stderr)]);
    expect({code, stderr, stdout: stdout.slice(-16000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed: true,
        mode, ownedProcessesOnly: true, capacityAuthority: false, fullWorkerQualification: false});
}, 20_000);
