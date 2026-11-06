// Native-internal bridge tests. Plugin callbacks receive neither sessions nor these internal helpers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {assertStatefulOwnerCompletedSnapshotV2, createStatefulOwnerCompletedSessionV2} from '../dist/stateful-owner-v2-internal.js';
import {configured, ownerIdentity, guard} from './stateful-owner-v2-fixture.mjs';
import {completeFixture} from './stateful-complete-kind-fixture.mjs';

test('the native snapshot bridge rejects foreign, unissued, ended and nontransaction sessions', async () => {
    const state = await configured(completeFixture()), identity = ownerIdentity();
    await state.adapter.acquireOwner({expected: null, nextOwner: identity}, guard);
    const view = (await state.adapter.recovery()).view, read = await state.adapter.completedRead(identity, view, guard);
    const foreign = completeFixture().client.startSession(), unissued = state.fixture.client.startSession();
    for (const session of [foreign, unissued]) {
        await session.withTransaction(async () => {
            await assert.rejects(assertStatefulOwnerCompletedSnapshotV2(state.adapter, read, view, session), /another client or transaction/);
        }, {}); await session.endSession();
    }
    const owned = createStatefulOwnerCompletedSessionV2(state.adapter);
    await assert.rejects(assertStatefulOwnerCompletedSnapshotV2(state.adapter, read, view, owned), /another client or transaction/);
    await owned.withTransaction(async () => {await assertStatefulOwnerCompletedSnapshotV2(state.adapter, read, view, owned);}, {});
    assert.ok(state.fixture.native.some(command => command.command === 'findOne' && command.name.endsWith('_metadata') && command.options?.session === owned));
    await owned.endSession(); await assert.rejects(assertStatefulOwnerCompletedSnapshotV2(state.adapter, read, view, owned), /another client or transaction/);
    state.adapter.closeRead(read);
});

test('snapshot session issuance supplies no read grant and cannot adopt an unknown adapter', async () => {
    assert.throws(() => createStatefulOwnerCompletedSessionV2({}), /unavailable/);
    const state = await configured(completeFixture()), identity = ownerIdentity();
    await state.adapter.acquireOwner({expected: null, nextOwner: identity}, guard); const view = (await state.adapter.recovery()).view;
    const session = createStatefulOwnerCompletedSessionV2(state.adapter);
    await session.withTransaction(async () => {
        await assert.rejects(assertStatefulOwnerCompletedSnapshotV2(state.adapter, {}, view, session), /Private read capability/);
    }, {}); await session.endSession();
});
