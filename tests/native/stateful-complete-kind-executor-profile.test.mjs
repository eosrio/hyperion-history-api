// Pure installed-source admission checks: no child process, temporary copy or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import {admitNativeApiSourceOptions, STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as profile,
    STATEFUL_COMPLETE_KIND_EXECUTOR_NATIVE_SOURCE as native, STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as first,
    STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as commands} from '../unit/stateful-engineering-source-admission.mjs';

test('executor profile admits the actual installed native39 and unchanged SDK/caller outputs', () => {
    const actual = admitNativeApiSourceOptions({engineeringSourceProfile: profile});
    assert.equal(actual.nativeSourceCommit, native.commit); assert.equal(actual.nativeTree, native.tree);
    assert.equal(actual.nativeFiles.files, 39); assert.equal(actual.nativeFiles.sha256, native.sha256);
    assert.equal(actual.sdkFiles.files, 31); assert.equal(actual.callerFiles.files, 550);
    assert.equal(actual.qualificationOnly, true);
});

test('both failed older complete-kind profiles keep their pins and refuse this different native assembly', () => {
    for (const prior of [first, commands]) assert.throws(() => admitNativeApiSourceOptions({engineeringSourceProfile: prior}), /native emissions|native count/);
});
