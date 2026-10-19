import {describe, expect, it} from 'bun:test';
import {LiveReaderCheckpoint, ReaderConfirmRange} from '../../src/indexer/helpers/reader-progress.js';

describe('reader successful-confirm boundaries', () => {
    it('requires every block, independently of callback-window emptiness or highest block', () => {
        const range = new ReaderConfirmRange(10, 13);
        const high = range.accepted(), low = range.accepted(), middle = range.accepted();
        range.settle(high, 12, true);
        range.settle(middle, 11, true);
        expect(range.complete).toBe(false);
        range.settle(low, 10, true);
        expect(range.complete).toBe(true);
        expect(range.settle(low, 10, true)).toBe(false);
    });

    it('does not treat failed or absent confirmations as completion', () => {
        const range = new ReaderConfirmRange(10, 12);
        range.settle(range.accepted(), 11, true);
        range.settle(range.accepted(), 10, false);
        expect(range.pending.size).toBe(0);
        expect(range.complete).toBe(false);
        expect(new ReaderConfirmRange(10, 12).complete).toBe(false);
    });
});

describe('live source replay checkpoint', () => {
    it('holds reverse publication above a missing lower confirm and retains reversible input', () => {
        const checkpoint = new LiveReaderCheckpoint(10, 'nine');
        const low = checkpoint.observe({num: 10, id: 'ten', previous: 'nine'}, 9);
        const high = checkpoint.observe({num: 11, id: 'eleven', previous: 'ten'}, 10);
        expect(high()).toBeUndefined();
        expect(low()).toEqual({nextBlock: 11, blockId: 'ten'});
        const next = checkpoint.observe({num: 12, id: 'twelve', previous: 'eleven'}, 11);
        expect(next()).toEqual({nextBlock: 12, blockId: 'eleven'});
    });

    it('discards late confirms from a replaced reversible branch', () => {
        const checkpoint = new LiveReaderCheckpoint(10, 'nine');
        const oldLow = checkpoint.observe({num: 10, id: 'old-ten', previous: 'nine'}, 9);
        const oldHigh = checkpoint.observe({num: 11, id: 'old-eleven', previous: 'old-ten'}, 9);
        oldHigh();
        const newLow = checkpoint.observe({num: 10, id: 'ten', previous: 'nine'}, 9);
        const newHigh = checkpoint.observe({num: 11, id: 'eleven', previous: 'ten'}, 10);
        expect(oldLow()).toBeUndefined();
        expect(oldHigh()).toBeUndefined();
        expect(newHigh()).toBeUndefined();
        expect(newLow()).toEqual({nextBlock: 11, blockId: 'ten'});
    });

    it('refuses an irreversible branch mismatch or rewind below the confirmed prefix', () => {
        const checkpoint = new LiveReaderCheckpoint(10, 'nine');
        const wrong = checkpoint.observe({num: 10, id: 'ten', previous: 'wrong'}, 10);
        expect(wrong).toThrow('Unlinked live block');
        const valid = new LiveReaderCheckpoint(10, 'nine');
        valid.observe({num: 10, id: 'ten', previous: 'nine'}, 10)();
        expect(() => valid.observe({num: 10, id: 'other', previous: 'nine'}, 10)).toThrow('rewound below');
    });

    it('bounds an unconfirmed or reversible tail instead of discarding the missing prefix', () => {
        const checkpoint = new LiveReaderCheckpoint(10, '', 2);
        checkpoint.observe({num: 10, id: 'ten', previous: 'nine'}, 9)();
        checkpoint.observe({num: 11, id: 'eleven', previous: 'ten'}, 9)();
        expect(() => checkpoint.observe({num: 12, id: 'twelve', previous: 'eleven'}, 9)).toThrow('recovery window exhausted');
    });
});
