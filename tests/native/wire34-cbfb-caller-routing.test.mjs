// Actual source options and wrapper routing only; never import provider/worker lifecycle code.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as profiles from '../unit/stateful-engineering-source-admission.mjs';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE as profile,observeWire34CbfbSourceOptions} from '../unit/wire34-cbfb-source-admission.mjs';
import {WIRE34_SOURCE,CBFB_SDK} from '../../scripts/qualification/wire34-cbfb/contract.mjs';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const source=read('tests/unit/protocol-native-api-source.mjs'),start=source.indexOf('    const admission = admitNativeApiSourceOptions(options), {nativeMarker} = admission;');
assert(start>0);const prefix=source.slice(start,source.indexOf('\n',start));
for(const [name,count]of [['portable-state-raw-target',1],['projection-frame-source-fence',1],['protocol-native-api',2]])
test('actual Wire34 '+name+' positive caller selects exact new profile before provider import',async()=>{
 const caller=read('tests/unit/wire34-cbfb-'+name+'.mjs');
 assert(caller.includes("import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE as STATEFUL_ALL_CBFB_SOURCE_PROFILE} from './stateful-engineering-source-admission.mjs';"));
 const options=[...caller.matchAll(/nativeApiWireSource\((\{[^}]+\})\)/g)];assert.equal(options.length,count);
 const scope={...profiles,STATEFUL_ALL_CBFB_SOURCE_PROFILE:profile};
 for(const match of options){
  const input=new Function(...Object.keys(scope),'return ('+match[1]+');')(...Object.values(scope));let observations=0;
  const run=new Function('admitNativeApiSourceOptions','return async function(options){'+prefix+'return admission;};')(options=>{
   assert.equal(options.engineeringSourceProfile,profile);observations++;return observeWire34CbfbSourceOptions(options);
  });
  const actual=await run(input);assert.equal(actual.profile,profile);assert.equal(actual.nativeMarker,input.nativeMarker??true);assert.equal(observations,1);
 }
});

test('actual queued-proof lock assertions bind both exact current HTTPS source revisions',()=>{
 const source=read('tests/unit/protocol-native-lag-replay.mjs'),start=source.indexOf('    assert.equal(lock.packages['),end=source.indexOf('    const began =',start);assert(start>0&&end>start);
 const verify=new Function('assert','lock','nativeSourceAdmission',source.slice(start,end));
 const admission={wireRevision:WIRE34_SOURCE.commit,sdkRevision:CBFB_SDK},lock=JSON.parse(read('package-lock.json'));verify(assert,lock,admission);
 for(const [name,revision]of [['hyperion-wire-plugin',admission.wireRevision],['hyperion-sdk',admission.sdkRevision]]){
  for(const resolved of ['git+https://github.com/eosrio/'+name+'.git#'+'0'.repeat(40),'git+ssh://git@github.com/eosrio/'+name+'.git#'+revision]){
   const changed=structuredClone(lock);changed.packages['node_modules/@eosrio/'+name].resolved=resolved;assert.throws(()=>verify(assert,changed,admission));
  }
 }
});

test('Bun wrappers explicitly choose named new callers only for Wire34 while preserving old defaults',()=>{
 for(const name of ['portable-state-raw-target','projection-frame-source-fence','protocol-native-api']){
  const source=read('tests/unit/'+name+'.test.ts'),matches=[...source.matchAll(/new URL\((process\.env\.HYPERION_NATIVE_SOURCE_PROFILE === '[^']+' \? '[^']+' : '[^']+'), import\.meta\.url\)/g)];assert(matches.length>=1,name);
  for(const [,expression]of matches)for(const selected of [undefined,'',profiles.STATEFUL_ALL_CBFB_SOURCE_PROFILE,profile,'unknown']){
   const actual=new Function('process','return ('+expression+');')({env:{HYPERION_NATIVE_SOURCE_PROFILE:selected}});
   assert.equal(actual,selected===profile?'./wire34-cbfb-'+name+'.mjs':'./'+name+'.mjs');
  }
 }
 const source=read('tests/unit/stateful-engineering-source-admission.test.ts');
 assert(source.includes("process.env.HYPERION_NATIVE_SOURCE_PROFILE === '"+profile+"'"));
 assert(source.includes("? './wire34-cbfb-source-admission-native.mjs' : './all-cbfb-source-admission-native.mjs'"));
 assert(source.includes('expect(result.cases).toBe(54)'));assert(source.includes('timeout: 60000'));assert(source.includes('}, 65000)'));
});
