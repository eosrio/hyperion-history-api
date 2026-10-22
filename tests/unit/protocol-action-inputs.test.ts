import {describe, expect, it} from 'bun:test';
import {deriveProtocolActionInputs, deriveActionSourceInventory, ActionSourceInventoryError,
    type ActionSourceInventoryInput} from '../../src/indexer/history/action-source-inventory.js';

const txid = 'a'.repeat(64), other = 'b'.repeat(64);
function action(ordinal: number, creator = 0, receiver = 'token', sequence = String(9007199254740993n + BigInt(ordinal))): any {
    return ['action_trace_v1', {action_ordinal: ordinal, creator_action_ordinal: creator, receiver,
        receipt: ['action_receipt_v0', {receiver, act_digest: 'c'.repeat(64), global_sequence: sequence,
            recv_sequence: String(ordinal), auth_sequence: [{account: 'alice', sequence: String(ordinal)}],
            code_sequence: 2, abi_sequence: 3}],
        act: {account: 'token', name: 'transfer', authorization: [{actor: 'alice', permission: 'active'}], data: '0102'},
        context_free: false, except: null, error_code: null}];
}
function transaction(actions: any[], id = txid): any {
    return ['transaction_trace_v0', {id, status: 0, scheduled: false, failed_dtrx_trace: null,
        except: null, error_code: null, cpu_usage_us: 1, net_usage_words: 0, action_traces: actions, partial: null}];
}
function legacy(traces: unknown): ActionSourceInventoryInput {
    return {profileId: 'antelope-default-v1', source: {chainId: 'd'.repeat(64), blockId: 'e'.repeat(64),
        blockNum: 1, producer: 'producer', timestamp: '2026-10-22T00:00:00.000'},
        policy: {schemaVersion: 1, parserVersion: '3.2', rootOnly: false, actionBlacklist: [], actionWhitelist: [],
            maxDepth: 0, maxInline: 0, eosioAlias: 'eosio'}, traces};
}

describe('original protocol action inputs without filtering or ABI extraction', () => {
    it('derives original inputs, notifications and independent inline origins from complete source', () => {
        const traces = [transaction([action(1), action(2, 1, 'alice'), action(3, 1)])];
        const rows = deriveProtocolActionInputs(traces);
        expect(rows).toHaveLength(3);
        expect(rows.map(row => row.inputActionOrdinal)).toEqual([1, 1, 3]);
        expect(rows.map(row => row.globalSequence)).toEqual(['9007199254740994', '9007199254740995', '9007199254740996']);
        expect(rows[0]).toEqual({transactionId: txid, actionOrdinal: 1, inputActionOrdinal: 1,
            account: 'token', receiver: 'token', name: 'transfer', rawHex: '0102',
            globalSequence: '9007199254740994', receiptAbiSequence: '3'});
        expect(Object.isFrozen(rows)).toBe(true);
        expect(rows.every(Object.isFrozen)).toBe(true);
        traces[0][1].action_traces[0][1].act.data = 'ffff';
        expect(rows[0]!.rawHex).toBe('0102');
    });

    it('retains source vector order when allocation ordinals differ from receipt execution order', () => {
        const root = action(1, 0, 'token', '10'), inline = action(3, 1, 'token', '11'), notification = action(2, 1, 'alice', '12');
        const rows = deriveProtocolActionInputs([transaction([root, inline, notification], other)]);
        expect(rows.map(row => row.actionOrdinal)).toEqual([1, 3, 2]);
        expect(rows.map(row => row.inputActionOrdinal)).toEqual([1, 3, 1]);
        expect(rows.every(row => row.transactionId === other)).toBe(true);
    });

    it('distinguishes a complete empty vector from unavailable or malformed source', () => {
        expect(deriveProtocolActionInputs([])).toEqual([]);
        expect(Object.isFrozen(deriveProtocolActionInputs([]))).toBe(true);
        for (const missing of [undefined, null, {}, ['not-a-transaction']]) {
            expect(() => deriveProtocolActionInputs(missing)).toThrow(ActionSourceInventoryError);
        }
        expect(() => deriveProtocolActionInputs(Array(100001).fill(null))).toThrow(/bounded/);
    });

    it('rejects inconsistent complete membership, receipts and ancestry instead of emitting partial rows', () => {
        const mutations = [
            (traces: any[]) => {traces.push(structuredClone(traces[0]));},
            (traces: any[]) => {traces[0][1].action_traces[1][1].action_ordinal = 1;},
            (traces: any[]) => {traces[0][1].action_traces[1][1].receipt[1].global_sequence = traces[0][1].action_traces[0][1].receipt[1].global_sequence;},
            (traces: any[]) => {traces[0][1].action_traces[0][1].receipt = null;},
            (traces: any[]) => {traces[0][1].action_traces[0][1].receipt[1].receiver = 'foreign';},
            (traces: any[]) => {traces[0][1].action_traces[1][1].creator_action_ordinal = 999;},
            (traces: any[]) => {traces[0][1].action_traces[1][1].receipt[1].global_sequence = '1';},
            (traces: any[]) => {traces[0][1].action_traces[1][1].act.data = '0103';},
            (traces: any[]) => {traces[0][1].action_traces[1][1].act.authorization[0].actor = 'foreign';},
            (traces: any[]) => {traces[0][1].action_traces[0][1].act.data = '0';},
            (traces: any[]) => {traces[0][1].status = 1;},
            (traces: any[]) => {traces[0][1].scheduled = true;},
        ];
        for (const mutate of mutations) {
            const traces = [transaction([action(1), action(2, 1, 'alice')])];
            mutate(traces);
            expect(() => deriveProtocolActionInputs(traces)).toThrow(ActionSourceInventoryError);
        }
    });

    it('rejects accessors before executing them', () => {
        const traces = [transaction([action(1)])];
        let getterCalls = 0;
        Object.defineProperty(traces[0][1].action_traces[0][1].act, 'data', {enumerable: true,
            get() {getterCalls++; return '0102';}});
        expect(() => deriveProtocolActionInputs(traces)).toThrow(ActionSourceInventoryError);
        expect(getterCalls).toBe(0);
    });

    it('keeps legacy Antelope exceptions as no-effects without assigning protocol input ordinals', () => {
        const failed = action(1); failed[1].except = 'contract failure'; failed[1].receipt = null;
        const traces = [transaction([failed])];
        const inventory = deriveActionSourceInventory(legacy(traces));
        expect(inventory.transactions[0]!.disposition).toBe('no-effects');
        expect(inventory.transactions[0]!.occurrences[0]!.inputActionOrdinal).toBeNull();
        expect(inventory.transactions[0]!.groups).toEqual([]);
        expect(() => deriveProtocolActionInputs(traces)).toThrow(ActionSourceInventoryError);
    });
});
