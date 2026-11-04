import {test} from 'node:test';
import assert from 'node:assert/strict';
import {admitCoordinatedNativeSourceOptions,STATEFUL_BULK_SOURCE_PROFILE,STATEFUL_BATCH_SOURCE_PROFILE,assertMappingRetryWireSource} from './stateful-engineering-source-admission.mjs';
test('bulk profile binds exact caller emissions and leaves predecessor separate',()=>{
 const admitted=admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_BULK_SOURCE_PROFILE});
 assert.equal(admitted.callerSourceCommit,'524eb2ce0ffeebbcd356b5a1b1dd9a064234a2cc');
 assert.equal(admitted.wireRevision,'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c');assert.equal(admitted.qualificationOnly,true);
 assert.throws(()=>admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_BATCH_SOURCE_PROFILE}));
 assert.doesNotThrow(()=>assertMappingRetryWireSource(admitted,[{sourceRevision:admitted.wireRevision}]));
});
