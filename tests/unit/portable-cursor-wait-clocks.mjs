/** Service-free controls use the driver's actual wait body; no worker/database substitute is launched. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {createPortableCursorWaitClocks, portableCursorWaitClockLimits} from '../../scripts/qualification/portable-cursor-wait-clocks.ts';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
assertNativeQualificationRuntime();

const source = stripTypeScriptTypes(readFileSync(new URL('../../scripts/qualification/portable-state-worker.ts', import.meta.url), 'utf8'));
assert.equal([...source.matchAll(/\bconst wait = async/g)].length, 1);
const waitStart = source.indexOf('    const wait = async'), waitEnd = source.indexOf('\n    const queues =', waitStart);
assert.ok(waitStart > 0 && waitEnd > waitStart);
const actualWait = source.slice(waitStart, waitEnd) + '\nglobalThis.actualWait = wait;';
const target = {blockNum: 717, blockId: 'a'.repeat(64)};
function fixture(options = {}) {
    let clock = 0, sleeps = 0;
    const cursorWaitClocks = createPortableCursorWaitClocks(), report = {errors: []};
    const scope = {assert, performance: options.performance ?? {now: () => clock}, deadline: options.deadline ?? 900000,
        master: options.master, api: undefined, report, cursorWaitClocks, describeError: String,
        pause: async milliseconds => {assert.equal(milliseconds, 100); sleeps++; clock += milliseconds;}};
    const context = vm.createContext(scope);
    // The real driver creates report.errors and its guard literal in the same realm.
    report.errors = vm.runInContext('[]', context);
    vm.runInContext(actualWait, context);
    return {wait: scope.actualWait, report, evidence: cursorWaitClocks.evidence,
        get clock() {return clock;}, set clock(value) {clock = value;}, get sleeps() {return sleeps;}};
}
function held() {
    let enter, release;
    const entered = new Promise(resolve => {enter = resolve;}), pending = new Promise(resolve => {release = resolve;});
    return {enter, entered, release, pending};
}

test('entry remains pending during an awaited operation and completion shares the recovery-poll clock', async () => {
    const f = fixture({performance, deadline: performance.now() + 1000}), h = held(); let calls = 0, settled = false, poll;
    const work = f.wait('durable cursor', async () => {calls++; const startedMs = performance.now(); h.enter(); await h.pending;
        poll = {kind: 'performance.now', pid: process.pid, processTimeOriginMs: performance.timeOrigin, startedMs, completedMs: performance.now()};
    }, 1000, undefined, target);
    work.then(() => {settled = true;}, () => {settled = true;});
    await h.entered; await delay(5);
    const row = f.evidence.records[0]; assert.equal(settled, false); assert.equal(row.status, 'pending'); assert.equal(row.completedMs, null);
    h.release(); const budget = await work;
    assert.equal(calls, 1); assert.equal(f.sleeps, 0); assert.equal(row.status, 'passed'); assert.equal(row.deadlineMs, budget.deadline);
    assert.deepEqual(f.evidence.clock, {kind: poll.kind, pid: poll.pid, processTimeOriginMs: poll.processTimeOriginMs});
    assert.ok(row.startedMs <= poll.startedMs && poll.startedMs <= poll.completedMs && poll.completedMs <= row.completedMs);
});

test('late held success remains awaited and fails at the original effective deadline', async () => {
    const f = fixture(), h = held(); let calls = 0, settled = false;
    const work = f.wait('durable cursor', async () => {calls++; h.enter(); await h.pending;}, 60000, {deadline: 75}, target);
    work.then(() => {settled = true;}, () => {settled = true;}); await h.entered;
    f.clock = 76; await Promise.resolve(); assert.equal(settled, false); assert.equal(f.evidence.records[0].status, 'pending');
    h.release(); await assert.rejects(work, /durable cursor did not complete: AssertionError.*original phase deadline exceeded/s);
    assert.equal(calls, 1); assert.equal(f.sleeps, 1);
    assert.deepEqual(f.evidence.records[0], {attempt: 1, target, startedMs: 0, deadlineMs: 75, completedMs: 176, status: 'failed'});
});

test('rejected poll preserves the original diagnostic and bounded cadence without deadline restart', async () => {
    const f = fixture(), h = held(); let calls = 0;
    const original = new Error('original rejected cursor poll');
    const work = f.wait('durable cursor', async () => {calls++; h.enter(); await h.pending; throw original;}, 60000, {deadline: 75}, target);
    await h.entered; f.clock = 76; h.release();
    await assert.rejects(work, error => error.message === 'durable cursor did not complete: ' + String(original));
    assert.equal(calls, 1); assert.equal(f.sleeps, 1); assert.equal(f.evidence.records[0].status, 'failed');
    assert.equal(f.evidence.records[0].deadlineMs, 75); assert.equal(f.evidence.records[0].completedMs, 176);
});

test('retry success retains original deadline and exactly the existing polls and sleeps', async () => {
    const f = fixture({deadline: 900000}); let calls = 0;
    const budget = await f.wait('durable cursor', async () => {if (++calls < 3) throw new Error('pending checkpoint');}, undefined, undefined, target);
    assert.equal(budget.deadline, 60000); assert.equal(calls, 3); assert.equal(f.sleeps, 2);
    assert.deepEqual(f.evidence.records[0], {attempt: 1, target, startedMs: 0, deadlineMs: 60000, completedMs: 200, status: 'passed'});
});

test('whole-run cap and expired entry cannot be extended by observation', async () => {
    for (const deadline of [50, 0]) {
        const f = fixture({deadline}); let calls = 0;
        await assert.rejects(f.wait('durable cursor', async () => {calls++; throw new Error('pending');}, 60000, undefined, target), /did not complete/);
        assert.equal(calls, deadline === 0 ? 0 : 1); assert.equal(f.evidence.records[0].deadlineMs, deadline);
        assert.equal(f.evidence.records[0].status, 'failed'); assert.equal(f.evidence.records[0].completedMs, deadline === 0 ? 0 : 100);
    }
});

test('child and report guards retain their original errors and failed completion before any poll', async () => {
    for (const kind of ['child', 'report']) {
        const f = fixture({master: kind === 'child' ? {exitCode: 1, signalCode: null} : undefined}); let calls = 0;
        if (kind === 'report') f.report.errors.push('original observed failure');
        await assert.rejects(f.wait('durable cursor', async () => {calls++;}, 60000, undefined, target), error => {
            assert.equal(error.name, 'AssertionError');
            if (kind === 'child') assert.equal(error.message, 'durable cursor: actual child exited');
            else assert.match(error.message, /original observed failure/);
            return true;
        });
        assert.equal(calls, 0); assert.equal(f.sleeps, 0); assert.equal(f.evidence.records[0].status, 'failed');
        assert.equal(f.evidence.records[0].completedMs, 0);
    }
});

test('unobserved waits leave no cursor rows; bounded tail retains the latest failure and detached target', async () => {
    const f = fixture(); await f.wait('other phase', async () => {});
    assert.equal(f.evidence.attempts, 0); assert.deepEqual(f.evidence.records, []);
    const mutableTarget = {...target};
    await f.wait('cursor', async () => {mutableTarget.blockNum = 718;}, 60000, undefined, mutableTarget);
    assert.deepEqual(f.evidence.records[0].target, target);
    for (let index = 1; index < portableCursorWaitClockLimits.maximumRecords; index++) await f.wait('cursor', async () => {}, 60000, undefined, target);
    await assert.rejects(f.wait('last cursor', async () => {assert.fail('unreachable expired work');}, 0, undefined, target), /did not complete/);
    assert.equal(f.evidence.attempts, 129); assert.equal(f.evidence.omittedRecords, 1); assert.equal(f.evidence.records.length, 128);
    assert.equal(f.evidence.records[0].attempt, 2); assert.equal(f.evidence.records.at(-1).attempt, 129);
    assert.equal(f.evidence.records.at(-1).status, 'failed');
});
