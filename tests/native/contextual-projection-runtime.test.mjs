import assert from 'node:assert/strict';
import test from 'node:test';
import {databaseFixture, genesis, hex, errorCode} from '../../packages/backend-mongodb/tests/fixture.mjs';
import {createMongoDbContextualRecoveryAdapter} from '../../packages/backend-mongodb/dist/index.js';

const definition = {schemaVersion: 2, id: 'runtime-contextual', mappingRevision: hex(10),
    source: {contract: 'token', table: 'items', abiDeployment: 'deployment-1', abiSha256: hex(11)},
    fields: [{name: 'owner', type: 'string', source: {kind: 'row', path: ['owner']}},
        {name: 'created', type: 'string', source: {kind: 'context', field: 'blockNum', format: 'decimal'}},
        {name: 'time', type: 'string', source: {kind: 'context', field: 'blockTimeMs', format: 'decimal'}}],
    initialization: {kind: 'genesis'}, preserveOnReplace: ['created', 'time'], onAbsent: 'incomplete'};
const binding = {chainId: hex(12), backendId: 'runtime-context', projectionId: definition.id,
    mappingRevision: definition.mappingRevision, abiDeployment: definition.source.abiDeployment,
    abiSha256: definition.source.abiSha256, generation: 'instance-1'};
const frame = (number, owner) => ({chainId: binding.chainId,
    block: {blockNum: number, blockId: hex(number), previousBlockId: hex(number - 1)},
    context: {contract: 'token', table: 'items', blockTimeMs: number * 1000},
    changes: [{contract: 'token', table: 'items', scope: '', primaryKey: 'one',
        abiDeployment: binding.abiDeployment, abiSha256: binding.abiSha256, present: true,
        value: {owner, created: 'untrusted', time: 'untrusted'}}]});
const adapterFor = fixture => createMongoDbContextualRecoveryAdapter({client: fixture.client,
    databaseName: 'contextual_runtime_fixture', backendId: binding.backendId});

test('the contextual runtime maps trusted context, preserves creation and resumes through fenced recovery', async () => {
    const {ContextualProjectionRuntime} = await import('../../build/indexer/projection/contextual-runtime.js');
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const runtime = await ContextualProjectionRuntime.create({adapter, definition, binding, genesis});
    await runtime.process(frame(1, 'alice')); const b = await runtime.process(frame(2, 'bob'));
    assert.deepEqual((await runtime.query({filter: [], limit: 10})).rows, [{key: '["","one"]',
        value: {owner: 'bob', created: '1', time: '1000'}}]);
    const undo = {binding, revision: b.view.revision, operationId: 'runtime-fork', from: b.view.checkpoint,
        ancestor: {blockNum: 1, blockId: hex(1)}, maxBlocks: 1};
    await runtime.rollback(undo);
    await assert.rejects(runtime.query({filter: [], limit: 10}, b.view), errorCode('projection.stale-revision'));
    const replacement = frame(2, 'carol'); replacement.block.blockId = hex(100); replacement.context.blockTimeMs = 3000;
    const c = await runtime.process(replacement);
    assert.deepEqual((await runtime.query({filter: [], limit: 10})).rows, [{key: '["","one"]',
        value: {owner: 'carol', created: '1', time: '1000'}}]);
    assert.notEqual(c.view.revision, b.view.revision);
});

test('capability and queue-budget refusal happen before initialization or source effects', async () => {
    const {ContextualProjectionRuntime} = await import('../../build/indexer/projection/contextual-runtime.js');
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const missing = new Proxy(adapter, {get(target, key) {
        if (key === 'capabilities') return {...target.capabilities, supported: []};
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await assert.rejects(ContextualProjectionRuntime.create({adapter: missing, definition, binding, genesis}), errorCode('projection.capability-unavailable'));
    await assert.rejects(ContextualProjectionRuntime.create({adapter, definition, binding, genesis, maximumPendingFrames: 0}),
        errorCode('projection.invalid-contract'));
    assert.equal(fixture.native.length, 0);
});

test('missing context, absent rows and malformed vectors fence only their projection', async () => {
    const {ContextualProjectionRuntime} = await import('../../build/indexer/projection/contextual-runtime.js');
    for (const fault of ['missing-time', 'absent', 'invalid-presence', 'malformed-vector', 'accessor']) {
        const fixture = databaseFixture(), adapter = adapterFor(fixture);
        const runtime = await ContextualProjectionRuntime.create({adapter, definition, binding, genesis});
        const input = frame(1, 'alice'); let calls = 0;
        if (fault === 'missing-time') delete input.context.blockTimeMs;
        if (fault === 'absent') {input.changes[0].present = false; delete input.changes[0].value;}
        if (fault === 'invalid-presence') input.changes[0].present = 'false';
        if (fault === 'malformed-vector') input.changes = 'malformed';
        if (fault === 'accessor') Object.defineProperty(input.changes[0].value, 'owner', {enumerable: true, get() {calls++; return 'bad';}});
        await assert.rejects(runtime.process(input));
        assert.equal(calls, 0);
        const state = await runtime.recovery(); assert.equal(state.checkpoint.blockNum, 0); assert.equal(state.pending.block.blockNum, 1);
        await assert.rejects(runtime.open(), errorCode('projection.incomplete'));
        const otherDefinition = {...definition, id: 'unrelated'}, otherBinding = {...binding, projectionId: 'unrelated'};
        const other = await ContextualProjectionRuntime.create({adapter: adapterFor(fixture), definition: otherDefinition, binding: otherBinding, genesis});
        const healthy = await other.process(frame(1, 'healthy')); assert.equal(healthy.view.checkpoint.blockNum, 1);
        assert.equal((await other.query({filter: [], limit: 10})).rows[0].value.owner, 'healthy');
    }
});

test('bounded FIFO captures old revisions and drains actual work before exact recovery', async () => {
    const {ContextualProjectionRuntime} = await import('../../build/indexer/projection/contextual-runtime.js');
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const runtime = await ContextualProjectionRuntime.create({adapter, definition, binding, genesis, maximumPendingFrames: 2});
    const before = await runtime.recovery();
    let release, entered;
    const held = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
    fixture.beforeFind = async name => {
        if (!name.endsWith('_metadata')) return;
        fixture.beforeFind = null; entered(); await held;
    };
    const first = runtime.process(frame(1, 'alice')); const firstRejected = assert.rejects(first, errorCode('projection.stale-revision'));
    await started;
    const second = runtime.process(frame(2, 'bob')); const secondRejected = assert.rejects(second, errorCode('projection.stale-revision'));
    await assert.rejects(runtime.process(frame(3, 'overflow')), errorCode('projection.apply-unavailable'));
    const originalPlan = {binding, revision: before.revision, operationId: 'original-from-zero', from: genesis, ancestor: genesis, maxBlocks: 1};
    let settled = false;
    const recovery = runtime.rollback(originalPlan); recovery.finally(() => {settled = true;}).catch(() => {});
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, 'No recovery before original awaited work settles');
    const refused = assert.rejects(recovery, errorCode('projection.stale-view'));
    release(); await Promise.all([firstRejected, secondRejected, refused]);
    const committed = await runtime.recovery(); assert.equal(committed.checkpoint.blockNum, 1);
    await runtime.rollback({...originalPlan, operationId: 'fresh-exact-plan', from: committed.checkpoint});
    assert.deepEqual((await runtime.query({filter: [], limit: 10})).rows, []);
});

test('mapping failure keeps its causal error when original failure-marking callbacks fence the scope', async () => {
    const {ContextualProjectionRuntime} = await import('../../build/indexer/projection/contextual-runtime.js');
    const {ProofConsumerScope} = await import('../../build/indexer/protocol/proof-consumer-scope.js');
    for (const rejectFallback of [false, true]) {
        const fixture = databaseFixture(), adapter = adapterFor(fixture), scope = new ProofConsumerScope('contextual-map-error-' + rejectFallback);
        const wrapped = new Proxy(adapter, {get(target, key) {
            if (key === 'markIncomplete') return async request => {
                await target.markIncomplete(request); scope.fence();
                if (rejectFallback) throw scope.signal.reason;
            };
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        }});
        const runtime = await ContextualProjectionRuntime.create({adapter: wrapped, definition, binding, genesis});
        const absent = frame(1, 'alice'); absent.changes[0].present = false; delete absent.changes[0].value;
        const error = await scope.run(() => runtime.process(absent)).then(() => assert.fail('Mapping must fail'), error => error);
        assert.equal(error.code, 'projection.incomplete'); assert.equal(scope.ownsFenceError(error), false);
        await scope.closeAndDrain();
        assert.equal((await adapter.recovery(binding)).checkpoint.blockNum, 0);
    }
});
