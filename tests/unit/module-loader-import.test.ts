import {describe, expect, it} from 'bun:test';
import {spawnSync} from 'node:child_process';

// Bun accepts native Windows paths that Node's ESM loader rejects.
// Exercise the emitted production loader in a Node child to catch that failure.
function probe(body: string) {
    const loader = new URL('../../build/indexer/modules/loader.js', import.meta.url).href;
    const script = `
        import assert from 'node:assert/strict';
        import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
        import {tmpdir} from 'node:os';
        import {join} from 'node:path';
        import {pathToFileURL} from 'node:url';
        const directory = mkdtempSync(join(tmpdir(), 'hyperion-loader # % '));
        try {
            const config = {settings: {chain: 'loader-test', parser: '3.2'}, indexer: {},
                features: {index_transfer_memo: true}, plugins: {}};
            process.env.CONFIG_JSON = join(directory, 'chain.json');
            writeFileSync(process.env.CONFIG_JSON, JSON.stringify(config));
            const cm = {config, connections: {chains: {'loader-test': {chain_id: '0'.repeat(64)}}},
                filters: {action_blacklist: new Set(), action_whitelist: new Set(),
                    delta_blacklist: new Set(), delta_whitelist: new Set()}};
            const until = async predicate => {
                const deadline = Date.now() + 2000;
                while (!predicate()) {
                    assert(Date.now() < deadline, 'action modules did not load');
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
            };
            const productionLoader = ${JSON.stringify(loader)};
            ${body}
            console.log('module-loader-probe-passed');
        } finally { rmSync(directory, {recursive: true, force: true}); }
    `;
    const child = spawnSync('node', ['--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 10000
    });
    expect({status: child.status, error: child.error?.message, stdout: child.stdout, stderr: child.stderr})
        .toEqual({status: 0, error: undefined, stdout: 'module-loader-probe-passed\n', stderr: ''});
}

describe('Module loader Node filesystem imports', () => {
    it('loads the production parser and executes a production action handler under Node', () => {
        probe(`
            const {HyperionModuleLoader} = await import(productionLoader);
            const loader = new HyperionModuleLoader(cm);
            await loader.loadParser();
            assert.equal(typeof loader.parser.parseAction, 'function');
            await until(() => loader.chainMappings.has('*::transfer'));
            const action = {act: {account: 'eosio.token', name: 'transfer',
                data: {from: 'alice', to: 'bob', quantity: '1.2500 SYS', memo: 'fixture'}}};
            loader.processActionData(action);
            assert.deepEqual(action['@transfer'], {
                from: 'alice', to: 'bob', amount: 1.25, symbol: 'SYS', memo: 'fixture'
            });
            assert.equal(action.act.data.from, undefined);
        `);
    });

    it('loads parser, action and enabled plugin files from paths containing spaces, # and %', () => {
        probe(`
            const modules = join(directory, 'build', 'indexer', 'modules');
            mkdirSync(join(modules, 'parsers'), {recursive: true});
            mkdirSync(join(modules, 'action_data'));
            mkdirSync(join(directory, 'build', 'indexer', 'helpers'));
            writeFileSync(join(directory, 'package.json'), JSON.stringify({type: 'module'}));
            writeFileSync(join(directory, 'build', 'indexer', 'helpers', 'common_functions.js'),
                'export function hLog(...args) { console.log(...args); }');
            // Preserve the emitted production implementation byte for byte.
            writeFileSync(join(modules, 'loader.js'), readFileSync(new URL(productionLoader)));
            cm.config.settings.parser = 'fixture # %';
            cm.config.plugins = {'plugin # %': {enabled: true}};
            writeFileSync(join(modules, 'parsers', 'fixture # %-parser.js'),
                'export default class { constructor(cm) { this.marker = cm.config.settings.parser; } }');
            writeFileSync(join(modules, 'action_data', 'action # %.js'),
                'export const hyperionModule = ' + JSON.stringify({chain: '*', contract: 'fixture',
                    action: 'direct', parser_version: ['fixture # %']}) +
                '; hyperionModule.handler = action => { action.direct = true; };');
            const plugins = join(directory, 'plugins');
            mkdirSync(join(plugins, 'plugin # %', 'build'), {recursive: true});
            writeFileSync(join(plugins, '.state.json'), JSON.stringify({plugins: {'plugin # %': {enabled: true}}}));
            writeFileSync(join(plugins, 'plugin # %', 'build', 'index.js'),
                'export default class { constructor() { this.actionHandlers = [{contract: ' +
                JSON.stringify('fixture') + ', action: ' + JSON.stringify('plugin') +
                ', handler(action) { action.plugin = true; }}]; } }');
            const {HyperionModuleLoader} = await import(pathToFileURL(join(modules, 'loader.js')).href);
            const loader = new HyperionModuleLoader(cm);
            await loader.init();
            assert.equal(loader.parser.marker, 'fixture # %');
            await until(() => loader.chainMappings.has('fixture::direct'));
            const direct = {act: {account: 'fixture', name: 'direct'}};
            loader.processActionData(direct);
            assert.equal(direct.direct, true);
            assert.equal(loader.plugins.length, 1);
            const plugin = {act: {account: 'fixture', name: 'plugin'}};
            loader.processActionData(plugin);
            assert.equal(plugin.plugin, true);
        `);
    });
});
