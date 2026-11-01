import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {createMongoDbStatefulOwnerAdapterV2} from '../dist/stateful-owner-v2.js';
import {createMongoDbStatefulIndexedAdapterV1} from '../dist/stateful-indexed-v1.js';
import {selectMongoDbIndexedEngineeringAssemblyV1,MONGODB_INDEXED_ENGINEERING_PROFILE_V1} from '../dist/stateful-indexed-engineering-v1.js';
import {prepared,totals,schema,collection,hex} from './indexed-schema-fixture.mjs';
import {ownerPort} from './indexed-schema-owner-port.mjs';
async function setup(indexed=true,port=ownerPort()){
 const s=await prepared(),options={client:port.client,databaseName:'inert_schema',backendId:'schema-fixture',collectionPrefix:'owner_port',declaration:s.owner,
  receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:1000,transactionTimeoutMS:2000};
 const requirements=[{declaration:s.declaration,limits:totals()}],adapter=indexed?await createMongoDbStatefulIndexedAdapterV1(options,requirements):await createMongoDbStatefulOwnerAdapterV2(options);
 const identity={id:'inert-runtime-owner',generation:'one'},lease=await adapter.acquireOwner({expected:null,nextOwner:identity},()=>{}),entries=new Map();
 const custody={async load(digest,source){return entries.get(digest+source)??null;},async retain(candidate){entries.set(candidate.declarationDigest+candidate.source.digest,candidate);}};
 const execute=async(reduce)=>{const recovery=await adapter.recovery(),n=recovery.view.checkpoint.blockNum+1,target=await sdk.captureStatefulRawTargetV2(s.owner,{
  schemaVersion:2,chainId:s.owner.projection.definition.binding.chainId,declarationDigest:s.owner.digest,owner:identity,previous:recovery.view,
  block:{blockNum:n,blockId:hex(n),previousBlockId:recovery.view.checkpoint.blockId},rawSource:{commitId:'inert:'+hex(n),selectionId:'inert:'+hex(n),observationId:'inert:'+hex(n),observationDigest:hex(n+100)}});
  await adapter.admitRaw(lease,target);await sdk.executeStatefulOwnerBlockV2(s.owner,adapter,lease,target.digest,{previous:target.target.previous.checkpoint,block:{...target.target.block,timeMs:'1001'},inputs:[]},custody,reduce,()=>{});
  const candidate=[...entries.values()].at(-1);await adapter.retireRaw(lease,target.digest,candidate.source.digest,candidate.digest);return adapter.recovery();};
 return {...s,options,requirements,port,adapter,identity,lease,execute};
}
const coverage=s=>[...s.port.storage].find(([name])=>name.endsWith('_ix1_'+s.declaration.digest+'_c'))?.[1].get(s.declaration.digest);
const selected=s=>selectMongoDbIndexedEngineeringAssemblyV1(s.adapter,MONGODB_INDEXED_ENGINEERING_PROFILE_V1);
test('actual native owner bootstrap initializes empty model coverage and closes every session',async()=>{
 const s=await setup();assert.equal(coverage(s).ready,true);assert.equal(coverage(s).checkpoint.blockNum,0);assert(s.port.sessions.length>=2);assert(s.port.sessions.every(session=>session.hasEnded));
 const actual=await selected(s).indexedForModel((await s.adapter.recovery()).view,s.declaration.digest,()=>{});assert.deepEqual(actual.indexedCapabilities.queryDeclarationDigests,[s.declaration.digest]);
 await assert.rejects(s.adapter.indexedForModel((await s.adapter.recovery()).view,s.declaration.digest,()=>{}),/engineering assembly/);
});
test('actual SDK candidate apply and native owner rollback carry sidecars with canonical progress',async()=>{
 const s=await setup(),result=await s.execute(async port=>{port.put('schema','one',schema());port.put('collection','c',collection());});
 assert.equal(result.view.checkpoint.blockNum,1);assert.equal(coverage(s).checkpoint.blockNum,1);assert.equal(coverage(s).ready,true);
 const read=await s.adapter.completedRead(s.identity,result.view,()=>{});assert.equal((await s.adapter.readCompleted(read,result.view,[{kind:'schema',key:'one'}])).results[0].status,'present');s.adapter.closeRead(read);
 const rolled=await s.adapter.rollbackOwned(s.lease,{declarationDigest:s.owner.digest,revision:result.view.revision,operationId:hex(95),from:result.view.checkpoint,ancestor:{blockNum:0,blockId:hex(0)},maxBlocks:1});
 assert.equal(rolled.recovery.view.checkpoint.blockNum,0);assert.equal(coverage(s).checkpoint.blockNum,0);assert.equal(coverage(s).revision,rolled.recovery.view.revision);assert.equal(coverage(s).ready,true);
 assert(s.port.sessions.every(session=>session.hasEnded));
});
test('old populated generation keeps actual keyed reads and refuses model coverage without scanning/rebuilding',async()=>{
 const s=await setup(false);await s.execute(async port=>port.put('schema','one',schema()));const previous=await s.adapter.recovery(),start=s.port.calls.length;
 const adapter=await createMongoDbStatefulIndexedAdapterV1(s.options,s.requirements),identity={...s.identity,generation:'two'};
 await adapter.acquireOwner({expected:{version:previous.version,view:previous.view,owner:previous.owner},nextOwner:identity},()=>{});
 const recovery=await adapter.recovery();assert.equal(coverage(s).ready,false);assert.equal(coverage(s).reason,'state-only-rebuild-required');
 const read=await adapter.completedRead(identity,recovery.view,()=>{});assert.equal((await adapter.readCompleted(read,recovery.view,[{kind:'schema',key:'one'}])).results[0].status,'present');adapter.closeRead(read);
 const engineering=selectMongoDbIndexedEngineeringAssemblyV1(adapter,MONGODB_INDEXED_ENGINEERING_PROFILE_V1);
 await assert.rejects(engineering.indexedForModel(recovery.view,s.declaration.digest,()=>{}),/not covered/);
 assert.equal(s.port.calls.slice(start).some(call=>call.name.includes('_stateful_v2_r_')&&call.command==='findOne'&&Object.keys(call.filter).length===0),false);
 assert(s.port.sessions.every(session=>session.hasEnded));
});
test('same-generation reopen preserves model readiness and an actual invalid-value commit poisons only that model',async()=>{
 const s=await setup();await s.execute(async port=>port.put('schema','one',schema()));const before=await s.adapter.recovery();
 const adapter=await createMongoDbStatefulIndexedAdapterV1(s.options,s.requirements);await adapter.acquireOwner({expected:{version:before.version,view:before.view,owner:before.owner},nextOwner:s.identity},()=>{});
 assert.equal(coverage(s).ready,true);
 const read=await adapter.completedRead(s.identity,(await adapter.recovery()).view,()=>{});assert.equal((await adapter.readCompleted(read,(await adapter.recovery()).view,[{kind:'schema',key:'one'}])).results[0].status,'present');adapter.closeRead(read);
 assert(s.port.sessions.every(session=>session.hasEnded));
 const fresh=await setup();await fresh.execute(async port=>port.put('collection','bad',{...collection(),authorized_accounts:[1]}));assert.equal(coverage(fresh).ready,false);assert.equal((await fresh.adapter.recovery()).view.checkpoint.blockNum,1);
});
