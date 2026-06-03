import { describe, it, expect } from 'bun:test';
import {
    applyAccountFilters,
    applyGenericFilters,
    applyCodeActionFilters
} from '../../src/api/routes/v2-history/get_actions/functions.js';

// get_actions builds its query with these clauses in *filter* context (not must/should), because
// results are always sorted by global_sequence and never by _score — so scoring is wasted work.
// These tests pin that placement so a regression back to scoring context is caught.

const newQueryStruct = () => ({ bool: { must: [] as any[], must_not: [] as any[], boost: 1.0 } });

describe('applyAccountFilters — filter context', () => {
    it('puts the account should-array in bool.filter with minimum_should_match, not bool.must', () => {
        const qs = newQueryStruct();
        applyAccountFilters({ account: 'eosio.token' }, qs);

        expect(qs.bool.must).toHaveLength(0);
        expect(qs.bool.filter).toHaveLength(1);
        const clause = qs.bool.filter[0];
        expect(clause.bool.minimum_should_match).toBe(1);
        // notified, receipts.receiver, act.authorization.actor — all bound to the account
        expect(clause.bool.should).toEqual([
            { term: { notified: 'eosio.token' } },
            { term: { 'receipts.receiver': 'eosio.token' } },
            { term: { 'act.authorization.actor': 'eosio.token' } }
        ]);
    });

    it('is a no-op when no account is given', () => {
        const qs = newQueryStruct();
        applyAccountFilters({}, qs);
        expect(qs.bool.filter).toBeUndefined();
        expect(qs.bool.must).toHaveLength(0);
    });
});

describe('applyGenericFilters — filter context', () => {
    it('puts a single primary-term match in bool.filter', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ producer: 'eosio' }, qs, new Set());
        expect(qs.bool.must).toHaveLength(0);
        expect(qs.bool.filter).toEqual([{ term: { producer: 'eosio' } }]);
    });

    it('puts a comma multi-value clause in bool.filter as a should with minimum_should_match', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ producer: 'a,b' }, qs, new Set());
        expect(qs.bool.must).toHaveLength(0);
        expect(qs.bool.filter).toHaveLength(1);
        expect(qs.bool.filter[0].bool.minimum_should_match).toBe(1);
        expect(qs.bool.filter[0].bool.should).toEqual([
            { term: { producer: 'a' } },
            { term: { producer: 'b' } }
        ]);
    });

    it('puts a range clause in bool.filter', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ block_num: '100-200' }, qs, new Set());
        expect(qs.bool.must).toHaveLength(0);
        expect(qs.bool.filter).toEqual([{ range: { block_num: { gte: '100', lte: '200' } } }]);
    });

    it('keeps negation in must_not (unchanged)', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ producer: '!eosio' }, qs, new Set());
        expect(qs.bool.must_not).toEqual([{ term: { producer: 'eosio' } }]);
        expect(qs.bool.filter).toBeUndefined();
    });
});

describe('applyCodeActionFilters — filter context', () => {
    it('puts the code:name filter in bool.filter (not root-level should)', () => {
        const qs = newQueryStruct();
        applyCodeActionFilters({ filter: 'eosio.token:transfer' }, qs);
        expect((qs.bool as any).should).toBeUndefined();
        expect(qs.bool.filter).toHaveLength(1);
        expect(qs.bool.filter[0].bool.minimum_should_match).toBe(1);
        expect(qs.bool.filter[0].bool.should).toEqual([
            { bool: { must: [{ term: { 'act.account': 'eosio.token' } }, { term: { 'act.name': 'transfer' } }] } }
        ]);
    });
});
