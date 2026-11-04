// Pure controls: evaluate actual call options and the admission prefix, never provider/worker lifecycle code.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as profiles from '../unit/stateful-engineering-source-admission.mjs';
import {STATEFUL_CURRENT_CBFB_SOURCE_PROFILE,observeCurrentCbfbSourceOptions} from '../unit/current-cbfb-source-admission.mjs';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const source=read('tests/unit/protocol-native-api-source.mjs'),start=source.indexOf('    const admission = admitNativeApiSourceOptions(options), {nativeMarker} = admission;');
assert(start>0);const prefix=source.slice(start,source.indexOf('\n',start));
for(const [path,count]of [['portable-state-raw-target.mjs',1],['projection-frame-source-fence.mjs',1],['protocol-native-api.mjs',2]])
test('actual '+path+' native positive callers select current bytes before provider import',async()=>{
 const caller=read('tests/unit/'+path),options=[...caller.matchAll(/nativeApiWireSource\((\{[^}]+\})\)/g)];assert.equal(options.length,count);
 const names=Object.keys(profiles),values=Object.values(profiles);
 for(const match of options){
  const input=new Function(...names,'return ('+match[1]+');')(...values);let observations=0;
  const run=new Function('admitNativeApiSourceOptions','return async function(options){'+prefix+'return admission;};')(options=>{
   assert.equal(options.engineeringSourceProfile,STATEFUL_CURRENT_CBFB_SOURCE_PROFILE);observations++;
   return observeCurrentCbfbSourceOptions(options);
  });
  const actual=await run(input);assert.equal(actual.profile,STATEFUL_CURRENT_CBFB_SOURCE_PROFILE);assert.equal(actual.nativeMarker,input.nativeMarker??true);assert.equal(observations,1);
 }
});

test('actual queued-proof lock assertions bind both exact current HTTPS source revisions',()=>{
 const source=read('tests/unit/protocol-native-lag-replay.mjs'),start=source.indexOf('    assert.equal(lock.packages['),end=source.indexOf('    const began =',start);assert(start>0&&end>start);
 const verify=new Function('assert','lock','nativeSourceAdmission',source.slice(start,end));
 const admission={wireRevision:'69a66064c077a405341f5aaf15e84b88b8d86ccb',sdkRevision:'dc20a03f2b60ba05a3369d677222a9cf0d65d299'},lock=JSON.parse(read('package-lock.json'));
 verify(assert,lock,admission);
 for(const [name,revision]of [['hyperion-wire-plugin',admission.wireRevision],['hyperion-sdk',admission.sdkRevision]]){
  for(const resolved of ['git+https://github.com/eosrio/'+name+'.git#'+'0'.repeat(40),'git+ssh://git@github.com/eosrio/'+name+'.git#'+revision]){
   const changed=structuredClone(lock);changed.packages['node_modules/@eosrio/'+name].resolved=resolved;assert.throws(()=>verify(assert,changed,admission));
  }
 }
});

test('actual original-Wire-row source header admits current assembly before loader and checks all component revisions',()=>{
 const fixture=read('tests/fixtures/portable-mapping-retry.mjs'),assertion=fixture.split('\n').find(line=>line.includes('assert(selected.components.every('));assert(assertion);
 const selected={components:[{sourceRevision:'69a66064c077a405341f5aaf15e84b88b8d86ccb'},{sourceRevision:'69a66064c077a405341f5aaf15e84b88b8d86ccb'}]},admission={wireRevision:selected.components[0].sourceRevision};
 const verify=new Function('assert','selected','nativeSourceAdmission',assertion);verify(assert,selected,admission);
 assert.throws(()=>verify(assert,{components:[selected.components[0],{sourceRevision:'0'.repeat(40)}]},admission));
 const call=fixture.match(/const nativeSourceAdmission = admitCoordinatedNativeSourceOptions\((\{[^}]+\})\);/);assert(call,'Current explicit admission before provider import required');
 assert(fixture.indexOf(call[0])<fixture.indexOf('const selected = await loadChainProtocol'));
 const input=new Function(...Object.keys(profiles),'return ('+call[1]+');')(...Object.values(profiles));assert.equal(input.engineeringSourceProfile,STATEFUL_CURRENT_CBFB_SOURCE_PROFILE);
});
