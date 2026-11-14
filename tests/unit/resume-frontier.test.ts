import {describe, expect, it} from 'bun:test';
import {findFirstMissingBlock} from '../../src/indexer/helpers/resume-frontier.js';

/** Counts block numbers of `present` inside [from, to], like a range count over the block index. */
function counter(present: number[]) {
    const calls: [number, number][] = [];
    const count = async (from: number, to: number) => {
        calls.push([from, to]);
        return present.filter(n => n >= from && n <= to).length;
    };
    return {count, calls};
}

const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, i) => from + i);

describe('first missing block', () => {
    it('is null for a contiguous range', async () => {
        expect(await findFirstMissingBlock(100, 200, counter(range(100, 200)).count)).toBeNull();
    });

    it('finds the gap a live reader leaves below the highest indexed block', async () => {
        // Historical reader reached 1,499, the live reader indexed 9,000-9,320.
        const c = counter([...range(1000, 1499), ...range(9000, 9320)]);
        expect(await findFirstMissingBlock(1000, 9320, c.count)).toBe(1500);
        expect(c.calls.length).toBeLessThanOrEqual(15);
    });

    it('finds a single missing block', async () => {
        const present = range(1, 1000).filter(n => n !== 777);
        expect(await findFirstMissingBlock(1, 1000, counter(present).count)).toBe(777);
    });

    it('finds a gap at the first block', async () => {
        expect(await findFirstMissingBlock(10, 20, counter(range(11, 20)).count)).toBe(10);
    });

    it('is null when the range holds no block documents', async () => {
        expect(await findFirstMissingBlock(10, 20, counter([]).count)).toBeNull();
    });

    it('is null when duplicates make the counts ambiguous', async () => {
        const present = [...range(1, 50), ...range(1, 50), ...range(80, 100)];
        expect(await findFirstMissingBlock(1, 100, counter(present).count)).toBeNull();
    });

    it('is null for an empty range', async () => {
        expect(await findFirstMissingBlock(20, 10, counter([]).count)).toBeNull();
    });
});
