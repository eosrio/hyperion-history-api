import assert from 'node:assert/strict';
import {statefulHostFixture} from './stateful-host-fixture.mjs';
assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
let cases = 0;
const first = await statefulHostFixture();
try {
    const response = await first.app.inject('/state');
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {success: true, data: {height: 3, occurrences: 4}});
    assert.equal(response.headers['hyperion-state-block-num'], '3');
    assert.equal(response.headers['hyperion-state-block-id'], first.p.positions[2].blockId);
    assert.equal(response.headers['hyperion-state-last-valid'], 'false'); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(first.probes, 3); cases++;
    first.supervisor.retire(first.parent);
    const retired = await first.app.inject('/state'); assert.equal(retired.statusCode, 503); assert.equal(retired.headers['retry-after'], '1');
    assert.equal(retired.headers['hyperion-state-block-num'], undefined);
    assert.equal((await first.app.inject('/unrelated')).statusCode, 200); cases++;
} finally {await first.close();}
for (const mode of ['socket', 'owner', 'source', 'payload', 'deadline', 'clock', 'pre-compose-deadline']) {
    const hooks = {}, fixture = await statefulHostFixture({timeoutMs: ['deadline', 'clock', 'pre-compose-deadline'].includes(mode) ? 200 : 1000, hooks});
    try {
        hooks.onSend = async () => {
            if (mode === 'socket') fixture.replaceSocket();
            if (mode === 'owner') fixture.supervisor.retire(fixture.parent);
            if (mode === 'source') await fixture.p.coordinator.revokeSource('fixture-source');
            if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 250));
            if (mode === 'clock') {const until = performance.now() + 250; while (performance.now() < until) {} }
        };
        if (mode === 'pre-compose-deadline') hooks.beforeCompose = () => new Promise(resolve => setTimeout(resolve, 250));
        if (mode === 'payload') hooks.payload = () => 'x'.repeat(fixture.declaration.projection.limits.responseBytes + 1);
        const response = await fixture.app.inject('/state'); assert.equal(response.statusCode, 503, mode + ': ' + response.body);
        assert.equal(response.headers['hyperion-state-block-num'], undefined); assert.equal(response.headers['retry-after'], '1');
        assert.equal(response.headers['cache-control'], 'no-store'); assert.equal((await fixture.app.inject('/unrelated')).statusCode, 200); cases++;
    } finally {await fixture.close();}
}
for (const mode of ['held-deadline', 'request-abort']) {
    const hooks = {}, fixture = await statefulHostFixture({timeoutMs: mode === 'held-deadline' ? 200 : 1000, hooks});
    let release, announce, latePort;
    const held = new Promise(resolve => {release = resolve;}), entered = new Promise(resolve => {announce = resolve;});
    try {
        hooks.compose = async ({port, request}) => {
            latePort = port; announce(); if (mode === 'request-abort') request.raw.emit('aborted'); await held;
        };
        const work = fixture.app.inject('/state'); await entered;
        const response = await work;
        assert.equal(response.statusCode, 503); assert.equal(response.headers['hyperion-state-block-num'], undefined);
        await assert.rejects(latePort.get('collection', 'last'));
        release(); await new Promise(resolve => setImmediate(resolve));
        assert.equal((await fixture.app.inject('/unrelated')).statusCode, 200); cases++;
    } finally {release(); await fixture.close();}
}
const fenced = await statefulHostFixture();
try {
    await fenced.p.advance(4);
    const source = fenced.p.source, original = source.statefulBlock; let announce, release;
    const entered = new Promise(resolve => {announce = resolve;}), held = new Promise(resolve => {release = resolve;});
    source.statefulBlock = async function(...args) {const value = await original.apply(this, args); announce(); await held; return value;};
    const work = fenced.controller.drain(); await entered;
    fenced.supervisor.fenceActive(); release(); await work; source.statefulBlock = original;
    assert.equal(fenced.ends.at(-1).rootResult, 'threw');
    assert.equal((await fenced.native.adapter.recovery()).view.checkpoint.blockNum, 3);
    assert.equal((await fenced.app.inject('/state')).statusCode, 503);
    await fenced.controller.drain();
    assert.equal((await fenced.native.adapter.recovery()).view.checkpoint.blockNum, 4);
    assert.equal((await fenced.app.inject('/state')).statusCode, 200); cases++;
} finally {await fenced.close();}
console.log(JSON.stringify({cases, actualFastifyInject: true, existingWorkerProbeMethod: true, managedLifecycle: true,
    exactSocketAndWorker: true, finalOnSendFencing: true, sharedHeaders: true, serializationBudget: true,
    heldDeadlineFenced: true, requestAbortFenced: true,
    monotonicSerializationDeadline: true, requestStartDeadline: true,
    originalFrameFencePreserved: true, freshFrameReconciled: true,
    services: false, physicalWireMongoQualification: false, originalAtomicHttpParity: false}));
