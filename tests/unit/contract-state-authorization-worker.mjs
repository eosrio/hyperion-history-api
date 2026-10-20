/** Actual emitted producer method with owned queue/config only; no service or source-capture qualification. */
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {Socket} from 'node:net';

const chain = 'contract-state-authorization', profileId = 'wire-sysio-7dede884-engineering-v1';
const chainId = '1'.repeat(64), blockId = '2'.repeat(64), marker = randomUUID();
const temporaryBase = realpathSync(tmpdir()), directory = realpathSync(mkdtempSync(join(temporaryBase, 'hyperion-state-authorization-')));
writeFileSync(join(directory, '.owner'), marker, {flag: 'wx'});
const previousDirectory = process.cwd(), previousEnvironment = {CONFIG_JSON: process.env.CONFIG_JSON,
    worker_role: process.env.worker_role, live_mode: process.env.live_mode};
let nativeAddonResolutions = 0, networkAttempts = 0;
const hooks = registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) {nativeAddonResolutions++; throw new Error('Selected Wire producer imported the Antelope native codec');}
    return next(specifier, context);
}});
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function () {networkAttempts++; throw new Error('Network disabled in production-method regression');};
const checks = [];
try {
    const config = {settings: {chain, parser: '3.2', eosio_alias: 'sysio',
        protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId}}, indexer: {},
        features: {}, scaling: {dyn_idx_queues: 2}, api: {}, whitelists: {actions: [], deltas: []}};
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: chainId}}}));
    process.env.CONFIG_JSON = join(directory, 'chain.json'); process.env.worker_role = 'reader'; process.env.live_mode = 'true'; process.chdir(directory);
    const [{default: Main}, {loadChainProtocol}] = await Promise.all([
        import('../../build/indexer/workers/deserializer.js'), import('../../build/indexer/protocol/selection.js'),
    ]);
    const selected = await loadChainProtocol(config.settings.protocol); assert.equal(selected.provider.profileId, profileId);
    const fixture = (contractState, allowed = []) => {
        const sent = [], worker = Object.create(Main.prototype);
        Object.assign(worker, {chain, conf: {...config, features: {contract_state: contractState}}, dyn_emit_idx: 1,
            allowedDynamicContracts: new Set(allowed), preIndexingQueue: {async push(payload) {
                sent.push({queue: payload.queue, content: Buffer.from(payload.content), headers: structuredClone(payload.headers)});
            }}});
        return {worker, sent};
    };
    const row = {code: 'contracta', table: 'records', scope: 'alice', primary_key: '18446744073709551615', payer: 'alice',
        block_num: 50, block_id: blockId, '@timestamp': '2026-10-20T12:00:00.000', present: 1,
        data: {id: '18446744073709551615', amount: '9007199254740993'}};
    const contracts = {contracta: {records: {auto_index: false, indices: {id: 1}}}};
    const denied = [
        ['absent-feature', undefined, []], ['absent-feature-plugin', undefined, ['contracta']],
        ['falsey-feature-plugin', false, ['contracta']], ['disabled-operator', {enabled: false, contracts}, []],
        ['omitted-enabled-operator', {contracts}, []], ['unselected-contract', {enabled: true, contracts: {other: {records: {}}}}, []],
        ['unselected-table', {enabled: true, contracts: {contracta: {other: {}}}}, []],
        ['false-table', {enabled: true, contracts: {contracta: {records: false}}}, []],
        ['wrong-plugin-account', {enabled: false, contracts}, ['other']],
    ];
    for (const [name, state, allowed] of denied) {
        const {worker, sent} = fixture(state, allowed);
        // A denied record must return before it reads/serializes the payload or rotates queues.
        const input = {...row, get data() {assert.fail(name + ' accessed denied data');}};
        worker.pushToDynamicTableQueue(input); await new Promise(resolve => setImmediate(resolve));
        assert.equal(sent.length, 0, name + ' published'); assert.equal(worker.dyn_emit_idx, 1, name + ' advanced queue');
    }
    checks.push('denied-opt-in-selection-and-zero-effects');
    for (const [name, state, allowed] of [
        ['enabled-operator', {enabled: true, contracts}, []],
        ['disabled-plugin', {enabled: false, contracts: {}}, ['contracta']],
        ['omitted-enabled-plugin', {contracts: {}}, ['contracta']],
        ['plugin-without-operator-contracts', {enabled: false}, ['contracta']],
    ]) {
        const {worker, sent} = fixture(state, allowed); worker.pushToDynamicTableQueue(structuredClone(row));
        await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 1, name + ' did not publish'); assert.equal(worker.dyn_emit_idx, 2);
    }
    checks.push('explicit-plugin-dependency-authorization');
    const {worker, sent} = fixture({enabled: true, contracts});
    const protocol = {id: '@eosrio/hyperion-wire-plugin', profileId, logicalIdentity: `wire-kv-v1:row:${chainId}:9:300:ff`,
        record: {kind: 'contract_row_kv', present: false, code: '9', payer: '10', tableId: 300, keyHex: 'ff', valueHex: ''},
        source: {chainId, blockNum: 51, blockId, ordinal: 3, abiDeployment: blockId + ':contracta:abi'},
        rawHex: '00ff', metadata: {recordKind: 'row', present: false}};
    const deletion = {...structuredClone(row), block_num: 51, present: 0, protocol, data: {}};
    worker.pushToDynamicTableQueue(structuredClone(row)); worker.pushToDynamicTableQueue(deletion);
    worker.pushToDynamicTableQueue({...structuredClone(row), table: 'unselected'});
    assert.equal(worker.dyn_emit_idx, 1, 'denied work disturbed wraparound queue');
    worker.pushToDynamicTableQueue({...structuredClone(row), block_num: 52});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent.map(message => message.queue), [chain + ':index_dynamic:1', chain + ':index_dynamic:2', chain + ':index_dynamic:1']);
    assert.equal(worker.dyn_emit_idx, 2); checks.push('authorized-queue-rotation');
    for (const [index, input] of [row, deletion, {...row, block_num: 52}].entries()) {
        const expected = {'@timestamp': input['@timestamp'], scope: input.scope,
            primary_key: input.primary_key, payer: input.payer, block_num: input.block_num, block_id: input.block_id, data: input.data,
            ...(input.protocol ? {protocol: input.protocol} : {})};
        assert.deepEqual(JSON.parse(sent[index].content), expected);
        assert.ok(sent[index].content.equals(Buffer.from(JSON.stringify(expected))), 'authorized publication bytes changed');
        assert.deepEqual(sent[index].headers, {code: input.code, table: input.table, block_num: input.block_num, present: input.present});
    }
    checks.push('legacy-and-protocol-metadata-byte-contract');
    assert.equal(nativeAddonResolutions, 0); assert.equal(networkAttempts, 0);
} finally {
    Socket.prototype.connect = originalConnect; hooks.deregister(); process.chdir(previousDirectory);
    for (const [key, value] of Object.entries(previousEnvironment)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
    assert.equal(dirname(directory), temporaryBase); assert.ok(basename(directory).startsWith('hyperion-state-authorization-'));
    assert.equal(realpathSync(directory), directory); assert.ok(!lstatSync(directory).isSymbolicLink());
    assert.equal(readFileSync(join(directory, '.owner'), 'utf8'), marker); rmSync(directory, {recursive: true});
}
console.log(JSON.stringify({passed: true, fixture: 'emitted-contract-state-authorization-controlled-publication', profileId,
    checks, nativeAddonResolutions, networkAttempts, nativeDatabase: false, liveTransportQualification: false}));
