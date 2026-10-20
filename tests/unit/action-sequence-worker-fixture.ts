import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const previous = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'hyperion-sequence-worker-'));
try {
    const chain = 'sequence-worker';
    const config = {settings: {chain, eosio_alias: 'eosio', parser: '3.2', debug: false}, indexer: {},
        features: {contract_console: false}, scaling: {}, api: {tx_cache_mode: 'batch'}, whitelists: {actions: [], deltas: []}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: '1'.repeat(64)}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const {default: Pool} = await import('../../src/indexer/workers/ds-pool.js');
    const {default: Parser} = await import('../../src/indexer/modules/parsers/3.2-parser.js');
    const {transactionSequenceCacheKey} = await import('../../src/indexer/helpers/transaction-cache.js');
    const parser: any = new Parser({config, filters: {action_whitelist: new Set(), action_blacklist: new Set()}} as any);
    const pool: any = Object.create(Pool.prototype), published: any[] = [], streamed: any[] = [], cache: any[] = [];
    pool.chain = chain; pool.conf = config; pool.profiler = {start: () => () => {}};
    pool.mLoader = {parser}; pool.temp_ds_counter = 0; pool.actionDsCounter = 0; pool.txCacheExpiration = 3600;
    pool.common = {deserializeActionAtBlockNative: async (_worker, act) => ({global_sequence: '00009', memo: String(act.data)}),
        attachActionExtras() {}};
    pool.pushToActionsQueue = payload => published.push(JSON.parse(payload));
    pool.pushToActionStreamingQueue = payload => streamed.push(JSON.parse(payload));
    pool.redisBatchPipeline = {hset(key, values) {cache.push({key, values: new Map(values)}); return this;},
        expire(key, seconds) {cache.push({key, seconds}); return this;}};
    const transactionId = 'a'.repeat(64);
    const trace = (sequence: string, ordinal: number) => ['action_trace_v1', {action_ordinal: ordinal,
        creator_action_ordinal: 0, except: null, error_code: null, act: {account: 'eosio.token', name: 'transfer', authorization: [], data: '00'},
        receipt: ['action_receipt_v0', {receiver: 'alice', global_sequence: sequence, recv_sequence: '18446744073709551615',
            auth_sequence: [{account: 'alice', sequence: '9223372036854775808'}], act_digest: ordinal.toString().padStart(64, '0'),
            code_sequence: 0xffffffff, abi_sequence: 0xffffffff}]}];
    // Exercise the production flatten comparator as well as the real parser, grouping and publication.
    parser.flatten = true; parser.flattenInlineActions = async value => value;
    const values = ['18446744073709551615', '9223372036854775808', '9007199254740993', '9007199254740992', '10', '9'];
    await pool.processTraces({id: transactionId, status: 0, cpu_usage_us: 0, net_usage_words: 0, signatures: [],
        action_traces: values.map((value, index) => trace(value, index + 1))}, {block_num: 42, block_id: 'b'.repeat(64),
        producer: 'alice', ts: '2026-10-20T00:00:00.000', inline_count: values.length, filtered: false, live: 'true'});
    const expected = [...values].reverse();
    assert.deepEqual(published.map(value => value.global_sequence), expected);
    assert.deepEqual(streamed.map(value => value.global_sequence), expected);
    assert.deepEqual([...cache[0].values.keys()], expected);
    assert.equal(cache[0].key, transactionSequenceCacheKey(chain, transactionId));
    assert.equal(cache[1].key, cache[0].key); assert.equal(cache[1].seconds, 3600);
    for (const value of published) {
        assert.equal(value.receipts[0].recv_sequence, '18446744073709551615');
        assert.equal(value.receipts[0].auth_sequence[0].sequence, '9223372036854775808');
        assert.equal(value.code_sequence, 0xffffffff); assert.equal(value.abi_sequence, 0xffffffff);
        assert.equal(value.act.data.global_sequence, '00009');
        assert.deepEqual(JSON.parse(cache[0].values.get(value.global_sequence).toString()), value);
    }
    // Contract decode errors use the same exact source identifier in telemetry.
    const events: any[] = [], originalSend = process.send;
    process.send = ((event: any) => {events.push(event); return true;}) as typeof process.send;
    try {
        parser.flatten = false; pool.common.deserializeActionAtBlockNative = async () => null;
        for (const variant of [true, false]) {
            const entry: any = trace('9007199254740993', 1);
            if (!variant) entry[1].receipt = entry[1].receipt[1];
            await pool.processTraces({id: transactionId, status: 0, cpu_usage_us: 0, net_usage_words: 0, signatures: [],
                action_traces: [entry]}, {block_num: 42, block_id: 'b'.repeat(64), producer: 'alice',
                ts: '2026-10-20T00:00:00.000', inline_count: 1, filtered: false, live: 'false'});
            assert.equal(events.filter(event => event.event === 'ds_error').at(-1).data.gs, '9007199254740993');
        }
    } finally {process.send = originalSend;}
    console.log(JSON.stringify({passed: true, exactPublication: true, exactCache: true, exactStreaming: true, exactTelemetry: true}));
} finally {process.chdir(previous); rmSync(directory, {recursive: true, force: true});}
