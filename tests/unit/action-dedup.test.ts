import { describe, it, expect } from 'bun:test';
import { groupActionTraces } from '../../src/indexer/helpers/action-dedup.js';

/**
 * Helper to create a minimal ActionTrace-like object for testing.
 * Uses realistic Antelope ordinals: each trace gets a unique action_ordinal,
 * and creator_action_ordinal links notifications back to their parent.
 */
function makeTrace(opts: {
    global_sequence: number;
    action_ordinal: number;
    creator_action_ordinal: number;
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
        creator_action_ordinal: opts.creator_action_ordinal,
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
                creator_action_ordinal: 0,
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

    it('should merge notification traces (same act_digest, different ordinals, same creator)', () => {
        // eosio.token::transfer notifies sender and receiver
        // Real Antelope: each notification gets a unique action_ordinal,
        // creator_action_ordinal points back to the original action
        const digest = 'digest_transfer_abc';
        const traces = [
            makeTrace({
                global_sequence: 1000,
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 1001,
                action_ordinal: 2,
                creator_action_ordinal: 1,
                act_digest: digest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 1002,
                action_ordinal: 3,
                creator_action_ordinal: 1,
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

    it('should NOT merge genuinely distinct duplicate actions (#148)', () => {
        // Two identical transfers in the same TX — different action_ordinal,
        // both with creator_action_ordinal=0 (root actions)
        const digest = 'digest_identical_transfer';
        const traces = [
            makeTrace({
                global_sequence: 2000,
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 2001,
                action_ordinal: 4,
                creator_action_ordinal: 0,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
        ];
        const result = groupActionTraces(traces);

        // Should produce 2 separate actions
        expect(result).toHaveLength(2);
        expect(result[0].receipts).toHaveLength(1);
        expect(result[1].receipts).toHaveLength(1);
        expect(result[0].global_sequence).toBe(2000);
        expect(result[1].global_sequence).toBe(2001);
    });

    it('should handle mixed scenario: duplicate actions each with notifications', () => {
        // TX has 2 identical transfers, each notifying sender and receiver
        // Transfer 1: ordinal=1 (root), ordinal=2 (notify sender), ordinal=3 (notify receiver)
        // Transfer 2: ordinal=4 (root), ordinal=5 (notify sender), ordinal=6 (notify receiver)
        const digest = 'digest_same_content';
        const traces = [
            // First transfer root
            makeTrace({
                global_sequence: 3000,
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // First transfer — sender notification
            makeTrace({
                global_sequence: 3001,
                action_ordinal: 2,
                creator_action_ordinal: 1,
                act_digest: digest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // First transfer — receiver notification
            makeTrace({
                global_sequence: 3002,
                action_ordinal: 3,
                creator_action_ordinal: 1,
                act_digest: digest,
                receiver: 'bob',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Second identical transfer root
            makeTrace({
                global_sequence: 3003,
                action_ordinal: 4,
                creator_action_ordinal: 0,
                act_digest: digest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Second transfer — sender notification
            makeTrace({
                global_sequence: 3004,
                action_ordinal: 5,
                creator_action_ordinal: 4,
                act_digest: digest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Second transfer — receiver notification
            makeTrace({
                global_sequence: 3005,
                action_ordinal: 6,
                creator_action_ordinal: 4,
                act_digest: digest,
                receiver: 'bob',
                account: 'eosio.token',
                name: 'transfer',
            }),
        ];
        const result = groupActionTraces(traces);

        // Should produce 2 actions, each with 3 receipts
        expect(result).toHaveLength(2);
        expect(result[0].receipts).toHaveLength(3);
        expect(result[1].receipts).toHaveLength(3);

        // Verify receivers for first group
        const receivers1 = result[0].receipts.map((r: any) => r.receiver);
        expect(receivers1).toContain('eosio.token');
        expect(receivers1).toContain('alice');
        expect(receivers1).toContain('bob');

        // Verify receivers for second group
        const receivers2 = result[1].receipts.map((r: any) => r.receiver);
        expect(receivers2).toContain('eosio.token');
        expect(receivers2).toContain('alice');
        expect(receivers2).toContain('bob');
    });

    it('should keep different actions separate (different act_digest)', () => {
        const traces = [
            makeTrace({
                global_sequence: 4000,
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'digest_AAA',
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            makeTrace({
                global_sequence: 4001,
                action_ordinal: 2,
                creator_action_ordinal: 0,
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

    it('should handle transfer + inline action with its own notifications', () => {
        // Root transfer notifies sender/receiver, then an inline action
        // (different digest) from the transfer also has notifications
        const transferDigest = 'digest_transfer';
        const inlineDigest = 'digest_inline_log';
        const traces = [
            // Root transfer
            makeTrace({
                global_sequence: 5000,
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: transferDigest,
                receiver: 'eosio.token',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Transfer notification to sender
            makeTrace({
                global_sequence: 5001,
                action_ordinal: 2,
                creator_action_ordinal: 1,
                act_digest: transferDigest,
                receiver: 'alice',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Transfer notification to receiver
            makeTrace({
                global_sequence: 5002,
                action_ordinal: 3,
                creator_action_ordinal: 1,
                act_digest: transferDigest,
                receiver: 'bob',
                account: 'eosio.token',
                name: 'transfer',
            }),
            // Inline action spawned by transfer (different digest)
            makeTrace({
                global_sequence: 5003,
                action_ordinal: 4,
                creator_action_ordinal: 1,
                act_digest: inlineDigest,
                receiver: 'logger',
                account: 'logger',
                name: 'logaction',
            }),
            // Inline action notification
            makeTrace({
                global_sequence: 5004,
                action_ordinal: 5,
                creator_action_ordinal: 4,
                act_digest: inlineDigest,
                receiver: 'alice',
                account: 'logger',
                name: 'logaction',
            }),
        ];
        const result = groupActionTraces(traces);

        // Should produce 2 docs:
        // 1. Transfer (3 receipts: eosio.token, alice, bob)
        // 2. Inline log action — the inline action (creator=1) and its
        //    notification (creator=4) have different canonical ordinals,
        //    so they stay separate (2 individual docs)
        //    The inline action uses canonical=1 (its creator), and the
        //    notification uses canonical=4 (its creator). Different keys.

        // Transfer group: digest_transfer:1
        const transferGroup = result.find(r => r.act.name === 'transfer');
        expect(transferGroup).toBeDefined();
        expect(transferGroup!.receipts).toHaveLength(3);

        // Inline actions: digest_inline_log:1 and digest_inline_log:4
        const inlineGroups = result.filter(r => r.act.name === 'logaction');
        expect(inlineGroups).toHaveLength(2);
    });
});
