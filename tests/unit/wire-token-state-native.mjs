import test from '../native/retained-workload-test.mjs';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepared} from './portable-state-source-fixture.mjs';
import {statefulHostFixture} from './stateful-host-fixture.mjs';
import {admitCoordinatedNativeSourceOptions, retainedWireSourceProfile} from './stateful-engineering-source-admission.mjs';
// A test copy of the Wire state plugin's emitted build: state/ in the Wire plugin repository, commit 7796e84.
import WireStatePlugin, {PROJECTION_ID} from '../fixtures/wire-token-state/plugin/build/index.js';

// Same retained Wire source and coordinated native graph as wire-managed-state-v2-native.mjs.
admitCoordinatedNativeSourceOptions({engineeringSourceProfile: retainedWireSourceProfile()});

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = join(root, 'tests/fixtures/portable-state-worker');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = path => import(new URL('../../build/' + path, import.meta.url));
const {installProtocolStateRoutes} = await load('api/helpers/protocol-state-readiness.js');
const routes = await Promise.all(['get_tokens', 'get_top_holders'].map(async route => (await load(`api/routes/v2-state/${route}/index.js`)).default));
/** Latest balance and stat rows at or below block 1480 in the testnet delta index. */
const oracle = JSON.parse(readFileSync(join(root, 'tests/fixtures/wire-token-state/oracle-1480.json'), 'utf8'));
const rankedSymbols = oracle.stats.map(({contract, symbol}) => ({contract, symbol}));
const config = () => ({enabled: true, tokens: {rankedSymbols}});
const units = text => BigInt(text.split(' ')[0].replace('.', ''));

test('retained Wire 1..1480 builds exact token state that core get_tokens and get_top_holders serve', {timeout: 240000}, async () => {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json')));
    assert.equal(manifest.archive.sha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const archive = readFileSync(join(sourceRoot, manifest.archive.file));
    assert.equal(archive.length, manifest.archive.bytes); assert.equal(sha(archive), manifest.archive.sha256);
    mkdirSync(join(root, 'out'), {recursive: true});
    const parent = realpathSync(join(root, 'out')), owned = mkdtempSync(join(parent, 'wire-token-state-'));
    let host;
    try {
        const destination = join(owned, 'verified');
        const preparation = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
            [join(sourceRoot, 'prepare.py'), destination], {encoding: 'utf8', timeout: 30000, windowsHide: true}));
        assert.equal(preparation.archiveSha256, manifest.archive.sha256);
        const members = new Map(manifest.members.map(row => [row.path, row]));
        const read = path => {
            const expected = members.get('source/' + path); assert(expected);
            const bytes = readFileSync(join(destination, 'source', path));
            assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256); return bytes;
        };
        const frames = Array.from({length: 1480}, (_, n) => read('block-' + String(n + 1).padStart(6, '0') + '.bin'));
        const receipt = JSON.parse(read('receipt.json'));
        // The last token contract (sysio.liq) is deployed at 254, so selectors resolve from block 255. That keeps
        // the reader/owner distance inside the existing 256-block window, as in the managed-state test.
        const p = await prepared({}, 255, undefined, {frames, schemaJson: read('schema.json').toString(),
            capture: {chainId: receipt.chainId, profileId: 'wire-sysio-6508c9e8-native-engineering-v1'}});
        host = await statefulHostFixture({preparedSource: p, timeoutMs: 5000, through: 255, completeKind: true,
            pluginDirectory: join(root, 'tests/fixtures/wire-token-state/plugin'), pluginConfiguration: config(), projectionId: PROJECTION_ID});
        assert.equal(host.ownerErrors.length, 0, host.ownerErrors.map(error => error.stack).join('\n'));
        for (let through = 255; through < 1480;) {
            const next = Math.min(1480, through + 8);
            await p.advance(next);
            for (let i = through; i < next && host.ownerErrors.length === 0; i++) await host.controller.drain();
            // Every reduced block passed the supply check: a mismatch fails the block and stops here.
            assert.equal(host.ownerErrors.length, 0, host.ownerErrors.map(error => error.stack).join('\n'));
            through = next;
        }
        const recovery = await host.native.adapter.recovery();
        assert.equal(recovery.view.checkpoint.blockNum, 1480);
        assert.equal(recovery.raw, null); assert.equal(recovery.pending, null); assert.equal(recovery.gap, null);

        const calls = [];
        host.app.decorate('manager', {chain: 'wire-token-state', conn: {mongodb: {enabled: true, database_prefix: 'hyperion'}},
            config: {settings: {protocol: {provider: 'extension', package: '@eosrio/hyperion-wire-plugin'}}, api: {enable_caching: true, limits: {}}}});
        host.app.decorate('redis', {get: async key => {calls.push(key); return null;}, set: async () => {calls.push('cache-write'); return 'OK';}});
        const legacy = async () => {calls.push('legacy-storage'); throw new Error('A plugin-backed route reached legacy storage');};
        host.app.decorate('mongo', {client: {db: legacy}});
        host.app.decorate('elastic', {search: legacy});
        const installed = await installProtocolStateRoutes(host.app, [new WireStatePlugin(config())], host.context, {maximumServingLagBlocks: 8}, () => {});
        assert.deepEqual([...installed.routes.keys()].sort(), ['get_tokens', 'get_top_holders']);
        for (const route of routes) await host.app.register(route, {prefix: '/v2/state'});

        const owners = [...new Set(oracle.balances.map(row => row.owner))].sort();
        assert.equal(oracle.balances.length, 63);
        for (const owner of owners) {
            const response = await host.app.inject(`/v2/state/get_tokens?account=${owner}`);
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.headers['hyperion-state-block-num'], '1480');
            assert.equal(response.headers['hyperion-state-block-id'], p.positions.at(-1).blockId);
            const tokens = response.json().tokens.map(({contract, symbol, balance, amount, precision}) => ({contract, symbol, balance, amount, precision}));
            const expected = oracle.balances.filter(row => row.owner === owner).map(row => ({contract: row.contract, symbol: row.balance.split(' ')[1],
                balance: row.balance, amount: Number(row.balance.split(' ')[0]), precision: row.balance.split(' ')[0].split('.')[1]?.length ?? 0}));
            const order = (a, b) => JSON.stringify([a.contract, a.symbol]) < JSON.stringify([b.contract, b.symbol]) ? -1 : 1;
            assert.deepEqual(tokens.sort(order), expected.sort(order), owner);
        }
        for (const {contract, symbol, supply} of oracle.stats) {
            const response = await host.app.inject(`/v2/state/get_top_holders?contract=${contract}&symbol=${symbol}&limit=500`);
            assert.equal(response.statusCode, 200, response.body);
            const holders = response.json().holders;
            const expected = oracle.balances.filter(row => row.contract === contract && row.balance.endsWith(' ' + symbol))
                .sort((a, b) => units(a.balance) === units(b.balance) ? (a.owner < b.owner ? -1 : 1) : units(a.balance) > units(b.balance) ? -1 : 1);
            assert.deepEqual(holders.map(holder => [holder.owner, holder.balance]), expected.map(row => [row.owner, row.balance]), symbol);
            assert.equal(holders.reduce((total, holder) => total + units(holder.balance), 0n), units(supply), `${symbol} holders add up to its supply`);
        }
        const unranked = await host.app.inject('/v2/state/get_top_holders?contract=sysio.token&symbol=NONE');
        assert.equal(unranked.statusCode, 400, unranked.body);
        assert.equal(unranked.json().code, 'invalid_state_request');
        assert.equal((await host.app.inject('/v2/state/get_top_holders?contract=sysio.token')).statusCode, 400);
        assert.deepEqual(calls.filter(call => !String(call).endsWith(':last_idx_block')), [], 'A backed route touched the response cache or legacy storage');

        host.disconnect();
        const unavailable = await host.app.inject('/v2/state/get_tokens?account=eosrio');
        assert.equal(unavailable.statusCode, 503);
        assert.equal(unavailable.headers['hyperion-state-block-num'], undefined);
    } finally {
        await host?.close();
        assert.equal(dirname(owned), parent); assert.ok(basename(owned).startsWith('wire-token-state-'));
        rmSync(owned, {recursive: true, force: true});
    }
});
