import { describe, expect, it } from 'bun:test';
import type { ConsumeMessage } from 'amqplib';
import { cargo } from 'async';
import { MongoRoutes } from '../../src/indexer/helpers/mongo-routes.js';
import { indexMongoBatch } from '../../src/indexer/helpers/mongo-batch.js';

function message(data: object, headers: object = {}, deliveryTag = 1): ConsumeMessage {
    return {
        content: Buffer.from(JSON.stringify(data)),
        properties: { headers },
        fields: { deliveryTag }
    } as ConsumeMessage;
}

function mongoRoutes(bulkWrite: (operations: any[], options: any, collection: string) => Promise<any>) {
    return new MongoRoutes({
        prepareMongoClient() {},
        mongodbClient: { db: () => ({ collection: (name: string) => ({
            bulkWrite: (operations: any[], options: any) => bulkWrite(operations, options, name)
        }) }) },
        conn: { mongodb: { database_prefix: 'test' } },
        chain: 'test'
    } as any);
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

function channel(deliveries: ConsumeMessage[]) {
    const pending = new Set(deliveries);
    const acknowledged: number[] = [];
    return {
        pending,
        acknowledged,
        ack(delivery: ConsumeMessage, allUpTo = false) {
            if (allUpTo || !pending.delete(delivery)) throw new Error('Unexpected acknowledgment');
            acknowledged.push(delivery.fields.deliveryTag);
        },
        async close() {}
    };
}

describe('Mongo write completion', () => {
    it('propagates a rejected named-route write without reporting successful completion', async () => {
        const failure = new Error('MongoDB unavailable');
        const routes = mongoRoutes(async () => { throw failure; });
        const completed: number[] = [];
        const result = routes.routes['table-accounts']([
            message({ code: 'token', scope: 'alice', symbol: 'EOS', amount: 1, block_num: 100, present: 1 })
        ]).then(size => completed.push(size));

        await expect(Promise.resolve(result)).rejects.toBe(failure);
        expect(completed).toEqual([]);
    });

    it.each([
        ['table-proposals', {}, {}],
        ['table-voters', {}, {}],
        ['state', { owner: 'alice', name: 'active', present: 1 }, { type: 'permission' }],
        ['state', { account: 'alice', permission: 'active', present: 1 }, { type: 'permission_link' }],
        ['dynamic-table', { scope: 'alice', primary_key: '1', data: {} }, { present: 1, code: 'token', table: 'accounts' }]
    ])('propagates a rejected %s write', async (route, data, headers) => {
        const failure = new Error('MongoDB unavailable');
        const routes = mongoRoutes(async () => { throw failure; });
        const result = routes.routes[route as string]([message(data as object, headers as object)]);
        await expect(Promise.resolve(result)).rejects.toBe(failure);
    });

    it('routes a mixed permission batch without treating links as permission documents', async () => {
        const filters: object[] = [];
        const routes = mongoRoutes(async operations => {
            filters.push(...operations.map(op => op.updateOne.filter));
        });
        const size = await routes.routes.state([
            message({ owner: 'alice', name: 'active', auth: {}, block_num: 100, present: 1 }, { type: 'permission' }),
            message({ account: 'alice', permission: 'active', code: 'token', action: 'transfer', block_num: 100, present: 1 }, { type: 'permission_link' })
        ]);
        expect(size).toBe(2);
        expect(filters).toEqual([
            { account: 'alice', perm_name: 'active' },
            { account: 'alice', perm_name: 'active' }
        ]);
    });
});

describe('Mongo delivered batch retry', () => {
    it('keeps failed work unacknowledged and uncounted until a successful retry', async () => {
        const batch = [message({}, {}, 1)];
        const prefetched = message({}, {}, 2);
        const broker = channel([...batch, prefetched]);
        const retry = deferred();
        const failed = deferred();
        const failure = new Error('MongoDB unavailable');
        let attempts = 0;
        let indexed = 0;
        const route = async () => {
            if (++attempts === 1) throw failure;
            return 1;
        };
        const work = indexMongoBatch(batch, route, broker, () => true, error => {
            expect(error).toBe(failure);
            failed.resolve();
        }, () => retry.promise).then(size => { indexed += size; });

        await failed.promise;
        expect(broker.acknowledged).toEqual([]);
        expect(broker.pending.size).toBe(2);
        expect(indexed).toBe(0);

        retry.resolve();
        await work;
        expect(broker.acknowledged).toEqual([1]);
        expect(broker.pending.has(prefetched)).toBe(true);
        expect(indexed).toBe(1);
    });

    it('allows unrelated work to complete while a failed batch waits for retry', async () => {
        const failedBatch = [message({}, {}, 1)];
        const otherBatch = [message({}, {}, 2)];
        const broker = channel([...failedBatch, ...otherBatch]);
        const retry = deferred();
        const failed = deferred();
        let attempts = 0;
        const pending = indexMongoBatch(failedBatch, async () => {
            if (++attempts === 1) throw new Error('Rejected');
            return 1;
        }, broker, () => true, () => failed.resolve(), () => retry.promise);

        await failed.promise;
        expect(await indexMongoBatch(otherBatch, async () => 1, broker, () => true, () => {})).toBe(1);
        expect(broker.acknowledged).toEqual([2]);
        expect(broker.pending.has(failedBatch[0])).toBe(true);
        retry.resolve();
        expect(await pending).toBe(1);
        expect(broker.acknowledged).toEqual([2, 1]);
    });

    it.each([true, false])('does not settle or count an old-channel write after channel loss (success=%s)', async succeeds => {
        const batch = [message({}, {}, 1)];
        const original = channel(batch);
        const replacement = channel([message({}, {}, 1)]);
        const writing = deferred();
        let current = original;
        const result = indexMongoBatch(batch, async () => {
            await writing.promise;
            if (!succeeds) throw new Error('Lost connection');
            return 1;
        }, original, () => current === original, () => {});

        current = replacement;
        writing.resolve();
        expect(await result).toBe(0);
        expect(original.acknowledged).toEqual([]);
        expect(replacement.acknowledged).toEqual([]);
        expect(replacement.pending.size).toBe(1);
    });

    it('stops retrying a retained batch when its channel is lost', async () => {
        const batch = [message({}, {}, 1)];
        const broker = channel(batch);
        const retry = deferred();
        const failed = deferred();
        let connected = true;
        let attempts = 0;
        const result = indexMongoBatch(batch, async () => {
            attempts++;
            throw new Error('Rejected');
        }, broker, () => connected, () => failed.resolve(), () => retry.promise);

        await failed.promise;
        connected = false;
        retry.resolve();
        expect(await result).toBe(0);
        expect(attempts).toBe(1);
        expect(broker.pending.size).toBe(1);
    });

    it('replays a partial named-route write before later queued state and counts each batch once', async () => {
        const delivered = [
            message({ code: 'token', scope: 'alice', symbol: 'EOS', amount: 1, block_num: 100, present: 1 }, {}, 1),
            message({ code: 'token', scope: 'alice', symbol: 'EOS', amount: 2, block_num: 101, present: 1 }, {}, 2),
            message({ code: 'token', scope: 'alice', symbol: 'EOS', amount: 3, block_num: 102, present: 1 }, {}, 3)
        ];
        const broker = channel(delivered);
        const stored = new Map<string, any>();
        let failOnce = true;
        const routes = mongoRoutes(async (operations, options) => {
            expect(options.ordered).toBe(true);
            for (let i = 0; i < operations.length; i++) {
                if (failOnce && i === 1) {
                    failOnce = false;
                    throw new Error('Connection lost after first write');
                }
                const { filter, update } = operations[i].updateOne;
                stored.set(JSON.stringify(filter), structuredClone(update.$set));
            }
        });
        const retry = deferred();
        const failed = deferred();
        let indexed = 0;
        let completed = 0;
        const queue = cargo((payload: ConsumeMessage[], done) => {
            void indexMongoBatch(payload, routes.routes['table-accounts'], broker, () => true,
                () => failed.resolve(), () => retry.promise).then(size => {
                indexed += size;
                completed++;
                done();
            });
        }, 2);
        const drained = new Promise<void>(resolve => queue.drain(resolve));
        queue.push(delivered);

        await failed.promise;
        expect([...stored.values()]).toEqual([{ amount: 1, block_num: 100 }]);
        expect(indexed).toBe(0);
        expect(completed).toBe(0);
        expect(broker.pending.size).toBe(3);
        retry.resolve();
        await drained;
        expect([...stored.values()]).toEqual([{ amount: 3, block_num: 102 }]);
        expect(indexed).toBe(3);
        expect(completed).toBe(2);
        expect(broker.acknowledged).toEqual([1, 2, 3]);
    });

    it('waits for every dynamic collection before retrying a partially successful batch', async () => {
        const batch = [
            message({ scope: 'alice', primary_key: '1', block_num: 100, data: { amount: 1 } }, { present: 1, code: 'token', table: 'accounts' }, 1),
            message({ scope: 'alice', primary_key: '1', block_num: 101, data: { amount: 2 } }, { present: 1, code: 'token', table: 'accounts' }, 2),
            message({ scope: 'alice', primary_key: '7', block_num: 101, data: { owner: 'alice' } }, { present: 1, code: 'nft', table: 'assets' }, 3)
        ];
        const broker = channel(batch);
        const slowCollectionStarted = deferred();
        const slowCollectionFinished = deferred();
        const retry = deferred();
        const failed = deferred();
        const stored = new Map<string, any>();
        let failures = 0;
        let tokenAttempts = 0;
        const routes = mongoRoutes(async (operations, options, collection) => {
            expect(options.ordered).toBe(true);
            if (collection === 'nft-assets' && tokenAttempts === 1) {
                slowCollectionStarted.resolve();
                await slowCollectionFinished.promise;
            }
            if (collection === 'token-accounts' && ++tokenAttempts === 1) {
                stored.set(collection, structuredClone(operations[0].updateOne.update.$set));
                throw new Error('One collection failed after partial success');
            }
            for (const operation of operations) {
                stored.set(collection, structuredClone(operation.updateOne.update.$set));
            }
        });
        const result = indexMongoBatch(batch, routes.routes['dynamic-table'], broker, () => true, () => {
            failures++;
            failed.resolve();
        }, () => retry.promise);

        await slowCollectionStarted.promise;
        expect(failures).toBe(0);
        expect(broker.acknowledged).toEqual([]);
        slowCollectionFinished.resolve();
        await failed.promise;
        expect(stored.get('token-accounts')['@block_num']).toBe(100);
        expect(stored.get('nft-assets')['@block_num']).toBe(101);
        retry.resolve();
        expect(await result).toBe(3);
        expect(stored.get('token-accounts')).toMatchObject({ amount: 2, '@block_num': 101, '@pk': '1' });
        expect(stored.get('nft-assets')).toMatchObject({ owner: 'alice', '@block_num': 101, '@pk': '7' });
        expect(broker.acknowledged).toEqual([1, 2, 3]);
    });

    it('does not duplicate linked actions when a permission batch is replayed after partial success', async () => {
        const batch = [
            message({ account: 'alice', permission: 'active', code: 'token', action: 'transfer', block_num: 100, present: 1 }, { type: 'permission_link' }, 1),
            message({ account: 'alice', permission: 'active', code: 'token', action: 'issue', block_num: 101, present: 1 }, { type: 'permission_link' }, 2)
        ];
        const broker = channel(batch);
        const linkedActions: object[] = [];
        let block = 0;
        let failOnce = true;
        const routes = mongoRoutes(async operations => {
            for (let i = 0; i < operations.length; i++) {
                if (failOnce && i === 1) {
                    failOnce = false;
                    throw new Error('Second write failed');
                }
                const update = operations[i].updateOne.update;
                const action = update.$addToSet.linked_actions;
                if (!linkedActions.some(item => JSON.stringify(item) === JSON.stringify(action))) {
                    linkedActions.push(action);
                }
                block = update.$set.block_num;
            }
        });

        expect(await indexMongoBatch(batch, routes.routes.state, broker, () => true, () => {}, async () => {})).toBe(2);
        expect(linkedActions).toEqual([
            { account: 'token', action: 'transfer' },
            { account: 'token', action: 'issue' }
        ]);
        expect(block).toBe(101);
        expect(broker.acknowledged).toEqual([1, 2]);
    });

    it('closes the original channel if acknowledgment fails so remaining deliveries can be recovered', async () => {
        const batch = [message({}, {}, 1), message({}, {}, 2)];
        const broker = channel(batch);
        let closed = false;
        const originalAck = broker.ack;
        broker.ack = msg => {
            if (msg.fields.deliveryTag === 2) throw new Error('Channel stopped accepting frames');
            originalAck(msg);
        };
        broker.close = async () => { closed = true; };

        expect(await indexMongoBatch(batch, async () => 2, broker, () => !closed, () => {})).toBe(0);
        expect(closed).toBe(true);
        expect(broker.acknowledged).toEqual([1]);
        expect(broker.pending.has(batch[1])).toBe(true);
    });
});
