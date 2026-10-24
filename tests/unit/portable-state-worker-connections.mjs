/** Real loopback status probes with original Wire bytes; no worker, database or live-chain qualification. */
import assert from 'node:assert/strict';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
import {once} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {StateHistorySocket} from '../../build/indexer/connections/state-history.js';
import {auditPortableWorkerSource, portableSourceLimits, servePortableWorkerSource} from '../../scripts/qualification/portable-state-worker-source.ts';

assertNativeQualificationRuntime();
const root = fileURLToPath(new URL('../../', import.meta.url)), directory = mkdtempSync(join(tmpdir(), 'hapi288-status-connections-'));
const fixtures = [], sockets = [];
async function eventually(condition) {
    const until = performance.now() + 2000;
    while (!condition()) {assert.ok(performance.now() < until, 'owned status socket did not close'); await pause(5);}
}
try {
    const prepared = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
        [join(root, 'tests/fixtures/portable-state-worker/prepare.py'), join(directory, 'capture')], {encoding: 'utf8', timeout: 20000});
    assert.equal(prepared.status, 0, prepared.stderr);
    const plan = JSON.parse(readFileSync(JSON.parse(prepared.stdout).plan));
    const source = await auditPortableWorkerSource({...plan.source, endBlock: 1}, 'wire-sysio-6508c9e8-native-engineering-v1');
    const start = async () => {const errors = [], server = await servePortableWorkerSource(source, errors); fixtures.push(server); return {server, errors};};
    const probe = async server => new StateHistorySocket(server.url, 16, {provider: 'extension',
        package: '@eosrio/hyperion-wire-plugin', profileId: source.profileId}).validateShipServers(source.chainId);

    const sequential = await start(), cycles = portableSourceLimits.connections + 4;
    for (let index = 0; index < cycles; index++) {
        const result = await probe(sequential.server);
        assert.equal(result.length, 1, `closed status sessions must not consume concurrent capacity at probe ${index + 1}`);
        assert.equal(result[0].active, true); assert.equal(result[0].chainId, source.chainId);
    }
    assert.deepEqual(sequential.errors, []); sequential.server.assertThrough(0);
    assert.equal(sequential.server.metrics().connections, cycles);
    await eventually(() => sequential.server.metrics().activeConnections === 0);
    assert.ok(sequential.server.requests.every(item => item.request[0] === 'get_status_request_v0'));

    const concurrent = await start();
    for (let index = 0; index < portableSourceLimits.connections; index++) {
        const socket = new WebSocket(concurrent.server.url); sockets.push(socket);
        const [, binary] = await once(socket, 'message'); assert.equal(binary, false);
    }
    const excess = new WebSocket(concurrent.server.url); sockets.push(excess); excess.on('error', () => {});
    await new Promise((resolveClose, reject) => {
        const timer = setTimeout(() => reject(new Error('excess concurrent source socket stayed open')), 2000);
        excess.once('close', () => {clearTimeout(timer); resolveClose();});
    });
    assert.deepEqual(concurrent.errors, ['portable source concurrent connection bound']);
    assert.equal(concurrent.server.metrics().connections, portableSourceLimits.connections);
    assert.equal(concurrent.server.metrics().activeConnections, portableSourceLimits.connections);
    assert.equal(concurrent.server.requests.length, 0);

    const historical = await start();
    for (let index = 0; index < portableSourceLimits.sessions; index++) assert.equal((await probe(historical.server))[0]?.active, true);
    assert.equal((await probe(historical.server)).length, 0);
    assert.deepEqual(historical.errors, ['portable source session history bound']);
    assert.equal(historical.server.metrics().connections, portableSourceLimits.sessions);
    assert.ok(historical.server.metrics().sessions.every(session => session.sent.length === 0 && session.acknowledged.length === 0));
    console.log(JSON.stringify({passed: true, node: process.version, sequentialStatusProbes: cycles,
        concurrentLimit: portableSourceLimits.connections, sessionHistoryLimit: portableSourceLimits.sessions,
        originalStatusOnly: true, streamedBlocks: 0, fullWorkerQualification: false}));
} finally {
    for (const socket of sockets) socket.terminate();
    for (const fixture of fixtures) await fixture.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('hapi288-status-connections-'));
    rmSync(directory, {recursive: true, force: true});
}
