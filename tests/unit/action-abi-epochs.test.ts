import {expect, test} from 'bun:test';

// Exercise the compiled production pool with the installed native decoder in Node.
// No worker constructor, network connection or substitute decoder is used.
test('production pool selects historical ABI before native decode across shuffled blocks', async () => {
    const poolUrl = new URL('../../build/indexer/workers/ds-pool.js', import.meta.url).href;
    const nativeUrl = new URL('../../node_modules/@eosrio/node-abieos/dist/abieos.js', import.meta.url).href;
    const antelopeUrl = new URL('../../node_modules/@wharfkit/antelope/lib/antelope.js', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
        import {tmpdir} from 'node:os'; import {join} from 'node:path';
        import {Abieos} from ${JSON.stringify(nativeUrl)};
        import {ABI, Serializer} from ${JSON.stringify(antelopeUrl)};
        const previous = process.cwd(); const directory = mkdtempSync(join(tmpdir(), 'hyperion-abi-epoch-'));
        try {
            mkdirSync(join(directory, 'config'));
            writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'epoch-test'}, indexer: {}}));
            writeFileSync(join(directory, 'config/connections.json'), '{}');
            process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
            const {default: Pool} = await import(${JSON.stringify(poolUrl)});
            const abi = revision => ({version: 'eosio::abi/1.2', types: [], structs: [{name: 'record', base: '', fields: [
                {name: 'sequence', type: 'uint64'}, ...(revision === 2 ? [{name: 'revision', type: 'uint32'}] : []), {name: 'memo', type: 'string'}]}],
                actions: [{name: 'record', type: 'record', ricardian_contract: ''}], tables: [], variants: []});
            const references = [1, 2].map(revision => ({block: revision * 10, actions: ['record'], tables: [], abi: JSON.stringify(abi(revision)),
                abi_hex: Buffer.from(Serializer.encode({object: ABI.from(abi(revision))}).array).toString('hex')}));
            const queries = []; const engine = Abieos.getInstance(); const nativeLoads = [];
            const pool = Object.assign(Object.create(Pool.prototype), {chain: 'epoch-test', conf: {settings: {}},
                profiler: {start: () => () => {}}, abieos: engine, failedAbiMap: new Map(), poolAbiCache: new Map(), poolTypeCache: new Map(),
                loadedActionAbis: new Map(), contracts: new Map(), contractUsage: {}, totalHits: 0,
                client: {search: async query => { const block = query.query.bool.must[1].range.block.lte; queries.push(block);
                    return {hits: {hits: references.filter(ref => ref.block <= block).reverse().map(_source => ({_source}))}}; }},
                loadCurrentAbiHex: async () => {throw new Error('current ABI fallback forbidden');}});
            const originalLoad = pool.loadAbiHex;
            pool.loadAbiHex = function (account, block, hex) { nativeLoads.push(block); return originalLoad.call(this, account, block, hex); };
            const cases = [{block: 11, revision: 1}, {block: 21, revision: 2}, {block: 11, revision: 1}, {block: 21, revision: 2}, {block: 22, revision: 2}];
            for (const [index, entry] of cases.entries()) {
                const expected = {sequence: String(index + 1), ...(entry.revision === 2 ? {revision: 2} : {}), memo: 'epoch-' + index};
                const hex = Buffer.from(Serializer.encode({object: expected, type: 'record', abi: abi(entry.revision)}).array).toString('hex');
                const actual = await pool.deserializeActionAtBlockNative(pool, {account: 'hyp.replay', name: 'record', authorization: [], data: hex}, entry.block);
                assert.deepEqual(actual, expected, 'wrong historical ABI at block ' + entry.block);
            }
            assert.deepEqual(queries, [11, 21, 22], 'same block should retain one memoized ABI lookup');
            assert.deepEqual(nativeLoads, [10, 20, 10, 20], 'reload only when the selected deployment changes');
            // A JSON fallback can also replace the native context behind a cached type.
            assert(await pool.getContractAtBlock('hyp.replay', 11, 'record'));
            const expected = {sequence: '9', revision: 2, memo: 'after-json-fallback'};
            const hex = Buffer.from(Serializer.encode({object: expected, type: 'record', abi: abi(2)}).array).toString('hex');
            const action = {account: 'hyp.replay', name: 'record', authorization: [], data: hex};
            assert.deepEqual(await pool.deserializeActionAtBlockNative(pool, action, 21), expected);
            pool.deleteCache('hyp.replay');
            assert.deepEqual(await pool.deserializeActionAtBlockNative(pool, action, 21), expected);
            assert.deepEqual(nativeLoads, [10, 20, 10, 20, 20, 20], 'fallback and explicit eviction must invalidate active ABI identity');
            pool.loadedActionAbis.clear(); pool.loadAbiHex = () => {throw new Error('invalid contract ABI');};
            assert.deepEqual(await pool.verifyLocalType('hyp.replay', 'record', 21, 'action'), [false, ''], 'a malformed contract ABI must not escape the selection boundary');
            // The historical ABI may contain the same struct name while only
            // a custom/current fallback declares the action. Cached type names
            // must be invalidated when the historical context is reloaded.
            const missingActionAbi = {...abi(1), actions: []};
            const historical = {block: 10, actions: [], tables: [], abi: JSON.stringify(missingActionAbi),
                abi_hex: Buffer.from(Serializer.encode({object: ABI.from(missingActionAbi)}).array).toString('hex')};
            for (const mode of ['custom', 'current']) {
                engine.deleteContract('hyp.replay'); let fallbackCalls = 0;
                const fallback = Object.assign(Object.create(Pool.prototype), {chain: 'epoch-test',
                    conf: {settings: {allow_custom_abi: mode === 'custom'}}, profiler: {start: () => () => {}}, abieos: engine,
                    failedAbiMap: new Map(), poolAbiCache: new Map(), poolTypeCache: new Map(), loadedActionAbis: new Map(),
                    contracts: new Map(), contractUsage: {}, totalHits: 0,
                    customAbiMap: new Map([['hyp.replay', [{startingBlock: 0, endingBlock: 100, abi: JSON.stringify(abi(2))}]]]),
                    client: {search: async () => ({hits: {hits: [{_source: historical}]}})},
                    loadCurrentAbiHex: async () => {assert.equal(mode, 'current'); fallbackCalls++; return engine.loadAbi('hyp.replay', JSON.stringify(abi(2)));}});
                const expectedFallback = {sequence: '1', revision: 2, memo: 'correct-' + mode};
                const data = Buffer.from(Serializer.encode({object: expectedFallback, type: 'record', abi: abi(2)}).array).toString('hex');
                for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await fallback.deserializeActionAtBlockNative(fallback,
                    {account: 'hyp.replay', name: 'record', authorization: [], data}, 21), expectedFallback, mode + ' fallback ABI identity was lost');
                assert.equal(fallbackCalls, mode === 'current' ? 2 : 0);
            }
            console.log('action-abi-epoch-probe-passed');
        } finally { process.chdir(previous); rmSync(directory, {recursive: true, force: true}); }
    `;
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node', '--input-type=module', '--eval', script], {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code, stdout, stderr}).toEqual({code: 0, stdout: 'action-abi-epoch-probe-passed\n', stderr: ''});
}, 15000);
