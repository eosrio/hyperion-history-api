/** Internal qualification only. Neither option authorizes a release/default distribution or launch. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {findPackageJSON} from 'node:module';

export const STATEFUL_ENGINEERING_API_SOURCE_PROFILE = 'stateful-owner-v2-18d235e-engineering';
export const STATEFUL_ACTION_METADATA_API_SOURCE_PROFILE = 'stateful-owner-v2-dd85ee5-18d235e-engineering';
export const STATEFUL_ACTION_METADATA_LEGACY_SOURCE_PROFILE = 'stateful-owner-v2-dd85ee5-7167659-engineering';
export const STATEFUL_METADATA_FIELDS_API_SOURCE_PROFILE = 'stateful-owner-v2-dd85ee5-18d235e-fields-engineering';
export const STATEFUL_METADATA_FIELDS_LEGACY_SOURCE_PROFILE = 'stateful-owner-v2-dd85ee5-7167659-fields-engineering';
export const STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE = 'stateful-owner-v2-7412889-18d235e-complete-kind-engineering';
export const STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE = 'stateful-owner-v2-7412889-18d235e-complete-kind-commands-engineering';
export const STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE = 'stateful-owner-v2-7412889-18d235e-complete-kind-executor-engineering';
export const STATEFUL_COMPLETE_KIND_EXECUTOR_NATIVE_SOURCE = Object.freeze({
    commit: '66d3a6b4152ba1ee6766b6ee3a22ccfe89b08224', tree: 'f21644e0642b67863524058dc62c574ee33d0061',
    files: 39, sha256: '8455fe288d51a02d39a143c9f152dd7ee6e3c3f098616d957c072b8aa8817d4a',
});
export const STATEFUL_COMPLETE_KIND_COMMANDS_NATIVE_SOURCE = Object.freeze({
    commit: '05c60d93f4d35d1d17edf5cba8ca3caddc8ee481', tree: '4d15a2043667b072261ba90dd7f0eef760a9272f',
    files: 36, sha256: '31c606437a5f65282eff845ca1653e6bfa8941d3ccfea4b87a2544a5ef54c3b1',
});
export const STATEFUL_COMPLETE_KIND_NATIVE_SOURCE = Object.freeze({
    commit: '71dc69240f87b4dfc98e6089ec7e075564457055', tree: '218071940baf5a7e773dc8d9df50d32b2d85e86a',
    files: 36, sha256: '53e26e3d0e564bc6b02265341c139054c5d79b4924bf14eb1cdbf39dc4ef0e50',
});
export const STATEFUL_COMPLETE_KIND_CALLER_SOURCE = Object.freeze({
    commit: '0f79994142add7d6c8a2c7b5491ea8a0e1d7adf2', files: 550,
    sha256: 'cebd1a2dc8e2b8ebdc36fef361017b88593d60405824b62ff68aba01878fd3d8',
    sources: Object.freeze([
        ['src/api/helpers/stateful-owner.ts', '8bdf6914852f2d9f008adbfd81fe83c0b3f94d6a2928f5567147a9030f72cb82'],
        ['src/indexer/connections/stateful-complete-kind-client.ts', '37ee22762dda7b1a10c9adbe036e1e0b2d19b8d39b9c2cc5391fca83ba0fb906'],
        ['src/indexer/connections/manager.class.ts', 'e5949cd8f0a539439a01e032770d9891e5037c801076335c52fb7ebb8da19807'],
        ['src/indexer/projection/stateful-plugin.ts', '4b1fbd3ba70be572020f8cf4e2928c3f6894ffe9e5503aa247cb74be47960622'],
        ['src/indexer/projection/stateful-registry.ts', 'f9dad39ff1a9911cba887e75bb11fe4cfdad2896f94a6a6d2eda31cc9d6783d6'],
        ['src/indexer/workers/projection.ts', '596e0969a1e0613f817d5ec65abcadaa2ac896c682bf7b18029e45cb999d4ad1'],
        ['src/indexer/projection/controller.ts', 'eadbbebe2b4ae7d19e372c1132174cbedc6c258ea83d17b98c2c7a9bbf8429b6'],
        ['src/indexer/projection/runtime.ts', '697c2ed177bc51e04cb9170debf644d595bcc7bcc1f4c8f7735f1415648f6785'],
    ]),
});
// Production source was committed before these additive qualification profiles.
export const STATEFUL_METADATA_FIELDS_NATIVE_SOURCE = Object.freeze({
    commit: '0b51a20c3d9a9b95c39a713c89cad6d55c5103d4', tree: '686850ba3acb00fc1f9424dd300483b83f84c654',
    files: 30, sha256: '3686c0473d9304288c7bf54bf44ea481f528185724da1ce024a59f2d16bea76e',
});
const oldWire = '7167659e9c043cb3351074fcacb40200cc57f3a3', wire = '18d235e34a9b7ab8c3e9f9a322874444d90eed8a';
const sdk = '58d68c5cea81490bbb1c9a7736d633d465bab3ef';
const metadataSdk = 'dd85ee590dcd1e359509c6c41ee99b541706b1f6';
const completeKindSdk = '7412889a14c84342551fd864ea3ebfcf28849385';
const completeKindProfile = profile => profile === STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE || profile === STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE
    || profile === STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE;
const completeKindNativeSource = profile => profile === STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE ? STATEFUL_COMPLETE_KIND_EXECUTOR_NATIVE_SOURCE
    : profile === STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE ? STATEFUL_COMPLETE_KIND_COMMANDS_NATIVE_SOURCE : STATEFUL_COMPLETE_KIND_NATIVE_SOURCE;
const fieldsProfile = profile => profile === STATEFUL_METADATA_FIELDS_API_SOURCE_PROFILE || profile === STATEFUL_METADATA_FIELDS_LEGACY_SOURCE_PROFILE;
const metadataProfile = profile => profile === STATEFUL_ACTION_METADATA_API_SOURCE_PROFILE || profile === STATEFUL_ACTION_METADATA_LEGACY_SOURCE_PROFILE || fieldsProfile(profile);
const legacyProfile = profile => profile === 'default-716' || profile === STATEFUL_ACTION_METADATA_LEGACY_SOURCE_PROFILE || profile === STATEFUL_METADATA_FIELDS_LEGACY_SOURCE_PROFILE;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => {assert(statSync(path).size <= 4 * 1024 * 1024, 'Qualification metadata byte bound');
    const bytes = readFileSync(path); return {bytes, json: JSON.parse(bytes), sha256: sha(bytes)};};
const exact = (actual, expected, label) => assert.equal(actual, expected, 'Unqualified ' + label);
const rootFor = specifier => realpathSync(resolve(dirname(fileURLToPath(import.meta.resolve(specifier))), '..'));
function inventory(root, maximumFiles = 512) {
    const rows = []; let bytes = 0;
    const visit = directory => {
        for (const member of readdirSync(directory, {withFileTypes: true})) {
            const path = resolve(directory, member.name);
            assert(!member.isSymbolicLink(), 'Qualification inventory symlink');
            if (member.isDirectory()) visit(path);
            else {assert(member.isFile()); bytes += statSync(path).size;
                assert(rows.length < maximumFiles && bytes <= 64 * 1024 * 1024, 'Qualification inventory bound'); const body = readFileSync(path);
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
    assert(profile === undefined || profile === STATEFUL_ENGINEERING_API_SOURCE_PROFILE || metadataProfile(profile)
        || completeKindProfile(profile), 'Unknown engineering source profile');
    const root = rootFor('@eosrio/hyperion-wire-plugin/protocol-provider.json'), pkg = read(resolve(root, 'package.json'));
    exact(pkg.json.name, '@eosrio/hyperion-wire-plugin', 'Wire package');
    const descriptor = read(resolve(root, 'dist/protocol-provider.json'));
    const node = read(resolve(root, 'dist/protocol-node-artifact.json')), rust = read(resolve(root, 'dist/protocol-rust-artifact.json'));
    for (const artifact of [node, rust]) {exact(artifact.json.sourceRevision, profile === undefined || legacyProfile(profile) ? oldWire : wire, 'Wire source revision'); exact(artifact.json.sourceModified, false, 'modified Wire source');}
    const lock = read(fileURLToPath(new URL('../../package-lock.json', import.meta.url))).json;
    const checkPin = (name, revision) => {
        const selected = lock.packages['node_modules/' + name];
        assert(['git+https://github.com/', 'git+ssh://git@github.com/'].some(prefix => selected?.resolved === prefix + 'eosrio/'
            + name.split('/')[1] + '.git#' + revision), 'Unqualified coordinated lock source');
    };
    if (profile === undefined) {checkPin('@eosrio/hyperion-wire-plugin', oldWire);
        return Object.freeze({nativeMarker, wireRevision: oldWire, profile: 'default-716', qualificationOnly: true});}
    if (profile === STATEFUL_ACTION_METADATA_LEGACY_SOURCE_PROFILE || profile === STATEFUL_METADATA_FIELDS_LEGACY_SOURCE_PROFILE) {
        checkPin('@eosrio/hyperion-wire-plugin', oldWire); checkPin('@eosrio/hyperion-sdk', metadataSdk);
        legacyWireArtifacts(root);
        const runtime = coordinatedRuntime(profile);
        return Object.freeze({nativeMarker, wireRevision: oldWire, profile, ...runtime,
            sdkTree: 'd9a8af0b8d284facca5d28b5905a1b5ffc911200', nativeTree: fieldsProfile(profile) ? STATEFUL_METADATA_FIELDS_NATIVE_SOURCE.tree : '8c97c35eaa7dd64785ecc6c3ef30da9ac6d4b025',
            ...(fieldsProfile(profile) ? {nativeSourceCommit: STATEFUL_METADATA_FIELDS_NATIVE_SOURCE.commit} : {}), qualificationOnly: true});
    }
    exact(pkg.sha256, '3795011555117b2b5f7a05924a0b3e168851308080e4862955e40a96fef9168e', 'Wire package bytes');
    exact(descriptor.sha256, 'ed711d3ca0175c69b08646f052caa952f123a1128ae1a30f2d8e10d23dbf1706', 'Wire descriptor');
    exact(node.sha256, '6f8da4ef4317986116d1e58d129abe62606f6bafc0daf84be9ea75b9c3e2fef6', 'Wire Node artifact');
    exact(rust.sha256, 'ae99a8f13e223273c6e54fe8495338eac09179fc79b8dc135f2b530645e22fbb', 'Wire Rust artifact');
    members(root, node.json); members(root, rust.json);
    exact(pkg.json.dependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + sdk, 'Wire SDK pin');
    if (completeKindProfile(profile)) {
        checkPin('@eosrio/hyperion-wire-plugin', wire); checkPin('@eosrio/hyperion-sdk', completeKindSdk);
        const runtime = coordinatedRuntime(profile), nativeSource = completeKindNativeSource(profile);
        return Object.freeze({nativeMarker, wireRevision: wire, profile, ...runtime, wireTree: '719a03aa0ea7b72d6a7411cfaaad78b05a1a8c4a',
            sdkTree: 'c486de0538bf33b4d7a199147e97ba763d731bab', nativeTree: nativeSource.tree,
            nativeSourceCommit: nativeSource.commit, callerSourceCommit: STATEFUL_COMPLETE_KIND_CALLER_SOURCE.commit,
            qualificationOnly: true});
    }
    const {sdkFiles, nativeFiles} = coordinatedRuntime(profile);
    checkPin('@eosrio/hyperion-wire-plugin', wire); checkPin('@eosrio/hyperion-sdk', metadataProfile(profile) ? metadataSdk : sdk);
    return Object.freeze({nativeMarker, wireRevision: wire, profile, descriptorSha256: descriptor.sha256, nodeSha256: node.sha256,
        rustSha256: rust.sha256, sdkFiles, nativeFiles, wireTree: '719a03aa0ea7b72d6a7411cfaaad78b05a1a8c4a',
        sdkTree: metadataProfile(profile) ? 'd9a8af0b8d284facca5d28b5905a1b5ffc911200' : '1f666cff5afe489b66e8a3729502b9a5978c5138',
        nativeTree: fieldsProfile(profile) ? STATEFUL_METADATA_FIELDS_NATIVE_SOURCE.tree : metadataProfile(profile) ? '8c97c35eaa7dd64785ecc6c3ef30da9ac6d4b025' : 'e1c51022e4478975538d0dd7d4d31f8ed63790b8',
        ...(fieldsProfile(profile) ? {nativeSourceCommit: STATEFUL_METADATA_FIELDS_NATIVE_SOURCE.commit} : {}), qualificationOnly: true});
}

function coordinatedRuntime(profile) {
    const metadata = metadataProfile(profile), selectedSdk = metadata ? metadataSdk : sdk;
    const sdkRoot = rootFor('@eosrio/hyperion-sdk/projection-stateful-owner-v2');
    const nativeRoot = rootFor('@eosrio/hyperion-backend-mongodb/stateful-owner-v2');
    const sdkPackage = read(resolve(sdkRoot, 'package.json')), nativePackage = read(resolve(nativeRoot, 'package.json'));
    if (completeKindProfile(profile)) {
        const nativeSource = completeKindNativeSource(profile);
        exact(sdkPackage.sha256, 'd2d92cb7a7f2d8b939391910372d8e551103939cce488244cf657f3ae301d680', 'complete-kind SDK package');
        exact(nativePackage.sha256, 'a63644e9195126e18955f91ef663161e6f9d215d262513d1d5375b28300f84d5', 'complete-kind native Git-LF package');
        exact(nativePackage.json.devDependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + completeKindSdk, 'complete-kind native SDK source');
        const sdkFiles = inventory(resolve(sdkRoot, 'dist')), nativeFiles = inventory(resolve(nativeRoot, 'dist'));
        exact(sdkFiles.files, 31, 'complete-kind SDK count'); exact(sdkFiles.sha256, 'cf77c0fe595f3fbb2bb828147579d9e4e8215aeef3fb5d4d8b213cceeba0821c', 'complete-kind SDK emissions');
        exact(nativeFiles.files, nativeSource.files, 'complete-kind native count');
        exact(nativeFiles.sha256, nativeSource.sha256, 'complete-kind native emissions');
        const nativeSdk = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(resolve(nativeRoot, 'package.json'))); assert(nativeSdk);
        exact(read(nativeSdk).sha256, sdkPackage.sha256, 'complete-kind receiving SDK package');
        exact(inventory(resolve(dirname(nativeSdk), 'dist')).sha256, sdkFiles.sha256, 'complete-kind receiving SDK emissions');
        const callerRoot = fileURLToPath(new URL('../../', import.meta.url));
        exact(read(resolve(callerRoot, 'package.json')).sha256, 'c98370f6c9f81aa8d6c4554ea798896d5e02bf9f8554e775f6edb1ee2c8bae54', 'complete-kind caller package');
        const callerFiles = inventory(resolve(callerRoot, 'build'), 1024);
        exact(callerFiles.files, STATEFUL_COMPLETE_KIND_CALLER_SOURCE.files, 'complete-kind caller count');
        exact(callerFiles.sha256, STATEFUL_COMPLETE_KIND_CALLER_SOURCE.sha256, 'complete-kind caller emissions');
        for (const [path, expected] of STATEFUL_COMPLETE_KIND_CALLER_SOURCE.sources)
            exact(sha(readFileSync(resolve(callerRoot, path))), expected, 'complete-kind Git-LF caller ' + path);
        return {sdkFiles, nativeFiles, callerFiles};
    }
    exact(sdkPackage.sha256, metadata ? 'dff953cf5e7fd64274aa5e3a60a7d760c6138e0bfee5eda1b85e53eafcd4fbf6'
        : '2e11db52cf8d150e30d165bafb962b50c6ad0cc764770714ea7fdca48a5e4684', 'SDK package');
    if (metadata) exact(nativePackage.sha256, 'cb040bf6f4ac6388e1bc82da911ba935e4cae5c8d6ed2aed83e8793aeb7899e9', 'dd85 native Git-LF package');
    else assert(['83ac5fdb7e9d49dc1c1028c30acab01709b05e0726d21498ff3531380efbab08',
        '0dad5f2e404773fe1603495ea29d4bd60ab63354f85c7e9346d8baf9726f6d42'].includes(nativePackage.sha256), 'Unqualified native package bytes');
    exact(nativePackage.json.devDependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + selectedSdk, 'native SDK source pin');
    const sdkFiles = inventory(resolve(sdkRoot, 'dist')), nativeFiles = inventory(resolve(nativeRoot, 'dist'));
    exact(sdkFiles.files, 31, 'SDK emission count'); exact(sdkFiles.sha256, metadata ? 'a4c203b00a2cf1e655709bb926e507eec065ac29e81d1ba6a05373b26c55a11a'
        : 'df919dbdbfe8eb6c0b0f05a7f4b4ddabf42095d9da1e2621d0adba250fd3b7cc', 'SDK emissions');
    exact(nativeFiles.files, 30, 'native emission count'); exact(nativeFiles.sha256, fieldsProfile(profile)
        ? STATEFUL_METADATA_FIELDS_NATIVE_SOURCE.sha256 : '6b9b8355aa2eca52a26d0e395d85c71679b414c348b466f614e6321f42b64e24', 'native emissions');
    const nativeSdk = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(resolve(nativeRoot, 'package.json')));
    assert(nativeSdk, 'Native runtime SDK is absent');
    exact(read(nativeSdk).sha256, sdkPackage.sha256, 'native runtime SDK package');
    exact(inventory(resolve(dirname(nativeSdk), 'dist')).sha256, sdkFiles.sha256, 'native runtime SDK emissions');
    return {sdkFiles, nativeFiles};
}

function legacyWireArtifacts(root) {
    for (const [path, expected] of [
        ['package.json', '60aa988bdad575945f23165fc22abf63f1bdcde68f0f565bc4db4fb23cea0a1d'],
        ['dist/protocol-provider.json', '7c5743a1c426859fe26aa98f1622914720f3b2594fc1a07eb2511d2fa864d24e'],
        ['dist/protocol-node-artifact.json', 'c762dabcddc9a7910d03ad793924214cdc1092377b13b9b61543434435bb0329'],
        ['dist/protocol-rust-artifact.json', '2e8324085338e2eb26720c526704aefc12a95fd0940959b29939d0e498ed6819'],
        ['dist/protocol-npm-lock.json', '2a1a0ba35057281c6a6c1693a928b2badc66a389103d1dd78677c99c13a9fb27']
    ]) exact(read(resolve(root, path)).sha256, expected, 'default716 ' + path);
    for (const runtime of ['node', 'rust']) members(root, read(resolve(root, 'dist/protocol-' + runtime + '-artifact.json')).json);
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
    const selectedSdk = completeKindProfile(admission.profile) ? completeKindSdk : metadataProfile(admission.profile) ? metadataSdk : sdk;
    pin('@eosrio/hyperion-sdk', selectedSdk);
    const runtime = coordinatedRuntime(admission.profile);
    const wireSdkRevision = legacyProfile(admission.profile) ? '339b5c93d1338968c18ed14254961439dcab16a0' : sdk;
    if (legacyProfile(admission.profile)) legacyWireArtifacts(root);
    const prepared = read(resolve(root, 'dist/protocol-npm-lock.json')).json;
    exact(prepared.packages[''].dependencies['@eosrio/hyperion-sdk'], 'git+https://github.com/eosrio/hyperion-sdk.git#' + wireSdkRevision, 'prepared Wire SDK source');
    const localSdk = findPackageJSON('@eosrio/hyperion-sdk', pathToFileURL(resolve(root, 'package.json')));
    assert(localSdk, 'Wire runtime SDK is absent');
    const legacy = legacyProfile(admission.profile);
    exact(read(localSdk).sha256, legacy ? '05600276ecf6029572dcce317f73fcb0231e3100482bb81d2fa8f17243179ab3'
        : '2e11db52cf8d150e30d165bafb962b50c6ad0cc764770714ea7fdca48a5e4684', 'Wire runtime SDK package');
    const localFiles = inventory(resolve(dirname(localSdk), 'dist'));
    exact(localFiles.files, legacy ? 13 : 31, 'Wire runtime SDK count');
    exact(localFiles.sha256, legacy ? 'cd5f6c2a8e4f4c520b01b533fe294a8d7c8cd0428d847be2e50ee84b0bbfebb3'
        : 'df919dbdbfe8eb6c0b0f05a7f4b4ddabf42095d9da1e2621d0adba250fd3b7cc', 'Wire runtime SDK emissions');
    return Object.freeze({...admission, sdkRevision: selectedSdk, wireSdkRevision, ...runtime, wireSdkFiles: localFiles});
}
