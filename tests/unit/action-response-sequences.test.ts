import {afterEach, expect, test} from 'bun:test';
import Fastify, {type FastifyInstance} from 'fastify';
import registerV1 from '../../src/api/routes/v1-history/get_actions/index.js';
import registerV2 from '../../src/api/routes/v2-history/get_actions/index.js';
import {streamPastCommon} from '../../src/api/helpers/functions.js';

const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function action(sequence: string | number) {
    return {global_sequence: sequence, block_num: 42, '@timestamp': '2026-10-20T00:00:00.000',
        trx_id: 'a'.repeat(64), action_ordinal: 1, creator_action_ordinal: 0,
        act: {account: 'eosio.token', name: 'transfer', authorization: [], data: {global_sequence: '0009', count: 7}},
        receipts: [{receiver: 'alice', global_sequence: sequence, recv_sequence: 0,
            auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}]}]};
}

function result(actions: any[]) {
    return {timed_out: false, _shards: {total: 1, successful: 1, failed: 0, skipped: 0},
        hits: {total: {value: actions.length, relation: 'eq'}, hits: actions.map(_source => ({_source}))}};
}

async function fixture(version: 1 | 2, actions: any[]) {
    const app = Fastify({logger: false}); servers.push(app);
    const cache = new Map<string, string>(); let calls = 0;
    app.decorate('manager', {chain: 'response-sequences', readIndexset: () => 'response-sequences-action-*',
        config: {settings: {}, api: {enable_caching: true, cache_life: 60, limits: {get_actions: 20}}}});
    app.decorate('redis', {get: async (key: string) => cache.get(key) ?? null,
        set: async (key: string, value: string) => {cache.set(key, value); return 'OK';}});
    app.decorate('elastic', {search: async () => {calls++; return result(structuredClone(actions));}});
    app.decorate('antelope', {chain: {get_info: async () => ({last_irreversible_block_num: {toNumber: () => 41}})}});
    app.decorate('allowedActionQueryParamSet', new Set());
    await app.register(version === 1 ? registerV1 : registerV2, {prefix: `/v${version}/history`});
    await app.ready();
    const request = version === 1 ? {method: 'POST' as const, url: '/v1/history/get_actions',
        payload: {account_name: 'alice', pos: 0, offset: 20}}
        : {method: 'GET' as const, url: '/v2/history/get_actions?hydrate=false'};
    return {app, request, calls: () => calls, cache};
}

for (const version of [1, 2] as const) {
    test(`v${version} action serializer and response cache preserve exact strings on Antelope`, async () => {
        const values = [1, '9', '10', '9007199254740992', '9007199254740993', '9223372036854775808', '18446744073709551615'];
        const f = await fixture(version, values.map(action));
        for (let repeat = 0; repeat < 2; repeat++) {
            const response = await f.app.inject(f.request);
            expect(response.statusCode).toBe(200);
            const actions = response.json().actions;
            expect(actions.map(value => version === 1 ? value.global_action_seq : value.global_sequence)).toEqual(values.map(String));
            for (const value of actions) {
                const receipt = version === 1 ? value.action_trace.receipt : value.receipts[0];
                expect(receipt.recv_sequence).toBe('0');
                expect(receipt.auth_sequence[0].sequence).toBe('18446744073709551615');
                if (version === 1) expect(value.account_action_seq).toBe('0');
                expect((version === 1 ? value.action_trace.act : value.act).data).toEqual({global_sequence: '0009', count: 7});
                expect(value.block_num).toBe(42);
            }
        }
        expect(f.calls()).toBe(1);
    });

    test(`v${version} refuses unsafe retained numeric metadata rather than returning rounded text`, async () => {
        const f = await fixture(version, [action(9007199254740992)]);
        expect((await f.app.inject(f.request)).statusCode).toBe(503);
        expect(f.cache.size).toBe(0);
    });

    test(`v${version} rejects malformed sequence filters before search or cache access`, async () => {
        for (const invalid of ['01', '+1', '18446744073709551616', '1e3']) {
            const f = await fixture(version, [action('1')]);
            const request = version === 1 ? {...f.request, payload: {account_name: 'alice', 'receipts.recv_sequence': invalid}}
                : {...f.request, url: `${f.request.url}&receipts.recv_sequence=${encodeURIComponent(invalid)}`};
            expect((await f.app.inject(request)).statusCode).toBe(400);
            expect(f.calls()).toBe(0);
            expect(f.cache.size).toBe(0);
        }
    });
}

test('legacy POST refuses unsafe numeric filters instead of reconstructing rounded sequence text', async () => {
    const f = await fixture(1, [action('1')]);
    const response = await f.app.inject({...f.request, payload: {account_name: 'alice', 'receipts.recv_sequence': 9007199254740992}});
    expect(response.statusCode).toBe(400);
    expect(f.calls()).toBe(0);
});

test('historical action stream emits canonical metadata strings and preserves contract fields', async () => {
    const messages: any[] = [];
    const socket: any = {connected: true, id: 'sequence-stream', emit: (_kind, value) => messages.push(value),
        timeout: () => ({emitWithAck: async (_kind, value) => {messages.push(value); return {status: true};}})};
    const fastify: any = {manager: {chain: 'sequence-stream', config: {settings: {}, api: {stream_scroll_limit: 100}}},
        elastic: {search: async () => result([action(9), action('9007199254740993')])}};
    await streamPastCommon(fastify, socket, 'sequence-request', {}, 'action');
    const streamed = messages.find(value => value.mode === 'history' && value.messages?.length)?.messages;
    expect(streamed.map(value => value.global_sequence)).toEqual(['9', '9007199254740993']);
    expect(streamed[0].receipts[0].recv_sequence).toBe('0');
    expect(streamed[0].act.data).toEqual({global_sequence: '0009', count: 7});
});

test('historical sequence filters preserve a safe numeric zero operand', async () => {
    const emitted: any[] = [];
    const actions = [action('9'), action('10')];
    actions[1].receipts[0].recv_sequence = 1;
    const socket: any = {connected: true, id: 'zero-stream', emit: () => {},
        timeout: () => ({emitWithAck: async (_kind, value) => {emitted.push(...value.messages); return {status: true};}})};
    const fastify: any = {manager: {chain: 'sequence-stream', config: {settings: {}, api: {stream_scroll_limit: 100}}},
        elastic: {search: async () => result(actions)}};
    await streamPastCommon(fastify, socket, 'zero-request',
        {filters: [{field: 'receipts.recv_sequence', value: 0, operator: 'eq'}]}, 'action');
    expect(emitted.map(value => value.global_sequence)).toEqual(['9']);
});
