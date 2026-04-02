import { describe, it, expect } from 'bun:test';
import { regroupActions } from '../../src/api/helpers/regroup-actions.js';

/**
 * Helper to create a minimal action as it would appear from ES (post-indexing).
 * Simulates both correctly-grouped data (multiple receipts) and
 * fragmented data (one receipt per document).
 */
function makeAction(opts: {
    action_ordinal: number;
    creator_action_ordinal: number;
    act_digest: string;
    receipts: { receiver: string }[];
    account?: string;
    name?: string;
}) {
    return {
        action_ordinal: opts.action_ordinal,
        creator_action_ordinal: opts.creator_action_ordinal,
        act_digest: opts.act_digest,
        act: {
            account: opts.account ?? 'eosio.token',
            name: opts.name ?? 'transfer',
            data: {},
        },
        receipts: opts.receipts,
        block_num: 100,
        trx_id: 'abc123',
    };
}

describe('regroupActions (API-side re-grouping)', () => {

    it('should pass through a single action unchanged', () => {
        const actions = [
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'AAA',
                receipts: [{ receiver: 'eosio.token' }],
            }),
        ];
        const result = regroupActions(actions);
        expect(result).toHaveLength(1);
        expect(result[0].receipts).toHaveLength(1);
    });

    it('should pass through already-grouped data unchanged', () => {
        // Data indexed correctly: 1 doc with 3 receipts
        const actions = [
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'AAA',
                receipts: [
                    { receiver: 'eosio.token' },
                    { receiver: 'alice' },
                    { receiver: 'bob' },
                ],
            }),
        ];
        const result = regroupActions(actions);
        expect(result).toHaveLength(1);
        expect(result[0].receipts).toHaveLength(3);
    });

    it('should re-group fragmented notification data (3 docs → 1)', () => {
        // Data indexed with broken dedup: 3 separate docs
        const actions = [
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'AAA',
                receipts: [{ receiver: 'eosio.token' }],
            }),
            makeAction({
                action_ordinal: 2,
                creator_action_ordinal: 1,
                act_digest: 'AAA',
                receipts: [{ receiver: 'alice' }],
            }),
            makeAction({
                action_ordinal: 3,
                creator_action_ordinal: 1,
                act_digest: 'AAA',
                receipts: [{ receiver: 'bob' }],
            }),
        ];
        const result = regroupActions(actions);
        expect(result).toHaveLength(1);
        expect(result[0].receipts).toHaveLength(3);

        const receivers = result[0].receipts.map((r: any) => r.receiver);
        expect(receivers).toContain('eosio.token');
        expect(receivers).toContain('alice');
        expect(receivers).toContain('bob');
    });

    it('should keep genuinely distinct duplicate actions separate', () => {
        // Two identical transfers, each fragmented into 3 docs (6 total → 2)
        const actions = [
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'AAA',
                receipts: [{ receiver: 'eosio.token' }],
            }),
            makeAction({
                action_ordinal: 2,
                creator_action_ordinal: 1,
                act_digest: 'AAA',
                receipts: [{ receiver: 'alice' }],
            }),
            makeAction({
                action_ordinal: 3,
                creator_action_ordinal: 1,
                act_digest: 'AAA',
                receipts: [{ receiver: 'bob' }],
            }),
            makeAction({
                action_ordinal: 4,
                creator_action_ordinal: 0,
                act_digest: 'AAA',
                receipts: [{ receiver: 'eosio.token' }],
            }),
            makeAction({
                action_ordinal: 5,
                creator_action_ordinal: 4,
                act_digest: 'AAA',
                receipts: [{ receiver: 'alice' }],
            }),
            makeAction({
                action_ordinal: 6,
                creator_action_ordinal: 4,
                act_digest: 'AAA',
                receipts: [{ receiver: 'bob' }],
            }),
        ];
        const result = regroupActions(actions);
        expect(result).toHaveLength(2);
        expect(result[0].receipts).toHaveLength(3);
        expect(result[1].receipts).toHaveLength(3);
    });

    it('should not duplicate receipts when data is already partially grouped', () => {
        // Edge case: some receipts already merged, some separate
        const actions = [
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'AAA',
                receipts: [
                    { receiver: 'eosio.token' },
                    { receiver: 'alice' },
                ],
            }),
            makeAction({
                action_ordinal: 3,
                creator_action_ordinal: 1,
                act_digest: 'AAA',
                receipts: [{ receiver: 'bob' }],
            }),
        ];
        const result = regroupActions(actions);
        expect(result).toHaveLength(1);
        expect(result[0].receipts).toHaveLength(3);
    });

    it('should re-group inline transfer split from its notifications (claimrewards scenario)', () => {
        // Data indexed with broken dedup: inline transfer (creator=claimrewards)
        // ended up in a separate group from its own notifications (creator=transfer)
        // because the old logic used creator_action_ordinal blindly.
        //
        // Elasticsearch has 3 documents:
        //   doc1: transfer ordinal=3 (notifications already merged, 2 receipts)
        //   doc2: transfer ordinal=2 (the inline action, 1 receipt)
        //   doc3: claimrewards ordinal=1 (1 receipt)
        const actions = [
            makeAction({
                action_ordinal: 3,
                creator_action_ordinal: 2,
                act_digest: 'TRANSFER_DIGEST',
                receipts: [{ receiver: 'eosio.bpay' }, { receiver: 'ledgerwisete' }],
            }),
            makeAction({
                action_ordinal: 2,
                creator_action_ordinal: 1,
                act_digest: 'TRANSFER_DIGEST',
                receipts: [{ receiver: 'eosio.token' }],
            }),
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'CLAIM_DIGEST',
                account: 'eosio',
                name: 'claimrewards',
                receipts: [{ receiver: 'eosio' }],
            }),
        ];
        const result = regroupActions(actions);

        // Should produce 2 actions: transfer (3 receipts) + claimrewards (1 receipt)
        expect(result).toHaveLength(2);

        const transfer = result.find(a => a.act.name === 'transfer');
        expect(transfer).toBeDefined();
        expect(transfer!.receipts).toHaveLength(3);
        const receivers = transfer!.receipts.map((r: any) => r.receiver);
        expect(receivers).toContain('eosio.token');
        expect(receivers).toContain('eosio.bpay');
        expect(receivers).toContain('ledgerwisete');

        const claim = result.find(a => a.act.name === 'claimrewards');
        expect(claim).toBeDefined();
        expect(claim!.receipts).toHaveLength(1);
    });

    it('should merge inline action with its own notifications', () => {
        // An inline action (different digest from creator) that has its own
        // require_recipient notifications should be merged with them
        const actions = [
            makeAction({
                action_ordinal: 4,
                creator_action_ordinal: 1,
                act_digest: 'INLINE_DIGEST',
                account: 'logger',
                name: 'logaction',
                receipts: [{ receiver: 'logger' }],
            }),
            makeAction({
                action_ordinal: 5,
                creator_action_ordinal: 4,
                act_digest: 'INLINE_DIGEST',
                account: 'logger',
                name: 'logaction',
                receipts: [{ receiver: 'alice' }],
            }),
            makeAction({
                action_ordinal: 1,
                creator_action_ordinal: 0,
                act_digest: 'ROOT_DIGEST',
                account: 'eosio.token',
                name: 'transfer',
                receipts: [{ receiver: 'eosio.token' }],
            }),
        ];
        const result = regroupActions(actions);

        // inline logaction should merge: 2 receipts (logger + alice)
        expect(result).toHaveLength(2);
        const logGroup = result.find(a => a.act.name === 'logaction');
        expect(logGroup).toBeDefined();
        expect(logGroup!.receipts).toHaveLength(2);
    });
});
