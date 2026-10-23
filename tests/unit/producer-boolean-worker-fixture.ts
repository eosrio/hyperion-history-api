import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

const captured = JSON.parse(readFileSync(new URL('./fixtures/wire-producer-boolean.json', import.meta.url), 'utf8'));
assert.equal(captured.kind, 'captured-decoded-producer-row');
assert.deepEqual(captured.source.abiField, {name: 'is_active', type: 'bool'});
assert.equal(captured.data.is_active, 1);
const previous = process.cwd(), parent = resolve(tmpdir()), prefix = 'hyperion-producer-boolean-';
const directory = mkdtempSync(join(parent, prefix)), previousConfig = process.env.CONFIG_JSON;
try {
    const chain = 'producer-boolean-fixture', config = {
        settings: {chain, system_contract: 'sysio', eosio_alias: 'sysio', parser: '3.2', debug: false},
        indexer: {disable_indexing: true}, features: {tables: {voters: false}}, scaling: {}, api: {},
        whitelists: {actions: [], deltas: []}, plugins: {},
    };
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({chains: {[chain]: {chain_id: captured.chainId}}}));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    const {default: Deserializer} = await import('../../src/indexer/workers/deserializer.js');
    const worker: any = Object.create(Deserializer.prototype);
    worker.conf = config; worker.tableHandlers = {};
    await worker.populateTableHandlers();
    const apply = async (value: unknown) => {
        const delta: any = {code: 'sysio', table: 'producers', block_num: captured.source.blockNum,
            block_id: captured.source.blockId, primary_key: 'captured-producer', present: 1,
            data: {total_votes: '12.5', unpaid_blocks: 7, is_active: value}};
        assert.equal(await worker.processTableDelta(delta, true), true);
        assert.equal(Object.hasOwn(delta, 'data'), false);
        assert.equal(delta['@producers'].total_votes, 12.5);
        assert.equal(delta['@producers'].unpaid_blocks, 7);
        return delta['@producers'].is_active;
    };
    for (const [input, expected] of [[0, false], [1, true], [false, false], [true, true]] as const)
        assert.strictEqual(await apply(input), expected);
    // Invalid representations retain their identity; the handler must never use Boolean(value), == or parseInt.
    const malformed: unknown[] = [2, -1, 0.5, NaN, Infinity, '0', '1', 'false', 'true', '', null, undefined, [], {}, new Number(1)];
    for (const value of malformed) assert.strictEqual(await apply(value), value);
    const actual: any = {code: 'sysio', table: 'producers', block_num: captured.source.blockNum,
        block_id: captured.source.blockId, primary_key: captured.data.owner, present: 1, data: structuredClone(captured.data)};
    assert.equal(await worker.processTableDelta(actual, true), true);
    assert.strictEqual(actual['@producers'].is_active, true);
    assert.equal(captured.data.is_active, 1, 'The extracted source fixture must remain unchanged');
    const missing: any = {code: 'sysio', table: 'producers', primary_key: 'none'};
    await worker.tableHandlers['sysio:producers'](missing);
    assert.equal(Object.hasOwn(missing, '@producers'), false);
    console.log(JSON.stringify({passed: true, actualHandler: true, capturedBlock: captured.source.blockNum,
        canonicalCases: 4, malformedCases: malformed.length, sourceUnchanged: true, nativeQualification: false}));
} finally {
    process.chdir(previous);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    const target = resolve(directory); assert.equal(dirname(target), parent); assert(basename(target).startsWith(prefix));
    rmSync(target, {recursive: true, force: true});
}
