/** Original emitted Wire worker/lifecycle callbacks; controlled I/O, no server qualification. */
import assert from 'node:assert/strict';
import {test, after} from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {managedWireAttemptFixture} from '../unit/managed-wire-attempt-fixture.mjs';
import {WorkerAttemptClient} from '../../build/indexer/protocol/worker-attempt-client.js';
import {currentProofConsumerScope, ProofConsumerFencedError} from '../../build/indexer/protocol/proof-consumer-scope.js';

assert.ok([24, 26].includes(Number(process.versions.node.split('.')[0])), 'native Node 24/26 required');
const evidenceRoot = process.env.HYPERION_NATIVE_STAGE_TIMING_EVIDENCE && realpathSync(process.env.HYPERION_NATIVE_STAGE_TIMING_EVIDENCE);
if (evidenceRoot) {
    assert.ok(isAbsolute(process.env.HYPERION_NATIVE_STAGE_TIMING_EVIDENCE));
    const ownedOut = realpathSync(fileURLToPath(new URL('../../out/', import.meta.url))), child = relative(ownedOut, evidenceRoot);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'explicit test evidence must stay beneath this checkout out directory');
}
const retain = (name, value) => {
    if (!evidenceRoot) return;
    assert.match(name, /^[a-z0-9-]+$/);
    const bytes = Buffer.from(JSON.stringify({controlledComponentOnly: true, native: process.version, ...value}, null, 2) + '\n');
    assert.ok(bytes.length <= 2 * 1024 * 1024);
    writeFileSync(join(evidenceRoot, name + '.json'), bytes, {flag: 'wx'});
};
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hyperion-stage-timing-'))), previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON;
mkdirSync(join(directory, 'config')); writeFileSync(join(directory, 'config/connections.json'), '{}');
writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'stage-timing-fixture'}, indexer: {}, features: {streaming: {enable: false}}}));
process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
const {installNativeWorkerStageTimings, nativeStageTimingBounds} = await import('../../scripts/qualification/portable-native-stage-timing.mjs');
after(() => {
    process.chdir(previousDirectory);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    assert.equal(dirname(directory), realpathSync(tmpdir())); assert.ok(basename(directory).startsWith('hyperion-stage-timing-'));
    rmSync(directory, {recursive: true, force: true});
});
const descriptor = {kind: 'ds-delivery', receiptId: '11111111-1111-1111-1111-111111111111', payloadSha256: 'a'.repeat(64),
    headersSha256: 'b'.repeat(64), consumerId: '22222222-2222-2222-2222-222222222222', publisherId: null, queue: 'owned-queue', deliveryTag: 1};

test('disabled observation leaves original methods intact; bounds cannot expand fixed diagnostic budgets', () => {
    const original = WorkerAttemptClient.prototype.run, timing = installNativeWorkerStageTimings();
    assert.equal(WorkerAttemptClient.prototype.run, original);
    assert.deepEqual(timing.snapshot(), {enabled: false, observationOnly: true}); timing.restore();
    assert.throws(() => installNativeWorkerStageTimings({enabled: 'true'}), /activation/);
    for (const options of [{maximumStarts: 0}, {maximumActive: nativeStageTimingBounds.maximumActive + 1}, {maximumTail: 65}])
        assert.throws(() => installNativeWorkerStageTimings({enabled: true, ...options}), /diagnostic bound/);
});

test('emitted lifecycle preserves opaque results and ordinary/owned-fence error identities', async () => {
    async function opaque(enabled) {
        const timing = installNativeWorkerStageTimings({enabled}), client = new WorkerAttemptClient({mode: 'controlled-local-only', role: 'ds_pool_worker'});
        let reads = 0;
        const value = Object.defineProperty({}, 'then', {get() {reads++; return undefined;}});
        try {
            assert.equal(await client.run(client.capture(descriptor), () => value), value);
            await turn(); return {reads, snapshot: timing.snapshot()};
        } finally {client.dispose(); timing.restore();}
    }
    const plain = await opaque(false), measured = await opaque(true);
    assert.equal(measured.reads, plain.reads, 'observation must not resolve opaque results through another promise');
    assert.equal(measured.snapshot.stages['attempt.run'].completed, 1);
    assert.equal(measured.snapshot.stages['attempt.run'].cancelled, 0, 'normal drain fencing does not turn a return into cancellation');
    const timing = installNativeWorkerStageTimings({enabled: true, maximumTail: 2}), client = new WorkerAttemptClient({mode: 'controlled-local-only', role: 'ds_pool_worker'});
    try {
        const primary = new Error('original ordinary error');
        await assert.rejects(client.run(client.capture(descriptor), () => {throw primary;}), error => error === primary);
        const foreign = new ProofConsumerFencedError();
        await assert.rejects(client.run(client.capture(descriptor), () => {throw foreign;}), error => error === foreign);
        let reads = 0;
        const opaqueError = Object.defineProperty({}, 'code', {get() {reads++; throw new Error('diagnostic getter must not execute');}});
        await assert.rejects(client.run(client.capture(descriptor), () => {throw opaqueError;}), error => error === opaqueError);
        assert.equal(reads, 0);
        let owned;
        await assert.rejects(client.run(client.capture(descriptor), () => {
            const scope = currentProofConsumerScope(true); scope.fence();
            try {scope.assertActive();} catch (error) {owned = error; throw error;}
        }), error => error === owned);
        await turn();
        const value = timing.snapshot(), run = value.stages['attempt.run'];
        assert.deepEqual([run.failed, run.cancelled, run.active], [3, 1, 0]);
        assert.equal(value.tail.length, 2); assert.equal(value.reportFailures, 0);
        assert.ok(Buffer.byteLength(JSON.stringify(value)) <= nativeStageTimingBounds.maximumSnapshotBytes);
    } finally {client.dispose(); timing.restore();}
});

test('counter/active saturation omits observations without blocking original lifecycle roots', async () => {
    const timing = installNativeWorkerStageTimings({enabled: true, maximumStarts: 2, maximumActive: 1, maximumTail: 1});
    const client = new WorkerAttemptClient({mode: 'controlled-local-only', role: 'ds_pool_worker'});
    try {
        for (let n = 0; n < 4; n++) assert.equal(await client.run(client.capture(descriptor), () => n), n);
        await turn(); const value = timing.snapshot();
        assert.equal(value.starts, 2); assert.ok(value.omittedStarts > 0);
        assert.ok(value.active.length <= 1); assert.ok(value.tail.length <= 1); assert.equal(value.reportFailures, 0);
    } finally {client.dispose(); timing.restore();}
});

async function snapshot(fixture, state) {
    const requestId = 'snapshot-' + state.messages.length;
    state.child.send({event: 'qualification_stage_snapshot', requestId});
    await fixture.until(() => state.messages.some(x => x.event === 'qualification_stage_snapshot' && x.requestId === requestId), state, 'bounded original stage snapshot');
    return state.messages.find(x => x.event === 'qualification_stage_snapshot' && x.requestId === requestId).snapshot;
}
const activeStage = (s, name) => s.active.filter(x => x.stage === name);

for (const [mode, role, heldEvent, release, stage] of [
    ['handoff-held-confirm', 'ds_pool_worker', 'qualification_confirm_held', 'qualification_release_confirm', 'action.trace-including-publication'],
    ['handoff-held-drain', 'ds_pool_worker', 'qualification_drain_held', 'qualification_release_drain', 'action.trace-including-publication'],
    ['handoff-held-write', 'ds_pool_worker', 'qualification_handoff_write_held', 'qualification_release_write', 'action.confirmed-handoff-persistence'],
    ['main-held-operation', 'deserializer', 'qualification_operation_fenced', 'qualification_release_operation', 'attempt.drain'],
    ['main-held-end', 'deserializer', 'qualification_end_held', 'qualification_release_end', 'attempt.end'],
]) test(`actual emitted ${mode} remains held until its original callback is released`, {timeout: 30000}, async () => {
    const fixture = managedWireAttemptFixture({role, workerMode: 'managed-original-' + mode});
    try {
        const state = fixture.spawn({HYPERION_QUALIFICATION_STAGE_TIMING_TEST: 'enabled'});
        await fixture.until(() => fixture.event(state, heldEvent), state, heldEvent);
        const held = await snapshot(fixture, state), rows = activeStage(held, stage);
        assert.equal(held.enabled, true); assert.ok(rows.length >= 1);
        const row = rows.find(r => r.mode === 'managed'); assert.ok(row, 'retain actual managed identity');
        assert.equal(row.binding.blockNum, role === 'deserializer' ? 1 : 33);
        assert.match(row.attemptId, /^[0-9a-f-]{36}$/);
        assert.equal(fixture.ownEnd(state), undefined, 'snapshot cannot release the original gate');
        if (role === 'ds_pool_worker') assert.equal(fixture.event(state, 'qualification_ack'), undefined);
        await turn(); const again = await snapshot(fixture, state);
        assert.ok(BigInt(activeStage(again, stage).find(r => r.spanId === row.spanId).elapsedNs) >= BigInt(row.elapsedNs));
        state.child.send({event: release});
        await fixture.until(() => fixture.event(state, 'qualification_fixture') && fixture.ownEnd(state), state, 'original physical callback and accepted end');
        const original = await fixture.inspectOriginal(state);
        assert.equal(original.end.rootResult, 'returned'); assert.equal(original.end.acknowledgementAttempted, true);
        assert.equal(original.snapshot.originalAckCount, 1);
        const done = await snapshot(fixture, state);
        assert.equal(done.stages[stage].active, 0); assert.ok(done.stages[stage].completed >= 1);
        assert.equal(done.stages['attempt.run'].active, 0); assert.equal(done.reportFailures, 0);
        assert.equal(done.runtime.pid, state.child.process.pid); assert.equal(done.runtime.node, process.version);
        assert.ok(done.runtime.cpuMicros.user >= 0); assert.ok(done.runtime.memoryBytes.rss > 0);
        if (role === 'ds_pool_worker') {
            assert.ok(done.stages['native.paired-or-standalone-open'].completed > 0);
            assert.ok(done.stages['native.retained-inventory'].completed > 0);
            assert.ok(done.stages['canonical.opening-recheck'].completed > 0);
            assert.ok(done.stages['action.seal'].completed > 0);
        }
        retain(mode, {held, heldAgain: again, settled: done, originalEnd: original.end,
            originalAckCount: original.snapshot.originalAckCount});
        await fixture.finish(state);
    } finally {await fixture.close();}
});

test('actual native cancellation retains the late original read until physical drain; snapshots grant no ACK/end', {timeout: 30000}, async () => {
    const fixture = managedWireAttemptFixture({role: 'ds_pool_worker', workerMode: 'managed-original-handoff-cancelled-open'});
    try {
        const state = fixture.spawn({HYPERION_QUALIFICATION_STAGE_TIMING_TEST: 'enabled'});
        await fixture.until(() => fixture.event(state, 'qualification_proof_held'), state, 'original canonical read held');
        const before = await snapshot(fixture, state);
        assert.ok(activeStage(before, 'native.paired-or-standalone-open').some(x => x.mode === 'managed' && x.input.paired === true));
        fixture.supervisor.fenceActive();
        await fixture.until(() => fixture.event(state, 'qualification_proof_wait_rejected'), state, 'outer cancellation precedes inner read settlement');
        const cancelled = await snapshot(fixture, state);
        assert.equal(fixture.ownEnd(state), undefined); assert.equal(fixture.event(state, 'qualification_ack'), undefined);
        assert.equal(fixture.event(state, 'qualification_proof_settled'), undefined);
        assert.ok(activeStage(cancelled, 'attempt.drain').some(x => x.mode === 'managed' && x.scopeAborted));
        state.child.send({event: 'qualification_release_proof'});
        await fixture.until(() => fixture.event(state, 'qualification_fixture') && fixture.ownEnd(state), state, 'actual late read and real end');
        const original = await fixture.inspectOriginal(state), done = await snapshot(fixture, state);
        assert.equal(original.end.rootResult, 'threw'); assert.equal(original.end.acknowledgementAttempted, false);
        assert.equal(original.snapshot.originalAckCount, 0);
        assert.ok(done.stages['attempt.run'].cancelled > 0 || done.stages['attempt.run'].failed > 0);
        assert.equal(done.stages['attempt.run'].active, 0); assert.equal(done.stages['attempt.drain'].active, 0);
        assert.equal(done.reportFailures, 0);
        const fenced = fixture.event(state, 'qualification_proof_fenced');
        assert.deepEqual(fixture.event(state, 'qualification_proof_settled').effects, fenced.effects);
        retain('handoff-cancelled-open', {held: before, cancelled, settled: done, originalEnd: original.end,
            fenced, originalReadSettled: fixture.event(state, 'qualification_proof_settled'),
            originalAckCount: original.snapshot.originalAckCount});
        await fixture.finish(state);
    } finally {await fixture.close();}
});
