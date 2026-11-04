import {afterEach, describe, expect, it} from 'bun:test';
import Fastify, {type FastifyInstance} from 'fastify';
import registerTrace from '../../src/api/routes/v1-trace/get_block/index.js';

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(app => app.close())); });

async function fixture(search: (query: any) => Promise<any>) {
    const app = Fastify({logger: false}); servers.push(app);
    const cache = new Map<string, string>(), writes: string[] = [];
    let infoCalls = 0;
    app.decorate('manager', {chain: 'test', readIndexset: () => 'test-action-*',
        config: {api: {enable_caching: true, cache_life: 60, limits: {get_actions: 10}, query_timeout: '10s'}}});
    app.decorate('redis', {get: async (key: string) => cache.get(key) ?? null,
        set: async (key: string, value: string) => {writes.push(value); cache.set(key, value); return 'OK';}});
    app.decorate('elastic', {search});
    app.decorate('antelope', {chain: {get_info: async () => {infoCalls++; return {last_irreversible_block_num: 99};}}});
    await app.register(registerTrace, {prefix: '/v1/trace_api'}); await app.ready();
    return {app, writes, infoCalls: () => infoCalls};
}
const call = (app: FastifyInstance, payload: unknown) => app.inject({method: 'POST', url: '/v1/trace_api/get_block', payload});
const complete = (hits: unknown[]) => ({took: 1, timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0}, hits: {total: {value: hits.length, relation: 'eq'}, hits}});

describe('indexed block trace availability', () => {
    it('reports an indexed miss as retryable without assuming whether it exists on chain, and does not cache it', async () => {
        let searches = 0;
        const f = await fixture(async () => {searches++; return complete([]);});
        for (const payload of [{block_num: 2707050}, {block_num: 999999999}, {block_id: 'a'.repeat(64)}]) {
            const response = await call(f.app, payload);
            expect(response.statusCode).toBe(503);
            expect(response.json()).toMatchObject({statusCode: 503, code: 'indexed_block_unavailable'});
            expect(response.headers['retry-after']).toBe('1');
            expect(response.headers['cache-control']).toBe('no-store');
        }
        expect(searches).toBe(3); expect(f.infoCalls()).toBe(0); expect(f.writes).toHaveLength(0);
    });
    it('retries the same selector after indexing catches up', async () => {
        let available = false, blockSearches = 0;
        const f = await fixture(async query => {
            if (query.index !== 'test-block-*') return complete([]);
            blockSearches++;
            return available ? complete([{_source: {block_id: 'a'.repeat(64), block_num: 42, prev_id: 'b'.repeat(64), '@timestamp': '2026-11-04T00:00:00', producer: 'alice'}}]) : complete([]);
        });
        const first = await call(f.app, {block_num: 42}); expect(first.statusCode).toBe(503); expect(f.writes).toHaveLength(0);
        available = true;
        const recovered = await call(f.app, {block_num: 42}); expect(recovered.statusCode).toBe(200); expect(recovered.json().number).toBe(42);
        expect(blockSearches).toBe(2); expect(f.infoCalls()).toBe(1);
    });
    it('treats missing or malformed selectors as 400 without searching', async () => {
        let searches = 0; const f = await fixture(async () => {searches++; return complete([]);});
        for (const payload of [{}, {block_num: 0}, {block_num: 'bad'}, {block_id: 'not-a-block-id'}, {block_num: 42, block_id: 'broken'}]) expect((await call(f.app, payload)).statusCode).toBe(400);
        expect(searches).toBe(0); expect(f.writes).toHaveLength(0);
    });
    it('returns a real indexed header and leaves search failures as errors', async () => {
        let searches = 0;
        const f = await fixture(async query => { searches++; return query.index === 'test-block-*'
            ? complete([{_source: {block_id: 'a'.repeat(64), block_num: 42, prev_id: 'b'.repeat(64), '@timestamp': '2026-11-04T00:00:00', producer: 'alice'}}]) : complete([]); });
        const ok = await call(f.app, {block_num: 42}); expect(ok.statusCode).toBe(200); expect(ok.json()).toMatchObject({number: 42, id: 'a'.repeat(64), transactions: []});
        expect(searches).toBe(2); expect(f.infoCalls()).toBe(1);
        const failed = await fixture(async () => {throw new Error('search failure');});
        const response = await call(failed.app, {block_num: 42}); expect(response.statusCode).toBe(500); expect(failed.writes).toHaveLength(0);
    });
});
