// Pure installed-source admission checks: no child process, temporary copy or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import {admitNativeApiSourceOptions, admitCoordinatedNativeSourceOptions, STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE as profile,
    STATEFUL_COMPLETE_KIND_CODEC_WIRE_SOURCE as wire, STATEFUL_COMPLETE_KIND_CODEC_CALLER_SOURCE as caller,
    STATEFUL_COMPLETE_KIND_METADATA_NATIVE_SOURCE as native, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE as metadata,
    STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as first, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as commands,
    STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as executor} from '../unit/stateful-engineering-source-admission.mjs';

test('codec profile admits installed Wire69 Node/Rust descriptors and unchanged SDK/native/caller emissions', () => {
    const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile});
    assert.equal(actual.wireRevision, wire.commit); assert.equal(actual.wireTree, wire.tree);
    assert.equal(actual.descriptorSha256, wire.descriptorSha256); assert.equal(actual.nodeSha256, wire.nodeSha256);
    assert.equal(actual.rustSha256, wire.rustSha256); assert.equal(actual.nativeSourceCommit, native.commit);
    assert.equal(actual.nativeTree, native.tree); assert.equal(actual.nativeFiles.sha256, native.sha256);
    assert.equal(actual.nativeFiles.files, 39); assert.equal(actual.sdkFiles.files, 31);
    assert.equal(actual.callerSourceCommit, caller.commit); assert.equal(actual.callerFiles.sha256, caller.sha256);
    assert.equal(actual.callerFiles.files, 550); assert.equal(actual.qualificationOnly, true);
    const coordinated = admitCoordinatedNativeSourceOptions({engineeringSourceProfile: profile});
    assert.equal(coordinated.sdkRevision, '7412889a14c84342551fd864ea3ebfcf28849385');
    assert.equal(coordinated.wireSdkRevision, '58d68c5cea81490bbb1c9a7736d633d465bab3ef');
    assert.equal(coordinated.wireSdkFiles.files, 31);
    assert.equal(coordinated.wireSdkFiles.sha256, 'df919dbdbfe8eb6c0b0f05a7f4b4ddabf42095d9da1e2621d0adba250fd3b7cc');
});

test('all four previous complete-kind profiles retain their pins and refuse the new Wire codec source', () => {
    for (const prior of [first, commands, executor, metadata])
        assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: prior}), /Wire source revision/);
});
