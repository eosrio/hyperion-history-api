import {expect, test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for (const scenario of ['socket-callbacks', 'legacy-socket-late-close', 'monitor', 'credits', 'bulk-credits', 'legacy-credits', 'coalesced-credits',
    'pause-during-confirm', 'resume-before-confirm', 'pause-during-drain', 'resume-before-drain',
    'pause-during-retention', 'reconnect-withheld', 'reconnect-during-confirm', 'legacy-queued-before-reconnect',
    'legacy-reconnect-during-drain', 'legacy-preopen-close', 'legacy-preopen-next-server', 'next-server', 'legacy-next-server', 'close-withheld', 'legacy-close-withheld', 'session-replacement', 'revoked-source', 'finish-cannot-resume', 'stop-cannot-resume', 'range-scheduling', 'failure-nack', 'failure-unknown-close']) {
    test(`native emitted reader backpressure: ${scenario}`, async () => {
        const child = Bun.spawn([process.env.READER_RECOVERY_NODE ?? process.env.HYPERION_NATIVE_NODE ?? 'node',
            fileURLToPath(new URL('./state-reader-live-backpressure.mjs', import.meta.url)), scenario],
        {stdout: 'pipe', stderr: 'pipe', timeout: 15_000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout: stdout.slice(-12000)}).toMatchObject({code: scenario.startsWith('failure-') ? 1 : 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, scenario,
            originalWireFrame: !scenario.startsWith('legacy') && scenario !== 'socket-callbacks', actualReaderMonitorAndEncoding: scenario !== 'socket-callbacks',
            actualSocketWrapper: scenario.includes('socket-'), controlledTransports: true, productionQualification: false});
    }, 20_000);
}
