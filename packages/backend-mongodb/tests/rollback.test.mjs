import assert from 'node:assert/strict';
import { test } from 'node:test';
import { binding, copy, databaseFixture, definition, errorCode, genesis, hex, put, request } from './fixture.mjs';

const metadata = fixture => [...fixture.storage.values()].flatMap(collection => [...collection.values()])
    .find(record => record.storageVersion);
const rows = async (adapter, selected = binding) => (await adapter.query(await adapter.open(selected), { filter: [], limit: 100 })).rows;
const plan = (view, ancestor, operationId = 'canonical-fork-1', maxBlocks = 1) => ({
    binding: copy(view.binding), revision: view.revision, from: copy(view.checkpoint), ancestor: copy(ancestor), operationId, maxBlocks,
});

test('rolls back orphan insert/update/delete and repeated keys, then admits a replacement and exact duplicates', async () => {
    const fixture = databaseFixture(), adapter = fixture.rollbackAdapter();
    const initial = await adapter.initialize(definition, binding, genesis);
    const first = await adapter.apply({ revision: initial.revision, batch: request(1, [put('keep', 'alice', 1), put('restore', 'bob', 2)]) });
    const second = await adapter.apply({ revision: initial.revision, batch: request(2, [
        put('keep', 'alice', 8), put('new', 'carol', 9), { kind: 'delete', key: 'restore' },
        put('keep', 'alice', 10), { kind: 'delete', key: 'new' }, put('new', 'carol', 11),
    ]) });
    assert.equal(metadata(fixture).undo[1].count, 3, 'one first before-image per distinct key');
    const recovery = await adapter.rollback(plan(second.view, first.view.checkpoint));
    assert.equal(recovery.status, 'rolled-back');
    assert.notEqual(recovery.recovery.revision, initial.revision);
    assert.deepEqual(await rows(adapter), [
        { key: 'keep', value: { owner: 'alice', balance: 1, enabled: true, empty: null } },
        { key: 'restore', value: { owner: 'bob', balance: 2, enabled: true, empty: null } },
    ]);
    await assert.rejects(adapter.query(first.view, { filter: [], limit: 1 }), errorCode('projection.stale-revision'));
    const replacement = request(2, [put('keep', 'alice', 22)]);
    replacement.block.blockId = hex(202);
    const applied = await adapter.apply({ revision: recovery.recovery.revision, batch: replacement });
    assert.equal((await adapter.apply({ revision: recovery.recovery.revision, batch: replacement })).status, 'duplicate');
    assert.equal((await adapter.rollback(plan(second.view, first.view.checkpoint))).status, 'duplicate');
    assert.deepEqual((await adapter.open(binding)).checkpoint, applied.view.checkpoint);
    assert.equal((await rows(adapter))[0].value.balance, 22);
    await assert.rejects(adapter.apply({ revision: initial.revision, batch: replacement }), errorCode('projection.stale-revision'));
});

test('one-block steps restart from durable cursor while old writers and views remain fenced', async () => {
    const fixture = databaseFixture(), adapter = fixture.rollbackAdapter({ receiptRetention: 1 });
    const initial = await adapter.initialize(definition, binding, genesis);
    const views = [];
    for (let number = 1; number <= 4; number++) views.push((await adapter.apply({ revision: initial.revision, batch: request(number, [put('x', 'alice', number)]) })).view);
    const original = plan(views[3], views[0].checkpoint, 'restart-fork', 1);
    let result = await adapter.rollback(original);
    assert.equal(result.status, 'in-progress');
    assert.equal(result.recovery.checkpoint.blockNum, 3);
    assert.equal(metadata(fixture).rollback.status, 'running');
    await assert.rejects(fixture.rollbackAdapter().open(binding), errorCode('projection.incomplete'));
    await assert.rejects(adapter.markIncomplete({ binding, revision: initial.revision, block: request(4, []).block, reason: 'late failure' }), errorCode('projection.stale-revision'));
    await assert.rejects(adapter.apply({ revision: result.recovery.revision, batch: request(4, []) }), errorCode('projection.incomplete'));
    result = await fixture.rollbackAdapter({ receiptRetention: 1 }).rollback(original);
    assert.equal(result.recovery.checkpoint.blockNum, 2);
    result = await fixture.rollbackAdapter({ receiptRetention: 1 }).rollback(original);
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual(result.recovery.checkpoint, views[0].checkpoint);
    assert.equal((await rows(fixture.rollbackAdapter({ receiptRetention: 1 })))[0].value.balance, 1);
    // Ordinary receipts expired, but the exact retained undo descriptor supplies the real digest.
    assert.equal((await adapter.apply({ revision: result.recovery.revision, batch: request(1, [put('x', 'alice', 1)]) })).status, 'duplicate');
});

test('explicit v1 migration starts coverage at actual checkpoint and rejects unfenced legacy access', async () => {
    const fixture = databaseFixture(), legacy = fixture.adapter();
    await legacy.initialize(definition, binding, genesis);
    await legacy.apply(request(1, [put('x', 'alice', 1)]));
    await legacy.apply(request(2, [put('x', 'alice', 2)]));
    const adapter = fixture.rollbackAdapter();
    const view = await adapter.initialize(definition, binding, genesis);
    assert.equal(view.checkpoint.blockNum, 2);
    assert.deepEqual((await adapter.recovery(binding)).coverage, {
        floor: view.checkpoint, retainedBlocks: 0, retainedBytes: 0, maxBlocks: 256, maxBytes: 64 * 1024 * 1024,
    });
    await assert.rejects(legacy.open(binding), errorCode('projection.invalid-contract'));
    await assert.rejects(legacy.markIncomplete(binding, request(3, []).block, 'unfenced old worker'), errorCode('projection.invalid-contract'));
    const third = await adapter.apply({ revision: view.revision, batch: request(3, [put('x', 'alice', 3)]) });
    const restored = await adapter.rollback(plan(third.view, view.checkpoint));
    assert.equal(restored.status, 'rolled-back');
    assert.equal((await rows(adapter))[0].value.balance, 2);
    await assert.rejects(adapter.rollback(plan(await adapter.open(binding), { blockNum: 1, blockId: hex(1) }, 'older-than-migration')), errorCode('projection.rollback-unavailable'));
    assert.equal((await adapter.recovery(binding)).rollback.status, 'unavailable');
    await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
});

test('bounded block retention and wrong branch identity persist unavailable without changing unrelated projections', async () => {
    for (const wrongIdentity of [false, true]) {
        const fixture = databaseFixture(), adapter = fixture.rollbackAdapter({ rollbackRetentionBlocks: 2 });
        const initial = await adapter.initialize(definition, binding, genesis);
        let current;
        for (let number = 1; number <= 4; number++) current = (await adapter.apply({ revision: initial.revision, batch: request(number, [put('x', 'alice', number)]) })).view;
        const before = await adapter.recovery(binding);
        assert.deepEqual(before.coverage.floor, { blockNum: 2, blockId: hex(2) });
        assert.equal(before.coverage.retainedBlocks, 2);
        const ancestor = wrongIdentity ? { blockNum: 3, blockId: hex(303) } : genesis;
        await assert.rejects(adapter.rollback(plan(current, ancestor)), errorCode('projection.rollback-unavailable'));
        const incomplete = await adapter.recovery(binding);
        assert.deepEqual(incomplete.checkpoint, current.checkpoint);
        assert.notEqual(incomplete.revision, current.revision);
        assert.equal(incomplete.rollback.status, 'unavailable');
        await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
        const otherDefinition = { ...definition, id: 'independent' }, otherBinding = { ...binding, projectionId: 'independent' };
        const other = await adapter.initialize(otherDefinition, otherBinding, genesis);
        await adapter.apply({ revision: other.revision, batch: request(1, [put('other', 'bob', 7)], otherBinding) });
        assert.equal((await rows(adapter, otherBinding))[0].value.balance, 7);
    }
});

test('same-checkpoint recovery cancels orphan pending and gap, rotates revision, and prevents ABA views', async () => {
    const fixture = databaseFixture(), adapter = fixture.rollbackAdapter();
    const initial = await adapter.initialize(definition, binding, genesis);
    const first = await adapter.apply({ revision: initial.revision, batch: request(1, [put('x', 'alice', 1)]) });
    await adapter.markIncomplete({ binding, revision: initial.revision, block: request(2, []).block, reason: 'orphan input failed' });
    await assert.rejects(adapter.markIncomplete({ binding, revision: initial.revision, block: request(4, []).block, reason: 'orphan gap' }), errorCode('projection.source-gap'));
    const recovered = await adapter.rollback(plan(first.view, first.view.checkpoint));
    assert.equal(recovered.status, 'rolled-back');
    assert.equal(recovered.recovery.pending, null);
    assert.equal(recovered.recovery.gap, null);
    assert.notEqual(recovered.recovery.revision, first.view.revision);
    await assert.rejects(adapter.query(first.view, { filter: [], limit: 1 }), errorCode('projection.stale-revision'));
    assert.equal((await rows(adapter))[0].value.balance, 1);
});

test('undo BSON byte bound prunes full blocks and rejects oversized before-images without applying effects', async () => {
    const fixture = databaseFixture();
    const adapter = fixture.rollbackAdapter({ rollbackRetentionBytes: 1800, rollbackMaxBlockBytes: 1200 });
    const initial = await adapter.initialize(definition, binding, genesis);
    for (let number = 1; number <= 5; number++) await adapter.apply({ revision: initial.revision, batch: request(number, [put('x', 'alice', number)]) });
    const recovery = await adapter.recovery(binding);
    assert.ok(recovery.coverage.retainedBytes <= 1800);
    assert.ok(recovery.coverage.floor.blockNum > 0);
    const unrelated = { ...definition, id: 'large-before-image' }, selected = { ...binding, projectionId: unrelated.id };
    const other = await adapter.initialize(unrelated, selected, genesis);
    await adapter.apply({ revision: other.revision, batch: request(1, [put('big', 'a'.repeat(2000), 1)], selected) });
    await assert.rejects(adapter.apply({ revision: other.revision, batch: request(2, [{ kind: 'delete', key: 'big' }], selected) }), errorCode('projection.apply-unavailable'));
    const pending = await adapter.recovery(selected);
    assert.equal(pending.checkpoint.blockNum, 1);
    assert.equal(pending.pending.block.blockNum, 2);
    const stored = [...fixture.storage.values()].flatMap(collection => [...collection.values()]).find(record => record._id === 'big');
    assert.equal(stored.value.owner.length, 2000);
    assert.equal((await rows(adapter))[0].value.balance, 5);
});

test('failed forward and failed undo transactions leave exact durable progress for a fresh adapter', async () => {
    const fixture = databaseFixture(), adapter = fixture.rollbackAdapter();
    const initial = await adapter.initialize(definition, binding, genesis);
    fixture.failPut = true;
    await assert.rejects(adapter.apply({ revision: initial.revision, batch: request(1, [put('x', 'alice', 1)]) }), errorCode('projection.apply-unavailable'));
    assert.equal((await adapter.recovery(binding)).checkpoint.blockNum, 0);
    assert.equal(metadata(fixture).undo.length, 0);
    const first = await fixture.rollbackAdapter().apply({ revision: initial.revision, batch: request(1, [put('x', 'alice', 1)]) });
    const second = await adapter.apply({ revision: initial.revision, batch: request(2, [put('x', 'alice', 2)]) });
    fixture.failPut = true;
    const original = plan(second.view, first.view.checkpoint);
    await assert.rejects(adapter.rollback(original), errorCode('projection.apply-unavailable'));
    const interrupted = await fixture.rollbackAdapter().recovery(binding);
    assert.equal(interrupted.checkpoint.blockNum, 2);
    assert.equal(interrupted.rollback.status, 'running');
    assert.equal(metadata(fixture).undo.length, 2);
    assert.equal((await fixture.rollbackAdapter().rollback(original)).status, 'rolled-back');
    assert.equal((await rows(adapter))[0].value.balance, 1);
});

test('corrupt or missing undo images keep the projection fenced rather than claim restored state', async () => {
    for (const corrupt of ['missing', 'value']) {
        const fixture = databaseFixture(), adapter = fixture.rollbackAdapter();
        const initial = await adapter.initialize(definition, binding, genesis);
        const first = await adapter.apply({ revision: initial.revision, batch: request(1, [put('x', 'alice', 1)]) });
        const second = await adapter.apply({ revision: initial.revision, batch: request(2, [put('x', 'alice', 2)]) });
        const images = [...fixture.storage.entries()].find(([name]) => name.includes('_u_'))[1];
        const [key, image] = [...images.entries()].find(([, entry]) => entry.blockId === hex(2));
        if (corrupt === 'missing') images.delete(key); else image.before.balance = 999;
        await assert.rejects(adapter.rollback(plan(second.view, first.view.checkpoint)), errorCode('projection.invalid-contract'));
        const recovery = await adapter.recovery(binding);
        assert.equal(recovery.rollback.status, 'running');
        assert.equal(recovery.checkpoint.blockNum, 2);
        await assert.rejects(adapter.open(binding), errorCode('projection.incomplete'));
    }
});

test('all v2 caller envelopes are captured before storage and malformed revisions have no native effects', async () => {
    const fixture = databaseFixture(), adapter = fixture.rollbackAdapter();
    const initial = await adapter.initialize(definition, binding, genesis);
    fixture.native.length = 0;
    let invoked = false;
    const badGenesis = { blockNum: 0, get blockId() { invoked = true; return hex(0); } };
    await assert.rejects(adapter.initialize(definition, binding, badGenesis), errorCode('projection.invalid-contract'));
    assert.equal(invoked, false);
    assert.equal(fixture.native.length, 0);
    const bad = { get revision() { invoked = true; return initial.revision; }, batch: request(1, []) };
    await assert.rejects(adapter.apply(bad), errorCode('projection.invalid-contract'));
    assert.equal(invoked, false);
    assert.equal(fixture.native.length, 0);
    const input = { revision: initial.revision, batch: request(1, [put('x', 'alice', 1)]) };
    const applying = adapter.apply(input);
    input.revision = hex(999); input.batch.mutations[0].value.balance = 999;
    const completed = await applying;
    assert.equal((await rows(adapter))[0].value.balance, 1);
    const altered = plan(completed.view, genesis);
    const recovering = adapter.rollback(altered);
    altered.ancestor.blockId = hex(999);
    assert.equal((await recovering).status, 'rolled-back');
    assert.equal((await rows(adapter)).length, 0);
});

test('configured retention policy cannot silently change when another instance reopens storage', async () => {
    const fixture = databaseFixture(), adapter = fixture.rollbackAdapter();
    await adapter.initialize(definition, binding, genesis);
    await assert.rejects(fixture.rollbackAdapter({ rollbackRetentionBlocks: 10 }).open(binding), errorCode('projection.invalid-contract'));
    const invalid = [0, -1, 4097, 1.5, NaN];
    for (const rollbackRetentionBlocks of invalid) assert.throws(() => fixture.rollbackAdapter({ rollbackRetentionBlocks }), errorCode('projection.invalid-contract'));
    assert.throws(() => fixture.rollbackAdapter({ rollbackRetentionBytes: 1024, rollbackMaxBlockBytes: 1025 }), errorCode('projection.invalid-contract'));
});

test('physical checkpoint revision rejects a historical v1 CAS captured before explicit migration', async () => {
    const fixture = databaseFixture(), legacy = fixture.adapter();
    await legacy.initialize(definition, binding, genesis);
    await legacy.apply(request(1, [put('x', 'alice', 1)]));
    const historical = copy(metadata(fixture));
    const adapter = fixture.rollbackAdapter();
    const view = await adapter.initialize(definition, binding, genesis);
    const current = metadata(fixture);
    assert.equal(current.checkpoint.revision, current.revision);
    const collectionName = [...fixture.storage.keys()].find(name => name.endsWith('_metadata'));
    const stale = await fixture.client.db().collection(collectionName).findOneAndUpdate({
        _id: historical._id, initialized: true, checkpoint: historical.checkpoint,
        pending: historical.pending, gap: historical.gap,
    }, { $set: { pending: { block: request(2, []).block, digest: null, reason: 'old binary failure' } } }, { returnDocument: 'after' });
    assert.equal(stale, null);
    assert.equal((await adapter.recovery(binding)).pending, null);
    assert.deepEqual(await adapter.open(binding), view);
    const recovered = await adapter.rollback(plan(view, view.checkpoint));
    assert.equal(metadata(fixture).checkpoint.revision, recovered.recovery.revision);
    assert.notEqual(metadata(fixture).checkpoint.revision, view.revision);
    assert.equal(Object.hasOwn((await adapter.open(binding)).checkpoint, 'revision'), false);
});
