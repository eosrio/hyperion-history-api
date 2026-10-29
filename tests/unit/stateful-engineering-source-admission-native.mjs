import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {admitNativeApiSourceOptions, STATEFUL_ENGINEERING_API_SOURCE_PROFILE as profile} from './stateful-engineering-source-admission.mjs';

assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
let cases = 0, accessorCalls = 0;
const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile}); assert.equal(actual.qualificationOnly, true); cases++;
for (const options of [{engineeringSourceProfile: 'unknown'}, {expectedWireRevision: actual.wireRevision},
    {get engineeringSourceProfile() {accessorCalls++; return profile;}}]) {assert.throws(() => admitNativeApiSourceOptions(options)); cases++;}
assert.equal(accessorCalls, 0);
assert.throws(() => admitNativeApiSourceOptions(), /Wire source revision/); cases++;
const parent = realpathSync(tmpdir()), directory = mkdtempSync(join(parent, 'hapi-engineering # % -'));
const copy = (from, to) => {mkdirSync(dirname(to), {recursive: true}); copyFileSync(from, to);};
const codeTree = (from, to) => {for (const entry of readdirSync(from, {withFileTypes: true})) {
    assert(!entry.isSymbolicLink()); if (entry.isDirectory()) codeTree(join(from, entry.name), join(to, entry.name));
    else {assert(entry.isFile()); copy(join(from, entry.name), join(to, entry.name));}
}};
try {
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    copy(fileURLToPath(new URL('../../package-lock.json', import.meta.url)), join(directory, 'package-lock.json'));
    const gate = join(directory, 'tests/unit/stateful-engineering-source-admission.mjs');
    copy(fileURLToPath(new URL('./stateful-engineering-source-admission.mjs', import.meta.url)), gate);
    const packageRoot = specifier => resolve(dirname(fileURLToPath(import.meta.resolve(specifier))), '..');
    const wire = packageRoot('@eosrio/hyperion-wire-plugin/protocol-provider.json');
    const destination = join(directory, 'node_modules/@eosrio/hyperion-wire-plugin');
    for (const path of ['package.json', 'dist/protocol-provider.json', 'dist/protocol-node-artifact.json', 'dist/protocol-rust-artifact.json']) copy(join(wire, path), join(destination, path));
    for (const name of ['protocol-node-artifact.json', 'protocol-rust-artifact.json'])
        for (const file of JSON.parse(readFileSync(join(wire, 'dist', name))).files) copy(join(wire, file.path), join(destination, file.path));
    for (const [name, specifier] of [['hyperion-sdk', '@eosrio/hyperion-sdk/projection-stateful-owner-v2'],
        ['hyperion-backend-mongodb', '@eosrio/hyperion-backend-mongodb/stateful-owner-v2']]) {
        const source = packageRoot(specifier), target = join(directory, 'node_modules/@eosrio', name);
        copy(join(source, 'package.json'), join(target, 'package.json'));
        codeTree(join(source, 'dist'), join(target, 'dist'));
    }
    const isolated = await import(pathToFileURL(gate).href);
    assert.deepEqual(isolated.admitNativeApiSourceOptions({engineeringSourceProfile: profile}), actual); cases++;
    const alter = (path, change, expected) => {
        const original = readFileSync(path);
        try {writeFileSync(path, change(original)); assert.throws(() => isolated.admitNativeApiSourceOptions({engineeringSourceProfile: profile}), expected); cases++;}
        finally {writeFileSync(path, original);}
        assert.deepEqual(isolated.admitNativeApiSourceOptions({engineeringSourceProfile: profile}), actual);
    };
    const json = change => bytes => Buffer.from(JSON.stringify(change(JSON.parse(bytes))));
    alter(join(destination, 'package.json'), json(value => ({...value, name: '@other/wire'})), /Wire package/);
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, sourceRevision: 'd'.repeat(40)})), /Wire source revision/);
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, files: [{...value.files[0], sha256: 'd'.repeat(64)}, ...value.files.slice(1)]})), /Wire Node artifact/);
    alter(join(destination, 'dist/provider.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong installed artifact\n')]), /artifact member/);
    alter(join(directory, 'node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong SDK tree\n')]), /SDK emissions/);
    alter(join(directory, 'node_modules/@eosrio/hyperion-backend-mongodb/dist/stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong native tree\n')]), /native emissions/);
    alter(join(directory, 'package-lock.json'), json(value => {
        value.packages['node_modules/@eosrio/hyperion-sdk'].resolved = 'git+https://other.invalid/eosrio/hyperion-sdk.git#' + 'd'.repeat(40); return value;
    }), /coordinated lock source/);
    // The actual helper must reject before creating/extracting temporary input or importing its runtime.
    const empty = join(directory, 'before-effects'); mkdirSync(empty);
    const previous = {TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR};
    try {
        Object.assign(process.env, {TEMP: empty, TMP: empty, TMPDIR: empty});
        const {nativeApiWireSource} = await import('./protocol-native-api-source.mjs');
        for (const options of [undefined, {expectedWireRevision: actual.wireRevision}]) {
            await assert.rejects(nativeApiWireSource(options)); assert.deepEqual(readdirSync(empty), []); cases++;
        }
    } finally {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}}
} finally {
    assert.equal(dirname(directory), parent); assert(basename(directory).startsWith('hapi-engineering # % -'));
    rmSync(directory, {recursive: true, force: true});
}
console.log(JSON.stringify({cases, sealedEngineeringOption: true, default716Preserved: true, artifactAndSourceSetChecked: true,
    unknownRevisionPackageTreeArtifactRefused: true, defaultOverrideRefusedBeforeEffects: true, temporaryCodeOnly: true,
    services: false, defaultDistributionQualified: false, launchQualified: false}));
