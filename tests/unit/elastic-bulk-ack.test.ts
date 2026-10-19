import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Channel, Message } from 'amqplib';
import { ElasticRoutes } from '../../src/indexer/helpers/elastic-routes.js';

function message(body: object, deliveryTag: number, type?: string): Message {
    return { content: Buffer.from(JSON.stringify(body)), fields: { deliveryTag },
        properties: { headers: type ? { type } : {} } } as Message;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function channel(deliveries: Message[]) {
    const broker = new EventEmitter();
    const pending = new Set(deliveries.map(delivery => delivery.fields.deliveryTag));
    const acknowledged: number[] = [];
    const requeued: number[] = [];
    let closed = false;
    const settle = (delivery: Message, allUpTo: boolean, output: number[]) => {
        if (closed || allUpTo || !pending.delete(delivery.fields.deliveryTag)) {
            throw new Error('Invalid or duplicate delivery acknowledgment');
        }
        output.push(delivery.fields.deliveryTag);
    };
    return Object.assign(broker, {
        pending, acknowledged, requeued,
        ack: (delivery: Message, allUpTo = false) => settle(delivery, allUpTo, acknowledged),
        nack: (delivery: Message, allUpTo = false, requeue = true) => {
            if (!requeue) throw new Error('Retry must preserve the delivery');
            settle(delivery, allUpTo, requeued);
        },
        ackAll: () => { for (const tag of pending) acknowledged.push(tag); pending.clear(); },
        nackAll: () => { for (const tag of pending) requeued.push(tag); pending.clear(); },
        close: async () => { closed = true; broker.emit('close'); }
    });
}

function routes(bulk: (request: any) => Promise<any>) {
    return new ElasticRoutes({ chain: 'test', config: {
        scaling: {}, settings: { index_version: 'v1', index_partition_size: 1000 }
    }, ingestClients: [{ bulk }] } as any);
}

function response(...entries: Array<[string | number, number]>) {
    return { errors: entries.some(([, status]) => status >= 300), items: entries.map(([id, status]) => ({
        index: { _id: String(id), _index: 'test-block-v1', status }
    })) };
}

function run(route: ElasticRoutes, batch: Message[], broker: ReturnType<typeof channel>, type = 'block') {
    return new Promise<number | undefined>(resolve => route.routes[type](batch, broker as unknown as Channel, resolve));
}

afterEach(() => { (ElasticRoutes as any).reportMaxBlock = reportMaxBlock; });
const reportMaxBlock = (ElasticRoutes as any).reportMaxBlock;

describe('Elasticsearch delivery acknowledgments', () => {
    it('waits for the bulk result and settles only its own deliveries', async () => {
        const batch = [message({ block_num: 1 }, 1)];
        const broker = channel([...batch, message({ block_num: 2 }, 2)]);
        const writing = deferred<any>();
        const work = run(routes(() => writing.promise), batch, broker);
        expect(broker.acknowledged).toEqual([]);
        writing.resolve(response([1, 201]));
        expect(await work).toBe(1);
        expect(broker.acknowledged).toEqual([1]);
        expect([...broker.pending]).toEqual([2]);
    });

    it('does not acknowledge another generic subrequest before it completes', async () => {
        const limits = message({ owner: 'alice' }, 1, 'resource_limits');
        const usage = message({ owner: 'bob' }, 2, 'resource_usage');
        const prefetched = message({ owner: 'carol' }, 3, 'resource_limits');
        const broker = channel([limits, usage, prefetched]);
        const slow = deferred<any>();
        const fast = deferred<void>();
        const route = routes(async request => {
            if (request.index.includes('userres')) return slow.promise;
            fast.resolve();
            return { errors: false, items: [{ update: { _id: 'alice', status: 200 } }] };
        });
        const work = run(route, [limits, usage], broker, 'generic');
        await fast.promise;
        await new Promise(resolve => setImmediate(resolve));
        expect(broker.acknowledged).toEqual([1]);
        expect([...broker.pending]).toEqual([2, 3]);
        slow.resolve({ errors: false, items: [{ update: { _id: 'bob', status: 200 } }] });
        expect(await work).toBe(2);
        expect(broker.acknowledged).toEqual([1, 2]);
        expect([...broker.pending]).toEqual([3]);
    });

    it('requeues only the submitted batch after a whole-request pressure rejection', async () => {
        const batch = [message({ block_num: 1 }, 1)];
        const broker = channel([...batch, message({ block_num: 2 }, 2)]);
        expect(await run(routes(async () => { throw Object.assign(new Error('Rejected'), { statusCode: 429 }); }), batch, broker)).toBe(0);
        expect(broker.requeued).toEqual([1]);
        expect(broker.acknowledged).toEqual([]);
        expect([...broker.pending]).toEqual([2]);
    });

    it.each([true, false])('counts only successful items and retries pressure failures (errors=%s)', async errors => {
        const batch = [message({ block_num: 1 }, 1), message({ block_num: 2 }, 2)];
        const broker = channel(batch);
        expect(await run(routes(async () => ({ ...response([1, 201], [2, 429]), errors })), batch, broker)).toBe(1);
        expect(broker.acknowledged).toEqual([1]);
        expect(broker.requeued).toEqual([2]);
    });

    it('matches duplicate IDs to their individual ordered delivery results', async () => {
        const batch = [message({ block_num: '7' }, 1), message({ block_num: '7' }, 2)];
        const broker = channel(batch);
        expect(await run(routes(async () => response([7, 201], [7, 429])), batch, broker)).toBe(1);
        expect(broker.acknowledged).toEqual([1]);
        expect(broker.requeued).toEqual([2]);
    });

    it('preserves missing-document and retry policies without blocking valid writes', async () => {
        const statuses = [200, 201, 404, 409, 400, 429, 503];
        const batch = statuses.map((_, index) => message({ block_num: String(index + 1) }, index + 1));
        const broker = channel(batch);
        const result = response(...statuses.map((status, index): [string, number] => [String(index + 1), status]));
        expect(await run(routes(async () => result), batch, broker)).toBe(2);
        expect(broker.acknowledged).toEqual([1, 2, 3]);
        expect(broker.requeued).toEqual([4, 5, 6, 7]);
        expect(broker.pending.size).toBe(0);
        expect(broker.listenerCount('close')).toBe(0);
    });

    it('correlates ordered scripted updates with repeated document IDs', async () => {
        const batch = [100, 101].map((block_num, index) => message({ block_num,
            code: 'token', scope: 'alice', symbol: 'EOS', amount: index + 1 }, index + 1));
        const broker = channel(batch);
        const route = routes(async request => {
            expect(request.operations).toHaveLength(4);
            expect(request.operations[0].update).toMatchObject({ _id: 'token-alice-EOS', retry_on_conflict: 3 });
            expect(request.operations[1].script.params.block_num).toBe(100);
            expect(request.operations[3].script.params.block_num).toBe(101);
            return { errors: true, items: [200, 429].map(status => ({ update: { _id: 'token-alice-EOS', status } })) };
        });
        expect(await run(route, batch, broker, 'table-accounts')).toBe(1);
        expect(broker.acknowledged).toEqual([1]);
        expect(broker.requeued).toEqual([2]);
    });

    it('completes an empty batch without sending a bulk request', async () => {
        let calls = 0;
        const broker = channel([]);
        expect(await run(routes(async () => { calls++; return response(); }), [], broker)).toBe(0);
        expect(calls).toBe(0);
        expect(broker.listenerCount('close')).toBe(0);
    });

    it.each([
        ['missing response', undefined],
        ['missing items', { errors: false }],
        ['missing errors flag', { items: response([1, 201], [2, 201]).items }],
        ['missing item', response([1, 201])],
        ['extra item', response([1, 201], [2, 201], [3, 201])],
        ['wrong ID', response([9, 201], [2, 201])],
        ['wrong operation', { errors: false, items: [{ update: { _id: '1', status: 200 } }, response([2, 201]).items[0]] }],
        ['missing status', { errors: false, items: [{ index: { _id: '1' } }, response([2, 201]).items[0]] }],
        ['multiple operations', { errors: false, items: [{ ...response([1, 201]).items[0], update: { _id: '1', status: 200 } }, response([2, 201]).items[0]] }]
    ])('fails closed before settling any item for a %s', async (_name, result) => {
        const batch = [message({ block_num: 1 }, 1), message({ block_num: 2 }, 2)];
        const broker = channel([...batch, message({ block_num: 3 }, 3)]);
        expect(await run(routes(async () => result), batch, broker)).toBe(0);
        expect(broker.acknowledged).toEqual([]);
        expect(broker.requeued).toEqual([1, 2]);
        expect([...broker.pending]).toEqual([3]);
    });

    it.each([true, false])('does not settle or count results after the original channel closes (success=%s)', async succeeds => {
        const batch = [message({ block_num: 1 }, 1)];
        const broker = channel(batch);
        const writing = deferred<any>();
        const work = run(routes(() => writing.promise), batch, broker);
        await broker.close();
        if (succeeds) writing.resolve(response([1, 201])); else writing.reject(new Error('Connection lost'));
        expect(await work).toBe(0);
        expect(broker.acknowledged).toEqual([]);
        expect(broker.requeued).toEqual([]);
        expect(broker.listenerCount('close')).toBe(0);
    });

    it('closes the original channel after a settlement failure without settling an acknowledged tag twice', async () => {
        const batch = [message({ block_num: 1 }, 1), message({ block_num: 2 }, 2)];
        const broker = channel(batch);
        const close = spyOn(broker, 'close');
        const acknowledge = broker.ack;
        broker.ack = delivery => {
            if (delivery.fields.deliveryTag === 2) throw new Error('Channel stopped accepting frames');
            acknowledge(delivery);
        };
        expect(await run(routes(async () => response([1, 201], [2, 201])), batch, broker)).toBe(0);
        expect(close).toHaveBeenCalledTimes(1);
        expect(broker.acknowledged).toEqual([1]);
        expect(broker.requeued).toEqual([]);
    });

    it.each([true, false])('reports delta progress only when every item succeeded (success=%s)', async succeeds => {
        const batch = [message({ block_num: 100, code: 'token', scope: 'alice', table: 'accounts', primary_key: '1' }, 1),
            message({ block_num: 101, code: 'token', scope: 'bob', table: 'accounts', primary_key: '2' }, 2)];
        const broker = channel(batch);
        const report = spyOn(ElasticRoutes as any, 'reportMaxBlock');
        const result = response(['100-token-alice-accounts-1', 201], ['101-token-bob-accounts-2', succeeds ? 201 : 429]);
        expect(await run(routes(async () => result), batch, broker, 'delta')).toBe(succeeds ? 2 : 1);
        expect(report.mock.calls).toEqual(succeeds ? [[101, 'test-delta-v1']] : []);
    });
});
