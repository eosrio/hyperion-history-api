import assert from 'node:assert/strict';
import test from 'node:test';
import {ASSEMBLY,PROFILE,assertIndexedAssemblyObservation} from './assembly.mjs';
const observed=()=>structuredClone({profile:PROFILE,pins:ASSEMBLY.pins,sources:ASSEMBLY.sources,trees:ASSEMBLY.trees});
test('new indexed engineering assembly is explicit and every native/SQL/managedHTTP acceptance remains pending',()=>{
 const result=assertIndexedAssemblyObservation(observed());assert.equal(result.nativeMongoDB,'pending');assert.equal(result.AtomicSQL,'pending');assert.equal(result.managedHTTP,'pending');
 assert.notEqual(PROFILE,'stateful-owner-v2-root741-native429-wire69-native45-linux-gitlf-engineering');
});
test('other SDK/native pins, raw CRLF bytes, partial/stale/extra emissions or implicit profiles refuse',()=>{
 for(const change of [x=>x.profile='current103',x=>x.pins.rootSDK=x.pins.rootSDK.replace('dc20','7412'),x=>x.pins.nativeSDK='old',
 x=>x.sources[0].sha256='f'.repeat(64),x=>x.trees.nativeBuild.pop(),x=>x.trees.rootBuild.push({path:'extra.js',bytes:0,sha256:'f'.repeat(64)})]){
  const value=observed();change(value);assert.throws(()=>assertIndexedAssemblyObservation(value));
 }
});
