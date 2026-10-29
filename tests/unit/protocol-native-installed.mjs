import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {admitNativeSourceEnvironment} from './stateful-engineering-source-admission.mjs';
const nativeSourceAdmission = admitNativeSourceEnvironment();
const {loadChainProtocol} = await import('../../build/indexer/protocol/selection.js');

const wireRevision = nativeSourceAdmission.wireRevision;
const sdkRevision = nativeSourceAdmission.sdkRevision;
const profileId = 'wire-sysio-6508c9e8-native-engineering-v1';
const host = fileURLToPath(new URL('../../', import.meta.url));
const wire = dirname(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'))));
const read = path => readFileSync(resolve(wire, path));
const json = path => JSON.parse(read(path));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = hex => Buffer.from(hex, 'hex');
const lock = JSON.parse(readFileSync(resolve(host, 'package-lock.json')));
assert.equal(lock.packages[''].dependencies['@eosrio/hyperion-wire-plugin'],
    `git+https://github.com/eosrio/hyperion-wire-plugin.git#${wireRevision}`);
assert.equal(lock.packages['node_modules/@eosrio/hyperion-wire-plugin'].resolved,
    `git+ssh://git@github.com/eosrio/hyperion-wire-plugin.git#${wireRevision}`);
assert.equal(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved,
    `git+ssh://git@github.com/eosrio/hyperion-sdk.git#${sdkRevision}`);
const preparedLock = json('dist/protocol-npm-lock.json');
assert.equal(preparedLock.packages[''].dependencies['@eosrio/hyperion-sdk'],
    `git+https://github.com/eosrio/hyperion-sdk.git#${nativeSourceAdmission.wireSdkRevision}`);
const receipt = json('dist/protocol-source-receipt.json');
assert.equal(receipt.sourceRevision, wireRevision);
for (const member of receipt.outputFiles) assert.equal(hash(read(member.path)), member.sha256, member.path);
// The source receipt also records build inputs omitted from the published bundle.
// Verify its shipped package/lock/profile inputs; the component manifests below
// bind every installed Node/Rust artifact member.
for (const path of ['package.json', 'package-lock.json', 'protocol-profile.json', 'Cargo.toml', 'Cargo.lock']) {
    const member = receipt.sourceFiles.find(member => member.path === path); assert(member);
    const installed = path === 'package-lock.json' ? 'dist/protocol-npm-lock.json' : path;
    assert.equal(hash(read(installed)), member.sha256, path);
}
const descriptor = json('dist/protocol-provider.json');
assert.deepEqual(descriptor.profiles.find(profile => profile.id === profileId).nativeActions, {interfaceVersion: 1});
const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId});
assert.equal(selected.provider.profileId, profileId);
assert(Object.isFrozen(selected.provider));
const native = selected.provider.nativeActions;
assert.equal(native.interfaceVersion, 1); assert(Object.isFrozen(native));
assert.deepEqual(selected.components.map(component => [component.runtime, component.sourceRevision]),
    [['node', wireRevision], ['rust', wireRevision]]);
for (const component of selected.components) {
    const artifactBytes = read(`dist/protocol-${component.runtime}-artifact.json`);
    assert.equal(hash(artifactBytes), component.sha256);
    const artifact = JSON.parse(artifactBytes);
    assert.equal(artifact.sourceRevision, wireRevision); assert.equal(artifact.sourceModified, false);
    for (const member of artifact.files) assert.equal(hash(read(member.path)), member.sha256, member.path);
}

// Authenticated original source and independent official-clio values, with no injected capability.
const fixture = 'fixtures/codec/native-onblock-6508-20261022/';
const manifest = json(fixture + 'manifest.json');
assert.equal(manifest.upstreamRevision, '6508c9e8f4044df8d5acb082a7af3be6a80cd9a0');
assert.equal(manifest.chainId, '9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d');
assert.equal(manifest.originalArchiveSha256, '42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7');
for (const member of manifest.members) {
    const raw = read(fixture + member.path);
    assert.equal(raw.length, member.bytes); assert.equal(hash(raw), member.sha256);
}
assert.equal(hash(read(fixture + 'expected.json')), 'f2d022f14e493f2297034dd8e7e1846d1504f19bbf1278afee8cd30a955b9720');
const rows = json(fixture + 'expected.json'); assert.deepEqual(rows.map(row => row.blockNum), [33, 122, 397]);
const schemaJson = read(fixture + manifest.schema.path).toString('utf8');
assert.equal(hash(schemaJson), '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9');
const session = selected.provider.createShipSession(JSON.parse(schemaJson));
try {
    const deployed = selected.provider.contractCodec.decodeAbi(read(fixture + 'deployed-sysio-32.abi.bin'));
    for (const row of rows) {
        const [, frame] = session.decodeResult(read(fixture + `block-${String(row.blockNum).padStart(6, '0')}.bin`));
        assert.equal(frame.this_block.block_id, row.blockId);
        const source = {chainId: manifest.chainId, blockNum: row.blockNum, blockId: row.blockId,
            previousBlockId: frame.prev_block.block_id};
        assert.deepEqual(native.observe({schemaJson, block: bytes(frame.block), traces: bytes(frame.traces)}, source),
            {schemaVersion: 1, decisions: [{origin: {transactionId: row.transactionId,
                actionOrdinal: row.actionOrdinal, rawSha256: row.rawSha256}, kind: 'native', nativeKind: row.nativeKind}]});
        assert.equal(hash(bytes(row.rawHex)), row.rawSha256);
        assert.deepEqual(native.decodeValue(row.nativeKind, bytes(row.rawHex)), row.expectedValue);
        assert.equal(Buffer.from(native.encodeValue(row.nativeKind, row.expectedValue)).toString('hex'), row.rawHex);
        assert.throws(() => selected.provider.contractCodec.decodeValue(deployed, 'onblock', bytes(row.rawHex)), error =>
            error.code === (row.blockNum === 122 ? 'unsupported_feature' : 'invalid_value')
            && error.message === row.originalContractCodecError);
    }
} finally {session.close?.();}

const genesis = 'fixtures/codec/native-genesis-6508-20261020/';
const genesisManifest = json(genesis + 'manifest.json');
for (const member of genesisManifest.members) {
    const raw = read(genesis + member.path);
    assert.equal(raw.length, member.bytes); assert.equal(hash(raw), member.sha256);
}
assert.deepEqual(selected.provider.verifyNativeGenesis({schemaJson: read(genesis + 'ship.abi.json').toString('utf8'),
    block: read(genesis + 'block.bin'), traces: null, deltas: read(genesis + 'deltas.bin')}, genesisManifest.source),
    json(genesis + 'expected.json'));
assert.equal(genesisManifest.source.previousBlockId, null, 'genuine genesis has no predecessor or trace vector');
console.log('installed-wire-native-passed');
