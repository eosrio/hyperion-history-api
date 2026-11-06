// Pure source and installed-byte controls; never import a native/timer workload.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE as profile,assertWire34Runtime,assertWire34Options,exactGitSource,assertWire34Envelope,WIRE34_SOURCE} from '../../scripts/qualification/wire34-cbfb/contract.mjs';
import {WIRE34_CBFB_MANIFEST as manifest,observeWire34CbfbSourceOptions} from '../unit/wire34-cbfb-source-admission.mjs';
import {retainedWireSourceProfile,admitNativeApiSourceOptions,STATEFUL_ALL_CBFB_SOURCE_PROFILE as oldProfile} from '../unit/stateful-engineering-source-admission.mjs';
const root=new URL('../../',import.meta.url),read=path=>readFileSync(new URL(path,root)),sha=b=>createHash('sha256').update(b).digest('hex');
const options={engineeringSourceProfile:profile};
test('Wire34 profile requires explicit inert selection and never reads accessors',()=>{
 let accessed=0;for(const input of [undefined,{},Object.create(null),{engineeringSourceProfile:'unknown'},{engineeringSourceProfile:oldProfile},{...options,extra:1},{...options,nativeMarker:'true'},{get engineeringSourceProfile(){accessed++;return profile;}},{...options,[Symbol('x')]:true}])assert.throws(()=>assertWire34Options(input));
 assert.equal(accessed,0);assert.deepEqual(assertWire34Options(options),{nativeMarker:true});assert.deepEqual(assertWire34Options({...options,nativeMarker:false}),{nativeMarker:false});
});
test('exact Git transport retains full repository and revision identity',()=>{
 for(const prefix of ['git+https://github.com/eosrio/','git+ssh://git@github.com/eosrio/'])exactGitSource(prefix+'hyperion-wire-plugin.git#'+WIRE34_SOURCE.commit,'hyperion-wire-plugin',WIRE34_SOURCE.commit);
 for(const value of ['git+https://github.com/other/hyperion-wire-plugin.git#'+WIRE34_SOURCE.commit,'git+https://evil.example/eosrio/hyperion-wire-plugin.git#'+WIRE34_SOURCE.commit,'git+https://github.com/eosrio/hyperion-sdk.git#'+WIRE34_SOURCE.commit,'git+https://github.com/eosrio/hyperion-wire-plugin.git#'+WIRE34_SOURCE.commit.slice(0,7),'git+https://github.com/eosrio/hyperion-wire-plugin.git#'+'0'.repeat(40),'git+ssh://git@github.com.evil/eosrio/hyperion-wire-plugin.git#'+WIRE34_SOURCE.commit])assert.throws(()=>exactGitSource(value,'hyperion-wire-plugin',WIRE34_SOURCE.commit));
});
test('coherent merged Node/Rust source envelope rejects mixed, modified and stale receipts',()=>{
 assert(Object.isFrozen(manifest)&&Object.isFrozen(manifest.wire.node.files));assert.throws(()=>{manifest.wire.commit='0'.repeat(40);},TypeError);
 assertWire34Envelope(manifest.wire,manifest.wire);
 const mutations=[x=>x.node.sourceRevision='69a66064c077a405341f5aaf15e84b88b8d86ccb',x=>x.rust.sourceRevision='e691f4471c6e5fdbe001e6709e88d48d33d8bf4c',x=>x.node.sourceModified=true,x=>x.rust.sourceOrigin='git-checkout',x=>x.sourceReceipt.sourceRevision='2eb52ac5d059d36fe58c0731fe218e7b6a0f5078',x=>x.rustMembers.pop(),x=>x.nodeMembers[0].sha256='0'.repeat(64),x=>x.files[0].sha256='0'.repeat(64),x=>x.tree='0'.repeat(40)];
 for(const mutate of mutations){const bad=structuredClone(manifest.wire);mutate(bad);assert.throws(()=>assertWire34Envelope(bad,manifest.wire));}
 for(const mutate of [x=>x.node.sourceModified=true,x=>x.commit='0'.repeat(40),x=>x.tree='0'.repeat(40),x=>x.rust.kind='compiled-rust',x=>x.node.files[0].sha256='0'.repeat(64),x=>x.sourceReceipt.outputFiles.pop(),x=>x.sourceReceipt.sourceFiles[0].sha256='0'.repeat(64)]){const bad=structuredClone(manifest.wire);mutate(bad);assert.throws(()=>assertWire34Envelope(bad,bad),'Even matching metadata cannot declare a different fixed cohort');}
});
test('all frozen Wire69 profile bytes and original default branch remain preserved',()=>{
 for(const row of manifest.preservedWire69Files)assert.equal(sha(read(row.path)),row.sha256,row.path);
 const routing=JSON.parse(read('scripts/qualification/wire34-cbfb/routing.json'));
 for(const [path,row] of Object.entries(routing.files)){let source=read(path).toString();for(const chunk of row.remove){assert.equal(source.split(chunk).length,2);source=source.replace(chunk,'');}for(const [current,prior] of row.replace){assert.equal(source.split(current).length,2);source=source.replace(current,prior);}assert.equal(sha(source),row.baseSha256,'Only declared additive routing/header edits: '+path);}
 assert.throws(()=>admitNativeApiSourceOptions(),/Wire source revision/);
 assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:oldProfile}),/routing source|routing source bytes|Exact all-CBFB|source digest|Exact all-CBFB source|routing source differs/i);
});
test('retained selector preserves default/old routing and refuses unknown or inherited profile choices',()=>{
 const old=process.env.HYPERION_NATIVE_SOURCE_PROFILE;try{for(const value of [undefined,'',oldProfile]){if(value===undefined)delete process.env.HYPERION_NATIVE_SOURCE_PROFILE;else process.env.HYPERION_NATIVE_SOURCE_PROFILE=value;assert.equal(retainedWireSourceProfile(),oldProfile);}process.env.HYPERION_NATIVE_SOURCE_PROFILE=profile;assert.equal(retainedWireSourceProfile(),profile);for(const value of ['unknown','default-716','stateful-sdk49-indexed-2d-engineering']){process.env.HYPERION_NATIVE_SOURCE_PROFILE=value;assert.throws(()=>retainedWireSourceProfile(),/Unknown retained Wire/);}}finally{if(old===undefined)delete process.env.HYPERION_NATIVE_SOURCE_PROFILE;else process.env.HYPERION_NATIVE_SOURCE_PROFILE=old;}
});
test('actual fresh installed-byte observation covers all four drivers and every emitted tree without workload acceptance',()=>{
 const observed=observeWire34CbfbSourceOptions(options);assert.equal(observed.profile,profile);assert.equal(observed.wireRevision,WIRE34_SOURCE.commit);assert.equal(observed.runtimeAcceptance,'pending');assert.deepEqual(Object.keys(observed.dependencies).sort(),['native:bson','native:mongodb','root:bson','root:mongodb']);assert.deepEqual(Object.keys(observed.emissions).sort(),['nativeBuild','nativeSDK','rootBuild','rootSDK']);assert(Object.values(observed.acceptance).every(v=>v==='pending'));
});
test('source closure has unique bounded members and an exact aggregate ledger with explicit cycle exclusions',()=>{
 const rows=manifest.sources.files;assert(rows.length>300&&rows.length<4096);assert.equal(new Set(rows.map(row=>row.path)).size,rows.length);assert.equal(rows.reduce((n,row)=>n+row.bytes,0),manifest.sources.totalBytes);
 assert.deepEqual(manifest.sources.excludedToAvoidHashCycles,['tests/fixtures/engineering-profiles/wire34-cbfb-linux.json','tests/unit/wire34-cbfb-source-admission.mjs']);
 for(const row of rows){const bytes=read(row.path);assert.equal(bytes.length,row.bytes,row.path);assert.equal(sha(bytes),row.sha256,row.path);}
});
test('retained archive, all callbacks/assertions and 180s inner deadline remain fixed',()=>{
 const cohort=JSON.parse(read('scripts/qualification/wire34-cbfb/cohort.json'));assert.deepEqual(cohort.retainedRange,[1,1480]);assert.equal(cohort.retainedDeadlineMS,180000);assert.equal(cohort.throughputOrParityClaim,false);assert.equal(cohort.physicalWire121.consumer,'29bf6d07454fdadd9fed351c70a706d65031c8a6');assert.equal(cohort.physicalWire121.wire,'e691f4471c6e5fdbe001e6709e88d48d33d8bf4c');
 const source=read('tests/unit/wire-managed-state-v2-native.mjs').toString();assert.match(source,/timeout: 180000/);assert.match(source,/length: 1480/);assert(source.includes(cohort.retainedArchive));assert.match(source,/await host\?\.close\(\)/);
});
test('new cohort runtime pins only actual Linux24.22.1/26.4.0 and grants no workload result',()=>{
 for(const [node,sha256] of [['v24.22.1','e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'],['v26.4.0','4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94']]){
  const runtime={node,sha256,platform:'linux',arch:'x64'};assert.deepEqual(assertWire34Runtime(runtime),{runtimeAcceptance:'pending'});
  for(const change of [{platform:'win32'},{arch:'arm64'},{sha256:'0'.repeat(64)},{node:'v26.13.0'},{node:'v24.19.0'}])assert.throws(()=>assertWire34Runtime({...runtime,...change}));
 }
});
test('actual dispatcher controller and child-environment seams use only the explicit new admission',()=>{
 const source=read('tests/unit/stateful-engineering-source-admission.mjs').toString();
 const extract=name=>{const start=source.indexOf('export function '+name+'(');assert(start>=0);const end=source.indexOf('\n}',start);assert(end>start);return source.slice(start,end+2).replace('export function','function').replaceAll('import.meta.url',JSON.stringify('unreachable-historical-module-url'));};
 const calls=[],result=runInNewContext([extract('admitNativeApiSourceOptions'),extract('admitCoordinatedNativeSourceOptions'),extract('admitNativeSourceEnvironment'),
  'const a=admitNativeApiSourceOptions({engineeringSourceProfile:STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,nativeMarker:false});',
  'const b=admitCoordinatedNativeSourceOptions({engineeringSourceProfile:STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,nativeMarker:false});',
  'const c=admitNativeSourceEnvironment(); [a.profile,b.profile,c.profile];'].join('\n'),
  {assert,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE:profile,process:{env:{HYPERION_NATIVE_SOURCE_PROFILE:profile}},admitWire34CbfbSourceOptions:options=>{calls.push(JSON.parse(JSON.stringify(options)));return {profile,qualificationOnly:true};}});
 assert.deepEqual(Array.from(result),[profile,profile,profile]);assert.deepEqual(calls,[{nativeMarker:false,engineeringSourceProfile:profile},{nativeMarker:false,engineeringSourceProfile:profile},{nativeMarker:true,engineeringSourceProfile:profile}]);
});
