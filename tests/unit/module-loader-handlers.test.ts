import {describe, expect, it} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HyperionModuleLoader} from '../../src/indexer/modules/loader.js';

function loader() {
    return new HyperionModuleLoader({config: {settings: {chain: 'handler-test', parser: '3.2'}, features: {}, plugins: {}},
        connections: {chains: {'handler-test': {chain_id: '1'.repeat(64)}}}} as any);
}

function gate() {
    let release!: () => void;
    return {promise: new Promise<void>(resolve => {release = resolve;}), release: () => release()};
}

describe('action handler settlement', () => {
    it('snapshots only selected handlers in stable order with detached rows', async () => {
        const modules = loader();
        const first = value => {value.selected = 'first';};
        const selected = value => {value.selected = 'replacement';};
        modules.includeActionModule({contract: 'zeta', action: 'send', handler: first});
        modules.includeActionModule({contract: 'alpha', action: 'zeta', handler: first});
        modules.includeActionModule({contract: 'alpha', action: 'alpha', handler: first});
        modules.includeActionModule({contract: 'zeta', action: 'send', handler: selected});
        const snapshot = modules.snapshotActionHandlers();
        expect(snapshot).toEqual([
            {contract: 'alpha', action: 'alpha', handlerSource: Function.prototype.toString.call(first)},
            {contract: 'alpha', action: 'zeta', handlerSource: Function.prototype.toString.call(first)},
            {contract: 'zeta', action: 'send', handlerSource: Function.prototype.toString.call(selected)}
        ]);
        snapshot[0].contract = 'changed'; snapshot.pop();
        expect(modules.snapshotActionHandlers().map(row => [row.contract, row.action]))
            .toEqual([['alpha', 'alpha'], ['alpha', 'zeta'], ['zeta', 'send']]);
        const action: any = {act: {account: 'zeta', name: 'send'}};
        await modules.processActionData(action); expect(action.selected).toBe('replacement');
    });

    it('awaits wildcard completion before starting the contract hook and settling the action', async () => {
        const modules = loader(), wildcard = gate(), specific = gate(), enteredSpecific = gate(), events: string[] = [];
        const action: any = {act: {account: 'alpha', name: 'send'}};
        modules.includeActionModule({contract: '*', action: 'send', handler: async value => {
            events.push('wildcard-start'); await wildcard.promise; value.wildcard = true; events.push('wildcard-done');
        }});
        modules.includeActionModule({contract: 'alpha', action: 'send', handler: async value => {
            expect(value.wildcard).toBe(true); events.push('contract-start'); enteredSpecific.release();
            await specific.promise; value.specific = true; events.push('contract-done');
        }});
        let settled = false;
        const processing = modules.processActionData(action).then(() => {settled = true;});
        expect(events).toEqual(['wildcard-start']); expect(settled).toBe(false);
        wildcard.release(); await enteredSpecific.promise;
        expect(events).toEqual(['wildcard-start', 'wildcard-done', 'contract-start']); expect(settled).toBe(false);
        specific.release(); await processing;
        expect(events).toEqual(['wildcard-start', 'wildcard-done', 'contract-start', 'contract-done']);
        expect(action.specific).toBe(true); expect(settled).toBe(true);
    });

    it('propagates rejected hooks without calling later hooks or blocking unrelated contracts', async () => {
        const modules = loader(), rejected = new Error('wildcard failed'); let specific = 0;
        modules.includeActionModule({contract: '*', action: 'broken', handler: async () => {
            await Promise.resolve(); throw rejected;
        }});
        modules.includeActionModule({contract: 'alpha', action: 'broken', handler: () => {specific++;}});
        await expect(modules.processActionData({act: {account: 'alpha', name: 'broken'}} as any)).rejects.toBe(rejected);
        expect(specific).toBe(0);
        modules.includeActionModule({contract: 'beta', action: 'healthy', handler: value => {value.healthy = true;}});
        const healthy: any = {act: {account: 'beta', name: 'healthy'}};
        await modules.processActionData(healthy); expect(healthy.healthy).toBe(true);
        await expect(modules.processActionData({act: {account: 'unknown', name: 'unhandled'}} as any)).resolves.toBeUndefined();
    });

    it('carries the actual DS extras promise through parser completion and existing hook-error handling', async () => {
        const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./action-handler-worker-fixture.ts', import.meta.url))],
            {stdout: 'pipe', stderr: 'pipe', timeout: 10000});
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({code, stdout, stderr}).toEqual({code: 0, stderr: '', stdout: JSON.stringify({passed: true,
            parserWaits: true, extrasRejects: true, parserHandlesRejection: true, unrelatedContract: true}) + '\n'});
    });
});

describe('emitted loader activation readiness', () => {
    it('settles built-ins deterministically before plugins while isolating one failed module', () => {
        const productionLoader = new URL('../../build/indexer/modules/loader.js', import.meta.url).href;
        const script = `
            import assert from 'node:assert/strict';
            import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
            import {tmpdir} from 'node:os';
            import {basename, dirname, join, resolve} from 'node:path';
            import {pathToFileURL} from 'node:url';
            const parent = resolve(tmpdir()), prefix = 'hyperion-handler-ready-';
            const directory = mkdtempSync(join(parent, prefix));
            const failures = [], originalLog = console.log;
            console.log = (...values) => failures.push(values.join(' '));
            try {
                const modules = join(directory, 'build', 'indexer', 'modules'), chainId = '1'.repeat(64);
                mkdirSync(join(modules, 'action_data'), {recursive: true}); mkdirSync(join(modules, 'parsers'));
                mkdirSync(join(directory, 'build', 'indexer', 'helpers'));
                writeFileSync(join(directory, 'package.json'), JSON.stringify({type: 'module'}));
                writeFileSync(join(modules, 'loader.js'), readFileSync(new URL(${JSON.stringify(productionLoader)})));
                for (const member of ['projection/stateful-inventory.js', 'protocol/immutable-bundle-store.js',
                    'protocol/bounded-document-read.js', 'protocol/proof-consumer-scope.js', 'helpers/bounded-json.js']) {
                    const target = join(directory, 'build', 'indexer', member);
                    mkdirSync(dirname(target), {recursive: true});
                    writeFileSync(target, readFileSync(new URL('../' + member, ${JSON.stringify(productionLoader)})));
                }
                writeFileSync(join(directory, 'build', 'indexer', 'helpers', 'common_functions.js'), 'export function hLog() {}');
                writeFileSync(join(modules, 'parsers', 'fixture-parser.js'), 'export default class {}');
                let release, entered;
                globalThis.activation = {events: [], finished: false,
                    gate: new Promise(resolve => {release = resolve;}), entered: () => entered()};
                const importing = new Promise(resolve => {entered = resolve;});
                const moduleSource = (chain, action, marker) => 'export const hyperionModule = ' +
                    JSON.stringify({chain, contract: 'alpha', action, parser_version: ['fixture']}) +
                    '; hyperionModule.handler = value => {value.marker = ' + JSON.stringify(marker) + ';};';
                writeFileSync(join(modules, 'action_data', '00-delayed-generic.js'),
                    'globalThis.activation.events.push("generic-import"); globalThis.activation.entered();' +
                    'await globalThis.activation.gate; globalThis.activation.events.push("generic-ready");' +
                    moduleSource('*', 'send', 'generic'));
                writeFileSync(join(modules, 'action_data', '10-failed.js'), 'throw new Error("isolated action module");');
                writeFileSync(join(modules, 'action_data', '20-specific.js'),
                    'globalThis.activation.events.push("specific");' + moduleSource(chainId, 'send', 'specific'));
                writeFileSync(join(modules, 'action_data', '30-later-generic.js'), moduleSource('*', 'send', 'late-generic'));
                writeFileSync(join(modules, 'action_data', '40-first-specific.js'), moduleSource(chainId, 'reverse', 'specific-first'));
                writeFileSync(join(modules, 'action_data', '50-later-generic.js'), moduleSource('*', 'reverse', 'late-generic'));
                writeFileSync(join(modules, 'action_data', '60-other-chain.js'), moduleSource('2'.repeat(64), 'foreign', 'foreign'));
                writeFileSync(join(modules, 'action_data', '65-plugin-base.js'), moduleSource('*', 'override', 'builtin'));
                writeFileSync(join(modules, 'action_data', '70-last.js'),
                    'globalThis.activation.events.push("last"); globalThis.activation.finished = true;' + moduleSource('*', 'last', 'last'));
                const pluginDirectory = join(directory, 'plugins');
                mkdirSync(join(pluginDirectory, 'ordered', 'build'), {recursive: true});
                writeFileSync(join(pluginDirectory, '.state.json'), JSON.stringify({plugins: {ordered: {enabled: true}}}));
                writeFileSync(join(pluginDirectory, 'ordered', 'build', 'index.js'),
                    'export default class {constructor() {' +
                    'if (!globalThis.activation.finished) throw new Error("plugin before built-ins");' +
                    'globalThis.activation.events.push("plugin"); this.actionHandlers = [{contract:"alpha", action:"override", handler(value) {value.marker="plugin";}}];}}');
                const {HyperionModuleLoader} = await import(pathToFileURL(join(modules, 'loader.js')).href);
                const loader = new HyperionModuleLoader({config: {settings: {chain: 'handler-ready', parser: 'fixture'},
                    features: {}, plugins: {ordered: {enabled: true}}}, connections: {chains: {'handler-ready': {chain_id: chainId}}}});
                let settled = false;
                const initialized = loader.init().then(() => {settled = true;});
                await importing;
                assert.equal(settled, false); assert.equal(loader.plugins.length, 0);
                release(); await initialized;
                assert.deepEqual(globalThis.activation.events, ['generic-import', 'generic-ready', 'specific', 'last', 'plugin']);
                assert.equal(loader.plugins.length, 1);
                for (const [name, marker] of [['send', 'specific'], ['reverse', 'specific-first'], ['last', 'last'], ['override', 'plugin']]) {
                    const value = {act: {account: 'alpha', name}}; await loader.processActionData(value); assert.equal(value.marker, marker);
                }
                const foreign = {act: {account: 'alpha', name: 'foreign'}}; await loader.processActionData(foreign);
                assert.equal(foreign.marker, undefined);
                assert.equal(failures.length, 1); assert.match(failures[0], /Error loading action module:.*isolated action module/);
                console.log = originalLog; console.log('handler-activation-passed');
            } finally {
                console.log = originalLog;
                const target = resolve(directory); assert.equal(dirname(target), parent); assert(basename(target).startsWith(prefix));
                rmSync(target, {recursive: true, force: true});
            }
        `;
        const child = spawnSync(process.env.HYPERION_NATIVE_NODE ?? 'node', ['--input-type=module', '--eval', script],
            {encoding: 'utf8', timeout: 10000, windowsHide: true});
        expect({status: child.status, error: child.error?.message, stdout: child.stdout, stderr: child.stderr})
            .toEqual({status: 0, error: undefined, stdout: 'handler-activation-passed\n', stderr: ''});
    });
});
