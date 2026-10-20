import {normalizeActionSequences} from './action-sequences.js';
import {canonicalUint64, compareUint64} from './uint64.js';

/** Existing unversioned entries may contain rounded values and cannot be reused by the exact API. */
export function transactionSequenceCacheKey(chain: string, trxId: string): string {
    return `trx_seq_v1:${chain}:${trxId}`;
}

/** Parse every member before accepting the cache; a damaged member makes the whole transaction miss. */
export function parseTransactionSequenceCache(cached: Record<string, string> | null | undefined, trxId: string):
    Array<{_source: Record<string, any>}> | undefined {
    if (!cached || Object.keys(cached).length === 0) return;
    try {
        const actions = Object.entries(cached).map(([field, serialized]) => {
            const action = normalizeActionSequences(JSON.parse(serialized));
            const sequence = canonicalUint64(field);
            if (sequence === '0' || action.global_sequence !== sequence || action.trx_id !== trxId || !Array.isArray(action.receipts)) {
                throw new Error('Invalid transaction sequence cache member');
            }
            return action;
        });
        actions.sort((left, right) => compareUint64(left.global_sequence, right.global_sequence));
        return actions.map(action => ({_source: action}));
    } catch {
        return;
    }
}
