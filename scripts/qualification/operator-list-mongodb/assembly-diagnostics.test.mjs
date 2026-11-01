// File-only controls: never import or execute the stop-capable CI controller or physical runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {diagnosticDirectory, diagnosticRelativePath, retainAdmission, writeAssemblyDiagnostic} from './assembly-diagnostics.mjs';
import {inventory} from './inventory.mjs';
import {sha} from './contract.mjs';
import {OPERATOR_LIST_ASSEMBLY, OPERATOR_LIST_PROFILE, diagnoseOperatorListAssembly} from './source-profile.mjs';

const json = path => JSON.parse(readFileSync(path));
function fixture(t) {
    const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'hapi416-assembly-test-'));
    t.after(() => {
        // Verify this exact task-owned absolute target before recursive removal on Windows.
        const actual = realpathSync(root);
        assert.equal(dirname(actual), parent); assert.ok(basename(actual).startsWith('hapi416-assembly-test-'));
        assert.equal(lstatSync(root).isSymbolicLink(), false); rmSync(actual, {recursive: true});
    });
    mkdirSync(join(root, 'build', 'nested'), {recursive: true}); mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'build', 'nested', 'literal.js'), Buffer.from('export const script = `a\r\nb`;\n'));
    writeFileSync(join(root, 'build', 'literal.js.map'), Buffer.from('{"version":3}\n'));
    writeFileSync(join(root, 'src', 'literal.ts'), Buffer.from('export const script = `a\r\nb`;\r\n'));
    const inventories = {rootBuild: inventory(join(root, 'build')), rootSource: inventory(join(root, 'src'), {textLF: true})};
    const trees = Object.fromEntries(Object.entries(inventories).map(([name, rows]) => [name, {
        path: name === 'rootBuild' ? 'build' : 'src', files: rows.length, sha256: sha(JSON.stringify(rows)), textLF: name === 'rootSource'}]));
    return {root, directory: 'operator-list-assembly-modeled', inventories,
        observed: {profile: OPERATOR_LIST_PROFILE, trees}, expected: OPERATOR_LIST_ASSEMBLY,
        admission: {status: 'rejected', error: {name: 'AssertionError', message: 'modeled mismatch'}},
        provenance: {scope: 'file-only-modeled-control'}};
}

test('diagnostics retain original CRLF bytes and complete per-file pins without admission authority', t => {
    const value = fixture(t), result = writeAssemblyDiagnostic(value), output = resolve(value.root, value.directory);
    assert.equal(result.admission, 'rejected'); assert.equal(result.qualificationGranted, false);
    const original = readFileSync(join(value.root, 'build', 'nested', 'literal.js'));
    assert.ok(readFileSync(join(output, 'rootBuild', 'nested', 'literal.js')).equals(original));
    assert.ok(original.includes(Buffer.from('\r\n')));
    const assessment = json(join(output, 'assessment.json')), index = json(join(output, 'index.json'));
    assert.deepEqual(assessment.observed, value.observed); assert.deepEqual(assessment.expected, OPERATOR_LIST_ASSEMBLY);
    assert.equal(index.collection, 'complete'); assert.equal(index.admission.status, 'rejected');
    assert.equal(index.inventorySha256, value.observed.trees.rootBuild.sha256); assert.equal(index.files, 2);
    assert.equal(index.qualificationGranted, false); assert.deepEqual(json(join(output, 'inventories.json')).trees, value.inventories);
    for (const row of index.payloads) {
        const bytes = readFileSync(join(output, row.path)); assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    }
    assert.equal(index.payloads.length, 4); assert.equal(index.payloads.some(row => row.path === 'index.json'), false);
    assert.throws(() => writeAssemblyDiagnostic(value), /EEXIST/);
});

test('changed original emissions and oversized raw inventories never receive a complete marker', t => {
    const changed = fixture(t); writeFileSync(join(changed.root, 'build', 'nested', 'literal.js'), 'changed');
    assert.throws(() => writeAssemblyDiagnostic(changed), /original file size changed/);
    assert.equal(existsSync(join(changed.root, changed.directory, 'index.json')), false);
    assert.equal(json(join(changed.root, changed.directory, 'assessment.json')).admission.status, 'rejected');
    const oversized = fixture(t), rows = [{path: 'large.js', bytes: 64 * 1024 * 1024 + 1, sha256: 'a'.repeat(64)}];
    oversized.inventories.rootBuild = rows; oversized.observed.trees.rootBuild.files = 1;
    oversized.observed.trees.rootBuild.sha256 = sha(JSON.stringify(rows));
    assert.throws(() => writeAssemblyDiagnostic(oversized), /raw byte bound/);
    assert.equal(existsSync(join(oversized.root, oversized.directory, 'index.json')), false);
});

test('unsafe and stale diagnostic destinations refuse before emission reads', () => {
    for (const value of ['', '../escape', 'operator-list-assembly-../escape', 'operator-list-assembly-a\\b', '/absolute', 'build',
        'operator-list-assembly-' + 'a'.repeat(97)]) assert.throws(() => diagnosticDirectory(value));
    for (const value of ['', '../x', 'a/../b', '/a', 'a//b', 'a\\b', 'C:/x', 'a/./b', 'a/\0b']) {
        assert.throws(() => diagnosticRelativePath(value));
    }
    assert.equal(diagnosticDirectory('operator-list-assembly-24.22.1'), 'operator-list-assembly-24.22.1');
    assert.equal(diagnosticRelativePath('nested/file.js'), 'nested/file.js');
    assert.throws(() => diagnoseOperatorListAssembly('../escape'), /fresh operator-list-assembly/);
});

test('an admission error remains primary when capture fails and successful collection cannot admit it', () => {
    const primary = new Error('original assembly mismatch'), secondary = new Error('diagnostic disk error');
    let observed;
    assert.throws(() => retainAdmission(() => {throw primary;}, verdict => {observed = verdict;}), error => error === primary);
    assert.equal(observed.status, 'rejected'); assert.equal(observed.error.message, primary.message);
    assert.throws(() => retainAdmission(() => {throw primary;}, () => {throw secondary;}), error => error === primary);
    assert.equal(primary.diagnosticFailure, secondary);
    assert.throws(() => retainAdmission(() => 'admitted assembly', () => {throw secondary;}), error => error === secondary);
    assert.equal(retainAdmission(() => 'admitted assembly', verdict => assert.equal(verdict.status, 'admitted')), 'admitted assembly');
});

test('workflow retains failed raw assembly diagnostics before the physical step while old profile stays frozen', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/build.yml', import.meta.url), 'utf8');
    const dedicated = workflow.slice(workflow.indexOf('\n  operator-lists-mongodb:'), workflow.indexOf('\n  action-sequences-design:'));
    assert.ok(dedicated.includes('source-profile.mjs --diagnostics operator-list-assembly-${{ matrix.node-version }}'));
    assert.ok(dedicated.includes('operator-list-assembly-${{ matrix.node-version }}/'));
    assert.ok(dedicated.indexOf('source-profile.mjs --diagnostics') < dedicated.indexOf('operator-list-mongodb/ci.mjs'));
    assert.ok(dedicated.includes('if: always()')); assert.equal(OPERATOR_LIST_ASSEMBLY.trees.rootBuild.sha256,
        '6fdcae1f6f79a2dda709dc574f28a8888985c4f8bc18071aeffe73dd951ab419');
});
