import {describe, expect, it} from 'bun:test';

// StateReader imports queue definitions that load configuration at module scope.
// Isolate that real import in a child, with owned temporary configuration and no
// worker construction or network connections. Production methods remain intact.
async function probe(body: string, fails = false) {
    const node = process.env.READER_RECOVERY_NODE;
    const source = new URL(node ? '../../build/indexer/workers/state-reader.js' : '../../src/indexer/workers/state-reader.ts', import.meta.url).href;
    const asyncSource = new URL('../../node_modules/async/dist/async.mjs', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import {EventEmitter} from 'node:events';
        import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
        import {tmpdir} from 'node:os';
        import {join} from 'node:path';
        import {cargo} from ${JSON.stringify(asyncSource)};
        const dir = mkdtempSync(join(tmpdir(), 'hyperion-reader-drain-'));
        const cleanup = () => {
            process.chdir(${JSON.stringify(process.cwd())});
            rmSync(dir, {recursive: true, force: true});
        };
        process.once('exit', cleanup);
        try {
            mkdirSync(join(dir, 'config'));
            writeFileSync(join(dir, 'chain.json'), JSON.stringify({settings: {chain: 'drain-test'}, indexer: {}}));
            writeFileSync(join(dir, 'config', 'connections.json'), '{}');
            process.chdir(dir);
            process.env.CONFIG_JSON = join(dir, 'chain.json');
            const {default: StateReader} = await import(${JSON.stringify(source)});
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = async (predicate, timeout = 1000, message = 'reader did not make expected progress') => {
                const deadline = Date.now() + timeout;
                while (!predicate()) {
                    assert(Date.now() < deadline, message);
                    await sleep(5);
                }
            };
            function fixture(live = false, autoConfirm = true) {
                const ch = Object.assign(new EventEmitter(), {async assertQueue() {}});
                const sent = [];
                const confirms = [];
                let confirmed = 0;
                let allowWrite = false;
                function publisher() {
                    return Object.assign(new EventEmitter(), {
                        sendToQueue(queue, content, options, confirm) {
                            sent.push({queue, value: content.toString(), options});
                            const acknowledge = (error = null) => {confirmed++; confirm(error);};
                            confirms.push(acknowledge);
                            if (autoConfirm) queueMicrotask(acknowledge);
                            return allowWrite;
                        }
                    });
                }
                const cch = publisher();
                const reader = Object.assign(Object.create(StateReader.prototype), {
                    chain: 'drain-test', conf: {scaling: {ds_queues: 1}},
                    ch, cch, ch_ready: true, cch_ready: true, isLiveReader: live, events: new EventEmitter(),
                    currentIdx: 1, drainCount: 0,
                    local_distributed_count: 0, range_size: 1000
                });
                let completions = 0;
                const queue = cargo((tasks, callback) => reader.distribute(tasks, () => {
                    completions++;
                    callback();
                }), 2);
                reader.stageOneDistQueue = queue;
                return {reader, ch, cch, sent, confirms, queue, publisher, confirmed: () => confirmed,
                    allowWrite: () => {allowWrite = true;}, completions: () => completions};
            }
            function virtualClock() {
                let now = 0;
                const timers = new Map();
                const nativeSetTimeout = globalThis.setTimeout;
                const nativeClearTimeout = globalThis.clearTimeout;
                const nativeNow = Object.getOwnPropertyDescriptor(performance, 'now');
                Object.defineProperty(performance, 'now', {configurable: true, value: () => now});
                globalThis.setTimeout = (callback, delay, ...args) => {
                    if (delay <= 5) return nativeSetTimeout(callback, delay, ...args);
                    const timer = {at: now + delay, fire: () => callback(...args), unref() {return this;}};
                    timers.set(timer, timer);
                    return timer;
                };
                globalThis.clearTimeout = timer => {
                    if (!timers.delete(timer)) nativeClearTimeout(timer);
                };
                return {
                    timers,
                    advance(milliseconds) {
                        now += milliseconds;
                        for (const timer of [...timers.values()].sort((a, b) => a.at - b.at))
                            if (timer.at <= now && timers.delete(timer)) timer.fire();
                    },
                    bounded(promise) {
                        return Promise.race([promise, new Promise(resolve => nativeSetTimeout(() => resolve('unbounded'), 100))]);
                    },
                    restore() {
                        globalThis.setTimeout = nativeSetTimeout;
                        globalThis.clearTimeout = nativeClearTimeout;
                        if (nativeNow) Object.defineProperty(performance, 'now', nativeNow);
                        else delete performance.now;
                    }
                };
            }
            ${body}
            console.log('reader-drain-probe-passed');
        } finally {
            cleanup();
        }
    `;
    const child = Bun.spawn([node ?? process.execPath, ...(node ? ['--input-type=module'] : []), '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
    const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
    ]);
    if (fails) {
        expect(code).toBe(1);
        expect(stderr).toBe('');
        expect(stdout).toContain('reader-recovery-failure-accounted');
    } else expect({code, stdout, stderr}).toEqual({code: 0, stdout: 'reader-drain-probe-passed\n', stderr: ''});
}

describe('StateReader confirm-channel backpressure', () => {
    it('keeps overlapping healthy confirms alive beyond a full confirmation window', async () => {
        await probe(`
            const clock = virtualClock();
            try {
                const f = fixture(true, false); f.allowWrite();
                const failures = [];
                f.reader.failPublisherRecovery = reason => failures.push(reason);
                const publish = num => f.reader.recursiveDistribute([{num, content: Buffer.from(String(num))}], f.cch, () => {});
                publish(1);
                for (let num = 2; num <= 70; num++) {
                    clock.advance(1000); publish(num); f.confirms[num - 2]();
                    assert.deepEqual(failures, [], 'healthy one-second confirms must not expire');
                }
                f.confirms.at(-1)();
                assert.equal(f.reader.publications.size, 0);
                assert.equal(clock.timers.size, 0, 'drained confirmation timer remains armed');
            } finally {clock.restore();}
        `);
    }, 15000);

    it('does not postpone a lost older confirm when a newer publication settles', async () => {
        await probe(`
            const clock = virtualClock();
            try {
                const f = fixture(true, false); f.allowWrite();
                const failures = [];
                f.reader.failPublisherRecovery = reason => failures.push(reason);
                f.reader.recursiveDistribute([{num: 1, content: Buffer.from('one')}], f.cch, () => {});
                clock.advance(30000);
                f.reader.recursiveDistribute([{num: 2, content: Buffer.from('two')}], f.cch, () => {});
                clock.advance(1000); f.confirms[1]();
                clock.advance(28999); assert.equal(failures.length, 0);
                clock.advance(1); assert.equal(failures.length, 1);
                assert.match(failures[0], /confirmation deadline exceeded/);
            } finally {clock.restore();}
        `);
    }, 15000);

    it.each(['confirm', 'ordinary'])('bounds a stalled %s channel close by the reader finish deadline', async channel => {
        await probe(`
            const clock = virtualClock();
            try {
                const f = fixture();
                f.reader.publications = new Map(); f.reader.confirmRange = {complete: true};
                f.reader.blockReadingQueue = {idle: () => true};
                f.reader.ship = {close() {}}; f.reader.profiler = {stopReporting() {}};
                const closed = [];
                f.cch.close = () => {closed.push('confirm'); return ${JSON.stringify(channel)} === 'confirm' ? new Promise(() => {}) : Promise.resolve();};
                f.ch.close = () => {closed.push('ordinary'); return new Promise(() => {});};
                const result = f.reader.finishReader().then(() => 'finished', error => error.message);
                await sleep(0);
                clock.advance(10000);
                assert.equal(await clock.bounded(result), 'Reader finish deadline exceeded');
                assert.deepEqual(closed, ${JSON.stringify(channel === 'confirm' ? ['confirm'] : ['confirm', 'ordinary'])});
                assert.equal(clock.timers.size, 0);
            } finally {clock.restore();}
        `);
    }, 15000);

    it('shares one finish budget across both channel closes and clears successful deadlines', async () => {
        await probe(`
            const clock = virtualClock();
            try {
                const f = fixture();
                f.reader.publications = new Map(); f.reader.confirmRange = {complete: true};
                f.reader.blockReadingQueue = {idle: () => true};
                f.reader.ship = {close() {}}; f.reader.profiler = {stopReporting() {}};
                let release; let ordinary = false;
                f.cch.close = () => new Promise(resolve => {release = resolve;});
                f.ch.close = () => {ordinary = true; return new Promise(() => {});};
                let outcome;
                const result = f.reader.finishReader().then(() => outcome = 'finished', error => outcome = error.message);
                clock.advance(7000); release(); await sleep(0);
                assert.equal(ordinary, true);
                clock.advance(2999); await sleep(0); assert.equal(outcome, undefined);
                clock.advance(1); await clock.bounded(result);
                assert.equal(outcome, 'Reader finish deadline exceeded');
                assert.equal(clock.timers.size, 0);
                f.cch.close = async () => {}; f.ch.close = async () => {};
                await f.reader.finishReader(); assert.equal(clock.timers.size, 0);
            } finally {clock.restore();}
        `);
    }, 15000);
    it.each(['nack', 'unknown-close', 'replaced', 'return'])('requires source replay after %s without unsupported completion', async failure => {
        await probe(`
            const f = fixture(false, false);
            const reports = [];
            process.send = msg => {reports.push(msg); return true;};
            process.on('exit', code => {
                assert.equal(code, 1);
                assert.equal(reports.filter(msg => msg.event === 'completed').length, 0);
                assert.equal(reports.filter(msg => msg.event === 'read_block').length, 0);
                assert.equal(reports.filter(msg => msg.event === 'reader_recovery_required').length, 1);
                console.log('reader-recovery-failure-accounted');
            });
            await f.reader.assertQueues();
            f.queue.push({num: 10, content: Buffer.from('ten')});
            await until(() => f.sent.length === 1);
            if (${JSON.stringify(failure)} === 'nack') {
                // Invoke the production callback retained by sendToQueue.
                f.confirms[0](new Error('message nacked'));
            } else if (${JSON.stringify(failure)} === 'unknown-close') f.cch.emit('close');
            else if (${JSON.stringify(failure)} === 'return') f.cch.emit('return', {});
            else {
                f.reader.cch = f.publisher();
                await f.reader.assertQueues();
                f.confirms[0]();
            }
            await sleep(1000);
            throw new Error('Reader did not fail closed');
        `, true);
    }, 15000);

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

    it('finishes a confirmed final-message cargo after publisher replacement without republishing it', async () => {
        await probe(`
            const f = fixture();
            let connections = 0;
            f.reader.events.on('ready', () => connections++);
            f.reader.onConnect();
            await until(() => connections === 1);
            f.queue.push({num: 1, content: Buffer.from('one')});
            await until(() => f.confirmed() === 1);
            assert.equal(f.completions(), 0);
            assert.equal(f.queue.running(), 1);
            f.cch.emit('close');
            assert.equal(f.queue.paused, true);
            const replacement = f.publisher();
            f.reader.ch = Object.assign(new EventEmitter(), {async assertQueue() {}});
            f.reader.cch = replacement;
            f.reader.onConnect();
            await until(() => connections === 2);
            await until(() => f.completions() === 1, 1000, 'replacement left confirmed empty cargo running');
            assert.equal(f.queue.idle(), true);
            assert.equal(f.sent.length, 1, 'republished the accepted final message');
            f.cch.emit('drain');
            replacement.emit('drain');
            await sleep(10);
            assert.equal(f.completions(), 1);
            assert.equal(f.sent.length, 1);
        `);
    }, 15000);

    it('continues only unsent cargo after known-success replacement and ignores duplicate confirms and old drains', async () => {
        await probe(`
            const f = fixture(false, false);
            const reports = [];
            process.send = message => {reports.push(message); return true;};
            let connections = 0;
            f.reader.events.on('ready', () => connections++);
            f.reader.onConnect();
            await until(() => connections === 1);
            f.queue.push([{num: 1, content: Buffer.from('one')}, {num: 2, content: Buffer.from('two')}]);
            await until(() => f.sent.length === 1);
            assert.equal(f.confirms.length, 1);
            assert.equal(reports.length, 0);
            f.confirms[0]();
            f.cch.emit('close');
            const replacement = f.publisher();
            f.reader.ch = Object.assign(new EventEmitter(), {async assertQueue() {}});
            f.reader.cch = replacement;
            f.reader.onConnect();
            await until(() => connections === 2);
            await until(() => f.sent.length === 2, 1000, 'replacement did not continue unsent active cargo');
            assert.equal(f.completions(), 0, 'replacement buffer still requires its own drain');
            assert.deepEqual(f.sent.map(value => value.value).sort(), ['one', 'two']);
            f.cch.emit('drain');
            await sleep(10);
            assert.equal(f.completions(), 0, 'old drain completed replacement cargo');
            replacement.emit('drain');
            await until(() => f.completions() === 1);
            assert.equal(f.queue.idle(), true);
            f.confirms.forEach(confirm => confirm());
            assert.deepEqual(reports.map(value => value.block_num).sort(), [1, 2]);
            f.cch.emit('drain');
            replacement.emit('drain');
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

    it('ignores replaced channel close and drain events through the actual onConnect lifecycle', async () => {
        await probe(`
            const f = fixture();
            let connections = 0;
            f.reader.events.on('ready', () => connections++);
            f.reader.onConnect();
            await until(() => connections === 1);
            const old = f.cch;
            const oldConsumer = f.ch;
            const replacement = f.publisher();
            const replacementConsumer = Object.assign(new EventEmitter(), {async assertQueue() {}});
            f.reader.cch = replacement;
            f.reader.ch = replacementConsumer;
            f.reader.onConnect();
            await until(() => connections === 2);
            assert.equal(f.reader.ch_ready, true);
            assert.equal(f.reader.cch_ready, true);
            assert.equal(f.queue.paused, false);
            oldConsumer.emit('close');
            old.emit('close');
            old.emit('drain');
            assert.deepEqual({consumer: f.reader.ch_ready, publisher: f.reader.cch_ready},
                {consumer: true, publisher: true}, 'stale close disabled replacement channels');
            assert.equal(f.queue.paused, false, 'stale close paused replacement cargo');
            replacementConsumer.emit('close');
            assert.equal(f.reader.ch_ready, false);
            assert.equal(f.reader.cch_ready, true);
            replacement.emit('close');
            assert.equal(f.reader.cch_ready, false);
            assert.equal(f.queue.paused, true);
            assert.equal(connections, 2);
        `);
    }, 15000);
});
