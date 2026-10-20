import {afterEach, expect, test} from 'bun:test';
import Fastify, {type FastifyInstance} from 'fastify';
import register from '../../src/api/routes/v2-stats/get_action_usage/index.js';

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

async function fixture(first: unknown, last: unknown, extra: Record<string, unknown> = {}) {
    const app = Fastify({logger: false});
    servers.push(app);
    const cache = new Map<string, string>();
    const writes: string[] = [];
    let searches = 0;
    app.decorate('manager', {chain: 'stats-sequences', readIndexset: () => 'stats-sequences-action-*',
        config: {settings: {}, api: {enable_caching: true, cache_life: 60}}});
    app.decorate('redis', {
        get: async (key: string) => cache.get(key) ?? null,
        set: async (key: string, value: string) => { writes.push(key); cache.set(key, value); return 'OK'; }
    });
    app.decorate('elastic', {
        search: async (params: any) => {
            if (params.aggs) return {timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
                hits: {hits: []}, aggregations: {unique_actors: {value: 3}}};
            const sequence = searches++ % 2 === 0 ? first : last;
            return {timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
                hits: {hits: sequence === undefined ? [] : [{_source: {global_sequence: sequence}}]}, ...extra};
        },
        count: async () => ({count: 2, _shards: {total: 1, successful: 1, failed: 0, skipped: 0}})
    });
    await app.register(register, {prefix: '/v2/stats'});
    await app.ready();
    const url = '/v2/stats/get_action_usage?period=1h&end_date=2026-10-20T01:00:00Z&unique_actors=true';
    return {app, cache, writes, url, searches: () => searches};
}

for (const [first, last, expected] of [
    ['0', '0', '0'], ['1', '10', '9'], [1, 10, '9'],
    ['9007199254740992', '9007199254740993', '1'],
    ['9223372036854775807', '9223372036854775808', '1'],
    ['0', '18446744073709551615', '18446744073709551615']
] as const) {
    test(`action usage returns exact decimal count ${expected} from ${first} to ${last}, fresh and cached`, async () => {
        const f = await fixture(first, last);
        const response = await f.app.inject(f.url);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({action_count: expected, tx_count: 2, unique_actors: 3});
        expect(typeof response.json().tx_count).toBe('number');
        const cached = await f.app.inject(f.url);
        expect(cached.statusCode).toBe(200);
        expect(cached.json()).toMatchObject({action_count: expected, cached: true});
        expect(f.searches()).toBe(2);
    });
}

test('numeric and malformed action usage cache entries cannot bypass the string contract', async () => {
    const f = await fixture('9007199254740992', '9007199254740993');
    expect((await f.app.inject(f.url)).json().action_count).toBe('1');
    for (const count of [1, '01', '18446744073709551616']) {
        for (const [key, raw] of f.cache) f.cache.set(key, JSON.stringify({...JSON.parse(raw), action_count: count}));
        expect((await f.app.inject(f.url)).json().action_count).toBe('1');
    }
    expect(f.searches()).toBe(8);
    expect(f.writes.some(key => key.includes('_act_stats_seq_v1_'))).toBe(true);
});

for (const [first, last] of [[undefined, '1'], ['1', undefined], [9007199254740992, '9007199254740993'],
    ['01', '2'], ['10', '9']] as const) {
    test(`invalid or missing sequence bounds return unavailable without caching: ${first}, ${last}`, async () => {
        const f = await fixture(first, last);
        const response = await f.app.inject(f.url);
        expect(response.statusCode).toBe(503);
        expect(response.json().action_count).toBeUndefined();
        expect(f.writes).toHaveLength(0);
    });
}

test('timed out or incomplete sequence searches cannot become a cached action count', async () => {
    for (const extra of [{timed_out: true}, {_shards: {total: 2, successful: 1, failed: 1, skipped: 0}}]) {
        const f = await fixture('1', '2', extra);
        expect((await f.app.inject(f.url)).statusCode).toBe(503);
        expect(f.writes).toHaveLength(0);
    }
});
