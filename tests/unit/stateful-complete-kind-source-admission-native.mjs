import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {admitNativeApiSourceOptions, admitNativeSourceEnvironment, STATEFUL_SDK49_SOURCE_PROFILE as profile, STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE as priorTraceProfile, STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE as priorCleanupProfile, STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE as priorSnapshotProfile, STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE as priorCurrentProfile, STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE as priorCodecProfile, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE as priorMetadataProfile, STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as priorExecutorProfile, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as priorCommandsProfile, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as priorCompleteKindProfile, STATEFUL_ACTION_METADATA_API_SOURCE_PROFILE as priorProfile, STATEFUL_METADATA_FIELDS_API_SOURCE_PROFILE as fieldsProfile, STATEFUL_ENGINEERING_API_SOURCE_PROFILE as oldProfile, STATEFUL_ACTION_METADATA_LEGACY_SOURCE_PROFILE as legacyProfile} from './stateful-engineering-source-admission.mjs';
import {NATIVE_CLEANUP_TRACE_ASSEMBLY as CURRENT_NATIVE_ASSEMBLY} from './native-cleanup-trace-source-admission.mjs';
import {findPackageJSON} from 'node:module';
import {ASSEMBLY} from '../../scripts/qualification/indexed-schema-mongodb/assembly.mjs';

assert.equal(process.versions.bun, undefined); assert.match(process.version, /^v(?:24|26)\./);
let cases = 0, accessorCalls = 0;
const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile}); assert.equal(actual.qualificationOnly, true); assert.deepEqual(actual.observation.sources, ASSEMBLY.sources); assert.deepEqual(actual.observation.trees, ASSEMBLY.trees); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorTraceProfile}), /Git-LF helper/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCleanupProfile}), /Git-LF helper|complete byte inventories/);
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorSnapshotProfile}), /Git-LF helper|complete byte inventories/);
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCurrentProfile}), /Git-LF helper|complete byte inventories/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCodecProfile}), /Unqualified coordinated lock source/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorMetadataProfile}), /Wire source revision/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorExecutorProfile}), /Wire source revision/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCommandsProfile}), /Wire source revision/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorCompleteKindProfile}), /Wire source revision/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: priorProfile}), /Wire source revision/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: fieldsProfile}), /Wire source revision/); cases++;
assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: oldProfile}), /Wire source revision/); cases++;
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
    // Copy the complete newly admitted source/native/SDK/driver/BSON graph, never infer receiving SDK parity.
    for (const file of ASSEMBLY.sources) copy(fileURLToPath(new URL('../../' + file.path, import.meta.url)), join(directory, file.path));
    for (const path of ['build','packages/backend-mongodb/dist','node_modules/@eosrio/hyperion-sdk','packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk',
        'node_modules/mongodb','node_modules/bson','packages/backend-mongodb/node_modules/mongodb','packages/backend-mongodb/node_modules/bson'])
        codeTree(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const path of ['node_modules/typescript/package.json', 'packages/backend-mongodb/node_modules/typescript/package.json'])
        copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    const gate = join(directory, 'tests/unit/stateful-engineering-source-admission.mjs');
    for (const path of Object.keys(CURRENT_NATIVE_ASSEMBLY.helperSources)) copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const path of ['tests/unit/sdk49-indexed-source-admission.mjs','tests/fixtures/engineering-profiles/sdk49-indexed-linux.json',
        'scripts/qualification/indexed-schema-mongodb/assembly.mjs','scripts/qualification/indexed-schema-mongodb/assembly.json'])
        copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const row of JSON.parse(readFileSync(new URL('../fixtures/engineering-profiles/sdk49-indexed-linux.json', import.meta.url))).routeSources)
        copy(fileURLToPath(new URL('../../' + row.path, import.meta.url)), join(directory, row.path));
    copy(fileURLToPath(new URL('../fixtures/engineering-profiles/native-cleanup-trace-linux.json', import.meta.url)), join(directory, 'tests/fixtures/engineering-profiles/native-cleanup-trace-linux.json'));
    copy(fileURLToPath(new URL('../fixtures/engineering-profiles/native-cleanup-linux.json', import.meta.url)), join(directory, 'tests/fixtures/engineering-profiles/native-cleanup-linux.json'));
    copy(fileURLToPath(new URL('../fixtures/engineering-profiles/native-snapshot-linux.json', import.meta.url)), join(directory, 'tests/fixtures/engineering-profiles/native-snapshot-linux.json'));
    copy(fileURLToPath(new URL('../fixtures/engineering-profiles/current-native45-linux.json', import.meta.url)), join(directory, 'tests/fixtures/engineering-profiles/current-native45-linux.json'));
    codeTree(fileURLToPath(new URL('../../scripts/qualification/operator-list-mongodb', import.meta.url)), join(directory, 'scripts/qualification/operator-list-mongodb'));
    const packageRoot = specifier => resolve(dirname(fileURLToPath(import.meta.resolve(specifier))), '..');
    const wire = packageRoot('@eosrio/hyperion-wire-plugin/protocol-provider.json');
    const destination = join(directory, 'node_modules/@eosrio/hyperion-wire-plugin');
    for (const path of ['package.json', 'dist/protocol-provider.json', 'dist/protocol-node-artifact.json', 'dist/protocol-rust-artifact.json', 'dist/protocol-npm-lock.json']) copy(join(wire, path), join(destination, path));
    for (const name of ['protocol-node-artifact.json', 'protocol-rust-artifact.json'])
        for (const file of JSON.parse(readFileSync(join(wire, 'dist', name))).files) copy(join(wire, file.path), join(destination, file.path));
    const wireSDK = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(join(wire, 'package.json'))); assert(wireSDK);
    copy(wireSDK, join(destination, 'node_modules/@eosrio/hyperion-sdk/package.json'));
    codeTree(join(dirname(wireSDK), 'dist'), join(destination, 'node_modules/@eosrio/hyperion-sdk/dist'));
    const isolated = await import(pathToFileURL(gate).href);
    assert.deepEqual(isolated.admitNativeApiSourceOptions({engineeringSourceProfile: profile}), actual); cases++;
    const alter = (path, change, expected) => {
        const original = readFileSync(path);
        try {writeFileSync(path, change(original)); assert.throws(() => isolated.admitNativeApiSourceOptions({engineeringSourceProfile: profile}), expected); cases++;}
        finally {writeFileSync(path, original);}
        assert.deepEqual(isolated.admitNativeApiSourceOptions({engineeringSourceProfile: profile}), actual);
    };
    const json = change => bytes => Buffer.from(JSON.stringify(change(JSON.parse(bytes))));
    alter(join(destination, 'package.json'), json(value => ({...value, name: '@other/wire'})), /Wire packageSha256/);
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, sourceRevision: 'd'.repeat(40)})), /Wire nodeSha256/);
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, files: [{...value.files[0], sha256: 'd'.repeat(64)}, ...value.files.slice(1)]})), /Wire nodeSha256/);
    alter(join(destination, 'dist/provider.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong installed artifact\n')]), /Wire member/);
    for (const path of ['node_modules/@eosrio/hyperion-sdk/package.json','packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/package.json'])
        alter(join(directory,path),bytes=>Buffer.concat([bytes,Buffer.from(' ')]),/installed SDK package bytes/);
    alter(join(directory, 'node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong SDK tree\n')]), /Whole indexed emission inventories/);
    alter(join(directory, 'packages/backend-mongodb/dist/stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong native tree\n')]), /Whole indexed emission inventories/);
    alter(join(directory, 'build/api/helpers/stateful-owner.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong host artifact\n')]), /Whole indexed emission inventories/);
    alter(join(directory, 'src/api/helpers/stateful-owner.ts'), bytes => Buffer.from(bytes.toString().replace(/\n/g, '\r\n')), /Raw Git-LF indexed source/);
    alter(join(directory, '.github/workflows/build.yml'), bytes => Buffer.concat([bytes, Buffer.from('\n# wrong route source\n')]), /routing source/);
    for (const path of ['node_modules/mongodb/package.json','node_modules/bson/package.json',
        'packages/backend-mongodb/node_modules/mongodb/package.json','packages/backend-mongodb/node_modules/bson/package.json'])
        alter(join(directory, path), bytes => Buffer.concat([bytes, Buffer.from(' ')]), /scoped MongoDB\/BSON packages/);
    for (const path of ['node_modules/typescript/package.json','packages/backend-mongodb/node_modules/typescript/package.json'])
        alter(join(directory,path),json(value=>({...value,version:'0.0.0'})),/installed TypeScript compiler/);
    alter(join(directory, 'package-lock.json'), json(value => {
        value.packages['node_modules/@eosrio/hyperion-sdk'].resolved = 'git+https://other.invalid/eosrio/hyperion-sdk.git#' + 'd'.repeat(40); return value;
    }), /Raw Git-LF indexed source/);
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
        assert.equal(selected.sdkRevision, 'dc20a03f2b60ba05a3369d677222a9cf0d65d299');
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
