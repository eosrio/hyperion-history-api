import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

// The router reports the newest streamed block as the API's live boundary, so a bulk block must never reach it.
test('only live deserializers stream block headers to the router', async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./deserializer-light-block-stream-fixture.ts', import.meta.url))],
        {stdout: 'pipe', stderr: 'pipe', timeout: 5000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stderr, stdout: stdout.slice(-8000)}).toMatchObject({code: 0, stderr: ''});
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.counts).toEqual({'live': 1, 'bulk': 0, 'unset-mode': 0, 'live-before-router': 0, 'live-without-block': 0});
    expect(result.published).toEqual([{queue: 'wax:stream', event: 'block', blockNum: 10,
        body: {block_num: 10, block_id: 'id10', producer: 'p', schedule_version: 1}}]);
    expect(result.noChannel).toBe('skipped');
}, 10000);
