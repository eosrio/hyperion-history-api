import {describe, expect, it} from 'bun:test';
import {
    ACTION_SEQUENCE_NAMESPACE as namespace, ActionSequenceStorageError,
    encodeActionSequenceStorage, restoreActionSequenceStorage
} from '../../src/indexer/history/action-sequence-storage.js';

const maximum = '18446744073709551615';
const action = (sequence = '9007199254740993'): any => ({
    global_sequence: sequence, block_num: 42, action_ordinal: 7, creator_action_ordinal: 0,
    code_sequence: 0xffffffff, abi_sequence: 9,
    act: {account: 'alpha', name: 'send', data: {global_sequence: '0004', value: 1.25, sequence: maximum}},
    '@plugin': {receipts: [{sequence: '01'}]},
    receipts: [
        {receiver: 'notified', global_sequence: maximum, recv_sequence: '9223372036854775808',
            code_sequence: 0xffffffff, abi_sequence: 0,
            auth_sequence: [{account: 'alice', sequence: maximum}, {account: 'bob', sequence: '9007199254740992'}]},
        {receiver: 'alpha', global_sequence: sequence, recv_sequence: '0', auth_sequence: []}
    ]
});

describe('exact action sequence storage codec', () => {
    it.each(['1', '9007199254740991', '9007199254740992', '9007199254740993',
        '9223372036854775807', '9223372036854775808', maximum])('round trips %s without mutating logical metadata or opaque contract data', sequence => {
        const logical = action(sequence), before = structuredClone(logical);
        const physical = encodeActionSequenceStorage(logical);
        expect(logical).toEqual(before);
        expect(physical).not.toBe(logical);
        expect(physical.act).not.toBe(logical.act);
        expect(physical[namespace].global).toEqual({value: sequence, key: sequence.padStart(20, '0')});
        expect(physical[namespace].receipts.map((receipt: any) => receipt.index)).toEqual([0, 1]);
        expect(physical[namespace].receipts[0].authorization.map((entry: any) => entry.index)).toEqual([0, 1]);
        expect(Object.hasOwn(physical, 'global_sequence')).toBe(BigInt(sequence) <= 0x7fffffffffffffffn);
        expect(physical.receipts[0].receiver).toBe('notified');
        expect(Object.hasOwn(physical.receipts[0], 'global_sequence')).toBe(false);
        expect(Object.hasOwn(physical.receipts[0], 'recv_sequence')).toBe(false);
        expect(Object.hasOwn(physical.receipts[0].auth_sequence[0], 'sequence')).toBe(false);
        expect(physical.receipts[0].auth_sequence[1].sequence).toBe('9007199254740992');
        expect(Object.hasOwn(physical, 'code_sequence')).toBe(false);
        expect(physical.abi_sequence).toBe(9);
        expect(physical[namespace].code_sequence).toBe(0xffffffff);
        const stored = structuredClone(physical), restored = restoreActionSequenceStorage(physical);
        expect(restored).toEqual(logical);
        expect(restored.global_sequence).toBe(sequence); // The selected origin is not receipts[0].
        expect(restored.code_sequence).toBe(0xffffffff);
        expect(restored.receipts[0].code_sequence).toBe(0xffffffff);
        expect(restored.block_num).toBe(42);
        expect(physical).toEqual(stored);
        expect(encodeActionSequenceStorage(logical)).toEqual(stored); // Redelivery has the same physical identity.
    });

    it('allows safe old numeric leaves only through the explicit legacy restore path', () => {
        const logical = action('42');
        logical.global_sequence = 42;
        logical.receipts = [{receiver: 'alpha', global_sequence: 42, recv_sequence: 0,
            auth_sequence: [{account: 'alice', sequence: Number.MAX_SAFE_INTEGER}]}];
        expect(restoreActionSequenceStorage(logical)).toEqual({...logical, global_sequence: '42',
            receipts: [{receiver: 'alpha', global_sequence: '42', recv_sequence: '0',
                auth_sequence: [{account: 'alice', sequence: String(Number.MAX_SAFE_INTEGER)}]}]});
        expect(logical.global_sequence).toBe(42);
        expect(() => encodeActionSequenceStorage(logical)).toThrow(ActionSequenceStorageError);
        for (const invalid of [9007199254740992, '+42', '042', '1e3', '18446744073709551616']) {
            logical.global_sequence = invalid;
            expect(() => restoreActionSequenceStorage(logical)).toThrow(ActionSequenceStorageError);
        }
    });

    it('does not infer a missing root from an exact receipt', () => {
        const value = action(); delete value.global_sequence;
        expect(() => encodeActionSequenceStorage(value)).toThrow(ActionSequenceStorageError);
        expect(() => restoreActionSequenceStorage(value)).toThrow(ActionSequenceStorageError);
    });

    it('validates present legacy committed receipt globals and uint32 counters without inventing absent metadata', () => {
        const value: any = {global_sequence: 42, receipt: ['action_receipt_v0', {global_sequence: 42,
            recv_sequence: 0, code_sequence: 0xffffffff, abi_sequence: 0, auth_sequence: []}]};
        expect(restoreActionSequenceStorage(value).receipt[1]).toEqual({global_sequence: '42', recv_sequence: '0',
            code_sequence: 0xffffffff, abi_sequence: 0, auth_sequence: []});
        value.receipt[1].global_sequence = 0;
        expect(() => restoreActionSequenceStorage(value)).toThrow(ActionSequenceStorageError);
        value.receipt[1].global_sequence = 42; value.receipt[1].abi_sequence = '0';
        expect(() => restoreActionSequenceStorage(value)).toThrow(ActionSequenceStorageError);
        expect(restoreActionSequenceStorage({global_sequence: '42'})).toEqual({global_sequence: '42'});
    });

    it.each([
        (value: any) => {value.global_sequence = '0';},
        (value: any) => {value[namespace] = {};},
        (value: any) => {value.receipts = [];},
        (value: any) => {delete value.receipts;},
        (value: any) => {value.receipts[0].global_sequence = 9007199254740992;},
        (value: any) => {delete value.receipts[0].recv_sequence;},
        (value: any) => {delete value.receipts[0].auth_sequence;},
        (value: any) => {value.receipts[0].auth_sequence[0].account = '';},
        (value: any) => {value.code_sequence = '4294967295';},
        (value: any) => {value.abi_sequence = 0x100000000;}
    ])('refuses malformed or incomplete logical identity', mutate => {
        const value = action(); mutate(value);
        expect(() => encodeActionSequenceStorage(value)).toThrow(ActionSequenceStorageError);
    });

    it.each([
        (value: any) => {value[namespace].version = 2;},
        (value: any) => {value[namespace].unknown = true;},
        (value: any) => {value[namespace].global.value = 9007199254740992;},
        (value: any) => {value[namespace].global.key = '00009007199254740992';},
        (value: any) => {value[namespace].receipts.pop();},
        (value: any) => {value[namespace].receipts[0].index = 1;},
        (value: any) => {value[namespace].receipts[0].receiver = 'other';},
        (value: any) => {value[namespace].receipts[0].authorization[0].index = 1;},
        (value: any) => {value[namespace].receipts[0].authorization[0].account = 'other';},
        (value: any) => {delete value[namespace].receipts[0].receive;},
        (value: any) => {value[namespace].receipts[0].authorization.reverse();},
        (value: any) => {value.global_sequence = '9007199254740992';},
        (value: any) => {delete value.global_sequence;},
        (value: any) => {value.receipts[0].auth_sequence[1].sequence = '9007199254740993';},
        (value: any) => {value.abi_sequence = 10;},
        (value: any) => {value[namespace].code_sequence = '4294967295';}
    ])('never falls back from a present but invalid physical namespace', mutate => {
        const value = encodeActionSequenceStorage(action()); mutate(value);
        expect(() => restoreActionSequenceStorage(value)).toThrow(ActionSequenceStorageError);
    });
});
