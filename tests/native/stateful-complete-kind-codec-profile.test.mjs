// Pure installed-source admission checks: no child process, temporary copy or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import {admitNativeApiSourceOptions, admitCoordinatedNativeSourceOptions, STATEFUL_COMBINED_REPLAY_SOURCE_PROFILE as profile, STATEFUL_COMPLETE_KIND_WIRE32_API_SOURCE_PROFILE as oldWire32,
    STATEFUL_COMPLETE_KIND_WIRE32_SOURCE as wire, STATEFUL_COMBINED_REPLAY_CALLER_SOURCE as caller, STATEFUL_COMPLETE_KIND_WIRE32_CALLER_SOURCE as frozenCaller,
    STATEFUL_COMPLETE_KIND_METADATA_NATIVE_SOURCE as native, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE as metadata,
    STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as first, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as commands,
    STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as executor, STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE as previousCodec, STATEFUL_COMPLETE_KIND_CODEC_WIRE_SOURCE as previousWire} from '../unit/stateful-engineering-source-admission.mjs';

test('composed replay profile admits exact Node/Rust descriptors, SDK/native and caller emissions', () => {
    const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile});
    assert.equal(actual.wireRevision, wire.commit); assert.equal(actual.wireTree, wire.tree);
    assert.equal(actual.descriptorSha256, wire.descriptorSha256); assert.equal(actual.nodeSha256, wire.nodeSha256);
    assert.equal(actual.rustSha256, wire.rustSha256); assert.equal(actual.nativeSourceCommit, native.commit);
    assert.equal(actual.nativeTree, native.tree); assert.equal(actual.nativeFiles.sha256, native.sha256);
    assert.equal(actual.nativeFiles.files, 39); assert.equal(actual.sdkFiles.files, 31);
    assert.equal(actual.callerSourceCommit, caller.commit);
    assert.equal(actual.callerHelperSourceCommit, 'c1b98a52a872b6c070ada32243c8286607e86883'); assert.equal(actual.callerFiles.sha256, caller.sha256);
    assert.deepEqual(actual.runtimeInputFiles, {files:308, sha256:'f0b4ada670720b644e1b83b97017aa090f3983f4e20bfb63f83041718fc79a1d'});
    assert.equal(actual.runtimeInputManifestSha256,'01a3c5c96ef9a6f961555776390335f0ee2c32d485a082180b2aaa0dc1e6b66b');
    assert.equal(actual.callerFiles.files, 554); assert.equal(actual.qualificationOnly, true);
    const coordinated = admitCoordinatedNativeSourceOptions({engineeringSourceProfile: profile});
    assert.equal(coordinated.sdkRevision, '7412889a14c84342551fd864ea3ebfcf28849385');
    assert.equal(coordinated.wireSdkRevision, '58d68c5cea81490bbb1c9a7736d633d465bab3ef');
    assert.equal(coordinated.wireSdkFiles.files, 31);
    assert.equal(coordinated.wireSdkFiles.sha256, 'df919dbdbfe8eb6c0b0f05a7f4b4ddabf42095d9da1e2621d0adba250fd3b7cc');
});

test('previous complete-kind profiles retain their pins and refuse the new Wire codec source', () => {
    assert.equal(previousWire.commit, '69a66064c077a405341f5aaf15e84b88b8d86ccb');
    assert.equal(previousWire.descriptorSha256, '19fc9804da7e9ec5744733cdc191cd430bb807d73c25dcb98014bf4ca3ef20b8');
    for (const prior of [first, commands, executor, metadata, previousCodec])
        assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: prior}), /Wire source revision/);
});

test('prior Wire32 caller profile refuses the composed caller inventory', () => {
    assert.equal(frozenCaller.sha256, '7f0117c6ec49a801820c9130cea1ec7f7e09227db524ff85b24ed9385933b911');
    assert.equal(frozenCaller.sources.find(([name]) => name === 'src/indexer/helpers/bounded-json.ts')[1], '9c62cc0fbb69fe34dc739d4904690dd506c10335590aba2a3d1e6a5dc068b5b7');
    assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: oldWire32}), /caller (?:count|emissions)/);
});
