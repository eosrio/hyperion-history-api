import {expect, it} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

// The master imports uWebSockets; exercise actual emitted Node artifacts rather
// than loading its native module through Bun. The CI matrix supplies Node24/26.
it('requires action template acknowledgment and the actual named mapping readback while preserving unrelated templates', async () => {
    const master = new URL('../../build/indexer/modules/master.js', import.meta.url).href;
    const storage = new URL('../../build/indexer/history/action-sequence-storage.js', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        const {HyperionMaster} = await import(${JSON.stringify(master)});
        const {actionSequenceMapping, ACTION_SEQUENCE_NAMESPACE: namespace} = await import(${JSON.stringify(storage)});
        const action = {index_patterns: ['fixture-action-*'], settings: {index: {sort: {field: 'global_sequence', order: 'desc'}}},
            mappings: {properties: {global_sequence: {type: 'long'}, [namespace]: actionSequenceMapping()}}};
        async function exercise({acknowledged = true, readback = 'correct', type = 'action'} = {}) {
            const calls = [], exits = [];
            const value = Object.assign(Object.create(HyperionMaster.prototype), {
                conf: {settings: {chain: 'fixture', use_read_aliases: true}}, esClient: {indices: {
                    putIndexTemplate: async request => {calls.push(['put', request]); return {acknowledged};},
                    getIndexTemplate: async request => {calls.push(['get', request]); return {index_templates: [{
                        name: readback === 'wrong-name' ? 'another-action' : 'fixture-action',
                        index_template: {index_patterns: action.index_patterns, template: {
                            mappings: readback === 'missing-schema' ? {properties: {}} : action.mappings
                        }}
                    }]};},
                    deleteTemplate: async request => {calls.push(['delete', request]); return {acknowledged: true};}
                }}
            });
            const originalExit = process.exit;
            process.exit = code => {exits.push(code); throw new Error('test intercepted fatal exit');};
            try {await value.updateIndexTemplates([{name: type, type}], {[type]: action});}
            catch (error) {assert.equal(error.message, 'test intercepted fatal exit');}
            finally {process.exit = originalExit;}
            return {calls, exits};
        }
        const success = await exercise();
        assert.deepEqual(success.exits, []);
        assert.deepEqual(success.calls.map(([kind]) => kind), ['put', 'get', 'delete']);
        assert.equal(success.calls[0][1].template.settings.index.sort.field, 'global_sequence');
        assert.deepEqual(success.calls[0][1].template.aliases, {'fixture-action-read': {}});
        for (const options of [{acknowledged: false}, {readback: 'wrong-name'}, {readback: 'missing-schema'}]) {
            const failure = await exercise(options);
            assert.deepEqual(failure.exits, [1]);
            assert.equal(failure.calls.some(([kind]) => kind === 'delete'), false);
        }
        const unrelated = await exercise({acknowledged: false, type: 'block'});
        assert.deepEqual(unrelated.exits, []);
        assert.deepEqual(unrelated.calls.map(([kind]) => kind), ['put']);
        console.log('action-sequence-master-passed');
    `;
    const node = process.env.HYPERION_NATIVE_NODE ?? process.env.READER_RECOVERY_NODE ?? Bun.which('node');
    if (!node) throw new Error('Node.js24/26 is required for the native action template test');
    const fixtureRoot = resolve(tmpdir()), prefix = 'hyperion-sequence-master-';
    const directory = mkdtempSync(join(fixtureRoot, prefix));
    try {
        const chain = 'fixture';
        mkdirSync(join(directory, 'config'));
        writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain, debug: false,
            eosio_alias: 'eosio', parser: '3.2'}, indexer: {}, features: {}, scaling: {}, api: {},
            whitelists: {actions: [], deltas: []}}));
        writeFileSync(join(directory, 'config/connections.json'), JSON.stringify({
            amqp: {protocol: 'http'}, elasticsearch: {host: '127.0.0.1:1', user: '', pass: ''},
            chains: {[chain]: {chain_id: '1'.repeat(64), http: 'http://127.0.0.1:1', ship: 'ws://127.0.0.1:1'}},
            redis: {host: '127.0.0.1', port: 1}
        }));
        const child = Bun.spawn([resolve(node), '--input-type=module', '--eval', script], {
            cwd: directory, env: {...process.env, CONFIG_JSON: join(directory, 'chain.json'), CHAIN_NAME: chain, TRACE_LOGS: 'false'},
            stdout: 'pipe', stderr: 'pipe'
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stderr}).toEqual({code: 0, stderr: ''});
        expect(stdout).toContain('action-sequence-master-passed');
    } finally {
        const target = resolve(directory);
        if (dirname(target) !== fixtureRoot || !basename(target).startsWith(prefix)) throw new Error('Unowned master fixture cleanup target');
        rmSync(target, {recursive: true, force: true});
    }
}, 15000);
