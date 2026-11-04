// Portable source-byte mutation controls. No child, timer, native fixture, network or service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {observeAllCbfbSourceOptions,STATEFUL_ALL_CBFB_SOURCE_PROFILE as profile} from '../unit/all-cbfb-source-admission.mjs';
import {NATIVE_CLEANUP_TRACE_ASSEMBLY as CURRENT_NATIVE_ASSEMBLY} from '../unit/native-cleanup-trace-source-admission.mjs';
import {DESCRIPTOR} from '../../scripts/qualification/indexed-schema-mongodb/all-cbfb-assembly.mjs';
const ASSEMBLY=DESCRIPTOR.observation;
test('actual isolated source-byte mutations reject all installed dependency, SDK, Wire, emission and routing families',async()=>{
const actual=observeAllCbfbSourceOptions({engineeringSourceProfile:profile});let cases=0;
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
    const nativeProfile=JSON.parse(readFileSync(new URL('../../scripts/qualification/indexed-schema-mongodb/all-cbfb-native-profile.json',import.meta.url)));
    for(const row of nativeProfile.sourceFiles)copy(fileURLToPath(new URL('../../'+row.path,import.meta.url)),join(directory,row.path));
    const gate = join(directory, 'tests/unit/all-cbfb-source-admission.mjs');
    for (const path of Object.keys(CURRENT_NATIVE_ASSEMBLY.helperSources)) copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const path of ['tests/unit/all-cbfb-source-admission.mjs','tests/fixtures/engineering-profiles/all-cbfb-linux.json',
        'tests/unit/sdk49-indexed-source-admission.mjs','tests/fixtures/engineering-profiles/sdk49-indexed-linux.json',
        'scripts/qualification/indexed-schema-mongodb/assembly.mjs','scripts/qualification/indexed-schema-mongodb/assembly.json'])
        copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const row of JSON.parse(readFileSync(new URL('../fixtures/engineering-profiles/all-cbfb-linux.json', import.meta.url))).routeSources)
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
    assert.deepEqual(isolated.observeAllCbfbSourceOptions({engineeringSourceProfile: profile}), actual); cases++;
    const alter = (path, change, expected) => {
        const original = readFileSync(path);
        try {writeFileSync(path, change(original)); assert.throws(() => isolated.observeAllCbfbSourceOptions({engineeringSourceProfile: profile}), expected); cases++;}
        finally {writeFileSync(path, original);}
        assert.deepEqual(isolated.observeAllCbfbSourceOptions({engineeringSourceProfile: profile}), actual);
    };
    const json = change => bytes => Buffer.from(JSON.stringify(change(JSON.parse(bytes))));
    alter(join(destination, 'package.json'), json(value => ({...value, name: '@other/wire'})), /Wire packageSha256/);
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, sourceRevision: 'd'.repeat(40)})), /Wire nodeSha256/);
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, files: [{...value.files[0], sha256: 'd'.repeat(64)}, ...value.files.slice(1)]})), /Wire nodeSha256/);
    alter(join(destination, 'dist/provider.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong installed artifact\n')]), /Wire member/);
    for (const path of ['node_modules/@eosrio/hyperion-sdk/package.json','packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/package.json'])
        alter(join(directory,path),bytes=>Buffer.concat([bytes,Buffer.from(' ')]),/installed (?:root|native) SDK package bytes/);
    alter(join(directory, 'node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong SDK tree\n')]), /Exact all-CBFB source\/emission assembly differs/);
    alter(join(directory, 'packages/backend-mongodb/dist/stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong native tree\n')]), /Exact all-CBFB source\/emission assembly differs/);
    alter(join(directory, 'build/api/helpers/stateful-owner.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong host artifact\n')]), /Exact all-CBFB source\/emission assembly differs/);
    alter(join(directory, 'src/api/helpers/stateful-owner.ts'), bytes => Buffer.from(bytes.toString().replace(/\n/g, '\r\n')), /Exact all-CBFB source\/emission assembly differs/);
    alter(join(directory, '.github/workflows/build.yml'), bytes => Buffer.concat([bytes, Buffer.from('\n# wrong route source\n')]), /routing source/);
    for (const path of ['node_modules/mongodb/package.json','node_modules/bson/package.json',
        'packages/backend-mongodb/node_modules/mongodb/package.json','packages/backend-mongodb/node_modules/bson/package.json'])
        alter(join(directory, path), bytes => Buffer.concat([bytes, Buffer.from(' ')]), /scoped MongoDB\/BSON packages/);
    for (const path of ['node_modules/typescript/package.json','packages/backend-mongodb/node_modules/typescript/package.json'])
        alter(join(directory,path),json(value=>({...value,version:'0.0.0'})),/installed TypeScript compiler/);
    alter(join(directory, 'package-lock.json'), json(value => {
        value.packages['node_modules/@eosrio/hyperion-sdk'].resolved = 'git+https://other.invalid/eosrio/hyperion-sdk.git#' + 'd'.repeat(40); return value;
    }), /Exact all-CBFB source\/emission assembly differs/);


    alter(join(destination, 'dist/protocol-rust-artifact.json'), json(value => ({...value, sourceRevision: 'e'.repeat(40)})), /Wire rustSha256/);
    alter(join(destination, 'dist/protocol-npm-lock.json'), json(value => ({...value, lockfileVersion: 0})), /Wire npmLockSha256/);
    alter(join(destination, 'node_modules/@eosrio/hyperion-sdk/dist/index.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// different nested SDK\n')]), /Wire SDK emissions/);
    alter(join(directory, 'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// different native SDK tree\n')]), /Exact all-CBFB source\/emission assembly differs/);

    assert.equal(cases,23);
} finally {
    const absolute=realpathSync(directory);assert.equal(dirname(absolute),parent);assert(basename(absolute).startsWith('hapi-complete-kind # % -'));assert(!lstatSync(directory).isSymbolicLink());
    rmSync(absolute,{recursive:true,force:true});
}
});
