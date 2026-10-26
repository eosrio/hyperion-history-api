import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as backends from '../dist/index.js';
import {binding, copy, databaseFixture, definition, errorCode, genesis, hex, put, request} from './fixture.mjs';

const checkpoint = number => ({blockNum: number, blockId: hex(number)});
const metadata = fixture => [...fixture.storage.values()].flatMap(collection => [...collection.values()])
    .find(record => record.storageVersion);
const adapterFor = (fixture, options) => backends.createMongoDbRecoveryAdapter({
    client: fixture.client, databaseName: 'portable_fixture', backendId: binding.backendId, ...options,
});
const populate = async (adapter, count) => {
    const initial = await adapter.initialize(definition, binding, genesis);
    for (let number = 1; number <= count; number++) {
        await adapter.apply({revision: initial.revision, batch: request(number, [put('x', 'alice', number)])});
    }
    return initial;
};
const inspection = (adapter, revision) => adapter.retainedCheckpoints({binding, revision});

test('recovery factory adds independently declared inspection while original factories remain unchanged', async () => {
    assert.equal(typeof backends.createMongoDbRecoveryAdapter, 'function');
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    assert.deepEqual(adapter.capabilities, fixture.rollbackAdapter().capabilities);
    assert.equal(adapter.capabilities.interfaceVersion, 2);
    assert.deepEqual(adapter.recoveryCapabilities, {interfaceVersion: 1, supported: ['retained-checkpoints']});
    assert.ok(Object.isFrozen(adapter.recoveryCapabilities) && Object.isFrozen(adapter.recoveryCapabilities.supported));
    for (const old of [fixture.adapter(), fixture.rollbackAdapter()]) {
        assert.equal(old.retainedCheckpoints, undefined);
        assert.equal(old.recoveryCapabilities, undefined);
    }
    const initial = await adapter.initialize(definition, binding, genesis);
    assert.deepEqual(JSON.parse(JSON.stringify((await inspection(adapter, initial.revision)).checkpoints)), [genesis]);
});

test('one durable validated metadata read returns the exact detached path without native undo images', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture);
    const initial = await populate(adapter, 3);
    fixture.native.length = 0;
    let reads = 0;
    fixture.beforeFind = () => {reads++; if (reads > 1) throw new Error('second metadata read would race the snapshot');};
    const output = await inspection(adapter, initial.revision);
    fixture.beforeFind = null;
    assert.deepEqual(JSON.parse(JSON.stringify(output.checkpoints)), [checkpoint(3), checkpoint(2), checkpoint(1), checkpoint(0)]);
    assert.equal(output.recovery.coverage.retainedBlocks + 1, output.checkpoints.length);
    assert.equal(output.recovery.revision, initial.revision);
    assert.equal(reads, 1);
    assert.equal(fixture.native.length, 1);
    const command = fixture.native[0];
    assert.equal(command.command, 'findOne');
    assert.equal(command.options.readPreference, 'primary');
    assert.deepEqual(command.options.readConcern, {level: 'majority'});
    assert.ok(!command.name.includes('_u_'), 'inspection does not read before-images');
    const encoded = JSON.stringify(output);
    assert.ok(!encoded.includes('imagesHash') && !encoded.includes('definitionHash') && !encoded.includes('storageVersion'));
    metadata(fixture).undo[1].block.blockId = hex(900);
    metadata(fixture).coverageFloor.blockId = hex(901);
    assert.equal(output.checkpoints[1].blockId, hex(2));
    assert.equal(output.recovery.coverage.floor.blockId, hex(0));
    assert.ok(Object.isFrozen(output.checkpoints[0]) && Object.isFrozen(output.recovery.coverage) && Object.isFrozen(output));
});

test('pruning, partial rollback restart and replacement report only the actually retained applied branch', async () => {
    const fixture = databaseFixture(), options = {rollbackRetentionBlocks: 2};
    const adapter = adapterFor(fixture, options), initial = await populate(adapter, 4);
    const before = await inspection(adapter, initial.revision);
    assert.deepEqual(JSON.parse(JSON.stringify(before.checkpoints)), [checkpoint(4), checkpoint(3), checkpoint(2)]);
    const plan = {binding, revision: initial.revision, from: checkpoint(4), ancestor: checkpoint(2), operationId: 'retained-fork', maxBlocks: 1};
    const partial = await adapter.rollback(plan);
    assert.equal(partial.status, 'in-progress');
    const restarted = adapterFor(fixture, options);
    const during = await inspection(restarted, partial.recovery.revision);
    assert.deepEqual(JSON.parse(JSON.stringify(during.checkpoints)), [checkpoint(3), checkpoint(2)]);
    assert.equal(during.recovery.rollback.status, 'running');
    assert.equal(during.recovery.rollback.sourceRevision, initial.revision);
    await assert.rejects(inspection(restarted, initial.revision), errorCode('projection.stale-revision'));
    await assert.rejects(restarted.open(binding), errorCode('projection.incomplete'));
    const complete = await restarted.rollback(plan);
    const after = await inspection(restarted, complete.recovery.revision);
    assert.deepEqual(JSON.parse(JSON.stringify(after.checkpoints)), [checkpoint(2)]);
    assert.equal(after.recovery.rollback.status, 'complete');
    const replacement = request(3, [put('x', 'alice', 303)]);
    replacement.block.blockId = hex(303);
    await restarted.apply({revision: complete.recovery.revision, batch: replacement});
    const replaced = await inspection(adapterFor(fixture, options), complete.recovery.revision);
    assert.deepEqual(JSON.parse(JSON.stringify(replaced.checkpoints)), [{blockNum: 3, blockId: hex(303)}, checkpoint(2)]);
    assert.equal(replaced.recovery.rollback.status, 'complete');
});

test('legacy migration reports its actual floor and never invents unretained older checkpoint IDs', async () => {
    const fixture = databaseFixture(), legacy = fixture.adapter();
    await legacy.initialize(definition, binding, genesis);
    await legacy.apply(request(1, [put('x', 'alice', 1)]));
    await legacy.apply(request(2, [put('x', 'alice', 2)]));
    const adapter = adapterFor(fixture), initial = await adapter.initialize(definition, binding, genesis);
    const migrated = await inspection(adapter, initial.revision);
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.checkpoints)), [checkpoint(2)]);
    assert.equal(migrated.recovery.coverage.retainedBlocks, 0);
    await adapter.apply({revision: initial.revision, batch: request(3, [])});
    const advanced = await inspection(adapterFor(fixture), initial.revision);
    assert.deepEqual(JSON.parse(JSON.stringify(advanced.checkpoints)), [checkpoint(3), checkpoint(2)]);
    await assert.rejects(legacy.open(binding), errorCode('projection.invalid-contract'));
});

test('pending, gap and unavailable recovery remain inspectable without granting serving readiness', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture), initial = await populate(adapter, 3);
    await adapter.markIncomplete({binding, revision: initial.revision, block: request(4, []).block, reason: 'source admitted'});
    await assert.rejects(adapter.markIncomplete({binding, revision: initial.revision, block: request(6, []).block, reason: 'future source gap'}),
        errorCode('projection.source-gap'));
    const pending = await inspection(adapterFor(fixture), initial.revision);
    assert.equal(pending.recovery.pending.block.blockNum, 4);
    assert.equal(pending.recovery.gap.block.blockNum, 6);
    assert.equal(pending.recovery.checkpoint.blockNum, 3);
    await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
    await assert.rejects(adapter.query({binding, revision: initial.revision, checkpoint: checkpoint(3)}, {filter: [], limit: 1}),
        errorCode('projection.incomplete'));
    await assert.rejects(adapter.rollback({binding, revision: initial.revision, from: checkpoint(3),
        ancestor: {blockNum: 2, blockId: hex(999)}, operationId: 'unavailable-fork', maxBlocks: 1}),
    errorCode('projection.rollback-unavailable'));
    const current = await adapter.recovery(binding);
    const unavailable = await inspection(adapterFor(fixture), current.revision);
    assert.equal(unavailable.recovery.rollback.status, 'unavailable');
    assert.deepEqual(JSON.parse(JSON.stringify(unavailable.checkpoints)), [checkpoint(3), checkpoint(2), checkpoint(1), checkpoint(0)]);
    await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
});

test('inspection captures request identity before awaiting I/O and rejects invalid or stale requests', async () => {
    const fixture = databaseFixture(), adapter = adapterFor(fixture), initial = await populate(adapter, 1);
    const input = {binding: copy(binding), revision: initial.revision};
    fixture.beforeFind = () => {input.binding.generation = 'changed'; input.revision = hex(999);};
    const output = await adapter.retainedCheckpoints(input);
    fixture.beforeFind = null;
    assert.equal(output.recovery.binding.generation, binding.generation);
    assert.equal(output.recovery.revision, initial.revision);
    for (const value of [{binding, revision: 'bad'}, {binding: {...binding, backendId: 'other'}, revision: initial.revision},
        {binding, revision: initial.revision, nativeSession: {}}, {binding: {...binding, $where: 'native'}, revision: initial.revision}]) {
        fixture.native.length = 0;
        await assert.rejects(adapter.retainedCheckpoints(value), errorCode('projection.invalid-contract'));
        assert.equal(fixture.native.length, 0);
    }
    let executions = 0;
    const accessor = {binding};
    Object.defineProperty(accessor, 'revision', {enumerable: true, get() {executions++; return initial.revision;}});
    fixture.native.length = 0;
    await assert.rejects(adapter.retainedCheckpoints(accessor), errorCode('projection.invalid-contract'));
    assert.equal(executions, 0); assert.equal(fixture.native.length, 0);
    const saved = JSON.stringify(metadata(fixture));
    await assert.rejects(inspection(adapter, hex(998)), errorCode('projection.stale-revision'));
    assert.equal(JSON.stringify(metadata(fixture)), saved);
});

test('missing, unavailable or corrupt metadata fails instead of reporting fabricated retained coverage', async () => {
    const empty = databaseFixture();
    await assert.rejects(inspection(adapterFor(empty), hex(1)), errorCode('projection.not-initialized'));
    const fixture = databaseFixture(), adapter = adapterFor(fixture), initial = await populate(adapter, 3);
    fixture.beforeFind = () => {throw new Error('majority read unavailable');};
    await assert.rejects(inspection(adapter, initial.revision), errorCode('projection.apply-unavailable'));
    fixture.beforeFind = null;
    const saved = copy(metadata(fixture));
    for (const mutate of [value => {value.undo.splice(1, 1);}, value => {value.undo[1].block.previousBlockId = hex(999);},
        value => {value.checkpoint.revision = hex(999);}, value => {value.coverageFloor = checkpoint(1);},
        value => {value.undo[0].block.blockId = value.undo[1].block.blockId;}]) {
        const value = metadata(fixture);
        for (const key of Object.keys(value)) delete value[key];
        Object.assign(value, copy(saved));
        mutate(value);
        await assert.rejects(inspection(adapter, initial.revision), errorCode('projection.invalid-contract'));
    }
    const value = metadata(fixture);
    for (const key of Object.keys(value)) delete value[key];
    Object.assign(value, copy(saved));
    value.binding.generation = 'other';
    await assert.rejects(inspection(adapter, initial.revision), errorCode('projection.stale-view'));
});
