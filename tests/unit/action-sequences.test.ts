import {describe, expect, test} from 'bun:test';
import {normalizeActionSequences, isActionSequenceField} from '../../src/indexer/helpers/action-sequences.js';
import {parseTransactionSequenceCache, transactionSequenceCacheKey} from '../../src/indexer/helpers/transaction-cache.js';
import {checkMetaFilter} from '../../src/indexer/helpers/common_functions.js';
import {checkActionFilters} from '../../src/api/helpers/streamFunctions.js';

const trxId = 'a'.repeat(64);
const action = (globalSequence: string | number) => ({global_sequence: globalSequence, trx_id: trxId,
    action_ordinal: 1, block_num: 42, code_sequence: 0xffffffff, abi_sequence: 0xffffffff,
    act: {account: 'eosio.token', name: 'transfer', authorization: [], data: {global_sequence: '00042', amount: 7}},
    receipts: [{receiver: 'alice', global_sequence: globalSequence, recv_sequence: '0',
        auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}]}]});

describe('action sequence metadata', () => {
    test('normalizes only known metadata and preserves grouped root identity', () => {
        const value = action('9007199254740993');
        value.receipts.unshift({receiver: 'bob', global_sequence: '9007199254740994', recv_sequence: '9', auth_sequence: []});
        expect(normalizeActionSequences(value)).toBe(value);
        expect(value.global_sequence).toBe('9007199254740993');
        expect(value.receipts.map(receipt => receipt.global_sequence)).toEqual(['9007199254740994', '9007199254740993']);
        expect(value.act.data).toEqual({global_sequence: '00042', amount: 7});
        expect(value.code_sequence).toBe(0xffffffff);
        expect(value.abi_sequence).toBe(0xffffffff);
        expect(value.block_num).toBe(42);
        expect(value.action_ordinal).toBe(1);
    });

    test('supports explicit exact legacy values and SHIP receipt variants', () => {
        const value = {global_sequence: 42, receipt: ['action_receipt_v0', {global_sequence: 42, recv_sequence: 0,
            auth_sequence: [{account: 'alice', sequence: 9007199254740991}], code_sequence: 7, abi_sequence: 8}]};
        normalizeActionSequences(value);
        expect(value).toEqual({global_sequence: '42', receipt: ['action_receipt_v0', {global_sequence: '42', recv_sequence: '0',
            auth_sequence: [{account: 'alice', sequence: '9007199254740991'}], code_sequence: 7, abi_sequence: 8}]});
    });

    test('refuses unsafe or malformed known metadata without inferring a root from receipts', () => {
        for (const invalid of [9007199254740992, -1, 1.5, '+1', '01', '1e3', '18446744073709551616']) {
            expect(() => normalizeActionSequences(action(invalid))).toThrow();
            const value = action('1');
            value.receipts[0].auth_sequence[0].sequence = invalid as any;
            expect(() => normalizeActionSequences(value)).toThrow();
        }
        const partial: any = {receipts: [{global_sequence: '42'}]};
        normalizeActionSequences(partial);
        expect(partial.global_sequence).toBeUndefined();
    });

    test('classifies only actual metadata paths', () => {
        for (const path of ['global_sequence', 'receipt.global_sequence', 'receipts.recv_sequence',
            'receipts[0].global_sequence', 'receipts.auth_sequence.sequence', 'receipts[1].auth_sequence[0].sequence']) {
            expect(isActionSequenceField(path)).toBe(true);
        }
        for (const path of ['act.data.global_sequence', '@transfer.recv_sequence', 'data.auth_sequence.sequence',
            'abi_sequence', 'code_sequence', 'parent', 'receipts.auth_sequence.account', 'block_num']) {
            expect(isActionSequenceField(path)).toBe(false);
        }
    });
});

describe('transaction sequence cache', () => {
    test('uses a chain-scoped versioned namespace and orders parsed uint64 values exactly', () => {
        expect(transactionSequenceCacheKey('chain-a', trxId)).not.toBe(transactionSequenceCacheKey('chain-b', trxId));
        expect(transactionSequenceCacheKey('chain-a', trxId)).not.toBe('trx_' + trxId);
        const values = ['18446744073709551615', '9223372036854775808', '9007199254740993', '10', '9'];
        const cached = Object.fromEntries(values.map(value => [value, JSON.stringify(action(value))]));
        expect(parseTransactionSequenceCache(cached, trxId)?.map(hit => hit._source.global_sequence))
            .toEqual([...values].reverse());
    });

    test('a malformed, unsafe or mismatched member invalidates the entire transaction', () => {
        const good = JSON.stringify(action('9'));
        for (const bad of ['{', JSON.stringify(action(9007199254740992)), JSON.stringify({...action('10'), trx_id: 'b'.repeat(64)}),
            JSON.stringify(action('11')), JSON.stringify({...action('10'), receipts: null})]) {
            expect(parseTransactionSequenceCache({'9': good, '10': bad}, trxId)).toBeUndefined();
        }
        expect(parseTransactionSequenceCache({}, trxId)).toBeUndefined();
    });
});

describe('live sequence predicates', () => {
    test('compares exact magnitudes, accepts zero and excludes arrays as a whole for ne', () => {
        const value = action('10');
        value.receipts.push({...value.receipts[0], global_sequence: '11', recv_sequence: '12'});
        expect(checkMetaFilter({field: 'global_sequence', value: '9', operator: 'gt'}, value, 'action')).toBe(true);
        expect(checkMetaFilter({field: 'global_sequence', value: '10', operator: 'gte'}, value, 'action')).toBe(true);
        expect(checkMetaFilter({field: 'receipts.recv_sequence', value: 0, operator: 'eq'}, value, 'action')).toBe(true);
        expect(checkMetaFilter({field: 'receipts.global_sequence', value: '10', operator: 'ne'}, value, 'action')).toBe(false);
        expect(checkMetaFilter({field: 'receipts.global_sequence', value: '9', operator: 'ne'}, value, 'action')).toBe(true);
        expect(checkMetaFilter({field: 'receipts.auth_sequence.sequence', value: '9223372036854775808', operator: 'gt'}, value, 'action')).toBe(true);
    });

    test('live request dispatch keeps neighboring large identifiers distinct and fails closed for invalid inputs', () => {
        const message = JSON.stringify(action('9007199254740993'));
        const request: any = {contract: '', account: '', action: '', start_from: 0, read_until: 0,
            filters: [{field: 'global_sequence', value: '9007199254740992', operator: 'gt'}]};
        expect(checkActionFilters(request, '', message)).toBe(true);
        request.filters[0].value = '9007199254740993';
        expect(checkActionFilters(request, '', message)).toBe(false);
        for (const invalid of [9007199254740992, '+1', '01', '18446744073709551616']) {
            expect(checkMetaFilter({field: 'global_sequence', value: invalid}, action('10'), 'action')).toBe(false);
        }
        expect(checkMetaFilter({field: 'global_sequence', value: '1', operator: 'starts_with'}, action('10'), 'action')).toBe(false);
        expect(checkMetaFilter({field: 'act.data.global_sequence', value: '00042'}, action('10'), 'action')).toBe(true);
    });
});
