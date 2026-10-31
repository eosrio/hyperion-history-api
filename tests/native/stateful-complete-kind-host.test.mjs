import assert from 'node:assert/strict';
import test from 'node:test';
import {statefulHostFixture} from '../unit/stateful-host-fixture.mjs';

test('the negotiated complete-kind accessor uses the real registry, worker probe and final headers', async () => {
    const fixture = await statefulHostFixture({completeKind: true});
    try {
        const response = await fixture.app.inject('/complete-kind'); assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), {success: true, data: [{key: 'last', value: {height: 3, occurrences: 4}}]});
        assert.equal(response.headers['hyperion-state-block-num'], '3'); assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(fixture.probes, 3); assert.equal(fixture.native.storage.dataCommands.length, 1);
        assert.equal((await fixture.app.inject('/state')).statusCode, 200, 'Existing get-only accessor still works');
    } finally {await fixture.close();}
});

test('the complete-kind host refuses missing projection capability before invoking a callback', async () => {
    const fixture = await statefulHostFixture({completeKind: true});
    try {
        const [id, entry] = [...fixture.registry.entries][0]; fixture.registry.entries.set(id, Object.freeze({...entry, completeKind: undefined}));
        const response = await fixture.app.inject('/complete-kind'); assert.equal(response.statusCode, 503);
        assert.equal(fixture.native.storage.dataCommands.length, 0); assert.equal(response.headers['hyperion-state-block-num'], undefined);
    } finally {await fixture.close();}
});

for (const mode of ['worker', 'source', 'socket', 'deadline', 'payload']) test(`final complete-kind publication refuses ${mode} changes`, async () => {
    const hooks = {}, fixture = await statefulHostFixture({completeKind: true, hooks, timeoutMs: mode === 'deadline' ? 200 : 1000});
    try {
        hooks.onSend = async () => {
            if (mode === 'worker') fixture.supervisor.retire(fixture.parent);
            if (mode === 'source') await fixture.p.coordinator.revokeSource('fixture-source');
            if (mode === 'socket') fixture.replaceSocket();
            if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 250));
        };
        if (mode === 'payload') hooks.payload = () => 'x'.repeat(fixture.declaration.projection.limits.responseBytes + 1);
        const response = await fixture.app.inject('/complete-kind'); assert.equal(response.statusCode, 503, response.body);
        assert.equal(response.headers['hyperion-state-block-num'], undefined); assert.equal(response.headers['retry-after'], '1');
        assert.equal(response.headers['cache-control'], 'no-store'); assert.equal((await fixture.app.inject('/unrelated')).statusCode, 200);
    } finally {await fixture.close();}
});

test('complete-kind request abort closes the SDK reader and refuses late results', async () => {
    const hooks = {}, fixture = await statefulHostFixture({completeKind: true, hooks}); let release, entered, escaped;
    const held = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
    try {
        hooks.compose = async ({port, request}) => {escaped = port; entered(); request.raw.emit('aborted'); await held;};
        const work = fixture.app.inject('/complete-kind'); await started;
        const response = await work; assert.equal(response.statusCode, 503); await assert.rejects(escaped.all('collection'));
        release(); await new Promise(resolve => setImmediate(resolve)); assert.equal((await fixture.app.inject('/unrelated')).statusCode, 200);
    } finally {release(); await fixture.close();}
});

test('a held complete-kind registry lookup obeys the request deadline before any data read', async () => {
    const fixture = await statefulHostFixture({completeKind: true, timeoutMs: 200}); let release, entered;
    const held = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
    const original = fixture.registry.initializeMissing.bind(fixture.registry);
    fixture.registry.initializeMissing = async () => {entered(); await held; return original();};
    try {
        const response = fixture.app.inject('/complete-kind'); await started;
        const deadline = await Promise.race([response, new Promise((_, reject) => setTimeout(() => reject(new Error('lookup deadline did not release request')), 1000))]);
        assert.equal(deadline.statusCode, 503); assert.equal(fixture.native.storage.dataCommands.length, 0);
        release(); await new Promise(resolve => setImmediate(resolve));
    } finally {release(); await fixture.close();}
});

test('a swallowed second composition still prevents successful final publication', async () => {
    const fixture = await statefulHostFixture({completeKind: true});
    fixture.app.get('/double-composition', async request => {
        const host = await fixture.context.statefulCompleteKindQueryHost(request, fixture.declaration.projection.definition.id);
        const result = await host.compose(fixture.declaration.projection.definition.id, async port => ({rows: await port.all('collection')}));
        try {await fixture.context.statefulQueryHost(request).compose(fixture.declaration.projection.definition.id, async () => ({}));} catch {}
        return result.value;
    });
    try {
        const response = await fixture.app.inject('/double-composition'); assert.equal(response.statusCode, 503);
        assert.equal(response.headers['hyperion-state-block-num'], undefined); assert.equal(fixture.native.storage.dataCommands.length, 1);
    } finally {await fixture.close();}
});
