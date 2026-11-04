import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('deserializer cargo recovers live/bulk and supervises failed broker requeue', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./deserializer-queue-fixture.ts', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, actualConstructorCargo: true, checks: [
        'live-redelivery-progress-without-stale-tags', 'bulk-redelivery-progress-without-stale-tags',
        'disconnected-releases-cargo', 'amqplib-write-failure-supervised-exit-without-resuming',
        'amqplib-closing-channel-supervised-exit-without-resuming'
    ]});
}, 10000);
