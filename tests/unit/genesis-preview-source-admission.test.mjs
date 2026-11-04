import test from 'node:test';
import assert from 'node:assert/strict';
import {admitCoordinatedNativeSourceOptions,STATEFUL_GENESIS_PREVIEW_SOURCE_PROFILE,
    STATEFUL_HISTORY_API_SOURCE_PROFILE} from './stateful-engineering-source-admission.mjs';

test('preview profile binds exact Wire, SDK, native and caller artifacts without accepting the old profile',()=>{
    const admitted=admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_GENESIS_PREVIEW_SOURCE_PROFILE});
    assert.equal(admitted.wireRevision,'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c');
    assert.equal(admitted.sdkRevision,'7412889a14c84342551fd864ea3ebfcf28849385');
    assert.equal(admitted.wireSdkRevision,'58d68c5cea81490bbb1c9a7736d633d465bab3ef');
    assert.equal(admitted.callerSourceCommit,'91f3871db386e91d31b1a0a23f16baf478434018');
    assert.equal(admitted.qualificationOnly,true);
    assert.throws(()=>admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_HISTORY_API_SOURCE_PROFILE}));
});
