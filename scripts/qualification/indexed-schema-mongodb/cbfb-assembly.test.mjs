import test from 'node:test';import assert from 'node:assert/strict';
import {PROFILE,DESCRIPTOR,observeCbfbAssembly,assertCbfbAssembly} from './cbfb-assembly.mjs';
import {assertIndexedAssemblyObservation} from './assembly.mjs';
test('cbfb assembly admits exact source and emissions while preserving historical refusal',()=>{
 const observed=observeCbfbAssembly(),receipt=assertCbfbAssembly(observed);assert.equal(receipt.profile,PROFILE);assert.equal(receipt.integratedNativeMongo,'pending');
 assert.throws(()=>assertIndexedAssemblyObservation({...observed,profile:'indexed-schema-sdk49-native2bf-engineering-v1'}),/SDK49\/native2bf pins differ/);
});
test('cbfb source, native SDK and emission mismatches fail closed',()=>{
 for(const mutate of [o=>o.pins.nativeSDK='other',o=>o.sources[0].sha256='0'.repeat(64),o=>o.trees.nativeBuild.pop(),o=>o.trees.rootBuild[0].sha256='f'.repeat(64)]){const value=structuredClone(DESCRIPTOR.observation);mutate(value);assert.throws(()=>assertCbfbAssembly(value),/profile differs/);}
});
