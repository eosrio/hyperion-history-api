import {describe, expect, it} from 'bun:test';
import {EventEmitter} from 'node:events';
import type {Channel, Message} from 'amqplib';
import {ElasticRoutes} from '../../src/indexer/helpers/elastic-routes.js';
import {ACTION_SEQUENCE_NAMESPACE as namespace, restoreActionSequenceStorage} from '../../src/indexer/history/action-sequence-storage.js';

const maximum = '18446744073709551615';
const action = (sequence = maximum): any => ({global_sequence: sequence, block_num: 42, code_sequence: 0xffffffff,
    abi_sequence: 0xffffffff, act: {account: 'alpha', name: 'send', data: {sequence: '0001'}},
    receipts: [{receiver: 'alpha', global_sequence: sequence, recv_sequence: maximum,
        auth_sequence: [{account: 'alice', sequence: maximum}]}]});
const delivery = (body: any, tag: number): Message => ({content: Buffer.from(JSON.stringify(body)),
    fields: {deliveryTag: tag}, properties: {}} as Message);
function broker() {
    const acknowledged: number[] = [], requeued: number[] = [];
    return Object.assign(new EventEmitter(), {
        acknowledged, requeued, ack: (message: Message) => {acknowledged.push(message.fields.deliveryTag);},
        nack: (message: Message, allUpTo: boolean, requeue: boolean) => {
            expect(allUpTo).toBe(false); expect(requeue).toBe(true); requeued.push(message.fields.deliveryTag);
        }
    });
}
function route(bulk: (request: any) => Promise<any>, enabled: boolean, extension = false) {
    return new ElasticRoutes({chain: 'fixture', config: {scaling: {}, settings: {protocol: extension ? {provider: 'extension'} : undefined,
        index_version: 'v1', index_partition_size: 1000}}, ingestClients: [{bulk}]} as any,
    undefined, {exactActionSequenceStorage: enabled});
}
const run = (routes: ElasticRoutes, batch: Message[], channel: ReturnType<typeof broker>) =>
    new Promise(resolve => routes.routes.action(batch, channel as unknown as Channel, resolve));

describe('opt-in exact action bulk adapter', () => {
    it.each([false, true])('uses independent exact IDs and deterministic redelivery for extension=%s', async extension => {
        const values = ['9007199254740992', '9007199254740993', '9223372036854775808', maximum];
        const bodies = values.map(sequence => ({...action(sequence), ...(extension ? {protocol: {input: {globalSequence: sequence}}} : {})}));
        const batch = bodies.map((body, index) => delivery(body, index + 1)), requests: any[] = [];
        const routes = route(async request => {requests.push(structuredClone(request)); return {errors: false,
            items: values.map(value => ({index: {_id: value, status: 201}}))};}, true, extension);
        const channel = broker();
        expect(await run(routes, batch, channel)).toBe(4);
        expect(requests[0].pipeline).toBe('_none');
        for (let index = 0; index < values.length; index++) {
            const operation = requests[0].operations[index * 2], physical = requests[0].operations[index * 2 + 1];
            expect(operation.index).toMatchObject({_id: values[index], _index: 'fixture-action-v1-000001'});
            expect(physical[namespace].global.value).toBe(values[index]);
            expect(restoreActionSequenceStorage(physical)).toEqual(bodies[index]);
        }
        expect(channel.acknowledged).toEqual([1, 2, 3, 4]); expect(channel.requeued).toEqual([]);
        expect(await run(routes, batch, broker())).toBe(4);
        expect(requests[1]).toEqual(requests[0]);
    });

    it('preserves the existing default route until complete read/coverage qualification enables the new writer', async () => {
        const body = action('42'); let request: any;
        const routes = route(async value => {request = value; return {errors: false, items: [{index: {_id: '42', status: 201}}]};}, false);
        expect(await run(routes, [delivery(body, 1)], broker())).toBe(1);
        expect(request.operations[1]).toEqual(body);
        expect(Object.hasOwn(request.operations[1], namespace)).toBe(false);
        expect(request.pipeline).toBeUndefined();
    });

    it.each([
        (body: any) => {body.global_sequence = 9007199254740992;},
        (body: any) => {delete body.global_sequence;},
        (body: any) => {body.global_sequence = '0';},
        (body: any) => {body.receipts = [];},
        (body: any) => {body.receipts[0].auth_sequence[0].sequence = '18446744073709551616';},
        (body: any) => {body.protocol = {input: {globalSequence: '9007199254740993'}};}
    ])('retains every delivery and sends no payload for an invalid or mismatched exact identity', async mutate => {
        const valid = {...action(), protocol: {input: {globalSequence: maximum}}};
        const invalid = structuredClone(valid); mutate(invalid); let calls = 0;
        const routes = route(async () => {calls++; throw new Error('Unreachable');}, true, true);
        const batch = [delivery(valid, 1), delivery(invalid, 2)], channel = broker();
        expect(await run(routes, batch, channel)).toBe(0);
        expect(calls).toBe(0); expect(channel.acknowledged).toEqual([]); expect(channel.requeued).toEqual([1, 2]);
    });

    it.each([400, 404, 409, 429, 503])('preserves retryability when Elasticsearch rejects a full-range item with %s', async status => {
        const routes = route(async () => ({errors: true, items: [{index: {_id: maximum, status}}]}), true);
        const channel = broker();
        expect(await run(routes, [delivery(action(), 1)], channel)).toBe(0);
        expect(channel.requeued).toEqual([1]); expect(channel.acknowledged).toEqual([]);
    });
});
