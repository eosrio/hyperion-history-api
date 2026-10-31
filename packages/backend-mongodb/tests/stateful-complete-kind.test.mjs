import assert from 'node:assert/strict';
import test from 'node:test';
import {Long} from 'mongodb';
import {setupComplete, completeFixture, totals, createMongoDbStatefulCompleteKindAdapterV1} from './stateful-complete-kind-fixture.mjs';
import {configured, sdk, admit, execute, retire, takeover, physical, hex} from './stateful-owner-v2-fixture.mjs';
import {definition, limits} from './stateful-fixture.mjs';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
const plain = value => JSON.parse(JSON.stringify(value));
const read = (state, limits = totals()) => state.compose(async port => ({rows: await port.all('collection')}), limits);
async function populated() {
    const state = await setupComplete(), target = await admit(state, 1);
    await execute(state, target, async port => {port.put('collection', 'z', {name: 'z', created: '18446744073709551615'});
        port.put('collection', 'a', {name: 'a', created: '9007199254740993'}); port.put('asset', 'other-kind', {id: '1', vector: []});});
    await retire(state, target); return state;
}

test('new capability requires effective typed nonretrying client options; old factory remains get-only', async () => {
    for (const change of [{retryReads: true}, {retryWrites: true}, {maxAdaptiveRetries: 2}, {maxAdaptiveRetries: undefined}]) {
        const state = await configured(completeFixture()); Object.assign(state.fixture.client.options, change);
        await assert.rejects(createMongoDbStatefulCompleteKindAdapterV1(state.options, totals()), /nonretrying/);
        assert.equal(state.fixture.dataCommands.length, 0);
    }
    const old = await configured(); assert.equal(old.adapter.completeKindCapabilities, undefined);
});

test('genuine native cursor exhaustion includes empty coverage, zero row budget, no kind limit', async () => {
    const state = await setupComplete(); const result = await read(state, {...totals(), responseRecords: 0});
    assert.deepEqual(plain(result.value), {rows: []}); assert.equal(state.fixture.dataCommands.length, 1);
    const command = state.fixture.dataCommands[0].value;
    assert.equal(command.limit, undefined); assert.equal(command.batchSize, 1); assert.equal(command.hint, 'h45_complete_kind_v1');
    assert.ok(state.fixture.sessions.every(session => session.hasEnded));
});

test('opaque signed native cursor ids are preserved; only exact zero establishes exhaustion', async () => {
    const state = await populated(); state.fixture.cursorIds.push(Long.fromString('-9223372036854775808'));
    assert.equal((await read(state)).value.rows.length, 2);
    assert.equal(state.fixture.dataCommands[1].value.getMore.toString(), '-9223372036854775808');
});

test('direct counted keyed reads retain the declared zero-key bound while kind enumeration remains available', async () => {
    const projection = await captureStatefulDeclaration(definition(), {...limits(), readKeys: 0});
    const state = await setupComplete(undefined, totals(), {projection}), view = (await state.adapter.recovery()).view;
    const cap = await state.adapter.completedRead(state.identity, view, () => {});
    await assert.rejects(state.adapter.readCompletedKey(cap, view, {kind: 'collection', key: 'x'}, totals()), /keyed read bound/);
    assert.equal(state.fixture.dataCommands.length, 0); state.adapter.closeRead(cap);
    assert.deepEqual(plain((await read(state)).value), {rows: []});
});

test('all rows/fields and exact bigint text survive; foreign kinds are excluded by native scope', async () => {
    const state = await populated(), result = await read(state);
    assert.deepEqual(plain(result.value.rows), [{key: 'z', value: {name: 'z', created: '18446744073709551615'}},
        {key: 'a', value: {name: 'a', created: '9007199254740993'}}]);
    assert.equal(state.fixture.dataCommands.length, 2); assert.equal(state.fixture.dataCommands[1].command, 'getMore');
    assert.equal(state.fixture.dataCommands.some(trace => Object.hasOwn(trace.value, 'limit')), false);
});

test('an empty live native batch does not claim completion; attempts include the continuation', async () => {
    const state = await populated(); state.fixture.emptyFirstBatch = true;
    const result = await read(state); assert.equal(result.value.rows.length, 2); assert.equal(state.fixture.dataCommands.length, 3);
    const bounded = await populated(); bounded.fixture.emptyFirstBatch = true;
    await assert.rejects(read(bounded, {...totals(), readAttempts: 1}), /attempt total/);
    assert.equal(bounded.fixture.dataCommands.length, 1); assert.equal(bounded.fixture.cleanup.length, 1);
});

test('record overflow fetches at most the documented extra row and never returns partial success', async () => {
    const state = await populated(); await assert.rejects(read(state, {...totals(), responseRecords: 1}), /row overflow/);
    assert.equal(state.fixture.dataCommands.length, 2);
    await assert.rejects(read(state, {...totals(), responseRecords: 0}), /row overflow/);
});

test('data callback retries share one attempt total; no excessive command is sent', async () => {
    const state = await setupComplete(); state.fixture.retryTransaction = true;
    await assert.rejects(read(state, {...totals(), readAttempts: 1}), /attempt total/);
    assert.equal(state.fixture.dataCommands.length, 1);
    const allowed = await setupComplete(); allowed.fixture.retryTransaction = true;
    await read(allowed, {...totals(), readAttempts: 2}); assert.equal(allowed.fixture.dataCommands.length, 2);
});

test('counted keyed data and kind enumeration consume the same explicit total', async () => {
    const state = await populated();
    const result = await state.compose(async port => ({keyed: await port.get('collection', 'a'), rows: await port.all('collection')}), {...totals(), readAttempts: 3});
    assert.equal(result.value.keyed.value.created, '9007199254740993'); assert.equal(state.fixture.dataCommands.length, 3);
    const bounded = await populated(); await assert.rejects(bounded.compose(async port => {
        await port.get('collection', 'a'); return {rows: await port.all('collection')};
    }, {...totals(), readAttempts: 2}), /attempt total/); assert.equal(bounded.fixture.dataCommands.length, 2);
});

test('unknown kinds, foreign tokens and mismatched views refuse before data commands', async () => {
    const state = await populated(), other = await populated(), view = (await state.adapter.recovery()).view;
    await assert.rejects(state.adapter.readCompletedKind({}, view, 'collection', totals()), /Foreign/);
    const foreign = await other.adapter.completedRead(other.identity, (await other.adapter.recovery()).view, () => {});
    await assert.rejects(state.adapter.readCompletedKind(foreign, view, 'collection', totals()), /Foreign/); other.adapter.closeRead(foreign);
    await assert.rejects(state.compose(async port => ({rows: await port.all('unknown')})), /Undeclared/);
    const cap = await state.adapter.completedRead(state.identity, view, () => {});
    await assert.rejects(state.adapter.readCompletedKind(cap, {...view, revision: hex(98)}, 'collection', totals()), /changed/);
    state.adapter.closeRead(cap); assert.equal(state.fixture.dataCommands.length, 0);
});

test('partial index or changed retry options refuse completed-read acquisition before callback', async () => {
    for (const mutate of [state => {const index = [...state.fixture.indexes.values()].flat().find(index => index.name === 'h45_complete_kind_v1'); index.partialFilterExpression = {key: 'a'};},
        state => {state.fixture.client.options.maxAdaptiveRetries = 2;}]) {
        const state = await populated(); mutate(state); let callbacks = 0;
        await assert.rejects(state.compose(async () => {callbacks++; return {};}));
        assert.equal(callbacks, 0); assert.equal(state.fixture.dataCommands.length, 0);
    }
});

test('duplicate, malformed, foreign and noncanonical native rows fail closed', async () => {
    for (const mutate of [answer => {answer.cursor.firstBatch[0].kind = 'asset';}, answer => {answer.cursor.firstBatch[0].json = '{ "extra": 1 }';},
        answer => {answer.cursor.id = '0';}, answer => {answer.cursor.ns = 'foreign.rows';},
        answer => {answer.cursor.firstBatch[0].key = '';}]) {
        const state = await populated(); state.fixture.reply = async (answer, trace) => {if (trace.command === 'find') mutate(answer);};
        await assert.rejects(read(state));
    }
    const state = await populated(); let first;
    state.fixture.reply = async (answer, trace) => {if (trace.command === 'find') first = answer.cursor.firstBatch[0];
        else answer.cursor.nextBatch = [first];};
    await assert.rejects(read(state), /duplicate/);
});

test('response byte overflow and caught failures cannot complete; cleanup/session lifetime is bounded', async () => {
    const state = await populated(); await assert.rejects(read(state, {...totals(), responseBytes: 64}), /byte total/);
    assert.equal(state.fixture.cleanup.length, 1); assert.ok(state.fixture.sessions.every(session => session.hasEnded));
    const poisoned = await populated(); await assert.rejects(poisoned.compose(async port => {
        try {await port.all('collection');} catch {} return {};
    }, {...totals(), responseBytes: 64}));
});

test('native errors, cancellation, owner takeover and fork revision refuse late data', async () => {
    for (const mode of ['native', 'cancel', 'owner', 'fork']) {
        const state = await populated(); let live = true;
        state.fixture.beforeData = async () => {
            if (mode === 'native') throw new Error('injected native read failure');
            if (mode === 'cancel') live = false;
            if (mode === 'owner') await takeover(state);
            if (mode === 'fork') physical(state).revision = hex(90);
        };
        await assert.rejects(state.compose(async port => ({rows: await port.all('collection')}), totals(), () => {if (!live) throw new Error('cancelled');}));
        assert.ok(state.fixture.sessions.every(session => session.hasEnded));
    }
});

test('a real raw gap persists through adapter reconstruction and cannot issue a complete-kind read', async () => {
    const state = await populated(), target = await admit(state, 2);
    await state.adapter.markRawFailure(state.lease, target.digest, 'original decode failed');
    await assert.rejects(read(state), /Failed raw\/source/); assert.equal(state.fixture.dataCommands.length, 0);
    const reconstructed = await createMongoDbStatefulCompleteKindAdapterV1(state.options, totals());
    const recovery = await reconstructed.recovery(); assert.equal(recovery.gap.kind, 'raw');
    await assert.rejects(reconstructed.completedRead(state.identity, recovery.view, () => {}), /Failed raw\/source/);
    assert.equal(state.fixture.dataCommands.length, 0);
});

test('native rollback invalidates the completed token and a fresh owner sees actual empty state', async () => {
    const state = await populated(), before = await state.adapter.recovery();
    const read = await state.adapter.completedRead(state.identity, before.view, () => {});
    await state.adapter.rollbackOwned(state.lease, {declarationDigest: state.declaration.digest, revision: before.view.revision,
        operationId: hex(92), from: before.view.checkpoint, ancestor: {blockNum: 0, blockId: hex(0)}, maxBlocks: 1});
    await assert.rejects(state.adapter.readCompletedKind(read, before.view, 'collection', totals())); state.adapter.closeRead(read);
    assert.equal(state.fixture.dataCommands.length, 0);
    const current = await takeover(state, 'after-rollback'), recovery = await current.adapter.recovery();
    const fresh = await current.adapter.completedRead(current.identity, recovery.view, () => {});
    const result = await current.adapter.readCompletedKind(fresh, recovery.view, 'collection', totals()); current.adapter.closeRead(fresh);
    assert.deepEqual(result.rows, []); assert.equal(result.complete, true);
});
