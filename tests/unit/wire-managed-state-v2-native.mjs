import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepared} from './portable-state-source-fixture.mjs';
import {statefulHostFixture} from './stateful-host-fixture.mjs';
import {limits} from '../../packages/backend-mongodb/tests/stateful-fixture.mjs';
import Plugin, {PROJECTION_ID, wireRecordKey} from '../fixtures/wire-managed-state-v2/plugin/build/index.js';
import {admitCoordinatedNativeSourceOptions, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE} from './stateful-engineering-source-admission.mjs';

// This fixture composes the combined complete-kind caller/native graph with Wire's own unchanged SDK.
admitCoordinatedNativeSourceOptions({engineeringSourceProfile: STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE});

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = join(root, 'tests/fixtures/portable-state-worker');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const config = () => ({enabled: true, qualificationOnly: true, limits: limits()});

test('Wire qualification plugin requires explicit opt-in and preserves physical key bytes', () => {
    assert.throws(() => new Plugin({enabled: true, limits: limits()}));
    assert.throws(() => new Plugin({enabled: true, qualificationOnly: true}));
    const registration = new Plugin(config()).getStatefulProjectionsV2();
    assert.equal(registration.interfaceVersion, 2); assert.equal(registration.sourceInputVersion, 2);
    assert.equal(registration.projections.length, 1); assert.equal(registration.projections[0].definition.id, PROJECTION_ID);
    assert.deepEqual(registration.projections[0].definition.selectors.map(s => s.name), ['attseq', 'outenvelopes']);
    const key = wireRecordKey({kind: 'kv-primary', tableId: 1067, keyHex: '0000000000000000'});
    assert.notEqual(key, wireRecordKey({kind: 'kv-primary', tableId: 1067, keyHex: '00'}));
    assert.throws(() => wireRecordKey({kind: 'contract-row', scope: '', primaryKey: '0'}));
    assert.throws(() => wireRecordKey({kind: 'kv-primary', tableId: 1067, keyHex: '00', scope: ''}));
    assert.notEqual(wireRecordKey({kind: 'kv-secondary', tableId: 2000, secondaryKeyHex: '0000', primaryKeyHex: '01'}),
        wireRecordKey({kind: 'kv-secondary', tableId: 2000, secondaryKeyHex: '00', primaryKeyHex: '01'}));
});

test('interleaved retained Wire 1..1480 reaches managed owner-v2 worker and request-scoped API with nonempty state',
    {timeout: 180000}, async () => {
    const manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json')));
    assert.equal(manifest.archive.sha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
    const archive = readFileSync(join(sourceRoot, manifest.archive.file));
    assert.equal(archive.length, manifest.archive.bytes); assert.equal(sha(archive), manifest.archive.sha256);
    mkdirSync(join(root, 'out'), {recursive: true});
    const parent = realpathSync(join(root, 'out')), owned = mkdtempSync(join(parent, 'wire-managed-retained-'));
    let host;
    try {
        const destination = join(owned, 'verified');
        const preparation = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
            [join(sourceRoot, 'prepare.py'), destination], {encoding: 'utf8', timeout: 30000, windowsHide: true}));
        assert.equal(preparation.archiveSha256, manifest.archive.sha256); assert.equal(preparation.files, 1488);
        const members = new Map(manifest.members.map(row => [row.path, row]));
        const read = path => {
            const expected = members.get('source/' + path); assert(expected);
            const bytes = readFileSync(join(destination, 'source', path));
            assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256); return bytes;
        };
        const frames = Array.from({length: 1480}, (_, n) => read('block-' + String(n + 1).padStart(6, '0') + '.bin'));
        const schemaJson = read('schema.json').toString();
        const receipt = JSON.parse(read('receipt.json'));
        // The first contract ABI is originally deployed at222. Keep reader/owner distance inside
        // the existing256-block window; this does not claim a cold historical catch-up proof.
        const p = await prepared({}, 222, undefined, {frames, schemaJson,
            capture: {chainId: receipt.chainId, profileId: 'wire-sysio-6508c9e8-native-engineering-v1'}});
        assert.equal(p.positions.length, 222);
        host = await statefulHostFixture({preparedSource: p, timeoutMs: 5000, through: 222,
            pluginDirectory: join(root, 'tests/fixtures/wire-managed-state-v2/plugin'),
            pluginConfiguration: config(), projectionId: PROJECTION_ID});
        assert.equal(host.ownerErrors.length, 0, host.ownerErrors.map(error => error.stack).join('\n'));
        for (let through = 222; through < 1480;) {
            const next = Math.min(1480, through + 8);
            await p.advance(next);
            for (let i = through; i < next && host.ownerErrors.length === 0; i++) await host.controller.drain();
            assert.equal(host.ownerErrors.length, 0, host.ownerErrors.map(error => error.stack).join('\n'));
            through = next;
        }
        const recovery = await host.native.adapter.recovery();
        assert.equal(recovery.view.checkpoint.blockNum, 1480, host.ownerErrors.map(error => error.stack).join('\n'));
        assert.equal(recovery.raw, null); assert.equal(recovery.pending, null); assert.equal(recovery.gap, null);
        assert.ok(host.ends.length >= 1480, 'Actual managed worker attempts must have completed');
        assert.ok(host.ends.every(end => end.status === 'quiescent' && end.rootResult === 'returned'));
        const plan = JSON.parse(readFileSync(join(sourceRoot, 'plan.template.json')));
        const barrier = plan.barriers.find(row => row.through === 1480);
        const attseq = await host.app.inject('/v2/qualification/wire/attseq/1067/0000000000000000');
        assert.equal(attseq.statusCode, 200, attseq.body);
        assert.equal(attseq.headers['hyperion-state-block-num'], '1480');
        assert.equal(attseq.headers['hyperion-state-block-id'], p.positions.at(-1).blockId);
        assert.equal(attseq.headers['hyperion-state-last-valid'], 'false');
        const value = attseq.json().row, expected = barrier.rows['sysio-msgch-attseq'][0].value;
        assert.deepEqual({id: value.id, next: value.next}, expected);
        assert.deepEqual(value.identity, {kind: 'kv-primary', tableId: 1067, keyHex: '0000000000000000'});
        assert.equal(Object.hasOwn(value.identity, 'scope'), false);
        for (const row of barrier.rows['sysio-msgch-outenvelopes']) {
            const key = JSON.parse(row.key)[1].split(':').at(-1);
            const response = await host.app.inject('/v2/qualification/wire/outenvelopes/18398/' + key);
            assert.equal(response.statusCode, 200, response.body);
            const actual = response.json().row, {identity, payer, ...fields} = actual;
            assert.deepEqual(fields, row.value); assert.equal(identity.keyHex, key);
            assert.ok(payer === null || typeof payer === 'string');
        }
        const deleted = await host.app.inject('/v2/qualification/wire/outenvelopes/18398/0000000000000001');
        assert.equal(deleted.statusCode, 200); assert.equal(deleted.json().row, null);
        const malformed = await host.app.inject('/v2/qualification/wire/attseq/1067/0');
        assert.equal(malformed.statusCode, 400);
        host.disconnect();
        const unavailable = await host.app.inject('/v2/qualification/wire/attseq/1067/0000000000000000');
        assert.equal(unavailable.statusCode, 503);
        assert.equal(unavailable.headers['hyperion-state-block-num'], undefined);
        assert.equal((await host.app.inject('/unrelated')).statusCode, 200);
    } finally {
        await host?.close();
        assert.equal(dirname(owned), parent); assert.ok(basename(owned).startsWith('wire-managed-retained-'));
        rmSync(owned, {recursive: true, force: true});
    }
});
