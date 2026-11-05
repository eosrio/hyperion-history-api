// Pure actual installed byte observations; no native/client/timer execution.
import test from 'node:test';import assert from 'node:assert/strict';
import {observeWire34CbfbAssembly as observeAllCbfbAssembly,assertWire34CbfbAssembly as assertAllCbfbAssembly} from './wire34-cbfb-assembly.mjs';
import {assertCbfbAssembly} from './cbfb-assembly.mjs';
test('new all-CBFB profile admits both actual independently installed SDKs and all four emitted trees',()=>{
 const observed=observeAllCbfbAssembly(),admitted=assertAllCbfbAssembly(observed);assert.equal(admitted.integratedNativeMongo,'pending');
 assert.equal(observed.pins.rootSDK,observed.pins.nativeSDK);for(const key of ['rootBuild','nativeBuild','rootSDK','nativeSDK'])assert(observed.trees[key].length>0);
 assert.throws(()=>assertCbfbAssembly(observed));
 for(const change of [v=>v.pins.rootSDK='git+https://github.com/eosrio/hyperion-sdk.git#dc20a03f2b60ba05a3369d677222a9cf0d65d299',v=>v.trees.nativeSDK.pop(),v=>v.sources[0].sha256='0'.repeat(64)]){const value=structuredClone(observed);change(value);assert.throws(()=>assertAllCbfbAssembly(value));}
});
