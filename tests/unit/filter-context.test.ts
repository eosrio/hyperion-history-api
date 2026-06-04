import { describe, it, expect } from 'bun:test';
import {
    applyAccountFilters,
    applyGenericFilters,
    applyCodeActionFilters
} from '../../src/api/routes/v2-history/get_actions/functions.js';

// get_actions builds its term clauses in *scoring* (must / root-should) context, NOT bool.filter.
// Filter context routes clauses through ES's query cache; for a low-selectivity account like
// eosio.token over large/old (cold-tier) segments, building the cached bitset costs far more than
// the BM25 it saves and defeats index-sort early termination (observed dominating node-6
// hot_threads). These tests pin the scoring-context placement so it can't regress back to filter.
// See memory: filter-context-query-cache-tradeoff.

const newQueryStruct = () => ({ bool: { must: [] as any[], must_not: [] as any[], boost: 1.0 } });

describe('applyAccountFilters — scoring context', () => {
    it('puts the account should-array in bool.must, not bool.filter', () => {
        const qs = newQueryStruct();
        applyAccountFilters({ account: 'eosio.token' }, qs);

        expect(qs.bool.filter).toBeUndefined();
        expect(qs.bool.must).toHaveLength(1);
        const clause = qs.bool.must[0];
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
        expect(qs.bool.must).toHaveLength(0);
        expect(qs.bool.filter).toBeUndefined();
    });
});

describe('applyGenericFilters — scoring context', () => {
    it('puts a single primary-term match in bool.must', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ producer: 'eosio' }, qs, new Set());
        expect(qs.bool.filter).toBeUndefined();
        expect(qs.bool.must).toEqual([{ term: { producer: 'eosio' } }]);
    });

    it('puts a comma multi-value clause in bool.must as a should group', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ producer: 'a,b' }, qs, new Set());
        expect(qs.bool.filter).toBeUndefined();
        expect(qs.bool.must).toHaveLength(1);
        expect(qs.bool.must[0].bool.should).toEqual([
            { term: { producer: 'a' } },
            { term: { producer: 'b' } }
        ]);
    });

    it('puts a range clause in bool.must', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ block_num: '100-200' }, qs, new Set());
        expect(qs.bool.must).toEqual([{ range: { block_num: { gte: '100', lte: '200' } } }]);
    });

    it('keeps negation in must_not', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ producer: '!eosio' }, qs, new Set());
        expect(qs.bool.must_not).toEqual([{ term: { producer: 'eosio' } }]);
    });

    it('keeps the @transfer.memo full-text match in must so sortedBy=_score still ranks by relevance', () => {
        const qs = newQueryStruct();
        applyGenericFilters({ 'transfer.memo': 'hello' }, qs, new Set(['transfer']));
        expect(qs.bool.must).toEqual([{ match: { '@transfer.memo': { query: 'hello' } } }]);
    });
});

describe('applyCodeActionFilters — scoring context', () => {
    it('puts the code:name filter in a root-level should + minimum_should_match', () => {
        const qs = newQueryStruct();
        applyCodeActionFilters({ filter: 'eosio.token:transfer' }, qs);
        expect(qs.bool.filter).toBeUndefined();
        expect((qs.bool as any).minimum_should_match).toBe(1);
        expect((qs.bool as any).should).toEqual([
            { bool: { must: [{ term: { 'act.account': 'eosio.token' } }, { term: { 'act.name': 'transfer' } }] } }
        ]);
    });
});
