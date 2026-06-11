import { describe, it, expect } from 'bun:test';
import { getSortDir, applyTimeFilter, isBlockNumber } from '../../src/api/routes/v2-history/get_actions/functions.js';

describe('getSortDir', () => {

    // Default behavior
    it('should return desc by default when no sort is specified', () => {
        expect(getSortDir({})).toBe('desc');
    });

    it('should return desc for sort=desc', () => {
        expect(getSortDir({ sort: 'desc' })).toBe('desc');
    });

    it('should return desc for sort=-1', () => {
        expect(getSortDir({ sort: '-1' })).toBe('desc');
    });

    it('should throw for invalid sort value', () => {
        expect(() => getSortDir({ sort: 'invalid' })).toThrow('invalid sort direction');
    });

    // sort=asc requires bounds
    it('should throw for sort=asc without after or before', () => {
        expect(() => getSortDir({ sort: 'asc' })).toThrow('sort=asc requires');
    });

    it('should throw for sort=1 without after or before', () => {
        expect(() => getSortDir({ sort: '1' })).toThrow('sort=asc requires');
    });

    // sort=asc with valid ISO date
    it('should return asc with a valid recent ISO date in after', () => {
        const recentDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
        expect(getSortDir({ sort: 'asc', after: recentDate })).toBe('asc');
    });

    it('should return asc with a valid recent ISO date in before', () => {
        const recentDate = new Date(Date.now() - 3600000).toISOString();
        expect(getSortDir({ sort: 'asc', before: recentDate })).toBe('asc');
    });

    // sort=asc with valid block number
    it('should return asc with a valid positive block number', () => {
        expect(getSortDir({ sort: 'asc', after: '425000000' })).toBe('asc');
    });

    it('should return asc with a numeric block number', () => {
        expect(getSortDir({ sort: 'asc', after: 425000000 })).toBe('asc');
    });

    // sort=asc with invalid bounds
    it('should reject sort=asc with after="0" (not a positive int → treated as a date, year 2000, outside the window)', () => {
        // "0" is not a positive integer, so it is classified as a date. new Date("0")
        // resolves to year 2000 — far outside the recency window — so it is now rejected
        // instead of silently bypassing the guard.
        expect(() => getSortDir({ sort: 'asc', after: '0' })).toThrow('within the last');
    });

    it('should throw for sort=asc with after=0 (falsy)', () => {
        expect(() => getSortDir({ sort: 'asc', after: 0 })).toThrow('sort=asc requires');
    });

    it('should throw for sort=asc with after="" (empty string)', () => {
        expect(() => getSortDir({ sort: 'asc', after: '' })).toThrow('sort=asc requires');
    });

    it('should throw for sort=asc with after="garbage"', () => {
        expect(() => getSortDir({ sort: 'asc', after: 'garbage' })).toThrow('sort=asc requires');
    });

    // Max window enforcement
    it('should throw for sort=asc with a date older than max window', () => {
        const oldDate = new Date('2020-01-01T00:00:00Z').toISOString();
        expect(() => getSortDir({ sort: 'asc', after: oldDate })).toThrow('within the last');
    });

    it('should respect custom maxAscWindowDays', () => {
        const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
        // Within 7 days → OK
        expect(getSortDir({ sort: 'asc', after: twoDaysAgo }, 7)).toBe('asc');
        // Outside 1 day → throws
        expect(() => getSortDir({ sort: 'asc', after: twoDaysAgo }, 1)).toThrow('within the last');
    });

    // Block numbers bypass max window check (no date to validate)
    it('should not apply max window check on block numbers', () => {
        expect(getSortDir({ sort: 'asc', after: '100' })).toBe('asc');
    });

    // Date strings WITHOUT a 'T' separator must still be window-checked (previously they
    // slipped past because the check only fired on strings containing 'T').
    it('should reject sort=asc with an old date that has no T separator', () => {
        expect(() => getSortDir({ sort: 'asc', after: '2020-01-01' })).toThrow('within the last');
    });

    it('should allow sort=asc with a recent date that has no T separator', () => {
        const todayDateOnly = new Date(Date.now() - 3600000).toISOString().split('T')[0];
        expect(getSortDir({ sort: 'asc', after: todayDateOnly })).toBe('asc');
    });

    // sort=asc bounded by a global_sequence range (the default sort field)
    it('should return asc with a global_sequence range bound', () => {
        expect(getSortDir({ sort: 'asc', global_sequence: '1000-2000' })).toBe('asc');
    });

    it('should return asc with a single positive global_sequence value', () => {
        expect(getSortDir({ sort: 'asc', global_sequence: '123456789' })).toBe('asc');
    });

    it('should return asc with a block_num range bound', () => {
        expect(getSortDir({ sort: 'asc', block_num: '425000000-425100000' })).toBe('asc');
    });

    it('should throw for sort=asc with a global_sequence range whose upper bound is 0', () => {
        expect(() => getSortDir({ sort: 'asc', global_sequence: '0-0' })).toThrow('sort=asc requires');
    });

    it('should throw for sort=asc with a non-numeric global_sequence', () => {
        expect(() => getSortDir({ sort: 'asc', global_sequence: 'garbage' })).toThrow('sort=asc requires');
    });

    it('should still apply the recency window to an old "after" date alongside a global_sequence bound', () => {
        const oldDate = new Date('2020-01-01T00:00:00Z').toISOString();
        expect(getSortDir({ sort: 'asc', global_sequence: '1000-2000' })).toBe('asc');
        expect(() => getSortDir({ sort: 'asc', after: oldDate, global_sequence: '1000-2000' })).toThrow('within the last');
    });

    // require_bounded_asc = false disables the guard entirely
    it('should return asc without any bound when requireBoundedAsc is false', () => {
        expect(getSortDir({ sort: 'asc' }, 90, false)).toBe('asc');
    });

    it('should skip the max window check when requireBoundedAsc is false', () => {
        const oldDate = new Date('2020-01-01T00:00:00Z').toISOString();
        expect(getSortDir({ sort: 'asc', after: oldDate }, 90, false)).toBe('asc');
    });

    it('should still reject an invalid sort direction when requireBoundedAsc is false', () => {
        expect(() => getSortDir({ sort: 'invalid' }, 90, false)).toThrow('invalid sort direction');
    });
});

describe('applyTimeFilter (mixed date / block-number bounds)', () => {

    const newStruct = () => ({ bool: { must: [], boost: 1.0 } as any });

    // Regression: this exact combination used to return 400 "Invalid time value [after]"
    it('block-number "after" + ISO-date "before" produces both ranges', () => {
        const qs = newStruct();
        applyTimeFilter({ after: '437506277', before: '2026-06-01T08:06:13' }, qs);
        const blockR = qs.bool.filter.find((f: any) => f.range.block_num);
        const tsR = qs.bool.filter.find((f: any) => f.range['@timestamp']);
        expect(blockR.range.block_num.gte).toBe('437506277');
        expect(blockR.range.block_num.lte).toBeUndefined();
        expect(tsR.range['@timestamp'].lte).toBe(new Date('2026-06-01T08:06:13').toISOString());
        expect(tsR.range['@timestamp'].gte).toBeUndefined();
    });

    it('ISO-date "after" + block-number "before" produces both ranges', () => {
        const qs = newStruct();
        applyTimeFilter({ after: '2025-01-01T00:00:00Z', before: '500000000' }, qs);
        const blockR = qs.bool.filter.find((f: any) => f.range.block_num);
        const tsR = qs.bool.filter.find((f: any) => f.range['@timestamp']);
        expect(tsR.range['@timestamp'].gte).toBe(new Date('2025-01-01T00:00:00Z').toISOString());
        expect(blockR.range.block_num.lte).toBe('500000000');
    });

    it('two block numbers collapse into a single block_num range', () => {
        const qs = newStruct();
        applyTimeFilter({ after: '100', before: '200' }, qs);
        expect(qs.bool.filter.length).toBe(1);
        expect(qs.bool.filter[0].range.block_num).toEqual({ gte: '100', lte: '200' });
    });

    it('two ISO dates collapse into a single @timestamp range', () => {
        const qs = newStruct();
        applyTimeFilter({ after: '2026-01-01T00:00:00Z', before: '2026-02-01T00:00:00Z' }, qs);
        expect(qs.bool.filter.length).toBe(1);
        expect(qs.bool.filter[0].range['@timestamp']).toEqual({
            gte: new Date('2026-01-01T00:00:00Z').toISOString(),
            lte: new Date('2026-02-01T00:00:00Z').toISOString()
        });
    });

    it('space-separated datetime is normalized to ISO and filters on @timestamp', () => {
        const qs = newStruct();
        applyTimeFilter({ after: '2026-01-01 00:00:00' }, qs);
        expect(qs.bool.filter[0].range['@timestamp'].gte).toBe(new Date('2026-01-01T00:00:00').toISOString());
    });

    it('no bounds → no filter added', () => {
        const qs = newStruct();
        applyTimeFilter({}, qs);
        expect(qs.bool.filter).toBeUndefined();
    });

    // Regression: a date string without 'T' must be a @timestamp bound, not block 2026
    it('classifies a date-only string (no T) as a @timestamp bound, not a block number', () => {
        const qs = newStruct();
        applyTimeFilter({ after: '2026-01-01' }, qs);
        expect(qs.bool.filter.find((f: any) => f.range.block_num)).toBeUndefined();
        expect(qs.bool.filter[0].range['@timestamp'].gte).toBe(new Date('2026-01-01').toISOString());
    });
});

describe('isBlockNumber', () => {
    it('treats bare positive integers (string or number) as block numbers', () => {
        expect(isBlockNumber('437506277')).toBe(true);
        expect(isBlockNumber(437506277)).toBe(true);
        expect(isBlockNumber('1')).toBe(true);
    });

    it('treats dates, zero, and non-integers as NOT block numbers', () => {
        expect(isBlockNumber('2026-01-01')).toBe(false);
        expect(isBlockNumber('2026-06-01T08:06:13')).toBe(false);
        expect(isBlockNumber('0')).toBe(false);
        expect(isBlockNumber('')).toBe(false);
        expect(isBlockNumber('garbage')).toBe(false);
    });
});
