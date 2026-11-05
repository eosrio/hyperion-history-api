// Portable source-byte mutation controls. No child, timer, native fixture, network or service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync,realpathSync,lstatSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {observeWire34CbfbSourceOptions,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE as profile, WIRE34_CBFB_MANIFEST} from '../unit/wire34-cbfb-source-admission.mjs';
import {NATIVE_CLEANUP_TRACE_ASSEMBLY as CURRENT_NATIVE_ASSEMBLY} from '../unit/native-cleanup-trace-source-admission.mjs';
import {DESCRIPTOR} from '../../scripts/qualification/indexed-schema-mongodb/wire34-cbfb-assembly.mjs';
const ASSEMBLY=DESCRIPTOR.observation;
test('Wire34 isolated source-byte mutations reject all installed dependency, SDK, Wire, emission and routing families',async()=>{
const actual=observeWire34CbfbSourceOptions({engineeringSourceProfile:profile});let cases=0;
const parent = realpathSync(tmpdir()), directory = mkdtempSync(join(parent, 'hapi-complete-kind # % -'));
const copy = (from, to) => {mkdirSync(dirname(to), {recursive: true}); copyFileSync(from, to);};
const codeTree = (from, to) => {for (const entry of readdirSync(from, {withFileTypes: true})) {
    assert(!entry.isSymbolicLink()); if (entry.isDirectory()) codeTree(join(from, entry.name), join(to, entry.name));
    else {assert(entry.isFile()); copy(join(from, entry.name), join(to, entry.name));}
}};
try {
    // Copy the complete newly admitted source/native/SDK/driver/BSON graph, never infer receiving SDK parity.
    for (const path of [...WIRE34_CBFB_MANIFEST.sources.files.map(row => row.path), ...WIRE34_CBFB_MANIFEST.sources.excludedToAvoidHashCycles])
        copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const path of ['build','packages/backend-mongodb/dist','node_modules/@eosrio/hyperion-sdk','packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk',
        'node_modules/mongodb','node_modules/bson','packages/backend-mongodb/node_modules/mongodb','packages/backend-mongodb/node_modules/bson'])
        codeTree(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    for (const path of ['node_modules/typescript/package.json', 'packages/backend-mongodb/node_modules/typescript/package.json'])
        copy(fileURLToPath(new URL('../../' + path, import.meta.url)), join(directory, path));
    const gate = join(directory, 'tests/unit/wire34-cbfb-source-admission.mjs');
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
    assert.deepEqual(isolated.observeWire34CbfbSourceOptions({engineeringSourceProfile: profile}), actual); cases++;
    const alter = (path, change, expected) => {
        const original = readFileSync(path);
        try {writeFileSync(path, change(original)); assert.throws(() => isolated.observeWire34CbfbSourceOptions({engineeringSourceProfile: profile}), expected); cases++;}
        finally {writeFileSync(path, original);}
        assert.deepEqual(isolated.observeWire34CbfbSourceOptions({engineeringSourceProfile: profile}), actual);
    };
    const json = change => bytes => Buffer.from(JSON.stringify(change(JSON.parse(bytes))));
    alter(join(destination, 'package.json'), json(value => ({...value, name: '@other/wire'})));
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, sourceRevision: 'd'.repeat(40)})));
    alter(join(destination, 'dist/protocol-node-artifact.json'), json(value => ({...value, files: [{...value.files[0], sha256: 'd'.repeat(64)}, ...value.files.slice(1)]})));
    alter(join(destination, 'dist/provider.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong installed artifact\n')]));
    for (const path of ['node_modules/@eosrio/hyperion-sdk/package.json','packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/package.json'])
        alter(join(directory,path),bytes=>Buffer.concat([bytes,Buffer.from(' ')]));
    alter(join(directory, 'node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong SDK tree\n')]));
    alter(join(directory, 'packages/backend-mongodb/dist/stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong native tree\n')]));
    alter(join(directory, 'build/api/helpers/stateful-owner.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// wrong host artifact\n')]));
    alter(join(directory, 'src/api/helpers/stateful-owner.ts'), bytes => Buffer.from(bytes.toString().replace(/\n/g, '\r\n')));
    alter(join(directory, '.github/workflows/build.yml'), bytes => Buffer.concat([bytes, Buffer.from('\n# wrong route source\n')]));
    for (const path of ['node_modules/mongodb/package.json','node_modules/bson/package.json',
        'packages/backend-mongodb/node_modules/mongodb/package.json','packages/backend-mongodb/node_modules/bson/package.json'])
        alter(join(directory, path), bytes => Buffer.concat([bytes, Buffer.from(' ')]));
    for (const path of ['node_modules/typescript/package.json','packages/backend-mongodb/node_modules/typescript/package.json'])
        alter(join(directory,path),json(value=>({...value,version:'0.0.0'})));
    alter(join(directory, 'package-lock.json'), json(value => {
        value.packages['node_modules/@eosrio/hyperion-sdk'].resolved = 'git+https://other.invalid/eosrio/hyperion-sdk.git#' + 'd'.repeat(40); return value;
    }));


    alter(join(destination, 'dist/protocol-rust-artifact.json'), json(value => ({...value, sourceRevision: 'e'.repeat(40)})));
    alter(join(destination, 'dist/protocol-npm-lock.json'), json(value => ({...value, lockfileVersion: 0})));
    alter(join(destination, 'node_modules/@eosrio/hyperion-sdk/dist/index.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// different nested SDK\n')]));
    alter(join(directory, 'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js'), bytes => Buffer.concat([bytes, Buffer.from('\n// different native SDK tree\n')]));

    assert.equal(cases,23);
} finally {
    const absolute=realpathSync(directory);assert.equal(dirname(absolute),parent);assert(basename(absolute).startsWith('hapi-complete-kind # % -'));assert(!lstatSync(directory).isSymbolicLink());
    rmSync(absolute,{recursive:true,force:true});
}
});
