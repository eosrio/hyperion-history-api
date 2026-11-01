import assert from 'node:assert/strict';
import test from 'node:test';
import {Long, MongoServerError} from 'mongodb';
import {negotiateOperatorListsV1, readOperatorListsV1} from '@eosrio/hyperion-sdk/operator-lists';
import {createMongoDbOperatorListSourceV1} from '../dist/operator-lists.js';
import {context, fixture, options, read, readLimits, setup} from './operator-list-fixture.mjs';
const failed = error => error.code === 'operator-list.unavailable' && error.retryable === true;
const lists = [{name: 'schemas', items: ['one', 'two', 'two', 'é', '😀']}, {name: 'empty', items: []}];

test('operator publication is partitioned and readers return detached ordered complete entries', async () => {
    const {source, f, publication} = await setup(lists), provider = source.createProvider(context());
    const selected = negotiateOperatorListsV1(readLimits(), source.capabilities, provider.capabilities);
    const result = await readOperatorListsV1(selected, provider, ['schemas', 'empty', 'missing'], 'operator-schema-lists', 'config-one', provider.assertCurrent);
    assert.deepEqual(result.entries, [...lists, {name: 'missing', items: []}]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.entries[0].items));
    assert.equal(publication.names, 2); assert.equal(publication.items, 5);
    assert.ok(f.data().some(row => row.type === 'getMore')); assert.equal(f.cursors.size, 0);
    assert.ok(f.sessions.every(session => session.hasEnded));
    assert.ok(f.sessions.every(session => session.snapshotEnabled && !session.inTransaction()));
    await assert.rejects(provider.read(['schemas'], readLimits()), failed);
    const warm = await read(source, ['schemas', 'empty', 'missing']); assert.equal(warm.attempts, 0);
});

test('metadata, counts, headers, item pages and native exhaustion all consume attempts', async () => {
    const {source, f} = await setup(lists); f.emptyFirst = true;
    const before = f.data().length, result = await read(source, ['schemas', 'missing']);
    assert.equal(result.attempts, f.data().length - before);
    assert.ok(f.data().filter(row => row.type === 'aggregate').length === 2);
    assert.ok(f.data().filter(row => row.type === 'find').length === 5);
    assert.ok(f.data().filter(row => row.type === 'getMore').length === 3);
    assert.ok(f.data().every(row => row.options.signal instanceof AbortSignal));
});

test('unprovisioned, wrong-generation and incomplete sources never invent missing-list emptiness', async () => {
    const f = fixture(), unprovisioned = createMongoDbOperatorListSourceV1(options(f));
    await assert.rejects(read(unprovisioned, ['missing']), failed);
    await assert.rejects(read(unprovisioned, []), failed);
    const {source} = await setup(lists, {}, f);
    const replacement = createMongoDbOperatorListSourceV1(options(f, {binding: {...source.binding, generation: 'config-two'}}));
    await assert.rejects(read(replacement, ['missing']), failed);
    const revision = [...f.rows('bounded_ol_v1_revision').values()][0]; revision.complete = false;
    await assert.rejects(read(source, ['missing']), failed);
});

test('a complete empty publication supports missing names and zero-item reads', async () => {
    const {source, f} = await setup([]);
    const result = await read(source, ['missing'], {...readLimits(), items: 0});
    assert.deepEqual(result.entries, [{name: 'missing', items: []}]); assert.equal(result.attempts, f.data().length);
    assert.equal((await read(source, ['missing'], {...readLimits(), items: 0})).attempts, 0);
});

test('ordinary revisions retain five-minute cached data while a cold reader selects the new revision', async () => {
    const {source, f} = await setup(lists);
    assert.deepEqual((await read(source, ['schemas'])).entries[0], lists[0]);
    await source.publish({revision: 'data-two', expectedRevision: 'data-one', entries: [{name: 'schemas', items: ['new']}]}, context());
    const result = await read(source, ['schemas']); assert.equal(result.attempts, 0); assert.deepEqual(result.entries[0], lists[0]);
    const cold = createMongoDbOperatorListSourceV1(options(f));
    assert.deepEqual((await read(cold, ['schemas'])).entries, [{name: 'schemas', items: ['new']}]);
    assert.equal(f.rows('bounded_ol_v1_revision').size, 2, 'Prior immutable data revisions remain retained');
});

test('cache age begins at the miss invocation, never completion or subsequent hits', async t => {
    let now = 1000; t.mock.method(performance, 'now', () => now);
    const {source, f} = await setup(lists);
    let delayed = false;
    f.after = entry => {if (!delayed && entry.type === 'find') {delayed = true; now += 1000;}};
    await read(source, ['schemas']); f.after = undefined;
    now = 300999; assert.equal((await read(source, ['schemas'])).attempts, 0);
    now = 301000; assert.ok((await read(source, ['schemas'])).attempts > 0);
});

test('concurrent cold readers keep coherent snapshots and the first complete cache winner', async () => {
    const {source, f} = await setup([{name: 'schemas', items: ['old-a', 'old-b', 'old-c']}]);
    let release, entered; const held = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
    let block = true;
    f.before = async entry => {if (block && entry.type === 'find' && entry.command.find === 'bounded_ol_v1_item') {block = false; entered(); await gate;}};
    const older = read(source, ['schemas']); await held;
    await source.publish({revision: 'data-two', expectedRevision: 'data-one', entries: [{name: 'schemas', items: ['new-a', 'new-b', 'new-c']}]}, context());
    const newer = await read(source, ['schemas']); release(); const original = await older;
    assert.deepEqual(original.entries[0].items, ['old-a', 'old-b', 'old-c']); assert.deepEqual(newer.entries[0].items, ['new-a', 'new-b', 'new-c']);
    const hit = await read(source, ['schemas']); assert.equal(hit.attempts, 0); assert.deepEqual(hit.entries, newer.entries);
});

test('source, chain, backend and config generations isolate identical list names', async () => {
    const {source, f} = await setup(lists); await read(source, ['schemas']);
    for (const changed of [{source: 'different'}, {chainId: 'b'.repeat(64)}, {backendId: 'other'}, {generation: 'two'}]) {
        const isolated = createMongoDbOperatorListSourceV1(options(f, {binding: {...source.binding, ...changed}}));
        await assert.rejects(read(isolated, ['schemas']), failed);
        await isolated.publish({revision: 'one', expectedRevision: null, entries: [{name: 'schemas', items: ['isolated']}]}, context());
        assert.deepEqual((await read(isolated, ['schemas'])).entries[0].items, ['isolated']);
    }
    assert.deepEqual((await read(source, ['schemas'])).entries[0], lists[0]);
});

test('retirement and request closure fence before reads, after awaits and after successful results', async () => {
    for (const when of ['before', 'await', 'after']) {
        const {source, f} = await setup(lists), provider = source.createProvider(context());
        if (when === 'before') source.retire();
        if (when === 'await') f.after = entry => {if (entry.type === 'find') source.retire();};
        if (when === 'after') {await provider.read(['schemas'], readLimits()); source.retire();}
        else await assert.rejects(provider.read(['schemas'], readLimits()), failed);
        assert.throws(provider.assertCurrent, failed);
    }
    const {source} = await setup(lists), reader = source.createProvider(context()); reader.close();
    assert.throws(reader.assertCurrent, failed); await assert.rejects(reader.read(['schemas'], readLimits()), failed);
});

test('aborted or expired lifetimes fail before effects and late cancellation cannot publish a cache result', async () => {
    const {source, f} = await setup(lists), abort = new AbortController(); abort.abort();
    assert.throws(() => source.createProvider(context({signal: abort.signal})), failed);
    assert.throws(() => source.createProvider(context({deadlineMS: performance.now() - 1})), failed); assert.equal(f.commands.length, 0);
    const late = new AbortController(); f.after = entry => {if (entry.type === 'getMore') late.abort();};
    await assert.rejects(read(source, ['schemas'], readLimits(), context({signal: late.signal})), failed);
    f.after = undefined; const retried = await read(source, ['schemas']); assert.ok(retried.attempts > 0);
    assert.equal(f.cursors.size, 0); assert.ok(f.sessions.every(session => session.hasEnded));
});

test('one budget covers distinct names, all item occurrences and exact UTF-8 bytes including cache hits', async () => {
    const {source, f} = await setup(lists);
    for (const [names, selected] of [
        [['schemas', 'schemas'], readLimits()], [['schemas'], {...readLimits(), names: 0}],
        [['schemas'], {...readLimits(), items: 4}], [['schemas'], {...readLimits(), bytes: 19}],
        [['schemas'], {...readLimits(), attempts: 5}], [['schemas'], {...readLimits(), attempts: 33}]
    ]) await assert.rejects(read(source, names, selected), failed);
    assert.equal(f.cursors.size, 0);
    const exact = {...readLimits(), bytes: 7 + 3 + 3 + 3 + 2 + 4, items: 5};
    assert.equal((await read(source, ['schemas'], exact)).entries[0].items.length, 5);
    await assert.rejects(read(source, ['schemas'], {...exact, bytes: exact.bytes - 1}), failed);
    await assert.rejects(read(source, ['schemas'], {...exact, items: 4}), failed);
});

test('failed reads and cache-capacity failures are not cached or silently truncated/evicted', async () => {
    const {source, f} = await setup(lists, {cache: {names: 1, items: 32, bytes: 4096}});
    await read(source, ['schemas']);
    await assert.rejects(read(source, ['missing']), failed);
    assert.equal((await read(source, ['schemas'])).attempts, 0);
    const before = f.data().length; await assert.rejects(read(source, ['missing']), failed); assert.ok(f.data().length > before);
});

test('partial storage, malformed rows, changing cursors and incorrect header totals fail closed', async () => {
    for (const fault of ['header-loss', 'item-loss', 'value', 'ordinal', 'digest', 'cursor-id', 'cursor-namespace', 'cursor-shape', 'oversized-batch', 'extra-row']) {
        const {source, f} = await setup(lists);
        if (fault === 'header-loss') f.rows('bounded_ol_v1_header').delete([...f.rows('bounded_ol_v1_header').keys()][0]);
        if (fault === 'item-loss') f.rows('bounded_ol_v1_item').delete([...f.rows('bounded_ol_v1_item').keys()][0]);
        if (fault === 'value') [...f.rows('bounded_ol_v1_item').values()][0].value = '\ud800';
        if (fault === 'ordinal') [...f.rows('bounded_ol_v1_item').values()][0].ordinal = 99;
        if (fault === 'digest') [...f.rows('bounded_ol_v1_header').values()].find(row => row.name === 'schemas').digest = '0'.repeat(64);
        f.after = (entry, answer) => {
            if (!answer.cursor || entry.command.find !== 'bounded_ol_v1_item' && entry.type !== 'getMore') return;
            if (fault === 'cursor-id' && entry.type === 'getMore') answer.cursor.id = Long.fromNumber(999);
            if (fault === 'cursor-namespace') answer.cursor.ns = 'other.foreign';
            if (fault === 'cursor-shape') answer.cursor.id = 42;
            if (fault === 'oversized-batch') answer.cursor.firstBatch = [null, null, null];
            if (fault === 'extra-row' && answer.cursor.nextBatch) answer.cursor.nextBatch.push({...answer.cursor.nextBatch[0]});
        };
        await assert.rejects(read(source, ['schemas']), failed, fault);
        assert.equal(f.cursors.size, ['cursor-namespace', 'cursor-shape'].includes(fault) ? 1 : 0,
            'Unknown cursor ownership stays an explicit failure; endSession must not invent remote cursor closure');
    }
});

test('original native failure takes precedence over cursor/session cleanup errors and uncertainty', async () => {
    const {source, f} = await setup(lists), original = new MongoServerError({ok: 0, code: 2, errmsg: 'original failure'});
    f.before = entry => {if (entry.type === 'getMore') throw original;}; f.cleanupFailure = new Error('cleanup failure'); f.endFailure = new Error('session cleanup failure');
    await assert.rejects(read(source, ['schemas']), error => failed(error) && error.cause === original && error.suppressed.length === 3);
    assert.equal(f.cursors.size, 1, 'Failed cursor cleanup cannot be claimed as closure by endSession'); f.before = undefined; f.endFailure = undefined; f.cleanupFailure = undefined;
    assert.ok((await read(source, ['schemas'])).attempts > 0);
});

test('snapshot sessions never enter commit/abort/callback retry loops and retry-capable clients are refused', async () => {
    const {source, f} = await setup(lists); assert.equal((await read(source, ['schemas'])).attempts, 8);
    for (const key of ['retryReads', 'retryWrites', 'maxAdaptiveRetries']) {
        const saved = f.client.options[key]; f.client.options[key] = key === 'maxAdaptiveRetries' ? 1 : true;
        assert.throws(() => source.createProvider(context()), failed); assert.throws(() => createMongoDbOperatorListSourceV1(options(f)), failed);
        f.client.options[key] = saved;
    }
    assert.equal((await read(source, ['schemas'])).attempts, 0);
});

test('publication is a complete CAS and failed imports cannot replace the last complete revision', async () => {
    const {source, f} = await setup(lists);
    await assert.rejects(source.publish({revision: 'two', expectedRevision: 'wrong', entries: []}, context()), failed);
    await assert.rejects(source.publish({revision: 'data-one', expectedRevision: null, entries: []}, context()), failed);
    const cold = createMongoDbOperatorListSourceV1(options(f)); assert.deepEqual((await read(cold, ['schemas'])).entries[0], lists[0]);
    assert.equal([...f.rows('bounded_ol_v1_source').values()][0].revision, 'data-one');
    assert.equal([...f.rows('bounded_ol_v1_revision').values()].find(row => row.revision === 'two').complete, false);
});

test('a concurrent losing CAS retains an unselected complete revision and never overwrites the winner', async () => {
    const {source, f} = await setup(lists); let entered, release;
    const waiting = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
    f.before = async entry => {
        if (entry.command.update === 'bounded_ol_v1_source' && entry.command.updates[0].u.revision === 'loser') {entered(); await gate;}
    };
    const losing = source.publish({revision: 'loser', expectedRevision: 'data-one', entries: [{name: 'schemas', items: ['lose']}]}, context());
    await waiting;
    const before = f.commands.length;
    const winner = await source.publish({revision: 'winner', expectedRevision: 'data-one', entries: [{name: 'schemas', items: ['win']}]}, context());
    assert.equal(winner.attempts, f.commands.length - before);
    release(); await assert.rejects(losing, failed);
    assert.equal([...f.rows('bounded_ol_v1_source').values()][0].revision, 'winner');
    assert.equal([...f.rows('bounded_ol_v1_revision').values()].find(row => row.revision === 'loser').complete, true);
    assert.deepEqual((await read(createMongoDbOperatorListSourceV1(options(f)), ['schemas'])).entries[0].items, ['win']);
    assert.ok(f.commands.filter(row => ['insert', 'update', 'createIndexes'].includes(row.type)).every(row =>
        row.command.writeConcern.w === 'majority' && row.command.writeConcern.j === true && row.options.session === undefined));
});

test('native budget reserves a real cleanup attempt and counts the actual kill without expanding the allowance', async () => {
    const {source, f} = await setup(lists);
    await assert.rejects(read(source, ['schemas'], {...readLimits(), attempts: 8}), failed);
    assert.equal(f.data().length, 8); assert.equal(f.data().filter(row => row.type === 'killCursors').length, 1); assert.equal(f.cursors.size, 0);
    f.commands = [];
    const result = await read(source, ['schemas'], {...readLimits(), attempts: 9}); assert.equal(result.attempts, 8); assert.equal(f.data().length, 8);
    assert.equal(f.data().filter(row => row.type === 'killCursors').length, 0, 'Unused cleanup credit is not reported as a native attempt');
});

test('an expired original deadline forbids late cleanup commands and retains explicit closure uncertainty', async t => {
    let now = 1000; t.mock.method(performance, 'now', () => now);
    const {source, f} = await setup(lists); const deadline = now + 50;
    f.after = entry => {if (entry.command.find === 'bounded_ol_v1_item') now = deadline;};
    await assert.rejects(read(source, ['schemas'], readLimits(), context({deadlineMS: deadline})), error => failed(error)
        && error.suppressed.some(value => value.message.includes('deadline expired')));
    assert.equal(f.data().filter(row => row.type === 'killCursors').length, 0); assert.equal(f.cursors.size, 1);
    f.after = undefined; assert.ok((await read(source, ['schemas'])).attempts > 0, 'Failed expired read was not a cache entry');
});

test('inert bounded UTF-16 input is captured before any publication effect', async () => {
    const f = fixture(), source = createMongoDbOperatorListSourceV1(options(f)); let invoked = false;
    const accessor = {name: 'one', get items() {invoked = true; return [];}};
    const proxy = new Proxy({name: 'one', items: []}, {ownKeys() {invoked = true; return ['name', 'items'];}});
    const sparse = new Array(1), extended = ['one']; extended.extra = true;
    for (const entries of [[accessor], [proxy], [{name: '\ud800', items: []}], [{name: 'x', items: ['\udfff']}],
        [{name: 'one', items: sparse}], [{name: 'one', items: extended}], [{name: 'one', items: []}, {name: 'one', items: []}]])
        await assert.rejects(source.publish({revision: 'data-one', expectedRevision: null, entries}, context()), failed);
    assert.equal(invoked, false); assert.equal(f.commands.length, 0);
});
