import type {Client} from '@elastic/elasticsearch';

/**
 * Lowest block in [first, last] that has no block document, or null when the range is contiguous,
 * holds no block documents at all, or holds duplicates (for example while two copies of an index
 * are readable), since an exact frontier cannot be told apart from those.
 * Block documents are keyed by block number, so a contiguous prefix of n blocks counts exactly n;
 * a binary search over prefix counts finds the first gap in O(log(last - first)) counts.
 */
export async function findFirstMissingBlock(
    first: number,
    last: number,
    countBlocks: (from: number, to: number) => Promise<number>
): Promise<number | null> {
    if (last < first) return null;
    const total = await countBlocks(first, last);
    if (total === 0 || total >= last - first + 1) return null;
    let lo = first, hi = last;
    // Invariant: [first, lo) is complete and [first, hi] is not.
    while (lo < hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const present = await countBlocks(first, mid);
        if (present > mid - first + 1) return null;
        if (present === mid - first + 1) lo = mid + 1; else hi = mid;
    }
    return lo;
}

export async function findFirstMissingIndexedBlock(es_client: Client, chain: string, first: number, last: number) {
    return findFirstMissingBlock(first, last, async (from, to) => {
        const result = await es_client.count({
            index: chain + '-block-*',
            query: {range: {block_num: {gte: from, lte: to}}}
        });
        return result.count;
    });
}
