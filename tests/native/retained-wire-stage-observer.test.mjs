// Pure observer/model controls. Never import or execute the retained workload/host fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRetainedWireStageObserver, observeRetainedWireNativeFixture, retainedWireStageBounds as bounds,
    retainedWireStageNames, sourceBlock} from '../unit/retained-wire-stage-observer.mjs';

function control(options = {}) {
    let time = 0n, tick, unrefs = 0, cleared = 0;
    const rows = [], lifecycle = new EventEmitter(), timer = {unref() {unrefs++;}};
    const observer = createRetainedWireStageObserver({enabled: true, now: () => time,
        resources: () => ({cpuMicros: {user: Number(time / 1000n), system: 0}, memoryBytes: {rss: 1000},
            eventLoop: {idle: 0, active: 1, utilization: 1}}),
        emit: row => rows.push(row), schedule(fn, delay) {assert.equal(delay, 1000); tick = fn; return timer;},
        unschedule(value) {assert.equal(value, timer); cleared++;}, lifecycle, ...options});
    return {observer, rows, lifecycle, advance(ns = 1000000000n) {time += ns;}, tick() {tick();},
        state: () => ({unrefs, cleared}), last: () => rows.at(-1)};
}

test('disabled observation reads or patches nothing and schedules no lifetime extension', () => {
    const forbidden = () => {throw new Error('disabled observer effect');};
    const observer = createRetainedWireStageObserver({now: forbidden, resources: forbidden, emit: forbidden, schedule: forbidden});
    const target = {operation() {return target;}};
    const original = target.operation;
    assert.equal(observer.watch(target, [['operation', 'source.frame']]), target);
    assert.equal(target.operation, original); observer.begin('source.frame')(); observer.report(); observer.close();
    assert.equal(target.operation(), target);
    assert.throws(() => createRetainedWireStageObserver({enabled: '1'}), /activation/);
});

test('monotonic bounded stages retain active work, failures and overlapping wall distributions', () => {
    const c = control(), outer = c.observer.begin('source.advance', 8), inner = c.observer.begin('source.frame', 1);
    c.advance(1000000n); inner(); inner(); c.advance(2000000n); c.observer.report();
    assert.equal(c.last().stages['source.frame'].completed, 1);
    assert.equal(c.last().stages['source.frame'].wall.totalNs, '1000000');
    assert.equal(c.last().active.length, 1); assert.equal(c.last().active[0].stage, 'source.advance');
    outer('failed'); c.advance(); c.tick();
    assert.equal(c.last().stages['source.advance'].failed, 1);
    assert.equal(c.last().stages['source.advance'].wall.totalNs, '3000000');
    assert.equal(c.last().active.length, 0); assert.equal(c.rows[0].intervalDriftNs, null);
    assert(c.last().elapsedNs > c.rows[0].elapsedNs); assert.equal(c.last().resources.memoryBytes.rss, 1000);
    assert.deepEqual(Object.keys(c.last().stages), retainedWireStageNames);
    assert(c.last().notExercised.includes('DSPool action publication/admission'));
    c.observer.close(); assert.deepEqual(c.state(), {unrefs: 1, cleared: 1});

    // Model late observations without executing/extending the real 180000ms workload.
    const late = control();
    for (let height = 1; height <= 1480; height++) {
        const finishSource = late.observer.begin('source.frame', height);
        const finishProjection = late.observer.begin('projection.source-frame', height);
        late.advance(125000000n); finishSource(); finishProjection();
        if (height % 8 === 0) late.tick();
    }
    assert.equal(late.rows.length, 186, 'block observations aggregate rather than emit per record');
    assert.equal(late.last().stages['source.frame'].lastBlock, 1480);
    assert.equal(late.last().stages['projection.source-frame'].lastBlock, 1480);
    const cleanup = late.observer.begin('cleanup.host'); late.advance(60000000000n); late.tick();
    assert.equal(late.last().elapsedNs, '245000000000'); assert.equal(late.last().intervalDriftNs, '59000000000');
    assert(late.last().active.some(span => span.stage === 'cleanup.host' && span.elapsedNs === '60000000000'));
    assert.equal(late.last().stages['cleanup.host'].completed, 0);
    cleanup(); late.lifecycle.emit('beforeExit');
    assert.equal(late.last().boundary, 'process-before-exit'); assert.equal(late.last().stages['cleanup.host'].completed, 1);
    assert.equal(late.last().observationOnly, true); assert.equal(Object.hasOwn(late.last(), 'testPassed'), false);
    assert(late.rows.length < bounds.snapshots); assert.equal(late.last().omitted, 0);
    assert(late.rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= bounds.rowBytes));
});

test('audited native/worker wrappers preserve receivers, arguments, values and original errors', async () => {
    const c = control(), session = {}, primary = new Error('original native failure'), result = Object.freeze({ok: true});
    const target = {calls: 0, async operation(input, options) {
        assert.equal(this, target); assert.equal(options.session, session); this.calls++;
        if (input === primary) throw primary; return result;
    }};
    const original = target.operation;
    let thenReads = 0;
    const opaque = Object.defineProperty({}, 'then', {get() {thenReads++; return undefined;}});
    target.syncValue = () => opaque;
    c.observer.watch(target, [['syncValue', 'native.command']]);
    assert.equal(target.syncValue(), opaque); assert.equal(thenReads, 0);
    c.observer.watch(target, [['operation', 'native.command']]);
    assert.equal(await target.operation(1, {session}), result);
    await assert.rejects(target.operation(primary, {session}), error => error === primary);
    assert.equal(target.calls, 2);
    let syncError = Object.create(null); target.sync = () => {throw syncError;};
    c.observer.watch(target, [['sync', 'native.command']]);
    assert.throws(() => target.sync(), error => error === syncError);
    c.observer.report(); assert.equal(c.last().stages['native.command'].failed, 2);
    c.observer.close(); assert.equal(target.operation, original);
});

test('diagnostic resource/emission/accessor failures neither substitute nor inspect original results', async () => {
    let reads = 0, emits = 0;
    const c = control({resources() {throw new Error('resource observation failed');}, emit() {emits++; throw new Error('sink failed');}});
    const primary = new Error('primary'), value = {ok: true};
    const target = {async operation() {return value;}, get accessor() {reads++; throw primary;}};
    c.observer.watch(target, [['accessor', 'native.command'], ['operation', 'native.command']]);
    assert.equal(await target.operation(), value); assert.equal(reads, 0); c.observer.close(); assert.equal(emits, 2);
    assert.deepEqual(c.state(), {unrefs: 1, cleared: 1});
});

test('pending command and actual cleanup error remain visible through close without late diagnostics', async () => {
    const c = control(); let reject;
    class Model {operation() {return new Promise((_, no) => {reject = no;});}}
    const target = new Model(), original = target.operation;
    c.observer.watch(target, [['operation', 'cleanup.host']]);
    const pending = target.operation(); c.observer.report(); assert.equal(c.last().active.length, 1);
    c.lifecycle.emit('beforeExit'); assert.equal(c.last().boundary, 'process-before-exit');
    assert.equal(c.last().stages['cleanup.host'].completed, 0); assert.equal(c.last().active.length, 1);
    assert.equal(target.operation, original); assert.equal(Object.hasOwn(target, 'operation'), false);
    const count = c.rows.length, error = new Error('original cleanup failed'); reject(error);
    await assert.rejects(pending, actual => actual === error);
    c.tick(); c.observer.close(); assert.equal(c.rows.length, count);
    assert.equal(c.lifecycle.listenerCount('beforeExit'), 0); assert.deepEqual(c.state(), {unrefs: 1, cleared: 1});
});

test('active slots, wrappers, rows and fixed interval cannot grow without bound', () => {
    const c = control(), finishes = Array.from({length: bounds.active + 1}, () => c.observer.begin('source.frame'));
    for (let i = 0; i <= bounds.wrappers; i++) c.observer.watch({operation() {}}, [['operation', 'native.command']]);
    for (let i = 0; i < bounds.snapshots + 2; i++) {c.advance(); c.tick();}
    assert.equal(c.rows.length, bounds.snapshots); assert.equal(c.last().boundary, 'snapshot-bound-censored');
    assert.equal(c.last().active.length, bounds.active); assert.equal(c.last().omitted, 2);
    assert(c.rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= bounds.rowBytes));
    finishes.forEach(finish => finish()); c.observer.close(); assert.equal(c.rows.length, bounds.snapshots);
    assert.deepEqual(c.state(), {unrefs: 1, cleared: 1});
});

test('the actual controlled native factory wiring retains client/session/cursor identities', async () => {
    const c = control(), result = {}, session = {async withTransaction(operation) {return operation(session);}, async endSession() {}};
    const cursor = {async toArray() {return result;}, async close() {}};
    const collection = Object.fromEntries(['insertOne', 'findOne', 'updateOne', 'findOneAndUpdate', 'replaceOne', 'deleteOne',
        'deleteMany', 'countDocuments', 'options'].map(name => [name, async () => result]));
    collection.find = () => cursor;
    const db = {collection: () => collection, admin: () => ({async command() {return result;}}), async createCollection() {return result;}};
    const client = {db: () => db, startSession: () => session};
    assert.equal(observeRetainedWireNativeFixture(client, c.observer), client);
    assert.equal(client.db(), db); assert.equal(db.collection(), collection); assert.equal(client.startSession(), session);
    assert.equal(await collection.findOne({}, {session}), result); assert.equal(collection.find(), cursor);
    assert.equal(await cursor.toArray(), result); await cursor.close();
    assert.equal(await session.withTransaction(original => {assert.equal(original, session); return result;}), result);
    await session.endSession(); c.observer.close();
    assert.equal(c.last().observationFailures, 0); assert.equal(c.last().stages['native.find-one'].completed, 1);
    assert.equal(c.last().stages['native.cursor'].completed, 2); assert.equal(c.last().stages['native.transaction'].completed, 1);
    assert.equal(c.last().stages['native.session-close'].completed, 1);
});

test('completed native sessions release their observation wrappers without retaining database/session authority', async () => {
    const c = control(), client = {db() {throw new Error('unused model DB');}, startSession() {
        const session = {async withTransaction(operation) {return operation(session);}, async endSession() {}};
        return session;
    }};
    observeRetainedWireNativeFixture(client, c.observer);
    for (let i = 0; i < 1000; i++) {
        const session = client.startSession(), originalEnd = Object.getPrototypeOf(session);
        await session.withTransaction(actual => {assert.equal(actual, session);}); await session.endSession();
        assert.equal(Object.getPrototypeOf(session), originalEnd);
    }
    c.observer.report(); assert.equal(c.last().liveWrappers, 2); assert.equal(c.last().omitted, 0);
    assert.equal(c.last().stages['native.session-close'].completed, 1000); c.observer.close();
    assert.equal(c.last().liveWrappers, 0); assert.equal(c.last().observationFailures, 0);
});

test('original retained test body/profile and 180000ms deadline remain exact; source block labels execute no getters', () => {
    const bytes = readFileSync(new URL('../unit/wire-managed-state-v2-native.mjs', import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n').replaceAll('STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE', 'STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), '32bbfc3e8a698edf1a506385dc1e346de4e4cf4c63ebb6ffeec879308e172eb3');
    let reads = 0; assert.equal(sourceBlock([{get source() {reads++; return {blockNum: 1};}}]), undefined);
    assert.equal(reads, 0); assert.equal(sourceBlock([{source: {blockNum: 222}}]), 222);
    const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8');
    assert.equal(workflow.split('HYPERION_RETAINED_WIRE_STAGES').length, 2, 'Only one inline workload invocation enables observation');
    assert(workflow.includes('HYPERION_RETAINED_WIRE_STAGES=1 node --test tests/unit/wire-managed-state-v2-native.mjs'));
    assert(workflow.includes('          node --test tests/unit/protocol-abi-history-native.mjs'));
    assert(workflow.includes('scripts/qualification/wire-source-snapshot.test.mjs tests/native/retained-wire-stage-observer.test.mjs'));
    assert.match(workflow, /node-version: \[24\.x, 26\.x\]/);
});
