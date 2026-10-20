import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('actual admitted native cargo failures supervise replacement without acknowledging or resuming stale work', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./action-source-cargo-failure-fixture.ts', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, actualConstructorCargo: true,
        nativeProtocolPath: true, nativeQualification: false, checks: [
            {replacedConsumer: false, supervisedExit: true, staleCargoDropped: true},
            {replacedConsumer: true, supervisedExit: true, staleCargoDropped: true}]});
}, 10000);
