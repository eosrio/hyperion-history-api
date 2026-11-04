import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('deserializer cargo progresses healthy batches and supervises failed batch owners', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./deserializer-queue-fixture.ts', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, actualConstructorCargo: true, checks: [
        'live-healthy-batches-progress', 'bulk-healthy-batches-progress',
        'legacy-live-supervised-exit-without-resuming', 'legacy-bulk-supervised-exit-without-resuming',
        'disconnected-supervised-exit-without-resuming', 'missing-channel-supervised-exit-without-resuming'
    ]});
}, 10000);

test('decode failure terminates the original consumer before an in-transit delivery can be ACKed', async () => {
    for (const mode of ['live', 'bulk']) {
        const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./deserializer-late-delivery-fixture.ts', import.meta.url)), `--${mode}`],
            {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 1, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({mode, code: 1,
            deliveries: [1, 2], parsed: [1], acked: [], nacked: [], queuedAtFailure: 1, ready: false, lateCompleted: false});
    }
}, 15000);

test('4.5 protocol and admitted-source failures still supervise replacement without resuming cargo', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./deserializer-queue-fixture.ts', import.meta.url)), '--protocol'],
        {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, actualConstructorCargo: true, checks: [
        'live-healthy-batches-progress', 'bulk-healthy-batches-progress',
        'legacy-live-supervised-exit-without-resuming', 'legacy-bulk-supervised-exit-without-resuming',
        'disconnected-supervised-exit-without-resuming', 'missing-channel-supervised-exit-without-resuming',
        'usesExtensionProtocol-supervised-exit-without-resuming', 'actionSourceAdmissionEnabled-supervised-exit-without-resuming'
    ]});
}, 10000);
