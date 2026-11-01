// Pure file/materialization controls. Do not import the stop-capable replay controller.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {captureWireSourceSnapshot, engineeringAdmissionSourcePaths} from './wire-source-snapshot.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url)), entry = 'tests/unit/stateful-engineering-source-admission.mjs';
const readSource = async path => {const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024);
    const bytes = await readFile(path); assert.equal(bytes.length, stat.size); return bytes;};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function owned(t) {
    const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'hapi416-snapshot-test-'));
    t.after(async () => {const actual = await realpath(root);
        assert.equal(dirname(actual), parent); assert.ok(basename(actual).startsWith('hapi416-snapshot-test-'));
        assert.equal((await lstat(root)).isSymbolicLink(), false); await rm(actual, {recursive: true});});
    return root;
}
const base = {repo, prefix: 'node_modules/@eosrio/hyperion-wire-plugin', componentFiles: new Map([['dist/inert.txt', Buffer.from('not executable\r\n')]]),
    runtimeSources: ['scripts/qualification/wire-source-snapshot.mjs'], readSource};

test('previous entry-only snapshot is red-capable: dispatcher cannot resolve its omitted static helper', async t => {
    const output = await owned(t);
    const hashes = await captureWireSourceSnapshot({...base, output, engineeringSelected: false, runtimeSources: [entry]});
    assert.ok(hashes[entry]); assert.equal(Object.keys(hashes).length, 2);
    await assert.rejects(import(pathToFileURL(join(output, 'sources', entry)).href), error => error.code === 'ERR_MODULE_NOT_FOUND');
});

test('actual shared snapshot writer retains complete loadable helper/data closure for every engineering selection', async t => {
    // Current and historical selections both load the active dispatcher graph. Only file bytes are exercised here.
    for (const selected of ['stateful-owner-v2-7412889-69a6606-complete-kind-engineering',
        'stateful-owner-v2-root741-native429-wire69-native45-linux-gitlf-engineering',
        'stateful-owner-v2-root741-native429-source-5aaaee4-linux-gitlf-engineering']) {
        const output = await owned(t), hashes = await captureWireSourceSnapshot({...base, output, engineeringSelected: Boolean(selected)});
        for (const file of [...engineeringAdmissionSourcePaths, ...base.runtimeSources]) {
            const original = await readFile(join(repo, file)), retained = await readFile(join(output, 'sources', file));
            assert.ok(retained.equals(original)); assert.equal(hashes[file], sha(original));
        }
        const opaque = await readFile(join(output, 'sources', base.prefix, 'dist/inert.txt')); assert.ok(opaque.includes(Buffer.from('\r\n')));
        const gate = await import(pathToFileURL(join(output, 'sources', entry)).href);
        assert.equal(typeof gate.admitCoordinatedNativeSourceOptions, 'function');
        assert.throws(() => gate.admitNativeApiSourceOptions({engineeringSourceProfile: 'unknown'}), /Unknown engineering source profile/);
        await assert.rejects(captureWireSourceSnapshot({...base, output, engineeringSelected: true}), /EEXIST/);
    }
});

test('snapshot metadata keeps default selection, raw-byte bound and safe paths without importing replay code', async () => {
    const plain = await captureWireSourceSnapshot({...base, engineeringSelected: false}); assert.equal(plain[entry], undefined);
    const same = Buffer.alloc(16 * 1024 * 1024), large = new Map(Array.from({length: 5}, (_, n) => ['dist/' + n + '.bin', same]));
    await assert.rejects(captureWireSourceSnapshot({...base, componentFiles: large, engineeringSelected: false}), /byte bound/);
    await assert.rejects(captureWireSourceSnapshot({...base, componentFiles: new Map([['../escape', Buffer.from('x')]]), engineeringSelected: false}), /Invalid snapshot source path/);
    const source = await readFile(new URL('./wire-worker-replay.ts', import.meta.url), 'utf8');
    assert.match(source, /const hashes = await captureWireSourceSnapshot\(\{repo, prefix, componentFiles, runtimeSources,/);
    assert.ok(source.includes("'scripts/qualification/wire-source-snapshot.mjs'"));
});
