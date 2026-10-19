import {describe, expect, it} from 'bun:test';

// StateReader imports queue definitions that load configuration at module scope.
// Isolate that real import in a child, with owned temporary configuration and no
// worker construction or network connections. Production methods remain intact.
async function probe(body: string) {
    const source = new URL('../../src/indexer/workers/state-reader.ts', import.meta.url).href;
    const asyncSource = new URL('../../node_modules/async/dist/async.mjs', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import {EventEmitter} from 'node:events';
        import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
        import {tmpdir} from 'node:os';
        import {join} from 'node:path';
        import {cargo} from ${JSON.stringify(asyncSource)};
        const dir = mkdtempSync(join(tmpdir(), 'hyperion-reader-drain-'));
        try {
            mkdirSync(join(dir, 'config'));
            writeFileSync(join(dir, 'chain.json'), JSON.stringify({settings: {chain: 'drain-test'}, indexer: {}}));
            writeFileSync(join(dir, 'config', 'connections.json'), '{}');
            process.chdir(dir);
            process.env.CONFIG_JSON = join(dir, 'chain.json');
            const {default: StateReader} = await import(${JSON.stringify(source)});
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = async (predicate, timeout = 1000) => {
                const deadline = Date.now() + timeout;
                while (!predicate()) {
                    assert(Date.now() < deadline, 'reader did not make expected progress');
                    await sleep(5);
                }
            };
            function fixture(live = false) {
                const ch = Object.assign(new EventEmitter(), {async assertQueue() {}});
                const sent = [];
                let allowWrite = false;
                function publisher() {
                    return Object.assign(new EventEmitter(), {
                        sendToQueue(queue, content, options, confirm) {
                            sent.push({queue, value: content.toString(), options});
                            queueMicrotask(() => confirm(null));
                            return allowWrite;
                        }
                    });
                }
                const cch = publisher();
                const reader = Object.assign(Object.create(StateReader.prototype), {
                    chain: 'drain-test', conf: {scaling: {ds_queues: 1}},
                    ch, cch, cch_ready: true, isLiveReader: live,
                    currentIdx: 1, drainCount: 0,
                    local_distributed_count: 0, range_size: 1000
                });
                let completions = 0;
                const queue = cargo((tasks, callback) => reader.distribute(tasks, () => {
                    completions++;
                    callback();
                }), 2);
                reader.stageOneDistQueue = queue;
                return {reader, ch, cch, sent, queue, publisher,
                    allowWrite: () => {allowWrite = true;}, completions: () => completions};
            }
            ${body}
            console.log('reader-drain-probe-passed');
        } finally {
            process.chdir(${JSON.stringify(process.cwd())});
            rmSync(dir, {recursive: true, force: true});
        }
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
    const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ]);
    expect({code, stdout, stderr}).toEqual({code: 0, stdout: 'reader-drain-probe-passed\n', stderr: ''});
}

describe('StateReader confirm-channel backpressure', () => {
    it.each([false, true])('waits for the publisher drain and completes each payload once (live=%s)', async live => {
        await probe(`
            const f = fixture(${live});
            await f.reader.assertQueues();
            f.queue.push([{num: 1, content: Buffer.from('one')}, {num: 2, content: Buffer.from('two')}]);
            await until(() => f.sent.length === 1);
            assert.equal(f.completions(), 0);
            // Ordinary-channel drain is unrelated to the confirm publisher.
            f.ch.emit('drain');
            await sleep(650);
            assert.equal(f.sent.length, 1, 'published another block before confirm-channel drain');
            assert.equal(f.completions(), 0, 'completed the cargo before publisher drain');
            f.allowWrite();
            f.cch.emit('drain');
            await until(() => f.completions() === 1);
            assert.equal(f.queue.idle(), true);
            assert.deepEqual(f.sent.map(value => value.value).sort(), ['one', 'two']);
            assert(f.sent.every(value => value.queue === ${JSON.stringify(live ? 'drain-test:live_blocks' : 'drain-test:blocks:1')}));
            assert(f.sent.every(value => value.options.persistent === true && value.options.mandatory === true));
            f.cch.emit('drain');
            await sleep(10);
            assert.equal(f.completions(), 1);
            assert.equal(f.sent.length, 2);
        `);
    }, 15000);

    it('waits for each drain when the last accepted message fills the publisher buffer', async () => {
        await probe(`
            const f = fixture();
            f.reader.conf.scaling.ds_queues = 2;
            await f.reader.assertQueues();
            f.queue.push([{num: 1, content: Buffer.from('one')}, {num: 2, content: Buffer.from('two')}]);
            await until(() => f.sent.length === 1);
            f.cch.emit('drain');
            await until(() => f.sent.length === 2);
            assert.equal(f.completions(), 0, 'last buffered message completed cargo before drain');
            assert.deepEqual(f.sent.map(value => value.queue), ['drain-test:blocks:1', 'drain-test:blocks:2']);
            assert.equal(f.reader.drainCount, 2);
            f.cch.emit('drain');
            await until(() => f.completions() === 1);
            assert.equal(f.queue.idle(), true);
            assert.deepEqual(f.sent.map(value => value.value).sort(), ['one', 'two']);
            f.cch.emit('drain');
            await sleep(10);
            assert.equal(f.sent.length, 2);
            assert.equal(f.completions(), 1);
        `);
    }, 15000);

    it('ignores a replaced publisher close and drain event', async () => {
        await probe(`
            const f = fixture();
            await f.reader.assertQueues();
            const old = f.cch;
            const replacement = f.publisher();
            f.reader.cch = replacement;
            await f.reader.assertQueues();
            assert.equal(f.reader.cch_ready, true);
            assert.equal(f.queue.paused, false);
            old.emit('close');
            old.emit('drain');
            assert.equal(f.reader.cch_ready, true, 'stale close disabled the replacement publisher');
            assert.equal(f.queue.paused, false, 'stale close paused replacement cargo');
            replacement.emit('close');
            assert.equal(f.reader.cch_ready, false);
            assert.equal(f.queue.paused, true);
        `);
    }, 15000);
});
