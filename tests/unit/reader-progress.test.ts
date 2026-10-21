import {describe, expect, it} from 'bun:test';
import {LiveReaderCheckpoint, ReaderConfirmRange, liveReaderResumePosition, portableLiveReaderStart} from '../../src/indexer/helpers/reader-progress.js';

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
    it('reopens at the confirmed irreversible prefix instead of a reversible coordinator tip', () => {
        const old = new LiveReaderCheckpoint(10, 'nine');
        const late = old.observe({num: 10, id: 'orphan-ten', previous: 'nine'}, 9);
        const reopened = old.reopen(14);
        expect(reopened.position).toEqual({nextBlock: 10, blockId: 'nine'});
        expect(late()).toBeUndefined();
        expect(() => old.observe({num: 10, id: 'ten', previous: 'nine'}, 10)).toThrow('retired');
        expect(reopened.observe({num: 10, id: 'replacement-ten', previous: 'nine'}, 10)())
            .toEqual({nextBlock: 11, blockId: 'replacement-ten'});
        expect(reopened.position).toEqual({nextBlock: 11, blockId: 'replacement-ten'});
    });

    it('honors an earlier durable source gap and only retains a matching anchor', () => {
        expect(liveReaderResumePosition({nextBlock: 10, blockId: 'nine'}, 8)).toEqual({nextBlock: 8, blockId: ''});
        expect(liveReaderResumePosition({nextBlock: 10, blockId: 'nine'}, null)).toEqual({nextBlock: 10, blockId: 'nine'});
        expect(liveReaderResumePosition({nextBlock: 10, blockId: 'nine'}, null, true)).toEqual({nextBlock: 1, blockId: ''});
        expect(() => liveReaderResumePosition({nextBlock: 10, blockId: 'nine'}, 0)).toThrow('boundary');
    });

    it('starts portable live replay at an internally consistent RPC LIB without certifying it', () => {
        const point = (blockNum: number, character: string) => ({blockNum, blockId: character.repeat(64)});
        expect(portableLiveReaderStart(point(15, 'a'), point(10, 'b'))).toBe(10);
        expect(portableLiveReaderStart(point(1, 'a'), point(0, '0'))).toBe(1);
        expect(() => portableLiveReaderStart(point(10, 'a'), point(11, 'b'))).toThrow('finality');
        expect(() => portableLiveReaderStart(point(10, 'a'), point(10, 'b'))).toThrow('finality');
        expect(() => portableLiveReaderStart(point(10, 'a'), {blockNum: 9, blockId: 'bad'})).toThrow('boundary');
    });

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
