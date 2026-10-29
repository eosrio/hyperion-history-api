/** Internal qualification only. Neither option authorizes a release/default distribution or launch. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';

export const STATEFUL_ENGINEERING_API_SOURCE_PROFILE = 'stateful-owner-v2-18d235e-engineering';
const oldWire = '7167659e9c043cb3351074fcacb40200cc57f3a3', wire = '18d235e34a9b7ab8c3e9f9a322874444d90eed8a';
const sdk = '58d68c5cea81490bbb1c9a7736d633d465bab3ef';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => {assert(statSync(path).size <= 4 * 1024 * 1024, 'Qualification metadata byte bound');
    const bytes = readFileSync(path); return {bytes, json: JSON.parse(bytes), sha256: sha(bytes)};};
const exact = (actual, expected, label) => assert.equal(actual, expected, 'Unqualified ' + label);
const rootFor = specifier => realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve(specifier))), '..'));
function inventory(root) {
    const rows = []; let bytes = 0;
    const visit = directory => {
        for (const member of readdirSync(directory, {withFileTypes: true})) {
            const path = resolve(directory, member.name);
            assert(!member.isSymbolicLink(), 'Qualification inventory symlink');
            if (member.isDirectory()) visit(path);
            else {assert(member.isFile()); bytes += statSync(path).size;
                assert(rows.length < 512 && bytes <= 64 * 1024 * 1024, 'Qualification inventory bound'); const body = readFileSync(path);
                rows.push([relative(root, path).replaceAll('\\', '/'), sha(body)]);}
        }
    };
    visit(root); rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return {files: rows.length, sha256: sha(JSON.stringify(rows))};
}
function members(root, manifest) {
    assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 512);
    const seen = new Set(); let bytes = 0;
    for (const file of manifest.files) {
        assert(typeof file.path === 'string' && !isAbsolute(file.path) && !file.path.includes('\\') && !seen.has(file.path));
        seen.add(file.path); const path = realpathSync(resolve(root, file.path)), inner = relative(root, path);
        assert(inner !== '..' && !inner.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(inner));
        bytes += statSync(path).size; assert(bytes <= 64 * 1024 * 1024, 'Qualification member byte bound');
        exact(sha(readFileSync(path)), file.sha256, 'installed Wire artifact member');
    }
}
export function admitNativeApiSourceOptions(input = {}) {
    assert(input && Object.getPrototypeOf(input) === Object.prototype && !Object.getOwnPropertySymbols(input).length, 'Inert qualification options required');
    const properties = Object.getOwnPropertyDescriptors(input);
    assert(Object.entries(properties).every(([key, value]) => ['nativeMarker', 'engineeringSourceProfile'].includes(key)
        && value.enumerable && Object.hasOwn(value, 'value')), 'Qualification default-path override refused');
    const nativeMarker = properties.nativeMarker?.value ?? true, profile = properties.engineeringSourceProfile?.value;
    assert(typeof nativeMarker === 'boolean');
    assert(profile === undefined || profile === STATEFUL_ENGINEERING_API_SOURCE_PROFILE, 'Unknown engineering source profile');
    const root = rootFor('@eosrio/hyperion-wire-plugin/protocol-provider.json'), pkg = read(resolve(root, 'package.json'));
    exact(pkg.json.name, '@eosrio/hyperion-wire-plugin', 'Wire package');
    const descriptor = read(resolve(root, 'dist/protocol-provider.json'));
    const node = read(resolve(root, 'dist/protocol-node-artifact.json')), rust = read(resolve(root, 'dist/protocol-rust-artifact.json'));
    for (const artifact of [node, rust]) {exact(artifact.json.sourceRevision, profile === undefined ? oldWire : wire, 'Wire source revision'); exact(artifact.json.sourceModified, false, 'modified Wire source');}
    const lock = read(fileURLToPath(new URL('../../package-lock.json', import.meta.url))).json;
    const checkPin = (name, revision) => {
        const selected = lock.packages['node_modules/' + name];
        assert(['git+https://github.com/', 'git+ssh://git@github.com/'].some(prefix => selected?.resolved === prefix + 'eosrio/'
            + name.split('/')[1] + '.git#' + revision), 'Unqualified coordinated lock source');
    };
    if (profile === undefined) {checkPin('@eosrio/hyperion-wire-plugin', oldWire);
        return Object.freeze({nativeMarker, wireRevision: oldWire, profile: 'default-716', qualificationOnly: true});}
    exact(pkg.sha256, '3795011555117b2b5f7a05924a0b3e168851308080e4862955e40a96fef9168e', 'Wire package bytes');
    exact(descriptor.sha256, 'ed711d3ca0175c69b08646f052caa952f123a1128ae1a30f2d8e10d23dbf1706', 'Wire descriptor');
    exact(node.sha256, '6f8da4ef4317986116d1e58d129abe62606f6bafc0daf84be9ea75b9c3e2fef6', 'Wire Node artifact');
    exact(rust.sha256, 'ae99a8f13e223273c6e54fe8495338eac09179fc79b8dc135f2b530645e22fbb', 'Wire Rust artifact');
    members(root, node.json); members(root, rust.json);
    exact(pkg.json.dependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + sdk, 'Wire SDK pin');
    const {sdkFiles, nativeFiles} = coordinatedRuntime();
    checkPin('@eosrio/hyperion-wire-plugin', wire); checkPin('@eosrio/hyperion-sdk', sdk);
    return Object.freeze({nativeMarker, wireRevision: wire, profile, descriptorSha256: descriptor.sha256, nodeSha256: node.sha256,
        rustSha256: rust.sha256, sdkFiles, nativeFiles, wireTree: '719a03aa0ea7b72d6a7411cfaaad78b05a1a8c4a',
        sdkTree: '1f666cff5afe489b66e8a3729502b9a5978c5138', nativeTree: 'e1c51022e4478975538d0dd7d4d31f8ed63790b8', qualificationOnly: true});
}

function coordinatedRuntime() {
    const sdkRoot = rootFor('@eosrio/hyperion-sdk/projection-stateful-owner-v2');
    const nativeRoot = rootFor('@eosrio/hyperion-backend-mongodb/stateful-owner-v2');
    const sdkPackage = read(resolve(sdkRoot, 'package.json')), nativePackage = read(resolve(nativeRoot, 'package.json'));
    exact(sdkPackage.sha256, '2e11db52cf8d150e30d165bafb962b50c6ad0cc764770714ea7fdca48a5e4684', 'SDK package');
    assert(['83ac5fdb7e9d49dc1c1028c30acab01709b05e0726d21498ff3531380efbab08',
        '0dad5f2e404773fe1603495ea29d4bd60ab63354f85c7e9346d8baf9726f6d42'].includes(nativePackage.sha256), 'Unqualified native package bytes');
    exact(nativePackage.json.devDependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + sdk, 'native SDK source pin');
    const sdkFiles = inventory(resolve(sdkRoot, 'dist')), nativeFiles = inventory(resolve(nativeRoot, 'dist'));
    exact(sdkFiles.files, 31, 'SDK emission count'); exact(sdkFiles.sha256, 'df919dbdbfe8eb6c0b0f05a7f4b4ddabf42095d9da1e2621d0adba250fd3b7cc', 'SDK emissions');
    exact(nativeFiles.files, 30, 'native emission count'); exact(nativeFiles.sha256, '6b9b8355aa2eca52a26d0e395d85c71679b414c348b466f614e6321f42b64e24', 'native emissions');
    const nativeSdk = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(resolve(nativeRoot, 'package.json')));
    assert(nativeSdk, 'Native runtime SDK is absent');
    exact(read(nativeSdk).sha256, sdkPackage.sha256, 'native runtime SDK package');
    exact(inventory(resolve(dirname(nativeSdk), 'dist')).sha256, sdkFiles.sha256, 'native runtime SDK emissions');
    return {sdkFiles, nativeFiles};
}

/** #392: explicit CI selection, fixed source set, no caller-provided authority or executable imports. */
export function admitNativeSourceEnvironment() {
    const selected = process.env.HYPERION_NATIVE_SOURCE_PROFILE;
    return admitCoordinatedNativeSourceOptions(selected === undefined || selected === '' ? {} : {engineeringSourceProfile: selected});
}
export function admitCoordinatedNativeSourceOptions(options = {}) {
    const admission = admitNativeApiSourceOptions(options);
    const root = rootFor('@eosrio/hyperion-wire-plugin/protocol-provider.json');
    const lock = read(fileURLToPath(new URL('../../package-lock.json', import.meta.url))).json;
    const pin = (name, revision) => assert(['git+https://github.com/', 'git+ssh://git@github.com/'].some(prefix =>
        lock.packages['node_modules/' + name]?.resolved === prefix + 'eosrio/' + name.split('/')[1] + '.git#' + revision), 'Unqualified coordinated lock source');
    pin('@eosrio/hyperion-sdk', sdk);
    const runtime = coordinatedRuntime();
    const wireSdkRevision = admission.profile === 'default-716' ? '339b5c93d1338968c18ed14254961439dcab16a0' : sdk;
    if (admission.profile === 'default-716') {
        for (const [path, expected] of [
            ['package.json', '60aa988bdad575945f23165fc22abf63f1bdcde68f0f565bc4db4fb23cea0a1d'],
            ['dist/protocol-provider.json', '7c5743a1c426859fe26aa98f1622914720f3b2594fc1a07eb2511d2fa864d24e'],
            ['dist/protocol-node-artifact.json', 'c762dabcddc9a7910d03ad793924214cdc1092377b13b9b61543434435bb0329'],
            ['dist/protocol-rust-artifact.json', '2e8324085338e2eb26720c526704aefc12a95fd0940959b29939d0e498ed6819'],
            ['dist/protocol-npm-lock.json', '2a1a0ba35057281c6a6c1693a928b2badc66a389103d1dd78677c99c13a9fb27']
        ]) exact(read(resolve(root, path)).sha256, expected, 'default716 ' + path);
        for (const runtime of ['node', 'rust']) members(root, read(resolve(root, 'dist/protocol-' + runtime + '-artifact.json')).json);
    }
    const prepared = read(resolve(root, 'dist/protocol-npm-lock.json')).json;
    exact(prepared.packages[''].dependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + wireSdkRevision, 'prepared Wire SDK source');
    const localSdk = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(resolve(root, 'package.json')));
    assert(localSdk, 'Wire runtime SDK is absent');
    const legacy = admission.profile === 'default-716';
    exact(read(localSdk).sha256, legacy ? '05600276ecf6029572dcce317f73fcb0231e3100482bb81d2fa8f17243179ab3'
        : '2e11db52cf8d150e30d165bafb962b50c6ad0cc764770714ea7fdca48a5e4684', 'Wire runtime SDK package');
    const localFiles = inventory(resolve(dirname(localSdk), 'dist'));
    exact(localFiles.files, legacy ? 13 : 31, 'Wire runtime SDK count');
    exact(localFiles.sha256, legacy ? 'cd5f6c2a8e4f4c520b01b533fe294a8d7c8cd0428d847be2e50ee84b0bbfebb3'
        : 'df919dbdbfe8eb6c0b0f05a7f4b4ddabf42095d9da1e2621d0adba250fd3b7cc', 'Wire runtime SDK emissions');
    return Object.freeze({...admission, sdkRevision: sdk, wireSdkRevision, ...runtime, wireSdkFiles: localFiles});
}
