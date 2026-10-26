import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test.each(['active', 'source-open', 'channel-close', 'retire', 'deferred', 'copied', 'stale',
    'control', 'unrelated-error', 'bounded', 'sink-failure'])('native fence origin preserves original lifecycle: %s', async mode => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-fence-origin.mjs', import.meta.url)), mode],
    {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim())).toMatchObject({passed: true, scenario: mode, controlledStorageAndChannels: true, sourceAuthority: false});
}, 20000);

test('controlled callback controls preserve member chunks, first origin, independent owners and original results', async () => {
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',
        fileURLToPath(new URL('./worker-fence-callbacks.mjs', import.meta.url))], {stdout: 'pipe', stderr: 'pipe', timeout: 15000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr}).toEqual({code: 0, stderr: ''});
    expect(JSON.parse(stdout.trim())).toMatchObject({passed: true, controlledCallbacksOnly: true, physicalIpcOrExitEvidence: false, chunks: 2});
}, 20000);
