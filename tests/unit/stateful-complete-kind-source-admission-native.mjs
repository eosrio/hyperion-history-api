import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {admitNativeApiSourceOptions, admitNativeSourceEnvironment, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as profile, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as priorCompleteKindProfile, STATEFUL_ACTION_METADATA_API_SOURCE_PROFILE as priorProfile, STATEFUL_COMPLETE_KIND_COMMANDS_NATIVE_SOURCE as nativeSource, STATEFUL_COMPLETE_KIND_CALLER_SOURCE as callerSource, STATEFUL_METADATA_FIELDS_API_SOURCE_PROFILE as fieldsProfile, STATEFUL_ENGINEERING_API_SOURCE_PROFILE as oldProfile, STATEFUL_ACTION_METADATA_LEGACY_SOURCE_PROFILE as legacyProfile} from './stateful-engineering-source-admission.mjs';

assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
let cases = 0, accessorCalls = 0;
const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile}); assert.equal(actual.qualificationOnly, true); assert.equal(actual.nativeSourceCommit, nativeSource.commit); assert.equal(actual.nativeTree, nativeSource.tree); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCompleteKindProfile}), /native emissions/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorProfile}), /SDK package/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: fieldsProfile}), /SDK package/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: oldProfile}), /SDK package/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: legacyProfile}), /Wire source revision/); cases++;
for (const options of [{engineeringSourceProfile: 'unknown'}, {expectedWireRevision: actual.wireRevision},
    {get engineeringSourceProfile() {accessorCalls++; return profile;}}]) {assert.throws(() => admitNativeApiSourceOptions(options)); cases++;}
assert.equal(accessorCalls, 0);
assert.throws(() => admitNativeApiSourceOptions(), /Wire source revision/); cases++;
const parent = realpathSync(tmpdir()), directory = mkdtempSync(join(parent, 'hapi-complete-kind # % -'));
const copy = (from, to) => {mkdirSync(dirname(to), {recursive: true}); copyFileSync(from, to);};
const codeTree = (from, to) => {for (const entry of readdirSync(from, {withFileTypes: true})) {
    assert(!entry.isSymbolicLink()); if (entry.isDirectory()) codeTree(join(from, entry.name), join(to, entry.name));
    else {assert(entry.isFile()); copy(join(from, entry.name), join(to, entry.name));}
}};
try {
    copy(fileURLToPath(new URL('../../package.json', import.meta.url)), join(directory, 'package.json'));
    codeTree(fileURLToPath(new URL('../../build', import.meta.url)), join(directory, 'build'));
    for (const [path] of callerSource.sources) copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
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
    alter(join(directory, 'build/api/helpers/stateful-owner.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong host artifact\n')]), /caller emissions/);
    alter(join(directory, 'src/api/helpers/stateful-owner.ts'), bytes => Buffer.from(bytes.toString().replace(/\n/g, '\r\n')), /Git-LF caller/);
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
    // The production caller fixtures must refuse unknown profiles before imports, hooks or extraction.
    const savedProfile = process.env.HYPERION_NATIVE_SOURCE_PROFILE;
    try {
        process.env.HYPERION_NATIVE_SOURCE_PROFILE = profile;
        const selected = admitNativeSourceEnvironment();
        assert.equal(selected.sdkRevision, '7412889a14c84342551fd864ea3ebfcf28849385');
        assert.equal(selected.wireSdkRevision, '58d68c5cea81490bbb1c9a7736d633d465bab3ef'); cases++;
        process.env.HYPERION_NATIVE_SOURCE_PROFILE = 'unknown';
        assert.throws(() => admitNativeSourceEnvironment(), /Unknown engineering source profile/); cases++;
        const before = join(directory, 'caller-before-effects'); mkdirSync(before);
        for (const name of ['action-attempt-disposition-worker.mjs', 'action-handoff-outcome-worker.mjs',
            'action-source-inventory-native.mjs', 'protocol-native-authorization-wire.mjs', 'protocol-native-consumer-worker.mjs',
            'protocol-native-installed.mjs', 'protocol-native-lag-replay.mjs', 'worker-attempt-quiescence-worker.mjs']) {
            const child = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))],
                {env: {...process.env, TEMP: before, TMP: before, TMPDIR: before}, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
            assert.equal(child.status, 1, name + ': ' + child.stderr);
            assert.match(child.stderr, /Unknown engineering source profile/, name);
            assert.deepEqual(readdirSync(before), [], name + ' ran fixture effects before admission'); cases++;
        }
        const {auditWireReplayFixture} = await import('../../scripts/qualification/wire-replay-fixture.ts');
        await assert.rejects(() => auditWireReplayFixture({outputDirectory: join(before, 'audit-output')}), /Unknown engineering source profile/); cases++;
        const {readWireComponentSources} = await import('../../scripts/qualification/wire-worker-replay.ts');
        await assert.rejects(() => readWireComponentSources(before, [], 'unknown'), /Unknown engineering source profile/); cases++;
        await assert.rejects(() => readWireComponentSources(before, [], profile), /selected installed package/); cases++;
        let sourceIO = 0;
        const client = new Proxy({}, {get() {sourceIO++; throw new Error('qualification performed I/O before source admission');}});
        for (const [file, name] of [['action-handoff-outcomes.mjs', 'qualifyActionHandoffOutcomes'],
            ['action-attempt-dispositions.mjs', 'qualifyActionAttemptDispositions']]) {
            const qualification = await import('../../scripts/qualification/' + file);
            await assert.rejects(() => qualification[name]({client}), /Unknown engineering source profile/);
            assert.equal(sourceIO, 0); cases++;
        }
        const journal = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/qualification/check-action-source-journal.mjs', import.meta.url))],
            {env: {...process.env, PATH: '', TEMP: before, TMP: before, TMPDIR: before}, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
        assert.equal(journal.status, 1, journal.stderr);
        assert.match(journal.stderr, /Unknown engineering source profile/);
        assert.deepEqual(readdirSync(before), [], 'journal source admission precedes Docker and temporary output'); cases++;
        process.env.HYPERION_NATIVE_SOURCE_PROFILE = '';
        assert.throws(() => admitNativeSourceEnvironment(), /Wire source revision/); cases++;
    } finally {if (savedProfile === undefined) delete process.env.HYPERION_NATIVE_SOURCE_PROFILE; else process.env.HYPERION_NATIVE_SOURCE_PROFILE = savedProfile;}
} finally {
    assert.equal(dirname(directory), parent); assert(basename(directory).startsWith('hapi-complete-kind # % -'));
    rmSync(directory, {recursive: true, force: true});
}
console.log(JSON.stringify({cases, sealedEngineeringOption: true, exactCompleteKindProfile:true, priorNativeProfileRefused:true, old58dCrossProfileRefused:true, legacy716CrossProfileRefused:true, default716Preserved: true, artifactAndSourceSetChecked: true,
    unknownRevisionPackageTreeArtifactRefused: true, defaultOverrideRefusedBeforeEffects: true, temporaryCodeOnly: true, callerEnvironmentAdmission: true, callerBeforeEffectsNegatives: 8, qualificationBeforeEffectsNegatives: 6,
    services: false, defaultDistributionQualified: false, launchQualified: false}));
