import { describe, it, expect } from 'bun:test';
import { getCachedLastIndexedBlocks } from '../../src/api/routes/v2/health/health.js';

// Minimal in-memory Redis stub with TTL-agnostic get/set that records calls.
function makeRedisStub(initial: Record<string, string> = {}) {
    const store: Record<string, string> = { ...initial };
    const calls = { get: 0, set: 0 };
    return {
        store,
        calls,
        get: async (key: string) => {
            calls.get++;
            return store[key] ?? null;
        },
        set: async (key: string, value: string, ..._args: any[]) => {
            calls.set++;
            store[key] = value;
            return 'OK';
        }
    };
}

// fastify.elastic is only reached through getLastIndexedBlockWithTotalBlocks,
// which issues a single search on `${chain}-block-*`. We stub that search and
// count invocations to prove the cache actually spares Elasticsearch.
function makeElasticStub(lastBlock: number, totalBlocks: number) {
    const calls = { search: 0 };
    const client = {
        calls,
        search: async (_params: any) => {
            calls.search++;
            return {
                hits: {
                    total: { value: totalBlocks },
                    hits: [{ sort: [lastBlock] }]
                }
            };
        }
    };
    return client;
}

function makeFastify(redis: any, elastic: any, chain = 'testchain') {
    return { redis, elastic, manager: { chain } } as any;
}

describe('getCachedLastIndexedBlocks', () => {
    it('cache miss: queries Elasticsearch, writes to Redis, reports cache=false', async () => {
        const redis = makeRedisStub();
        const elastic = makeElasticStub(1000, 950);
        const fastify = makeFastify(redis, elastic);

        const result = await getCachedLastIndexedBlocks(fastify);

        expect(result.cache).toBe(false);
        expect(result.indexedBlocks[0]).toBe(1000);
        expect(elastic.calls.search).toBe(1);
        // value was cached under the chain-scoped key
        expect(redis.store['testchain::last_indexed_blocks']).toBe(JSON.stringify([1000, 950]));
        expect(redis.calls.set).toBe(1);
    });

    it('cache hit: serves from Redis, does NOT touch Elasticsearch, reports cache=true', async () => {
        const redis = makeRedisStub({
            'testchain::last_indexed_blocks': JSON.stringify([2000, 1980])
        });
        const elastic = makeElasticStub(9999, 9999);
        const fastify = makeFastify(redis, elastic);

        const result = await getCachedLastIndexedBlocks(fastify);

        expect(result.cache).toBe(true);
        expect(result.indexedBlocks).toEqual([2000, 1980]);
        // the whole point: ES is spared under repeated polling
        expect(elastic.calls.search).toBe(0);
        expect(redis.calls.set).toBe(0);
    });

    it('second call within TTL is a hit served from the first call\'s cached value (one ES query for many probes)', async () => {
        const redis = makeRedisStub();
        const elastic = makeElasticStub(500, 480);
        const fastify = makeFastify(redis, elastic);

        const first = await getCachedLastIndexedBlocks(fastify);
        const second = await getCachedLastIndexedBlocks(fastify);
        const third = await getCachedLastIndexedBlocks(fastify);

        expect(first.cache).toBe(false);
        expect(second.cache).toBe(true);
        expect(third.cache).toBe(true);
        // three "probes", a single Elasticsearch query
        expect(elastic.calls.search).toBe(1);
        expect(second.indexedBlocks).toEqual(first.indexedBlocks);
    });

    it('uses a chain-scoped cache key so chains do not share block data', async () => {
        const redis = makeRedisStub();
        const elasticA = makeElasticStub(100, 90);
        const elasticB = makeElasticStub(200, 190);

        const a = await getCachedLastIndexedBlocks(makeFastify(redis, elasticA, 'chainA'));
        const b = await getCachedLastIndexedBlocks(makeFastify(redis, elasticB, 'chainB'));

        expect(a.indexedBlocks[0]).toBe(100);
        expect(b.indexedBlocks[0]).toBe(200);
        expect(redis.store['chainA::last_indexed_blocks']).toBeDefined();
        expect(redis.store['chainB::last_indexed_blocks']).toBeDefined();
    });
});
