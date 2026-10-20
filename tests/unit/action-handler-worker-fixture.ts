import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

const previous = process.cwd(), parent = resolve(tmpdir()), prefix = 'hyperion-handler-worker-';
const directory = mkdtempSync(join(parent, prefix)), previousConfig = process.env.CONFIG_JSON;
try {
    const chain = 'handler-worker', config = {settings: {chain, eosio_alias: 'eosio', parser: '3.2', debug: false},
        indexer: {}, features: {}, scaling: {}, api: {}, whitelists: {actions: [], deltas: []}, plugins: {}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: '1'.repeat(64)}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const {default: Pool} = await import('../../src/indexer/workers/ds-pool.js');
    const {default: Parser} = await import('../../src/indexer/modules/parsers/3.2-parser.js');
    const {HyperionModuleLoader} = await import('../../src/indexer/modules/loader.js');
    const filters = {action_whitelist: new Set(), action_blacklist: new Set()};
    const cm: any = {config, filters, connections: {chains: {[chain]: {chain_id: '1'.repeat(64)}}}};
    const modules = new HyperionModuleLoader(cm), parser = new Parser(cm), pool: any = Object.create(Pool.prototype);
    pool.conf = config; pool.profiler = {start: () => () => {}}; pool.mLoader = modules;
    pool.common = {deserializeActionAtBlockNative: async () => ({value: 7}), attachActionExtras: pool.attachActionExtras};
    const gate = () => {
        let release!: () => void;
        return {promise: new Promise<void>(resolve => {release = resolve;}), release: () => release()};
    };
    const wildcard = gate(), specific = gate(), enteredWildcard = gate(), enteredSpecific = gate();
    modules.includeActionModule({contract: '*', action: 'send', handler: async value => {
        enteredWildcard.release(); await wildcard.promise; value.wildcard = true;
    }});
    modules.includeActionModule({contract: 'alpha', action: 'send', handler: async value => {
        assert.equal(value.wildcard, true); enteredSpecific.release(); await specific.promise; value.specific = true;
    }});
    const action = (account = 'alpha', name = 'send'): any => ({action_ordinal: 1, creator_action_ordinal: 0,
        except: null, error_code: null, act: {account, name, authorization: [], data: '00'},
        receipt: ['action_receipt_v0', {receiver: account, global_sequence: '9007199254740993', recv_sequence: '7',
            auth_sequence: [], act_digest: 'd'.repeat(64), code_sequence: 1, abi_sequence: 1}]});
    const transaction: any = {block_num: 42, block_id: 'b'.repeat(64), producer: 'alice', trx_id: 'a'.repeat(64),
        cpu_usage_us: 0, net_usage_words: 0, signatures: [], inline_count: 0, filtered: false};
    const value = action(), processed: any[] = [];
    const parsing = parser.parseAction(pool, '2026-10-20T00:00:00.000', value, transaction, [], processed,
        {action_traces: [value]}, {status: false});
    await enteredWildcard.promise; assert.equal(processed.length, 0);
    wildcard.release(); await enteredSpecific.promise; assert.equal(processed.length, 0);
    specific.release(); assert.equal(await parsing, true); assert.equal(processed.length, 1);
    assert.equal(processed[0].specific, true); assert.equal(processed[0].global_sequence, '9007199254740993');

    const rejected = new Error('awaited contract hook failure');
    modules.includeActionModule({contract: 'alpha', action: 'send', handler: async () => {await Promise.resolve(); throw rejected;}});
    await assert.rejects(pool.attachActionExtras(pool, action()), error => error === rejected);
    const messages: string[] = [], originalLog = console.log, failed = action(), afterFailure: any[] = [];
    const hookFailures: unknown[] = [];
    pool.noteActionHookFailure = (error: unknown) => hookFailures.push(error);
    console.log = (...values) => messages.push(values.map(String).join(' '));
    try {
        assert.equal(await parser.parseAction(pool, '', failed, transaction, [], afterFailure,
            {action_traces: [failed]}, {status: false}), true);
    } finally {console.log = originalLog;}
    assert.equal(afterFailure.length, 1);
    assert.deepEqual(hookFailures, [rejected]);
    assert(messages.some(message => message.includes('Failed to call attachActionExtras:') && message.includes(rejected.message)));

    for (const reason of [undefined, null]) {
        modules.includeActionModule({contract: 'alpha', action: 'send', handler: async () => {
            await Promise.resolve(); return Promise.reject(reason);
        }});
        await pool.attachActionExtras(pool, action()).then(() => assert.fail('Rejected hook unexpectedly fulfilled'),
            (failure: unknown) => assert.strictEqual(failure, reason));
        const failed = action(), processed: any[] = [], before = hookFailures.length, logged: string[] = [];
        console.log = (...values) => logged.push(values.map(String).join(' '));
        try {
            assert.equal(await parser.parseAction(pool, '', failed, transaction, [], processed,
                {action_traces: [failed]}, {status: false}), true);
        } finally {console.log = originalLog;}
        assert.equal(hookFailures.length, before + 1); assert.strictEqual(hookFailures.at(-1), reason);
        assert.equal(processed.length, 1, 'Existing parser recovery still returns its action to the transaction boundary');
        assert(logged.some(message => message.includes('Failed to call attachActionExtras:') && message.includes(String(reason))),
            'Falsy rejection is logged without dereferencing reason.message');
    }

    modules.includeActionModule({contract: 'beta', action: 'healthy', handler: value => {value.healthy = true;}});
    const healthy = action('beta', 'healthy'), unrelated: any[] = [];
    assert.equal(await parser.parseAction(pool, '', healthy, transaction, [], unrelated,
        {action_traces: [healthy]}, {status: false}), true);
    assert.equal(unrelated.length, 1); assert.equal(unrelated[0].healthy, true);
    console.log(JSON.stringify({passed: true, parserWaits: true, extrasRejects: true, parserHandlesRejection: true, unrelatedContract: true}));
} finally {
    process.chdir(previous);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    const target = resolve(directory); assert.equal(dirname(target), parent); assert(basename(target).startsWith(prefix));
    rmSync(target, {recursive: true, force: true});
}
