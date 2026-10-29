import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPortableStageObserver} from './portable-state-stage-observer.mjs';

test('observer preserves real promises, results, errors, receiver and callback and bounds rows', async () => {
    const rows = [], scope = {id: 'attempt-1'}, value = {ok: true}, failure = Object.assign(new Error('fenced'), {code: 'worker_attempt_fenced'});
    class Controller {static create(options) {return options;}}
    class Runtime {constructor() {this.binding = {projectionId: 'p'};} process() {return this.promise;}}
    const adapter = {markIncomplete() {return Promise.resolve(value);}, apply() {return this.promise;}};
    const source = {frame(n, definition, admit) {assert.equal(this, source); return admit({blockNum: n});}, revalidate() {return Promise.reject(failure);}};
    const observer = installPortableStageObserver({Controller, Runtime, currentScope: () => scope, record: (_, row) => rows.push(row), maximumRecords: 30});
    try {
        const options = Controller.create({source, adapter}); assert.equal(options.source, source);
        const admission = Promise.resolve(value); const actual = source.frame(1336, {id: 'p'}, () => admission);
        assert.equal(actual, admission); assert.equal(await actual, value);
        const rejected = source.revalidate(); await assert.rejects(rejected, error => error === failure);
        const runtime = new Runtime(); runtime.promise = Promise.resolve(value); assert.equal(runtime.process({block:{blockNum:1336}}), runtime.promise);
        adapter.promise = Promise.resolve(value); assert.equal(adapter.apply({binding:{projectionId:'p'},block:{blockNum:1336}}), adapter.promise);
        await Promise.resolve();
        assert.ok(rows.some(row => row.stage === 'source.frame' && row.state === 'return' && row.blockNum === 1336));
        assert.ok(rows.some(row => row.stage === 'proof.revalidate' && row.state === 'cancel' && row.diagnosticScopeId === 1));
        assert.ok(rows.some(row => row.stage === 'runtime.process' && row.state === 'return'));
        assert.ok(rows.some(row => row.stage === 'adapter.apply' && row.state === 'return'));
        assert.equal(observer.snapshot().failures, 0);
    } finally {observer.restore();}
});

test('observer failures and cap do not alter original synchronous errors or results', async () => {
    class Controller {static create(options) {return options;}}
    class Runtime {process() {throw sentinel;}}
    const sentinel = new Error('original');
    const observer = installPortableStageObserver({Controller, Runtime, currentScope: () => undefined, record: () => {throw new Error('observer');}, maximumRecords: 1});
    try {assert.throws(() => new Runtime().process({block:{blockNum:1336}}), error => error === sentinel); assert.ok(observer.snapshot().failures > 0);}
    finally {observer.restore();}
    const rows = [];
    const capped = installPortableStageObserver({Controller, Runtime, currentScope: () => undefined, record: (_, row) => rows.push(row), maximumRecords: 1});
    try {assert.throws(() => new Runtime().process({block:{blockNum:1336}}), error => error === sentinel); assert.equal(rows.length, 1); assert.equal(capped.snapshot().omitted, 1);}
    finally {capped.restore();}
});


test('window retains target tail, shared surfaces wrap once and restore descriptors', async () => {
    class Controller {static create(options) {return options;}}
    class Runtime {process() {return Promise.resolve('ok');}}
    const scope = {}, rows = [], source = {frame(n, d, admit) {return admit({blockNum:n});}, revalidate() {return Promise.resolve();}};
    const adapter = {markIncomplete() {return Promise.resolve();}, apply() {return Promise.resolve();}};
    const originals = [source.frame, source.revalidate, adapter.markIncomplete, adapter.apply, Controller.create, Runtime.prototype.process];
    const observer = installPortableStageObserver({Controller, Runtime, currentScope: () => scope, record: (_, row) => rows.push(row)});
    Controller.create({source,adapter}); const wrapped = source.frame; Controller.create({source,adapter}); assert.equal(source.frame, wrapped);
    for (let block = 1; block <= 1480; block++) await source.frame(block, {id:'p'}, () => Promise.resolve());
    await Promise.resolve();
    assert.ok(observer.snapshot().filtered > 2000); assert.equal(observer.snapshot().omitted, 0);
    assert.ok(rows.some(row => row.blockNum === 1270)); assert.ok(rows.some(row => row.blockNum === 1336));
    assert.ok(rows.some(row => row.blockNum === 1480)); assert.ok(rows.every(row => row.blockNum >= 1200));
    observer.restore(); assert.deepEqual([source.frame, source.revalidate, adapter.markIncomplete, adapter.apply, Controller.create, Runtime.prototype.process], originals);
});

test('nonwritable shared surface never changes the original result', async () => {
    class Controller {static create(options) {return options;}} class Runtime {process() {return Promise.resolve();}}
    const original = () => Promise.resolve('unchanged'); const source = Object.freeze({frame: original, revalidate: original});
    const adapter = Object.freeze({markIncomplete: original, apply: original});
    const observer = installPortableStageObserver({Controller, Runtime, currentScope: () => undefined, record: () => {}});
    try {assert.equal(Controller.create({source, adapter}).source, source); assert.equal(await source.frame(), 'unchanged'); assert.ok(observer.snapshot().failures >= 4);}
    finally {observer.restore();}
});
