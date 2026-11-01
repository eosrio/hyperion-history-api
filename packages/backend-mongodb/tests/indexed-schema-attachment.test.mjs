import assert from 'node:assert/strict';
import test from 'node:test';
import {createMongoDbStatefulIndexedAdapterV1} from '../dist/stateful-indexed-v1.js';
import {createMongoDbStatefulOwnerAdapterV2} from '../dist/stateful-owner-v2.js';
import {createMongoDbStatefulCompleteKindAdapterV1} from '../dist/stateful-complete-kind-v1.js';
import {selectMongoDbIndexedEngineeringAssemblyV1,MONGODB_INDEXED_ENGINEERING_PROFILE_V1} from '../dist/stateful-indexed-engineering-v1.js';
import {prepared,model,totals,page} from './indexed-schema-fixture.mjs';
async function attached(input={}){
 const s=await prepared({model:input.model??model()}),operations=[];
 // A constructor-only native port. It cannot open a connection or execute a command.
 const client={options:{retryReads:false,retryWrites:false,maxAdaptiveRetries:0},db(){return {collection(name){return new Proxy({collectionName:name},{get(target,key){if(key in target)return target[key];return()=>{operations.push([name,key]);throw new Error('unexpected native I/O');};}});}};}};
 const options={client,databaseName:'inert_schema',backendId:'schema-fixture',collectionPrefix:'schema_fixture',declaration:s.owner,
  receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:1000,transactionTimeoutMS:2000};
 const adapter=await createMongoDbStatefulIndexedAdapterV1(options,[{declaration:s.declaration,limits:totals()}]);return {...s,adapter,operations,options};
}
test('indexed attachment constructs no native I/O and initial offers do not assert readiness',async()=>{
 const s=await attached();assert.deepEqual(s.operations,[]);assert.deepEqual(s.adapter.indexedCapabilities.queryDeclarationDigests,[]);assert.deepEqual(s.adapter.indexedCapabilities.comparisonProfiles,[]);
 assert.equal(s.adapter.capabilities.family,'stateful-projection-owner-recovery');assert.equal(typeof s.adapter.readCompleted,'function');
 await assert.rejects(s.adapter.indexedForModel(s.view,s.declaration.digest,()=>{}),/explicitly pinned indexed engineering assembly/);assert.deepEqual(s.operations,[]);
});
test('Atomic SQL comparison profiles have empty offers and refuse before any native data I/O',async()=>{
 const m=model();m.textComparison='atomicassets-postgresql-sql-v1';const s=await attached({model:m});
 await assert.rejects(s.adapter.indexedForModel(s.view,s.declaration.digest,()=>{}),/no native qualification/);
 assert.deepEqual(s.operations,[]);assert.deepEqual(s.adapter.indexedCapabilities.comparisonProfiles,[]);
});
test('copied completed-read DTOs cannot gain native indexed authority',async()=>{
 const s=await attached();for(const read of [{},Object.freeze({}),{view:s.view,owner:s.owner}]){
  await assert.rejects(s.adapter.queryCompleted(read,s.view,page(),totals(),s.declaration),/Foreign or closed/);
  await assert.rejects(s.adapter.completedView(read),error=>error.code==='stateful.unavailable');
 }assert.deepEqual(s.operations,[]);
});
test('an existing owner attachment from another instance/declaration cannot be transplanted',async()=>{
 const s=await attached();await assert.rejects(createMongoDbStatefulIndexedAdapterV1(s.options,[{declaration:s.declaration,limits:totals()}],undefined,
  {capabilities:s.adapter.capabilities}),/another actual owner/);assert.deepEqual(s.operations,[]);
});
test('genuine same-declaration owners reject other clients, databases, namespaces and native policies before I/O',async()=>{
 const s=await attached(),requirements=[{declaration:s.declaration,limits:totals()}];
 const changes=[{collectionPrefix:'other_prefix'},{databaseName:'other_database'},{client:{...s.options.client}},
  ...['receiptRetention','rollbackRetentionBlocks','rollbackRetentionBytes','rollbackMaxBlockBytes','operationTimeoutMS','transactionTimeoutMS']
   .map(key=>({[key]:s.options[key]+1}))];
 for(const change of changes){
  const original=await createMongoDbStatefulOwnerAdapterV2({...s.options,...change});
  await assert.rejects(createMongoDbStatefulIndexedAdapterV1(s.options,requirements,undefined,original),/actual owner native binding/);
 }
 assert.deepEqual(s.operations,[]);
});
test('two genuine same-declaration namespace owners can attach only to their own exact native binding',async()=>{
 const s=await attached(),requirements=[{declaration:s.declaration,limits:totals()}],a={...s.options,collectionPrefix:'owner_a'},b={...s.options,collectionPrefix:'owner_b'};
 const ownerA=await createMongoDbStatefulOwnerAdapterV2(a),ownerB=await createMongoDbStatefulOwnerAdapterV2(b);
 await assert.rejects(createMongoDbStatefulIndexedAdapterV1(a,requirements,undefined,ownerB),/actual owner native binding/);
 const indexedA=await createMongoDbStatefulIndexedAdapterV1({...a},requirements,undefined,ownerA),indexedB=await createMongoDbStatefulIndexedAdapterV1({...b},requirements,undefined,ownerB);
 assert.equal(indexedA.capabilities,ownerA.capabilities);assert.equal(indexedB.capabilities,ownerB.capabilities);assert.deepEqual(s.operations,[]);
});
test('complete-kind facades retain the same private native binding through indexed attachment',async()=>{
 const s=await attached(),requirements=[{declaration:s.declaration,limits:totals()}],{readAttempts,responseRecords,responseBytes}=totals(),limits={readAttempts,responseRecords,responseBytes};
 const original=await createMongoDbStatefulCompleteKindAdapterV1(s.options,limits);
 await assert.rejects(createMongoDbStatefulIndexedAdapterV1({...s.options,collectionPrefix:'other_owner'},requirements,limits,original),/actual owner native binding/);
 const indexed=await createMongoDbStatefulIndexedAdapterV1({...s.options},requirements,limits,original);
 assert.equal(indexed.completeKindCapabilities,original.completeKindCapabilities);assert.deepEqual(s.operations,[]);
});
test('retrying clients and duplicate model identities refuse during inert construction',async()=>{
 const s=await attached();await assert.rejects(createMongoDbStatefulIndexedAdapterV1({...s.options,client:{...s.options.client,options:{retryReads:true,retryWrites:false,maxAdaptiveRetries:0}}},
  [{declaration:s.declaration,limits:totals()}]),/nonretrying/);
 await assert.rejects(createMongoDbStatefulIndexedAdapterV1(s.options,[{declaration:s.declaration,limits:totals()},{declaration:s.declaration,limits:totals()}]),/Ambiguous indexed model/);
 assert.deepEqual(s.operations,[]);
});
test('engineering opt-in requires exact pinned emissions and still requires native index/coverage admission',async()=>{
 const s=await attached();assert.throws(()=>selectMongoDbIndexedEngineeringAssemblyV1(s.adapter,'implicit'));
 const selected=selectMongoDbIndexedEngineeringAssemblyV1(s.adapter,MONGODB_INDEXED_ENGINEERING_PROFILE_V1);
 assert.notEqual(selected,s.adapter);assert.deepEqual(selected.indexedCapabilities.comparisonProfiles,[]);
 await assert.rejects(selected.indexedForModel(s.view,s.declaration.digest,()=>{}),/unexpected native I\/O/);
 assert.equal(s.operations.length,1);
});
test('the engineering selector never turns Atomic SQL into a qualified comparison profile',async()=>{
 const m=model();m.textComparison='atomicassets-postgresql-sql-v1';const s=await attached({model:m});
 const selected=selectMongoDbIndexedEngineeringAssemblyV1(s.adapter,MONGODB_INDEXED_ENGINEERING_PROFILE_V1);
 await assert.rejects(selected.indexedForModel(s.view,s.declaration.digest,()=>{}),/no native qualification/);assert.deepEqual(s.operations,[]);
});
