import {describe, expect, it} from 'bun:test';
import {EventEmitter} from 'node:events';
import type {Channel, Message} from 'amqplib';
import {ElasticRoutes} from '../../src/indexer/helpers/elastic-routes.js';
import {createIndexerSettlementRecovery as recovery} from '../../src/indexer/helpers/indexer-settlement-recovery.js';

function delivery(id: number): Message {
    return {content: Buffer.from(JSON.stringify({block_num: id})), fields: {deliveryTag: id}, properties: {}} as Message;
}

function channel(fail: 'ack' | 'nack' | undefined, closeRejects = false) {
    const broker = new EventEmitter();
    const acknowledged: number[] = [];
    const requeued: number[] = [];
    let closed = false;
    return Object.assign(broker, {
        acknowledged, requeued,
        ack(message: Message) {
            if (fail === 'ack') throw new Error('Cannot send ACK frame');
            acknowledged.push(message.fields.deliveryTag);
        },
        nack(message: Message) {
            if (fail === 'nack') throw new Error('Cannot send NACK frame');
            requeued.push(message.fields.deliveryTag);
        },
        async close() {
            if (closeRejects) throw new Error('Channel close failed');
            closed = true;
            broker.emit('close');
        },
        isClosed: () => closed
    });
}

function routes(result: 'success' | 'request-pressure' | 'item-pressure', recover: (channel: Channel) => void) {
    return new ElasticRoutes({chain: 'test', config: {scaling: {}, settings: {
        index_version: 'v1', index_partition_size: 1000}}, ingestClients: [{bulk: async () => {
        if (result === 'request-pressure') throw new Error('Whole-request pressure rejection');
        return {errors: result !== 'success', items: [{index: {_id: '1', status: result === 'success' ? 201 : 429}}]};
    }}]} as any, recover);
}

function run(route: ElasticRoutes, broker: ReturnType<typeof channel>) {
    return new Promise<number | undefined>(resolve => route.routes.block([delivery(1)], broker as unknown as Channel, resolve));
}

describe('Elasticsearch settlement failure recovery', () => {
    it('exits a child process with code one through the default current-channel handler', async () => {
        const helper = new URL('../../src/indexer/helpers/indexer-settlement-recovery.ts', import.meta.url).href;
        const script = `import {createIndexerSettlementRecovery} from ${JSON.stringify(helper)};
            import {writeSync} from 'node:fs';
            const channel = {};
            writeSync(1, 'calling recovery\\n');
            createIndexerSettlementRecovery(() => channel)(channel);
            writeSync(1, 'UNREACHED\\n');`;
        const child = Bun.spawn([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe('calling recovery\n');
        expect(stderr).toBe('');
    });

    it.each([
        ['success', 'ack'], ['request-pressure', 'nack'], ['item-pressure', 'nack']
    ] as const)('requests worker replacement after %s cannot send its %s frame', async (result, failedMethod) => {
        const original = channel(failedMethod);
        const replacement = channel(undefined);
        let current = original as unknown as Channel;
        let ready = true;
        let replacementConsumers = 0;
        const exits: number[] = [];
        original.on('close', () => { ready = false; });
        const recover = recovery(() => current, code => {
            // Record the actual exit request and model the supervisor's next
            // worker binding a new consumer; this is not a real master process.
            exits.push(code);
            expect(ready).toBe(false);
            current = replacement as unknown as Channel;
            replacementConsumers++;
            ready = true;
        });
        expect(await run(routes(result, recover), original)).toBe(0);
        expect(original.isClosed()).toBe(true);
        expect(exits).toEqual([1]);
        expect(replacementConsumers).toBe(1);
        expect(ready).toBe(true);
        expect(await run(routes('success', recover), replacement)).toBe(1);
        expect(replacement.acknowledged).toEqual([1]);
    });

    it('still requests replacement when closing the affected current channel rejects', async () => {
        const original = channel('ack', true);
        const exits: number[] = [];
        const recover = recovery(() => original as unknown as Channel, code => exits.push(code));
        expect(await run(routes('success', recover), original)).toBe(0);
        expect(exits).toEqual([1]);
    });

    it('does not terminate a healthy replacement when the failed old channel finishes closing', async () => {
        const original = channel('ack');
        const replacement = channel(undefined);
        let current = original as unknown as Channel;
        const close = original.close;
        original.close = async () => {
            await close();
            current = replacement as unknown as Channel;
        };
        const exits: number[] = [];
        const recover = recovery(() => current, code => exits.push(code));
        expect(await run(routes('success', recover), original)).toBe(0);
        expect(exits).toEqual([]);
        expect(await run(routes('success', recover), replacement)).toBe(1);
        expect(replacement.acknowledged).toEqual([1]);
    });

    it.each(['request-pressure', 'item-pressure'] as const)('does not restart after %s was successfully requeued', async result => {
        const broker = channel(undefined);
        const exits: number[] = [];
        const recover = recovery(() => broker as unknown as Channel, code => exits.push(code));
        expect(await run(routes(result, recover), broker)).toBe(0);
        expect(exits).toEqual([]);
        expect(broker.isClosed()).toBe(false);
        expect(broker.requeued).toEqual([1]);
    });
});
