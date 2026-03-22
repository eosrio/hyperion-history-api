import { describe, it, expect } from 'bun:test';
import { groupActionTraces } from '../../src/indexer/helpers/action-dedup.js';

/**
 * Helper to create a minimal ActionTrace-like object for testing.
 * Only includes the fields that the grouping logic actually uses.
 */
function makeTrace(opts: {
    global_sequence: number;
    action_ordinal: number;
    act_digest: string;
    receiver: string;
    account: string;
    name: string;
    code_sequence?: number;
    abi_sequence?: number;
}) {
    return {
        global_sequence: opts.global_sequence,
        action_ordinal: opts.action_ordinal,
        act: {
            account: opts.account,
            name: opts.name,
            data: {},
        },
        receipt: {
            act_digest: opts.act_digest,
            receiver: opts.receiver,
            global_sequence: opts.global_sequence,
            code_sequence: opts.code_sequence ?? 1,
            abi_sequence: opts.abi_sequence ?? 1,
        },
        trx_id: 'abc123',
        block_num: 100,
        block_id: 'block100',
        producer: 'prod1',
        '@timestamp': '2024-01-01T00:00:00.000',
        signatures: [],
        except: null,
        creator_action_ordinal: 0,
        cpu_usage_us: 0,
        net_usage_words: 0,
        error_code: null,
        max_inline: 0,
        inline_count: 0,
        inline_filtered: false,
    } as any;
}

describe('groupActionTraces', () => {

    it('should pass through a single action unchanged', () => {
        const traces = [
            makeTrace({
                global_sequence: 1000,
                action_ordinal: 1,
                act_digest: 'digest_aaa',
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
        ];
        const result = groupActionTraces(traces);
        expect(result).toHaveLength(1);
        expect(result[0].receipts).toHaveLength(1);
        expect(result[0].receipts[0].receiver).toBe('eosio.token');
        expect(result[0].receipt).toBeUndefined();
    });

    it('should merge notification traces (same act_digest + same action_ordinal)', () => {
        // eosio.token::transfer notifies sender, receiver, and contract
        const digest = 'digest_transfer_abc';
        const traces = [
            makeTrace({
                global_sequence: 1000,
                action_ordinal: 1,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 1001,
                action_ordinal: 1,
                act_digest: digest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 1002,
                action_ordinal: 1,
                act_digest: digest,
                receiver: 'bob',
                account: 'eosio.token',
                name: 'transfer',
            }),
        ];
        const result = groupActionTraces(traces);
        expect(result).toHaveLength(1);
        expect(result[0].receipts).toHaveLength(3);

        const receivers = result[0].receipts.map((r: any) => r.receiver);
        expect(receivers).toContain('eosio.token');
        expect(receivers).toContain('alice');
        expect(receivers).toContain('bob');
    });

    it('should NOT merge duplicate identical actions (same act_digest, different action_ordinal)', () => {
        // Two identical transfers in the same TX — different action_ordinal, different global_sequence
        const digest = 'digest_identical_transfer';
        const traces = [
            makeTrace({
                global_sequence: 2000,
                action_ordinal: 1,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 2001,
                action_ordinal: 3, // different action_ordinal
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
        ];
        const result = groupActionTraces(traces);

        // THIS IS THE BUG TEST: should produce 2 separate actions
        expect(result).toHaveLength(2);
        expect(result[0].receipts).toHaveLength(1);
        expect(result[1].receipts).toHaveLength(1);
        expect(result[0].global_sequence).toBe(2000);
        expect(result[1].global_sequence).toBe(2001);
    });

    it('should handle mixed scenario: duplicate actions each with notifications', () => {
        // TX has 2 identical transfers, each notifying sender and receiver
        const digest = 'digest_same_content';
        const traces = [
            // First transfer (action_ordinal=1) — contract notification
            makeTrace({
                global_sequence: 3000,
                action_ordinal: 1,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // First transfer — sender notification
            makeTrace({
                global_sequence: 3001,
                action_ordinal: 1,
                act_digest: digest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Second identical transfer (action_ordinal=3) — contract notification
            makeTrace({
                global_sequence: 3002,
                action_ordinal: 3,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Second transfer — sender notification
            makeTrace({
                global_sequence: 3003,
                action_ordinal: 3,
                act_digest: digest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
        ];
        const result = groupActionTraces(traces);

        // Should produce 2 actions, each with 2 receipts
        expect(result).toHaveLength(2);
        expect(result[0].receipts).toHaveLength(2);
        expect(result[1].receipts).toHaveLength(2);
    });

    it('should keep different actions separate (different act_digest)', () => {
        const traces = [
            makeTrace({
                global_sequence: 4000,
                action_ordinal: 1,
                act_digest: 'digest_AAA',
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 4001,
                action_ordinal: 2,
                act_digest: 'digest_BBB',
                receiver: 'eosio',
                account: 'eosio',
                name: 'newaccount',
            }),
        ];
        const result = groupActionTraces(traces);
        expect(result).toHaveLength(2);
        expect(result[0].act.name).toBe('transfer');
        expect(result[1].act.name).toBe('newaccount');
    });
});
