// Pure installed-source admission checks: no child process, temporary copy or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import {admitNativeApiSourceOptions, STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE as profile,
    STATEFUL_COMPLETE_KIND_METADATA_NATIVE_SOURCE as native, STATEFUL_COMPLETE_KIND_METADATA_CALLER_SOURCE as caller,
    STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as first, STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as commands,
    STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as executor} from '../unit/stateful-engineering-source-admission.mjs';

test('combined metadata profile admits the actual merged native and canonical-JSON caller assembly', () => {
    const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile});
    assert.equal(actual.nativeSourceCommit, native.commit); assert.equal(actual.nativeTree, native.tree);
    assert.equal(actual.nativeFiles.files, native.files); assert.equal(actual.nativeFiles.sha256, native.sha256);
    assert.equal(actual.callerSourceCommit, caller.commit); assert.equal(actual.callerFiles.files, caller.files);
    assert.equal(actual.callerFiles.sha256, caller.sha256); assert.equal(caller.sources.length, 9);
    assert.equal(actual.sdkFiles.files, 31); assert.equal(actual.qualificationOnly, true);
});

test('all three prior complete-kind profiles retain their pins and refuse the combined assembly', () => {
    for (const prior of [first, commands, executor])
        assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: prior}), /native emissions|native count/);
});
