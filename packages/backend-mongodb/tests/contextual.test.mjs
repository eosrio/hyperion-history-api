import assert from 'node:assert/strict';
import test from 'node:test';
import * as adapters from '../dist/index.js';
import {databaseFixture, binding as oldBinding, genesis, hex, errorCode} from './fixture.mjs';

export const definition = {schemaVersion: 2, id: 'contextual-items', mappingRevision: hex(10),
    source: {contract: 'token', table: 'items', abiDeployment: 'deployment-1', abiSha256: hex(11)},
    fields: [{name: 'contract', type: 'string', source: {kind: 'context', field: 'contract'}},
        {name: 'owner', type: 'string', source: {kind: 'row', path: ['owner']}},
        {name: 'created', type: 'string', source: {kind: 'context', field: 'blockNum', format: 'decimal'}},
        {name: 'time', type: 'string', source: {kind: 'context', field: 'blockTimeMs', format: 'decimal'}},
        {name: 'nullable', type: 'null', source: {kind: 'row', path: ['nullable']}}],
    initialization: {kind: 'genesis'}, preserveOnReplace: ['created', 'time', 'nullable'], onAbsent: 'incomplete'};
export const binding = {...oldBinding, projectionId: definition.id};
export const all = {filter: [], limit: 100};
export const put = (owner, number, time = number * 1000) => ({kind: 'put-preserving', key: 'one',
    value: {contract: 'token', owner, created: String(number), time: String(time), nullable: null},
    preserveFields: ['created', 'time', 'nullable']});
export const batch = (number, mutations, time = number * 1000, id = hex(number), previous = hex(number - 1)) => ({
    binding, previous: {blockNum: number - 1, blockId: previous}, block: {blockNum: number, blockId: id, previousBlockId: previous},
    source: {contract: 'token', table: 'items', blockTimeMs: time},
    policy: {preserveOnReplace: ['created', 'time', 'nullable'], onAbsent: 'incomplete'}, mutations});
export const adapterFor = fixture => adapters.createMongoDbContextualRecoveryAdapter({client: fixture.client,
    databaseName: 'portable_contextual_fixture', backendId: binding.backendId});

test('contextual Mongo replacements preserve first creation and required null in transaction order', async () => {
    assert.equal(typeof adapters.createMongoDbContextualRecoveryAdapter, 'function');
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const start = await adapter.initialize(definition, binding, genesis);
    const first = {revision: start.revision, batch: batch(1, [put('alice', 1)])};
    const a = await adapter.apply(first);
    const second = {revision: start.revision, batch: batch(2, [put('bob', 2), put('carol', 2)])};
    const b = await adapter.apply(second);
    assert.equal(a.status, 'applied'); assert.equal(b.status, 'applied');
    assert.deepEqual((await adapter.query(b.view, all)).rows, [{key: 'one',
        value: {contract: 'token', owner: 'carol', created: '1', time: '1000', nullable: null}}]);
    assert.equal((await adapter.apply(second)).status, 'duplicate');
    const reopened = adapterFor(fixture);
    assert.deepEqual(await reopened.open(binding), b.view);
    const retained = await reopened.retainedCheckpoints({binding, revision: b.view.revision});
    assert.ok(Object.isFrozen(retained.checkpoints) && Object.isFrozen(retained.checkpoints[0]));
    assert.deepEqual(retained.checkpoints.map(point => ({...point})),
        [{blockNum: 2, blockId: hex(2)}, {blockNum: 1, blockId: hex(1)}, genesis]);
    await assert.rejects(reopened.apply({...second, batch: {...second.batch,
        mutations: [put('bob', 2), put('carol', 2, 1000)]}}), errorCode('projection.conflicting-replay'));
});

test('rollback B restores A, rollback A removes it, and replacement C receives new creation context', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const start = await adapter.initialize(definition, binding, genesis);
    await adapter.apply({revision: start.revision, batch: batch(1, [put('alice', 1)])});
    const b = await adapter.apply({revision: start.revision, batch: batch(2, [put('bob', 2), put('carol', 2)])});
    const undoB = {binding, revision: start.revision, operationId: 'undo-B', from: b.view.checkpoint,
        ancestor: {blockNum: 1, blockId: hex(1)}, maxBlocks: 1};
    const restored = await adapter.rollback(undoB);
    assert.equal(restored.status, 'rolled-back');
    const aView = await adapter.open(binding);
    assert.deepEqual((await adapter.query(aView, all)).rows, [{key: 'one', value: put('alice', 1).value}]);
    assert.notEqual(aView.revision, start.revision);
    await assert.rejects(adapter.apply({revision: start.revision, batch: batch(2, [put('old', 2)])}), errorCode('projection.stale-revision'));
    await assert.rejects(adapter.query(b.view, all), errorCode('projection.stale-revision'));
    const undoA = {binding, revision: aView.revision, operationId: 'undo-A', from: aView.checkpoint, ancestor: genesis, maxBlocks: 1};
    await adapterFor(fixture).rollback(undoA);
    const empty = await adapter.open(binding);
    assert.deepEqual((await adapter.query(empty, all)).rows, []);
    const c = {revision: empty.revision, batch: batch(1, [put('dora', 1, 3000)], 3000, hex(100))};
    const applied = await adapter.apply(c);
    assert.deepEqual((await adapter.query(applied.view, all)).rows, [{key: 'one', value: put('dora', 1, 3000).value}]);
    assert.equal((await adapter.rollback(undoA)).status, 'duplicate', 'Lost completion retry cannot undo replacement C');
    assert.deepEqual((await adapter.query(applied.view, all)).rows, [{key: 'one', value: put('dora', 1, 3000).value}]);
    await assert.rejects(adapter.rollback(undoB), errorCode('projection.stale-revision'));
});

test('failed and uncertain writes retain exact original candidates for a fresh adapter retry', async () => {
    for (const fault of ['effect', 'uncertain-intent']) {
        const fixture = databaseFixture(), adapter = adapterFor(fixture);
        const start = await adapter.initialize(definition, binding, genesis);
        await adapter.apply({revision: start.revision, batch: batch(1, [put('alice', 1)])});
        const request = {revision: start.revision, batch: batch(2, [put('bob', 2), put('carol', 2)])};
        if (fault === 'effect') fixture.failPut = true;
        else fixture.failFindAndModify = 'after';
        await assert.rejects(adapter.apply(request), errorCode('projection.apply-unavailable'));
        const reopened = adapterFor(fixture), recovery = await reopened.recovery(binding);
        assert.equal(recovery.checkpoint.blockNum, 1); assert.equal(recovery.pending.block.blockNum, 2);
        assert.match(recovery.pending.digest, /^[0-9a-f]{64}$/);
        await assert.rejects(reopened.open(binding), errorCode('projection.incomplete'));
        await assert.rejects(reopened.apply({...request, batch: {...request.batch, source: {...request.batch.source, blockTimeMs: 2001}}}),
            errorCode('projection.conflicting-replay'));
        const applied = await reopened.apply(request);
        assert.deepEqual((await reopened.query(applied.view, all)).rows, [{key: 'one',
            value: {contract: 'token', owner: 'carol', created: '1', time: '1000', nullable: null}}]);
    }
});

test('missing context is represented by a fenced incomplete marker, never a fabricated apply', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const start = await adapter.initialize(definition, binding, genesis);
    await adapter.markIncomplete({binding, revision: start.revision, block: batch(1, []).block, reason: 'Original timestamp is unavailable'});
    await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
    assert.equal((await adapter.recovery(binding)).checkpoint.blockNum, 0);
    const writes = () => fixture.native.filter(item => ['replace', 'delete', 'update', 'findAndModify'].includes(item.command)).length;
    const before = writes();
    const malformed = {revision: start.revision, batch: batch(1, [put('alice', 1)])}; delete malformed.batch.source;
    await assert.rejects(adapter.apply(malformed), errorCode('projection.invalid-contract'));
    await assert.rejects(adapter.markIncomplete({binding, revision: 'f'.repeat(64), block: batch(1, []).block, reason: 'stale'}),
        errorCode('projection.stale-revision'));
    assert.equal(writes(), before);
    const applied = await adapter.apply({revision: start.revision, batch: batch(1, [put('alice', 1)])});
    assert.equal(applied.view.checkpoint.blockNum, 1);
});

test('the contextual storage family refuses legacy adoption and unfenced policy bypass', async () => {
    const legacyDefinition = {schemaVersion: 1, id: definition.id, mappingRevision: definition.mappingRevision,
        source: definition.source, initialization: definition.initialization,
        fields: definition.fields.map(field => ({name: field.name, type: field.type, path: [field.name]}))};
    const fixture = databaseFixture();
    await fixture.adapter().initialize(legacyDefinition, binding, genesis);
    await assert.rejects(adapterFor(fixture).initialize(definition, binding, genesis), errorCode('projection.capability-unavailable'));
    const isolated = databaseFixture(), contextual = adapterFor(isolated);
    const start = await contextual.initialize(definition, binding, genesis);
    await assert.rejects(isolated.adapter().initialize(legacyDefinition, binding, genesis), errorCode('projection.invalid-contract'));
    await assert.rejects(isolated.rollbackAdapter().initialize(legacyDefinition, binding, genesis), errorCode('projection.capability-unavailable'));
    const bypass = {revision: start.revision, batch: batch(1, [put('alice', 1)])};
    bypass.batch.mutations[0] = {kind: 'put', key: 'one', value: put('alice', 1).value};
    await assert.rejects(contextual.apply(bypass), errorCode('projection.invalid-contract'));
    assert.equal((await contextual.open(binding)).checkpoint.blockNum, 0);
});

test('an owner revision changed across the awaited durable lookup rejects effects and publication', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const start = await adapter.initialize(definition, binding, genesis);
    const a = await adapter.apply({revision: start.revision, batch: batch(1, [put('alice', 1)])});
    fixture.beforeFind = async name => {
        if (!name.endsWith('_metadata')) return;
        fixture.beforeFind = null;
        await adapterFor(fixture).rollback({binding, revision: start.revision, operationId: 'rotate-before-apply',
            from: a.view.checkpoint, ancestor: a.view.checkpoint, maxBlocks: 1});
    };
    await assert.rejects(adapter.apply({revision: start.revision, batch: batch(2, [put('old', 2)])}), errorCode('projection.stale-revision'));
    const current = await adapter.open(binding); let reads = 0;
    fixture.beforeFind = async (name, options) => {
        if (!name.endsWith('_metadata') || options?.session || ++reads !== 2) return;
        fixture.beforeFind = null;
        await adapterFor(fixture).rollback({binding, revision: current.revision, operationId: 'rotate-before-publication',
            from: current.checkpoint, ancestor: current.checkpoint, maxBlocks: 1});
    };
    await assert.rejects(adapter.query(current, all), errorCode('projection.stale-revision'));
    assert.equal((await adapter.open(binding)).checkpoint.blockNum, 1);
});

test('the final preserved record is bounded even when prior and candidate each fit', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const large = {...definition, id: 'large-context',
        fields: Array.from({length: 8}, (_, index) => ({name: 'f' + index, type: 'string', source: {kind: 'row', path: ['f' + index]}})),
        preserveOnReplace: ['f0', 'f1', 'f2', 'f3']};
    const selected = {...binding, projectionId: large.id};
    const start = await adapter.initialize(large, selected, genesis);
    const record = preserved => Object.fromEntries(large.fields.map((field, index) => [field.name,
        (index < 4) === preserved ? 'x'.repeat(60000) : '']));
    const request = (number, value) => ({revision: start.revision, batch: {...batch(number, []), binding: selected,
        policy: {preserveOnReplace: large.preserveOnReplace, onAbsent: 'incomplete'},
        mutations: [{kind: 'put-preserving', key: 'large', value, preserveFields: large.preserveOnReplace}]}});
    await adapter.apply(request(1, record(true)));
    await assert.rejects(adapter.apply(request(2, record(false))), errorCode('projection.invalid-contract'));
    assert.equal((await adapter.recovery(selected)).checkpoint.blockNum, 1);
    await assert.rejects(adapter.open(selected), errorCode('projection.incomplete'));
});

test('explicit nonpreserving put remains a full replacement and declared deletion has a real before-image', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const ordinary = {...definition, id: 'ordinary-context', preserveOnReplace: [], onAbsent: 'delete'};
    const selected = {...binding, projectionId: ordinary.id};
    const start = await adapter.initialize(ordinary, selected, genesis);
    const request = (number, mutations) => ({revision: start.revision, batch: {...batch(number, mutations), binding: selected,
        policy: {preserveOnReplace: [], onAbsent: 'delete'}}});
    await adapter.apply(request(1, [{kind: 'put', key: 'one', value: put('alice', 1).value}]));
    const b = await adapter.apply(request(2, [{kind: 'put', key: 'one', value: put('bob', 2).value}]));
    assert.deepEqual((await adapter.query(b.view, all)).rows, [{key: 'one', value: put('bob', 2).value}]);
    const removed = await adapter.apply(request(3, [{kind: 'delete', key: 'one'}]));
    assert.deepEqual((await adapter.query(removed.view, all)).rows, []);
    await adapter.rollback({binding: selected, revision: start.revision, operationId: 'undo-declared-delete',
        from: removed.view.checkpoint, ancestor: b.view.checkpoint, maxBlocks: 1});
    assert.deepEqual((await adapter.query(await adapter.open(selected), all)).rows, [{key: 'one', value: put('bob', 2).value}]);
});
