// Evidence-only file capture. No admission fallback, byte normalization, client or child process.
import assert from 'node:assert/strict';
import {lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {inventory} from './inventory.mjs';
import {sha} from './contract.mjs';

const maximumFiles = 1024, maximumBytes = 64 * 1024 * 1024, maximumMetadataBytes = 4 * 1024 * 1024;
const digest = value => sha(Buffer.from(JSON.stringify(value)));
export function diagnosticDirectory(name) {
    assert.ok(typeof name === 'string' && /^operator-list-assembly-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(name),
        'Diagnostics require a fresh operator-list-assembly-* directory directly inside this checkout');
    return name;
}
export function diagnosticRelativePath(name) {
    assert.ok(typeof name === 'string' && name.length > 0 && name.length <= 1024 &&
        name.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part)),
    'Unsafe diagnostic inventory path');
    return name;
}
const errorRecord = error => ({name: String(error?.name ?? 'Error'), code: String(error?.code ?? ''),
    message: String(error?.message ?? error).slice(0, 16384), messageTruncated: String(error?.message ?? error).length > 16384});

/** Capture cannot replace an original admission failure or turn it into a successful result. */
export function retainAdmission(assertAdmission, capture) {
    let value, primary;
    try {value = assertAdmission();} catch (error) {primary = error;}
    try {capture(primary ? {status: 'rejected', error: errorRecord(primary)} : {status: 'admitted'});}
    catch (error) {
        if (!primary) throw error;
        // Keep the original thrown object, including its actual/expected assertion evidence.
        if (primary && typeof primary === 'object') {
            try {Object.defineProperty(primary, 'diagnosticFailure', {value: error, enumerable: true});} catch {}
        }
        console.error('Operator-list diagnostic capture failed after admission rejection:', error);
    }
    if (primary) throw primary;
    return value;
}

/** Full raw caller emissions plus all per-file inventories; completion has no qualification authority. */
export function writeAssemblyDiagnostic({root, directory, observed, inventories, expected, admission, provenance}) {
    root = realpathSync(root); diagnosticDirectory(directory);
    const output = resolve(root, directory), payloads = [];
    // No recursive mkdir or replacement: a stale/partial capture is never silently reused.
    mkdirSync(output, {mode: 0o700});
    const write = (name, bytes) => {
        diagnosticRelativePath(name);
        const path = join(output, name); mkdirSync(dirname(path), {recursive: true, mode: 0o700});
        writeFileSync(path, bytes, {flag: 'wx', mode: 0o600});
        const retained = readFileSync(path);
        assert.ok(retained.equals(bytes), 'Diagnostic payload changed after write');
        payloads.push({path: name, bytes: bytes.length, sha256: sha(bytes)});
    };
    const json = (name, value) => {
        const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
        assert.ok(bytes.length <= maximumMetadataBytes, 'Diagnostic metadata bound exceeded'); write(name, bytes);
    };
    json('assessment.json', {schemaVersion: 1, scope: 'operator-list-assembly-diagnostic', qualificationGranted: false,
        collection: 'started', admission, provenance, observed, expected});
    assert.deepEqual(Object.keys(inventories).sort(), Object.keys(observed.trees).sort(), 'Diagnostic tree coverage differs');
    for (const [name, rows] of Object.entries(inventories)) {
        assert.ok(Array.isArray(rows) && rows.length <= maximumFiles, 'Diagnostic file count bound exceeded');
        assert.equal(rows.length, observed.trees[name].files, 'Diagnostic inventory count changed');
        assert.equal(digest(rows), observed.trees[name].sha256, 'Diagnostic inventory digest changed');
    }
    json('inventories.json', {schemaVersion: 1, digestAlgorithm: 'sha256(JSON.stringify(rows))', trees: inventories});
    const tree = observed.trees.rootBuild, rows = inventories.rootBuild;
    assert.ok(tree && rows && tree.textLF === false, 'Caller emissions must remain byte-exact');
    diagnosticRelativePath(tree.path);
    let total = 0;
    for (const row of rows) {
        diagnosticRelativePath(row.path);
        assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256), 'Invalid diagnostic file pin');
        total += row.bytes; assert.ok(total <= maximumBytes, 'Diagnostic raw byte bound exceeded');
    }
    for (const row of rows) {
        // Recheck every original path segment; a renamed/replaced/symlinked input cannot be captured under its earlier pin.
        let path = root;
        for (const segment of (tree.path + '/' + row.path).split('/')) {
            path = join(path, segment); assert.equal(lstatSync(path).isSymbolicLink(), false, 'Diagnostic capture refuses symlinks');
        }
        const stat = lstatSync(path);
        assert.ok(stat.isFile() && stat.size === row.bytes, 'Diagnostic original file size changed');
        const bytes = readFileSync(path);
        assert.ok(bytes.length === row.bytes && sha(bytes) === row.sha256, 'Diagnostic original file bytes changed');
        write('rootBuild/' + row.path, bytes);
    }
    assert.deepEqual(inventory(join(output, 'rootBuild')), rows, 'Retained raw caller emissions differ');
    // The final index is the only collection-complete marker. Absence/partial output stays incomplete.
    json('index.json', {schemaVersion: 1, scope: 'operator-list-assembly-diagnostic', qualificationGranted: false,
        collection: 'complete', admission, rawTree: 'rootBuild', files: rows.length, bytes: total,
        inventorySha256: tree.sha256, payloads: [...payloads]});
    return {directory: output, files: rows.length, bytes: total, admission: admission.status, qualificationGranted: false};
}
