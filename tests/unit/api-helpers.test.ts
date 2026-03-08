import { describe, it, expect } from 'bun:test';
import {
    getTotalValue,
    getTrackTotalHits,
    mergeActionMeta,
    mergeDeltaMeta,
    addTermMatch,
    extendResponseSchema,
    extendQueryStringSchema,
    getRouteName,
} from '../../src/api/helpers/functions.js';

describe('getTotalValue', () => {
    it('should return value from total.value (object form)', () => {
        const response = { hits: { total: { value: 42, relation: 'eq' }, hits: [] } };
        expect(getTotalValue(response as any)).toBe(42);
    });

    it('should return value from total (number form)', () => {
        const response = { hits: { total: 100, hits: [] } };
        expect(getTotalValue(response as any)).toBe(100);
    });

    it('should return 0 when total is missing', () => {
        const response = { hits: { hits: [] } };
        expect(getTotalValue(response as any)).toBe(0);
    });
});

describe('getTrackTotalHits', () => {
    it('should return 10000 by default (no track param)', () => {
        expect(getTrackTotalHits({})).toBe(10000);
        expect(getTrackTotalHits(undefined)).toBe(10000);
    });

    it('should return true for track=true', () => {
        expect(getTrackTotalHits({ track: 'true' })).toBe(true);
    });

    it('should return false for track=false', () => {
        expect(getTrackTotalHits({ track: 'false' })).toBe(false);
    });

    it('should parse numeric track value', () => {
        expect(getTrackTotalHits({ track: '5000' })).toBe(5000);
    });

    it('should throw on invalid track value', () => {
        expect(() => getTrackTotalHits({ track: 'invalid' })).toThrow('failed to parse track param');
    });
});

describe('mergeActionMeta', () => {
    it('should merge @action_name into act.data', () => {
        const action = {
            act: { name: 'transfer', data: { existing: true } },
            '@transfer': { from: 'alice', to: 'bob' },
            '@timestamp': '2024-01-01T00:00:00.000'
        };
        mergeActionMeta(action);
        expect(action.act.data).toEqual({ existing: true, from: 'alice', to: 'bob' });
        expect(action['@transfer']).toBeUndefined();
        expect(action['timestamp']).toBe('2024-01-01T00:00:00.000');
    });

    it('should keep @action_name when keep=true', () => {
        const action = {
            act: { name: 'transfer', data: {} },
            '@transfer': { from: 'alice' },
            '@timestamp': '2024-01-01T00:00:00.000'
        };
        mergeActionMeta(action, true);
        expect(action.act.data).toEqual({ from: 'alice' });
        expect(action['@transfer']).toBeDefined();
    });

    it('should handle actions without matching meta field', () => {
        const action = {
            act: { name: 'transfer', data: { amount: 100 } },
            '@timestamp': '2024-01-01T00:00:00.000'
        };
        mergeActionMeta(action);
        expect(action.act.data).toEqual({ amount: 100 });
    });
});

describe('mergeDeltaMeta', () => {
    it('should merge @table_name into data', () => {
        const delta = {
            table: 'accounts',
            data: { existing: true },
            '@accounts': { balance: '100.0000 EOS' },
            '@timestamp': '2024-01-01T00:00:00.000'
        };
        const result = mergeDeltaMeta(delta);
        expect(result.data).toEqual({ existing: true, balance: '100.0000 EOS' });
        expect(result['@accounts']).toBeUndefined();
        expect(result['timestamp']).toBe('2024-01-01T00:00:00.000');
        expect(result['@timestamp']).toBeUndefined();
    });

    it('should keep @table_name when keep=true', () => {
        const delta = {
            table: 'accounts',
            data: {},
            '@accounts': { balance: '100.0000 EOS' },
            '@timestamp': '2024-01-01T00:00:00.000'
        };
        mergeDeltaMeta(delta, true);
        expect(delta['@accounts']).toBeDefined();
    });
});

describe('addTermMatch', () => {
    it('should add term match for valid field value', () => {
        const data = { code: 'eosio.token' };
        const search_body = { query: { bool: { must: [] as any[] } } };
        addTermMatch(data, search_body, 'code');
        expect(search_body.query.bool.must).toHaveLength(1);
        expect(search_body.query.bool.must[0]).toEqual({ term: { code: 'eosio.token' } });
    });

    it('should skip wildcard (*) values', () => {
        const data = { code: '*' };
        const search_body = { query: { bool: { must: [] as any[] } } };
        addTermMatch(data, search_body, 'code');
        expect(search_body.query.bool.must).toHaveLength(0);
    });

    it('should skip empty string values', () => {
        const data = { code: '' };
        const search_body = { query: { bool: { must: [] as any[] } } };
        addTermMatch(data, search_body, 'code');
        expect(search_body.query.bool.must).toHaveLength(0);
    });

    it('should skip missing fields', () => {
        const data = {};
        const search_body = { query: { bool: { must: [] as any[] } } };
        addTermMatch(data, search_body, 'code');
        expect(search_body.query.bool.must).toHaveLength(0);
    });
});

describe('extendResponseSchema', () => {
    it('should include base fields and custom fields', () => {
        const result = extendResponseSchema({
            actions: { type: 'array' }
        });
        const props = result[200].properties;
        expect(props.query_time_ms).toBeDefined();
        expect(props.cached).toBeDefined();
        expect(props.lib).toBeDefined();
        expect(props.total).toBeDefined();
        expect(props.actions).toEqual({ type: 'array' });
    });
});

describe('extendQueryStringSchema', () => {
    it('should include limit and skip plus custom params', () => {
        const result = extendQueryStringSchema({
            account: { description: 'account name', type: 'string' }
        });
        expect(result.properties.limit).toBeDefined();
        expect(result.properties.skip).toBeDefined();
        expect(result.properties.account).toBeDefined();
    });

    it('should add required fields when specified', () => {
        const result = extendQueryStringSchema({}, ['account']);
        expect(result.required).toEqual(['account']);
    });

    it('should omit required when not specified', () => {
        const result = extendQueryStringSchema({});
        expect(result.required).toBeUndefined();
    });
});

describe('getRouteName', () => {
    it('should extract route name from file path', () => {
        expect(getRouteName('/some/path/get_actions/index.ts')).toBe('get_actions');
    });

    it('should handle nested paths', () => {
        expect(getRouteName('/api/routes/v2-history/get_transaction/handler.ts')).toBe('get_transaction');
    });
});
