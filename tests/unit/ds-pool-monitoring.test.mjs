import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Load the emitted pool with inert configuration; no constructor or transports.
const previousDirectory = process.cwd(), previousConfig = process.env.CONFIG_JSON;
const directory = mkdtempSync(join(tmpdir(), 'hyperion-monitor-'));
let Pool;
try {
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'chain.json'), JSON.stringify({settings: {chain: 'controlled'}, indexer: {},
        features: {tables: {}}, scaling: {}, whitelists: {}, blacklists: {}}));
    writeFileSync(join(directory, 'config/connections.json'), '{}');
    process.chdir(directory); process.env.CONFIG_JSON = join(directory, 'chain.json');
    ({default: Pool} = await import('../../build/indexer/workers/ds-pool.js'));
} finally {
    process.chdir(previousDirectory);
    if (previousConfig === undefined) delete process.env.CONFIG_JSON; else process.env.CONFIG_JSON = previousConfig;
    rmSync(directory, {recursive: true, force: true});
}

test('pool monitoring reports native and legacy activity and recognizes idle intervals', () => {
    const originalInterval = globalThis.setInterval, originalSend = process.send;
    const sent = []; let tick;
    globalThis.setInterval = callback => { tick = callback; return 1; };
    process.send = message => { sent.push(structuredClone(message)); return true; };
    try {
        const pool = Object.assign(Object.create(Pool.prototype), {
            monitoringLoop: null, totalHits: 0, actionDsCounter: 7, contractUsage: {},
            noActionCounter: 8, conf: {indexer: {abi_scan_mode: false, live_reader: false}}
        });
        pool.startMonitoring(); pool.startMonitoring();
        tick();
        assert.deepEqual(sent.splice(0), [{event: 'ds_report', actions: 7}]);
        assert.equal(pool.noActionCounter, 0);
        assert.equal(pool.actionDsCounter, 0);
        pool.totalHits = 2; pool.actionDsCounter = 3; pool.contractUsage = {example: [2, 0]};
        tick();
        assert.deepEqual(sent.splice(0), [
            {event: 'contract_usage_report', data: {example: [2, 0]}, total_hits: 2},
            {event: 'ds_report', actions: 3}
        ]);
        assert.deepEqual(pool.contractUsage, {}); assert.equal(pool.totalHits, 0);
        assert.equal(pool.actionDsCounter, 0); assert.equal(pool.noActionCounter, 0);
        tick();
        assert.deepEqual(sent, []); assert.equal(pool.noActionCounter, 1);
        pool.totalHits = 1; pool.contractUsage = {example: [1, 0]};
        tick();
        assert.deepEqual(sent.splice(0), [
            {event: 'contract_usage_report', data: {example: [1, 0]}, total_hits: 1},
            {event: 'ds_report', actions: 0}
        ]);
        assert.equal(pool.noActionCounter, 0);
    } finally { globalThis.setInterval = originalInterval; process.send = originalSend; }
});
