import {test} from 'node:test';
import assert from 'node:assert/strict';
import {admitCoordinatedNativeSourceOptions,STATEFUL_BATCH_SOURCE_PROFILE,STATEFUL_GENESIS_RPC_SOURCE_PROFILE,assertMappingRetryWireSource} from './stateful-engineering-source-admission.mjs';
test('batch profile binds exact caller emissions and leaves predecessor separate',()=>{
 const admitted=admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_BATCH_SOURCE_PROFILE});
 assert.equal(admitted.callerSourceCommit,'0d66963c1ce331abde0a8ba35bcb0e7659b4f825');
 assert.equal(admitted.wireRevision,'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c');assert.equal(admitted.qualificationOnly,true);
 assert.throws(()=>admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_GENESIS_RPC_SOURCE_PROFILE}));
 assert.doesNotThrow(()=>assertMappingRetryWireSource(admitted,[{sourceRevision:admitted.wireRevision}]));
});
