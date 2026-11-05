// Pure cbfb fixture controls: never import or run the native process lifecycle.
import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import * as ts from 'typescript/unstable/ast';
import {PLAN as historical} from './native-contract.mjs';
import {PLAN,sha} from './wire34-cbfb-native-contract.mjs';
import {DESCRIPTOR} from './wire34-cbfb-assembly.mjs';
import {NATIVE_PROFILE,observeNativeInputs,assertNativeInputs,assertNativeRuntime} from './wire34-cbfb-native-assembly.mjs';
import {observeSourceClosure,assertSourceClosure} from './native-source-closure.mjs';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {verifyIndexedTrace} from './all-cbfb-native-trace.mjs';
import {page as nativePage,count as nativeCount} from './wire34-cbfb-native-contract.mjs';

const cleanupRouting=JSON.parse(readFileSync(new URL('./all-cbfb-native-cleanup-routing.json',import.meta.url)));
const recorded=JSON.parse(readFileSync(new URL('../../../tests/fixtures/engineering-profiles/failed-native-membership-41884653731.json',import.meta.url)));
for(const capture of recorded.captures)test('recorded Node '+capture.node+' membership requests keep exact per-request accounting in the real runner handler',async()=>{
 const source=readFileSync(new URL('./wire34-cbfb-native-runner.mjs',import.meta.url),'utf8'),
  phaseWork=/^ const phaseWork=.*$/m.exec(source)?.[0],verify=/^ const verify=.*$/m.exec(source)?.[0],
  start=source.indexOf("   'bounded-int64-membership':async()=>{"),end=source.indexOf("   'sealed-explain':",start);
 assert(phaseWork&&verify&&start>0&&end>start);let calls=0;const observed=[];
 const result=await runInNewContext(`(async()=>{let phase={name:'bounded-int64-membership'};const trace=[];${phaseWork}\n${verify}\nconst direct=async request=>JSON.parse(JSON.stringify(await observe(request,phase.name,trace)));const handlers={${source.slice(start,end)}};return handlers['bounded-int64-membership']();})()`,{
  assert,PLAN,verifyIndexedTrace,page:nativePage,count:nativeCount,
  observe:async(request,phase,trace)=>{
   const selected=capture.requests[calls];assert(selected,'Unexpected membership query');assert.equal(request.kind,calls===0?'page':'count');
   assert.equal(request.where[1].values.length,calls===2?0:3);
   for(const row of selected.rows)trace.push({...structuredClone(row),seq:trace.length,phase});
   observed.push({name:selected.name,phase,attempts:selected.attempts});calls++;
   return {attempts:selected.attempts,result:request.kind==='page'?{rows:[{key:'s:d'},{key:'s:a'}]}:{value:selected.name==='count'?'2':'0'}};
  }
 });
 assert.equal(calls,3);assert.equal(result.bsonLongMembership,true);assert.equal(new Set(observed.map(row=>row.phase)).size,3);
 assert.deepEqual(observed.map(row=>row.name),['page','count','empty']);
});
test('cbfb fixture preserves historical resources, limits and all existing cases',()=>{
 assert.deepEqual(PLAN.fixture,historical.fixture);assert.deepEqual(PLAN.limits,historical.limits);assert.equal(PLAN.operationMS,historical.operationMS);assert.equal(PLAN.transactionMS,historical.transactionMS);
 assert.deepEqual(PLAN.cases.filter(x=>x!=='bounded-int64-membership'),historical.cases);assert(PLAN.cases.includes('bounded-int64-membership'));
 assert.equal(PLAN.sdk,'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');assert.equal(PLAN.acceptance.nativeMongoDB,'pending-until-run');
});
test('cbfb native profile captures exact installed dependencies and retains historical descriptor',()=>{
 const actual=observeNativeInputs(),receipt=assertNativeInputs(actual);assert.equal(receipt.profile,PLAN.profile);
 for(const mutate of [x=>x.sourceFiles[0].sha256='0'.repeat(64),x=>x.dependencies['native:bson'].files.pop(),x=>x.baseAssemblySha256='f'.repeat(64)]){const copy=structuredClone(actual);mutate(copy);assert.throws(()=>assertNativeInputs(copy));}
 for(const runtime of NATIVE_PROFILE.runtimes){assertNativeRuntime({node:runtime.node,platform:'linux',arch:'x64',executableSha256:runtime.executableSha256});assert.throws(()=>assertNativeRuntime({node:runtime.node,platform:'linux',arch:'x64',executableSha256:'0'.repeat(64)}));}
});
test('cbfb native source closure is exact and bounded',()=>{
 const boundaries=new Set(DESCRIPTOR.observation.sources.map(x=>x.path));for(const [key,prefix] of Object.entries({rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'}))for(const row of DESCRIPTOR.observation.trees[key])boundaries.add(prefix+'/'+row.path);
 const closure=observeSourceClosure({root:fileURLToPath(new URL('../../../',import.meta.url)),ts,boundaries,...NATIVE_PROFILE.sourceClosure.inputs});assertSourceClosure(closure,NATIVE_PROFILE);
 const altered=structuredClone(closure);altered.edges.pop();assert.throws(()=>assertSourceClosure(altered,NATIVE_PROFILE),/closure changed/);
});
import * as logical from '@eosrio/hyperion-sdk/projection-stateful';
import * as owner from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import * as indexed from '../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-indexed-query-v1.js';
import * as nativeOwner from '../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js';
import {receiveMongoIndexedModelV1,planMongoIndexedQueryV1} from '../../../packages/backend-mongodb/dist/stateful-indexed-model-v1.js';
import {projectionDefinition,projectionLimits,schemaModel,page} from './wire34-cbfb-native-contract.mjs';
test('real mixed root/native SDK captures bounded signed-int64 set as BSON Long',async()=>{
 const projection=await logical.captureStatefulDeclaration(projectionDefinition(logical,'mixed-sdk-control'),projectionLimits());
 const capability=supported=>({family:owner.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:projection.limits});
 const declared=await owner.negotiateStatefulOwnerV2(projection,capability(owner.STATEFUL_OWNER_HOST_CAPABILITIES_V2),capability(owner.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const received=await nativeOwner.receiveStatefulOwnerDeclarationV2(declared),nativeCapability=supported=>({family:nativeOwner.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:received.projection.limits});
 const native=await nativeOwner.negotiateStatefulOwnerV2(received.projection,nativeCapability(nativeOwner.STATEFUL_OWNER_HOST_CAPABILITIES_V2),nativeCapability(nativeOwner.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const declaration=await indexed.captureIndexedDeclarationV1(native,'owned-native-fixture-v1',schemaModel()),model=await receiveMongoIndexedModelV1(native,declaration,PLAN.limits);
 const where=[{field:'contract',op:'eq',value:'atomicassets'},{field:'created',op:'in',values:['9007199254740995','9007199254740993','9007199254740993']}];
 const planned=planMongoIndexedQueryV1(model,page({where,limit:8}),'fixture_rows'),set=planned.pipeline[0].$match.$and.find(row=>row['v.created'])['v.created'].$in;
 assert.deepEqual(set.map(v=>v.toString()),where[1].values);assert(set.every(v=>v._bsontype==='Long'));assert.equal(planned.allowDiskUse,false);
});

function restoreNativeCleanup(path,source){const row=cleanupRouting.files.find(row=>row.path===path);if(!row)return source;assert.equal(sha(source),row.currentSha256,'Native cleanup source differs from reviewed boundary edits: '+path);for(const change of [...row.changes].reverse()){assert.equal(source.split(change.current).length-1,change.count);source=source.split(change.current).join(change.historical);}assert.equal(sha(source),row.historicalSha256);return source;}
test('all-CBFB successor preserves exact original native workload, controller, trace and accepted capability selection',()=>{
 const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
 for(const name of ['runner','ci','trace','contract']){
  const path='scripts/qualification/indexed-schema-mongodb/all-cbfb-native-'+name+'.mjs',current=read('./all-cbfb-native-'+name+'.mjs');let actual=restoreNativeCleanup(path,current).replaceAll('./all-cbfb-native-','./cbfb-native-');if(['runner','ci'].includes(name))assert.throws(()=>restoreNativeCleanup(path,current+'\n'),/reviewed boundary/);
  if(name==='runner')actual=actual.replace("rootSdk:'cbfb'","rootSdk:'dc20'");
  if(name==='contract')actual=actual.replace('indexed-schema-mongodb-all-cbfb-linux-gha-v1','indexed-schema-mongodb-cbfb-49dfe-linux-gha-v1');
  assert.equal(actual,read('./cbfb-native-'+name+'.mjs'),'Only explicit profile imports/identity and correct SDK metadata may differ: '+name);
 }
 assert.equal(PLAN.assembly,'indexed-royalty-sdk-cbfb-native-cf514-engineering-v1');
});
