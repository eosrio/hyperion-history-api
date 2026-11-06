import assert from 'node:assert/strict';
import test from 'node:test';
import {BSON} from 'mongodb';
import {retainedBytes} from '../dist/rollback-contract.js';

/** The encoding the additive size calculation must stay equal to. */
const encoded = undo => BSON.calculateObjectSize({undo}) - BSON.calculateObjectSize({undo: []})
    + undo.reduce((total, item) => total + item.imageBytes, 0);
const descriptor = n => ({block: {blockNum: n, blockId: 'a'.repeat(64), previousBlockId: 'b'.repeat(64)},
    digest: 'c'.repeat(64), count: n % 7, imageBytes: (n % 7) * 13, note: 'x'.repeat(n % 11), nested: {values: [n, String(n)], flag: n % 2 === 0}});

test('retained bytes equal the full BSON encoding across array index widths', () => {
    for (const length of [0, 1, 9, 10, 11, 99, 100, 101, 999, 1000, 1001]) {
        const undo = Array.from({length}, (_, index) => descriptor(index + 1));
        assert.equal(retainedBytes(undo), encoded(undo), `length ${length}`);
    }
});

test('a remembered descriptor is still charged for its current array position', () => {
    const undo = Array.from({length: 120}, (_, index) => descriptor(index + 1));
    assert.equal(retainedBytes(undo), encoded(undo));
    const shifted = undo.slice(95);
    assert.equal(retainedBytes(shifted), encoded(shifted));
    const single = [undo[110]];
    assert.equal(retainedBytes(single), encoded(single));
});
