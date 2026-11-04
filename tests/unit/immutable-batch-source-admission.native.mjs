import {test} from 'node:test';
import assert from 'node:assert/strict';
import {admitCoordinatedNativeSourceOptions,STATEFUL_COMBINED_REPLAY_SOURCE_PROFILE,
 STATEFUL_COMBINED_REPLAY_CALLER_SOURCE,STATEFUL_BULK_SOURCE_PROFILE,STATEFUL_BATCH_SOURCE_PROFILE,
 STATEFUL_COMPLETE_KIND_WIRE32_CACHE_API_SOURCE_PROFILE,assertMappingRetryWireSource} from './stateful-engineering-source-admission.mjs';

test('combined replay profile binds exact caller emissions and refuses frozen predecessors',()=>{
 const admitted=admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_COMBINED_REPLAY_SOURCE_PROFILE});
 assert.equal(admitted.callerSourceCommit,STATEFUL_COMBINED_REPLAY_CALLER_SOURCE.commit);
 assert.equal(admitted.callerFiles.sha256,STATEFUL_COMBINED_REPLAY_CALLER_SOURCE.sha256);
 assert.equal(admitted.wireRevision,'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c');assert.equal(admitted.qualificationOnly,true);
 for(const engineeringSourceProfile of [STATEFUL_BATCH_SOURCE_PROFILE,STATEFUL_BULK_SOURCE_PROFILE,STATEFUL_COMPLETE_KIND_WIRE32_CACHE_API_SOURCE_PROFILE])
  assert.throws(()=>admitCoordinatedNativeSourceOptions({engineeringSourceProfile}),/caller (?:count|emissions)/);
 assert.doesNotThrow(()=>assertMappingRetryWireSource(admitted,[{sourceRevision:admitted.wireRevision}]));
 assert.throws(()=>assertMappingRetryWireSource(admitted,[{sourceRevision:'d'.repeat(40)}]),/component source revision/);
});
