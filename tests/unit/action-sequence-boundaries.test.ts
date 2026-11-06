import {afterEach, describe, expect, test} from 'bun:test';
import Fastify, {type FastifyInstance} from 'fastify';
import HyperionParser from '../../src/indexer/modules/parsers/3.2-parser.js';
import {groupActionTraces} from '../../src/indexer/helpers/action-dedup.js';
import {transactionSequenceCacheKey} from '../../src/indexer/helpers/transaction-cache.js';
import registerV1 from '../../src/api/routes/v1-history/get_transaction/index.js';
import registerV2 from '../../src/api/routes/v2-history/get_transaction/index.js';
import {fileURLToPath} from 'node:url';

const trxId = 'a'.repeat(64);
const servers: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function action(sequence: string | number, ordinal = 1): any {
    return {global_sequence: sequence, block_num: 42, block_id: 'b'.repeat(64), trx_id: trxId,
        '@timestamp': '2026-10-20T00:00:00.000', action_ordinal: ordinal, creator_action_ordinal: 0,
        code_sequence: 0xffffffff, abi_sequence: 0xffffffff, act_digest: String(ordinal).padStart(64, '0'),
        act: {account: 'eosio.token', name: 'transfer', authorization: [], data: {amount: 7, global_sequence: '0009'}},
        receipts: [{receiver: 'alice', global_sequence: sequence, recv_sequence: 0,
            auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}]}]};
}

describe('3.2 parser sequence boundary', () => {
    test('certified notification order does not replace the representative root sequence', () => {
        const root = action('9007199254740993', 1), notification = action('9007199254740994', 2);
        for (const value of [root, notification]) {
            value.receipt = {...value.receipts[0], code_sequence: 0xffffffff, abi_sequence: 0xffffffff};
            delete value.receipts;
            value.protocol = {schemaVersion: 1, input: {transactionId: trxId, actionOrdinal: value.action_ordinal,
                inputActionOrdinal: 1, globalSequence: value.global_sequence}};
        }
        notification.receipt.receiver = 'bob';
        const grouped: any[] = groupActionTraces([notification, root], 'certified-extension');
        expect(grouped).toHaveLength(1);
        expect(grouped[0].global_sequence).toBe('9007199254740993');
        expect(grouped[0].receipts.map(receipt => receipt.global_sequence)).toEqual(['9007199254740994', '9007199254740993']);
        expect(grouped[0].action_ordinal).toBe(1);
    });
    test('DS-pool publishes, streams and caches exact root/receipt/auth metadata with the production flatten sort', async () => {
        const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./action-sequence-worker-fixture.ts', import.meta.url))],
            {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr, stdout}).toMatchObject({code: 0, stderr: ''});
        expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed: true, exactPublication: true,
            exactCache: true, exactStreaming: true, exactTelemetry: true});
    });
    for (const extension of [false, true]) {
        test(`keeps uint64 source identity exact before ${extension ? 'extension' : 'native'} data handling and grouping`, async () => {
            const parser = new HyperionParser({config: {settings: {chain: 'sequence-test', eosio_alias: 'eosio'}},
                filters: {action_whitelist: new Set(), action_blacklist: new Set()}} as any);
            const seen: string[] = [];
            const worker: any = {usesExtensionProtocol: extension, usesProtocolSourceBindings: extension, profiler: {start: () => () => {}},
                conf: {indexer: {}}, common: {
                    deserializeActionAtBlockNative: async (_worker, act) => {seen.push('native'); return {amount: 7};},
                    attachActionExtras: (_worker, trace) => {expect(trace.receipt[1].global_sequence).toBe('9007199254740993');}
                }, deserializeProtocolAction: async trace => {
                    seen.push('extension');
                    expect(trace.receipt[1].global_sequence).toBe('9007199254740993');
                    expect(trace.receipt[1].recv_sequence).toBe('0');
                    trace.act.data = {amount: 7};
                }};
            const value = action('9007199254740993');
            const receipt = {...value.receipts[0], act_digest: value.act_digest, code_sequence: 0xffffffff, abi_sequence: 0xffffffff};
            value.receipt = ['action_receipt_v0', receipt];
            delete value.receipts; delete value.global_sequence;
            value.except = null; value.error_code = null;
            const traces: any[] = [];
            const transaction: any = {block_num: 42, block_id: 'b'.repeat(64), producer: 'alice', trx_id: trxId,
                cpu_usage_us: 1, net_usage_words: 2, signatures: [], inline_count: 0, filtered: false};
            expect(await parser.parseAction(worker, '2026-10-20T00:00:00.000', value, transaction, [], traces,
                {action_traces: [value]}, {status: false})).toBe(true);
            const grouped: any[] = groupActionTraces(traces);
            expect(seen).toEqual([extension ? 'extension' : 'native']);
            expect(grouped[0].global_sequence).toBe('9007199254740993');
            expect(grouped[0].receipts[0]).toMatchObject({global_sequence: '9007199254740993', recv_sequence: '0',
                auth_sequence: [{account: 'alice', sequence: '18446744073709551615'}]});
            expect(grouped[0].code_sequence).toBe(0xffffffff);
            expect(grouped[0].abi_sequence).toBe(0xffffffff);
            expect(grouped[0].block_num).toBe(42);
            expect(grouped[0].act.data).toEqual({amount: 7});
        });
    }

    test('does not admit zero or rounded committed identifiers to contract hooks', async () => {
        const parser = new HyperionParser({config: {settings: {chain: 'sequence-test', eosio_alias: 'eosio'}},
            filters: {action_whitelist: new Set(), action_blacklist: new Set()}} as any);
        let calls = 0;
        const worker: any = {profiler: {start: () => () => {}}};
        parser.deserializeActionData = async () => { calls++; };
        for (const sequence of ['0', 9007199254740992]) {
            const value: any = {act: {account: 'eosio.token', name: 'transfer'}, except: null,
                receipt: ['action_receipt_v0', {global_sequence: sequence}]};
            await expect(parser.parseAction(worker, '', value, {} as any, [], [], {}, {status: false})).rejects.toThrow();
        }
        expect(calls).toBe(0);
    });
});

async function fixture(version: 1 | 2, cached: Record<string, string>, fallback: any[] = []) {
    const app = Fastify({logger: false}); servers.push(app);
    const hashReads: string[] = [], ttlReads: string[] = []; let searches = 0;
    app.decorate('manager', {chain: 'sequence-test', readIndexset: () => 'sequence-test-action-*',
        config: {settings: {index_version: 'v1', index_partition_size: 1000}, api: {enable_caching: false,
            limits: {get_trx_actions: 100}}}});
    app.decorate('redis', {hgetall: async key => {hashReads.push(key); return cached;},
        ttl: async key => {ttlReads.push(key); return 30;}, get: async key => key === 'sequence-test_get_info'
            ? JSON.stringify({last_irreversible_block_num: 40}) : null, set: async () => 'OK'});
    app.decorate('elastic', {search: async () => {searches++; return {timed_out: false,
        _shards: {total: 1, successful: 1, failed: 0, skipped: 0}, hits: {hits: fallback.map(value => ({_source: value}))}};}});
    await app.register(version === 1 ? registerV1 : registerV2, {prefix: `/v${version}/history`});
    await app.ready();
    const request = version === 1 ? {method: 'POST' as const, url: '/v1/history/get_transaction', payload: {id: trxId}}
        : {method: 'GET' as const, url: `/v2/history/get_transaction?hydrate=false&id=${trxId}`};
    return {app, request, hashReads, ttlReads, searches: () => searches};
}

for (const version of [1, 2] as const) describe(`v${version} transaction sequence cache routes`, () => {
    test('sorts fully parsed cache actions by exact sequence magnitude and emits strings', async () => {
        const values = ['18446744073709551615', '9223372036854775808', '9007199254740993', '9007199254740992', '10', '9'];
        const cached = Object.fromEntries(values.map((value, index) => [value, JSON.stringify(action(value, index + 1))]));
        const f = await fixture(version, cached);
        const response = await f.app.inject(f.request);
        expect(response.statusCode).toBe(200);
        const body = response.json();
        const sequences = version === 1 ? body.traces.map(trace => trace.receipt.global_sequence)
            : body.actions.map(value => value.global_sequence);
        expect(sequences).toEqual([...values].reverse());
        const receipt = version === 1 ? body.traces[0].receipt : body.actions[0].receipts[0];
        expect(receipt.recv_sequence).toBe('0');
        expect(receipt.auth_sequence[0].sequence).toBe('18446744073709551615');
        expect(f.hashReads).toEqual([transactionSequenceCacheKey('sequence-test', trxId)]);
        expect(f.ttlReads).toEqual(f.hashReads);
        expect(f.searches()).toBe(0);
    });

    for (const invalid of ['{', JSON.stringify(action(9007199254740992)), JSON.stringify(action('12'))]) {
        test(`falls back as a whole for a damaged cache member ${invalid.slice(0, 22)}`, async () => {
            const f = await fixture(version, {'9': JSON.stringify(action('9')), '10': invalid}, [action(42)]);
            const response = await f.app.inject(f.request);
            expect(response.statusCode).toBe(200);
            const body = response.json();
            const sequences = version === 1 ? body.traces.map(trace => trace.receipt.global_sequence)
                : body.actions.map(value => value.global_sequence);
            expect(sequences).toEqual(['42']);
            expect(f.searches()).toBe(1);
            expect(f.ttlReads).toHaveLength(0);
        });
    }
});
