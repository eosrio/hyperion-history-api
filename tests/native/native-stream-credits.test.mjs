import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeStreamCredits} from '../../build/api/stream/native-credits.js';

const scope = (stream = '1', generation = '1', subscription = '100') =>
    ({connection_id: '9', stream_id: stream, generation, subscription_id: subscription});
const record = (memo = '🌐') => ({block_num: 100, block_id: 'a'.repeat(64),
    payload: {global_sequence: '18446744073709551615', act: {data: {memo}}}});
const ack = (selected, sequence = '1') => ({...selected, sequence});

test('both windows charge actual frame records and complete UTF-8 bytes before transport acceptance', () => {
    const credits = new NativeStreamCredits('9', {records: 2, bytes: 4096}), selected = scope();
    credits.open(selected, {records: 1, bytes: 2048});
    let encoded;
    assert.equal(credits.send(selected, 'history', [record()], text => {
        encoded = text;
        assert.equal(credits.snapshot().records, 1);
        assert.equal(credits.snapshot().bytes, Buffer.byteLength(text));
        return true;
    }), 'sent');
    assert.equal(JSON.parse(encoded).sequence, '1');
    assert.ok(Buffer.byteLength(encoded) > encoded.length);
    assert.equal(credits.send(selected, 'history', [record()], () => {throw new Error('writer must not run');}), 'blocked');
    assert.equal(credits.acknowledge(ack(selected)), true);
    assert.deepEqual(credits.snapshot(), {records: 0, bytes: 0, streams: 1, lifetimeSubscriptions: 1});
});

test('duplicate, future, out-of-order and foreign ACKs never create credit', () => {
    const credits = new NativeStreamCredits('9', {records: 4, bytes: 4096}), selected = scope();
    credits.open(selected, {records: 4, bytes: 4096});
    for (let i = 0; i < 2; i++) assert.equal(credits.send(selected, 'history', [record()], () => true), 'sent');
    const initial = credits.snapshot();
    for (const packet of [ack(selected, '2'), ack(selected, '3'), {...ack(selected), connection_id: '8'},
        {...ack(selected), generation: '2'}, {...ack(selected), subscription_id: '101'}])
        assert.equal(credits.acknowledge(packet), false);
    assert.deepEqual(credits.snapshot(), initial);
    assert.equal(credits.acknowledge(ack(selected)), true);
    const once = credits.snapshot();
    assert.equal(credits.acknowledge(ack(selected)), false);
    assert.deepEqual(credits.snapshot(), once);
    assert.equal(credits.acknowledge(ack(selected, '2')), true);
    assert.equal(credits.snapshot().bytes, 0);
});

test('connection pressure is shared while a blocked stream leaves independent stream credit usable', () => {
    const credits = new NativeStreamCredits('9', {records: 2, bytes: 4096}), first = scope(), second = scope('2', '1', '200');
    credits.open(first, {records: 1, bytes: 2048}); credits.open(second, {records: 2, bytes: 4096});
    assert.equal(credits.send(first, 'history', [record()], () => true), 'sent');
    assert.equal(credits.send(first, 'history', [record()], () => true), 'blocked');
    assert.equal(credits.send(second, 'live', [record()], () => true), 'sent');
    assert.equal(credits.send(second, 'live', [record()], () => true), 'blocked');
    assert.equal(credits.close(first), true);
    assert.equal(credits.send(second, 'live', [record()], () => true), 'sent');
    assert.equal(credits.snapshot().records, 2);
});

test('unsent or failed writes release reservations without consuming frame sequence', () => {
    const credits = new NativeStreamCredits('9', {records: 1, bytes: 2048}), selected = scope();
    credits.open(selected, {records: 1, bytes: 2048});
    assert.equal(credits.send(selected, 'history', [record()], () => false), 'transport_rejected');
    assert.equal(credits.snapshot().bytes, 0);
    assert.throws(() => credits.send(selected, 'history', [record()], () => {throw new Error('write failed');}), /write failed/);
    assert.equal(credits.snapshot().records, 0);
    assert.equal(credits.acknowledge(ack(selected)), false);
    assert.equal(credits.send(selected, 'history', [record()], text => {
        assert.equal(JSON.parse(text).sequence, '1'); return true;
    }), 'sent');
});

test('an ACK cannot settle a pending write and a synchronous close cannot release twice', () => {
    const credits = new NativeStreamCredits('9', {records: 2, bytes: 4096}), selected = scope();
    credits.open(selected, {records: 2, bytes: 4096});
    assert.equal(credits.send(selected, 'history', [record()], () => {
        assert.equal(credits.acknowledge(ack(selected)), false);
        assert.equal(credits.close(selected), true);
        return true;
    }), 'scope_retired');
    assert.deepEqual(credits.snapshot(), {records: 0, bytes: 0, streams: 0, lifetimeSubscriptions: 1});
    assert.equal(credits.close(selected), false);
    assert.equal(credits.acknowledge(ack(selected)), false);
});

test('retired generations and subscription IDs cannot be reused or settle a new scope', () => {
    const credits = new NativeStreamCredits('9', {records: 2, bytes: 4096}), first = scope(), next = scope('1', '2', '101');
    credits.open(first, {records: 2, bytes: 4096});
    assert.equal(credits.send(first, 'history', [record()], () => true), 'sent');
    credits.close(first);
    assert.throws(() => credits.open(scope('1', '1', '102'), {records: 1, bytes: 2048}), /reused/);
    assert.throws(() => credits.open(scope('2', '1', '100'), {records: 1, bytes: 2048}), /reused/);
    credits.open(next, {records: 2, bytes: 4096});
    assert.equal(credits.send(first, 'live', [record()], () => true), 'scope_retired');
    assert.equal(credits.send(next, 'history', [record()], text => {assert.equal(JSON.parse(text).sequence, '1'); return true;}), 'sent');
    assert.equal(credits.acknowledge(ack(first)), false);
    assert.equal(credits.snapshot().records, 1);
});

test('oversize frames fail before invoking a writer or changing either window', () => {
    const credits = new NativeStreamCredits('9', {records: 1, bytes: 1024}), selected = scope();
    credits.open(selected, {records: 1, bytes: 1024});
    const rejectWriter = () => {throw new Error('oversize must not reach transport');};
    assert.equal(credits.send(selected, 'history', [record('x'.repeat(1024))], rejectWriter), 'frame_exceeds_window');
    assert.equal(credits.send(selected, 'history', [record(), record()], rejectWriter), 'frame_exceeds_window');
    assert.equal(credits.send(selected, 'history', [record('x'.repeat(1024 * 1024))], rejectWriter), 'frame_exceeds_window');
    assert.equal(credits.snapshot().bytes, 0);
});

test('active and lifetime subscription bookkeeping stays bounded', () => {
    const credits = new NativeStreamCredits('9', {records: 1, bytes: 1024}, {maximumStreams: 1, maximumLifetimeSubscriptions: 2}), first = scope();
    credits.open(first, {records: 1, bytes: 1024});
    assert.throws(() => credits.open(scope('2', '1', '200'), {records: 1, bytes: 1024}), /limit exceeded/);
    credits.close(first);
    const next = scope('2', '1', '200'); credits.open(next, {records: 1, bytes: 1024}); credits.close(next);
    assert.throws(() => credits.open(scope('3', '1', '300'), {records: 1, bytes: 1024}), /limit exceeded/);
    assert.deepEqual(credits.snapshot(), {records: 0, bytes: 0, streams: 0, lifetimeSubscriptions: 2});
});

test('credit notifications coalesce after settled state changes', async () => {
    let notifications = 0;
    const credits = new NativeStreamCredits('9', {records: 2, bytes: 4096}, {onCredit: () => {notifications++;}}), selected = scope();
    credits.open(selected, {records: 2, bytes: 4096});
    for (let i = 0; i < 2; i++) credits.send(selected, 'history', [record()], () => true);
    credits.acknowledge(ack(selected)); credits.acknowledge(ack(selected, '2'));
    assert.equal(notifications, 0);
    await Promise.resolve();
    assert.equal(notifications, 1);
    assert.equal(credits.snapshot().bytes, 0);
});

test('only a true transport result commits a frame', () => {
    const credits = new NativeStreamCredits('9', {records: 1, bytes: 2048}), selected = scope();
    credits.open(selected, {records: 1, bytes: 2048});
    assert.equal(credits.send(selected, 'history', [record()], () => 1), 'transport_rejected');
    assert.equal(credits.snapshot().bytes, 0);
    assert.equal(credits.acknowledge(ack(selected)), false);
});
