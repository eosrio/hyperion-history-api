// Explicit current engineering assembly, separate from every frozen historical profile.
import assert from 'node:assert/strict';
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';
import {admitOperatorListAssembly, OPERATOR_LIST_PROFILE, OPERATOR_LIST_ASSEMBLY} from '../../scripts/qualification/operator-list-mongodb/linux-source-profile.mjs';
import {inventory} from '../../scripts/qualification/operator-list-mongodb/inventory.mjs';
import {sha} from '../../scripts/qualification/operator-list-mongodb/contract.mjs';
const freeze = value => {if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;};
export const CURRENT_NATIVE_ASSEMBLY = freeze(JSON.parse(readFileSync(new URL('../fixtures/engineering-profiles/current-native45-linux.json', import.meta.url))));
export const STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE = CURRENT_NATIVE_ASSEMBLY.profile;
assert.equal(STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, 'stateful-owner-v2-root741-native429-wire69-native45-linux-gitlf-engineering');
assert.equal(CURRENT_NATIVE_ASSEMBLY.assemblyProfile, OPERATOR_LIST_PROFILE);
assert.equal(CURRENT_NATIVE_ASSEMBLY.schemaVersion, 1); assert.equal(CURRENT_NATIVE_ASSEMBLY.qualificationOnly, true);
assert.equal(CURRENT_NATIVE_ASSEMBLY.rootSDK, OPERATOR_LIST_ASSEMBLY.pins.rootSDK);
assert.equal(CURRENT_NATIVE_ASSEMBLY.nativeSDK, OPERATOR_LIST_ASSEMBLY.pins.nativeSDK);
assert.equal(CURRENT_NATIVE_ASSEMBLY.wire.commit, OPERATOR_LIST_ASSEMBLY.pins.Wire);
assert.equal(CURRENT_NATIVE_ASSEMBLY.productSource.commit, OPERATOR_LIST_ASSEMBLY.productSource.commit);
assert.equal(CURRENT_NATIVE_ASSEMBLY.productSource.tree, OPERATOR_LIST_ASSEMBLY.productSource.tree);
const root = fileURLToPath(new URL('../../', import.meta.url));
const exact = (actual, expected, label) => assert.deepEqual(actual, expected, 'Unqualified current ' + label);
const raw = path => {
    const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, 'Current qualification source bound');
    const bytes = readFileSync(path); assert.equal(bytes.length, stat.size); return bytes;
};
const read = path => {
    const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, 'Current qualification metadata bound');
    const bytes = readFileSync(path); assert.equal(bytes.length, stat.size); return {bytes, json: JSON.parse(bytes), sha256: sha(bytes)};
};
function members(directory, manifest) {
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 512);
    const seen = new Set(); let total = 0; directory = realpathSync(directory);
    for (const file of manifest.files) {
        assert.ok(typeof file.path === 'string' && !isAbsolute(file.path) && !file.path.includes('\\') && !seen.has(file.path));
        seen.add(file.path); const candidate = resolve(directory, file.path), actual = realpathSync(candidate), inner = relative(directory, actual);
        assert.ok(inner && inner !== '..' && !inner.startsWith('../') && !inner.startsWith('..\\') && !isAbsolute(inner), 'Current Wire member escaped package');
        assert.equal(lstatSync(candidate).isSymbolicLink(), false); const stat = lstatSync(actual); assert.ok(stat.isFile());
        total += stat.size; assert.ok(total <= 64 * 1024 * 1024, 'Current Wire member byte bound');
        const bytes = readFileSync(actual); assert.equal(bytes.length, stat.size); exact(sha(bytes), file.sha256, 'Wire artifact member');
    }
}
export function assertCurrentNativeOptions(input = {}) {
    assert.ok(input && Object.getPrototypeOf(input) === Object.prototype && !Object.getOwnPropertySymbols(input).length, 'Inert current qualification options required');
    const properties = Object.getOwnPropertyDescriptors(input);
    assert.ok(Object.entries(properties).every(([key, value]) => ['nativeMarker', 'engineeringSourceProfile'].includes(key)
        && value.enumerable && Object.hasOwn(value, 'value')), 'Current qualification default override refused');
    const nativeMarker = properties.nativeMarker?.value ?? true, profile = properties.engineeringSourceProfile?.value;
    assert.equal(typeof nativeMarker, 'boolean'); exact(profile, STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE, 'explicit profile selection');
    return {nativeMarker, profile};
}
export function assertCurrentHelperSources() {
    assert.ok(Object.keys(CURRENT_NATIVE_ASSEMBLY.helperSources).length >= 2, 'Current helper source pins absent');
    for (const [path, expected] of Object.entries(CURRENT_NATIVE_ASSEMBLY.helperSources))
        exact(sha(raw(resolve(root, path))), expected, 'Git-LF helper ' + path);
}
export function admitCurrentNativeApiSourceOptions(input = {}) {
    const {nativeMarker, profile} = assertCurrentNativeOptions(input);
    assertCurrentHelperSources();
    // This independently selected profile validates all caller/native/source/SDK/driver/BSON trees and exact runtime metadata.
    const assembly = admitOperatorListAssembly(OPERATOR_LIST_PROFILE), expected = CURRENT_NATIVE_ASSEMBLY;
    for (const [path, expectedHash] of expected.callerSources)
        exact(sha(raw(resolve(root, path))), expectedHash, 'Git-LF caller ' + path);
    const wireRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))), '..'));
    const pkg = read(resolve(wireRoot, 'package.json')), descriptor = read(resolve(wireRoot, 'dist/protocol-provider.json'));
    const node = read(resolve(wireRoot, 'dist/protocol-node-artifact.json')), rust = read(resolve(wireRoot, 'dist/protocol-rust-artifact.json'));
    exact(pkg.json.name, '@eosrio/hyperion-wire-plugin', 'Wire package');
    for (const artifact of [node, rust]) {exact(artifact.json.sourceRevision, expected.wire.commit, 'Wire source revision'); exact(artifact.json.sourceModified, false, 'modified Wire source');}
    exact(pkg.sha256, expected.wire.packageSha256, 'Wire package bytes'); exact(descriptor.sha256, expected.wire.descriptorSha256, 'Wire descriptor');
    exact(node.sha256, expected.wire.nodeSha256, 'Wire Node artifact'); exact(rust.sha256, expected.wire.rustSha256, 'Wire Rust artifact');
    const prepared = read(resolve(wireRoot, 'dist/protocol-npm-lock.json'));
    exact(prepared.sha256, expected.wire.npmLockSha256, 'Wire prepared lock bytes'); members(wireRoot, node.json); members(wireRoot, rust.json);
    const pin = 'git+https://github.com/eosrio/hyperion-sdk.git#' + expected.wireSDK;
    exact(pkg.json.dependencies['@eosrio/hyperion-sdk'], pin, 'Wire SDK source');
    exact(prepared.json.packages[''].dependencies['@eosrio/hyperion-sdk'], pin, 'prepared Wire SDK source');
    const localSdk = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(resolve(wireRoot, 'package.json'))); assert.ok(localSdk, 'Wire runtime SDK absent');
    exact(read(localSdk).sha256, expected.wireSDKPackageSha256, 'Wire runtime SDK package');
    const pairs = inventory(resolve(dirname(localSdk), 'dist')).map(row => [row.path, row.sha256]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const wireSdkFiles = {files: pairs.length, sha256: sha(JSON.stringify(pairs)), format: 'sorted-path-sha256-pairs-v1'};
    exact(wireSdkFiles, expected.wireSDKFiles, 'Wire runtime SDK emissions');
    const files = name => ({files: assembly.trees[name].files, sha256: assembly.trees[name].sha256, format: 'path-bytes-sha256-inventory-v1'});
    return freeze({nativeMarker, profile, qualificationOnly: true, wireRevision: expected.wire.commit, wireTree: expected.wire.tree,
        descriptorSha256: descriptor.sha256, nodeSha256: node.sha256, rustSha256: rust.sha256,
        sdkRevision: expected.rootSDK, nativeSDKRevision: expected.nativeSDK, wireSdkRevision: expected.wireSDK,
        sdkTree: expected.rootSDKTree, nativeSDKTree: expected.nativeSDKTree,
        nativeSourceCommit: expected.productSource.commit, nativeTree: expected.productSource.tree,
        nativeSourceScope: 'eosrio/hyperion-history-api:packages/backend-mongodb/src', callerSourceCommit: expected.productSource.commit,
        sdkFiles: files('rootSDK'), nativeSDKFiles: files('nativeSDK'), nativeFiles: files('nativeBuild'), callerFiles: files('rootBuild'), wireSdkFiles,
        assemblyProfile: OPERATOR_LIST_PROFILE, assemblySha256: assembly.assemblySha256,
        runtime: assembly.runtime, engineeringRuntimeCandidate: assembly.engineeringRuntimeCandidate, runtimeAcceptance: assembly.runtimeAcceptance,
        sourceInventories: OPERATOR_LIST_ASSEMBLY.trees, acceptance: expected.acceptance});
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    assert.deepEqual(process.argv.slice(2), ['--admit-current'], 'Current source CLI requires explicit --admit-current');
    console.log(JSON.stringify(admitCurrentNativeApiSourceOptions({engineeringSourceProfile: STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE}), null, 2));
}
