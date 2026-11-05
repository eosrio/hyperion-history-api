import test from 'node:test';
import assert from 'node:assert/strict';
import {Long} from 'mongodb';
import {assertMongoIndexedTracerModelV1,planMongoIndexedQueryV1} from '../dist/stateful-indexed-model-v1.js';
import {prepared,page,model} from './indexed-schema-fixture.mjs';

test('int64 membership uses exact BSON Long values, including boundaries and duplicates',async()=>{
 const definition=model();definition.fields.find(f=>f.id==='created').operators.push('in');
 const state=await prepared({model:definition});assert.doesNotThrow(()=>assertMongoIndexedTracerModelV1(state.native));
 const values=['-9223372036854775808','-1','0','9007199254740993','9223372036854775807','-1'];
 const request=page({where:[{field:'contract',op:'eq',value:'atomicassets'},{field:'created',op:'in',values}]});
 const plan=planMongoIndexedQueryV1(state.native,request,'sidecar');
 const predicate=plan.pipeline[0].$match.$and.find(x=>x['v.created'])['v.created'].$in;
 assert.equal(predicate.length,values.length);assert.ok(predicate.every(Long.isLong));assert.deepEqual(predicate.map(v=>v.toString()),values);
});
test('empty sets are explicit, invalid int64s refuse and text sets remain strings',async()=>{
 const definition=model();definition.fields.find(f=>f.id==='created').operators.push('in');const state=await prepared({model:definition});
 const make=values=>page({where:[{field:'contract',op:'eq',value:'atomicassets'},{field:'created',op:'in',values}]});
 const empty=planMongoIndexedQueryV1(state.native,make([]),'sidecar');assert.deepEqual(empty.pipeline[0].$match.$and.find(x=>x['v.created'])['v.created'].$in,[]);
 for(const bad of ['01','-0','9223372036854775808','-9223372036854775809','null'])assert.throws(()=>planMongoIndexedQueryV1(state.native,make([bad]),'sidecar'));
 const strings=planMongoIndexedQueryV1(state.native,page({where:[{field:'contract',op:'eq',value:'atomicassets'},{field:'collection',op:'in',values:['a','雪','a']}]}),'sidecar');
 assert.deepEqual(strings.pipeline[0].$match.$and.find(x=>x['v.collection'])['v.collection'].$in,['a','雪','a']);
});
import {createMongoDbStatefulIndexedAdapterV1} from '../dist/stateful-indexed-v1.js';
import {selectMongoDbIndexedEngineeringAssemblyV1,MONGODB_INDEXED_ENGINEERING_PROFILE_V1} from '../dist/stateful-indexed-engineering-v1.js';
test('new SDK and code do not inherit the old pinned native engineering authority',async()=>{
 const definition=model();definition.fields.find(f=>f.id==='created').operators.push('in');const state=await prepared({model:definition});let io=0;
 const client={options:{retryReads:false,retryWrites:false,maxAdaptiveRetries:0},db(){return {collection(name){return new Proxy({collectionName:name},{get(target,key){if(key in target)return target[key];return()=>{io++;throw Error('unexpected I/O');};}});}};}};
 const options={client,databaseName:'inert',backendId:'schema-fixture',collectionPrefix:'fixture',declaration:state.owner,receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:1000,transactionTimeoutMS:2000};
 const adapter=await createMongoDbStatefulIndexedAdapterV1(options,[{declaration:state.declaration,limits:state.native.limits}]);
 assert.deepEqual(adapter.indexedCapabilities.comparisonProfiles,[]);assert.throws(()=>selectMongoDbIndexedEngineeringAssemblyV1(adapter,MONGODB_INDEXED_ENGINEERING_PROFILE_V1),/source pins differ/);assert.equal(io,0);
});
import {selectMongoDbRoyaltyEngineeringAssemblyV1,MONGODB_ROYALTY_ENGINEERING_PROFILE_V1} from '../dist/stateful-indexed-royalty-engineering-v1.js';
test('old royalty selector refuses changed native emission and new assembly requires a locally created adapter',async()=>{
 const definition=model();definition.fields.find(f=>f.id==='created').operators.push('in');const state=await prepared({model:definition});let io=0;
 const client={options:{retryReads:false,retryWrites:false,maxAdaptiveRetries:0},db(){return {collection(name){return new Proxy({collectionName:name},{get(target,key){if(key in target)return target[key];return()=>{io++;throw Error('unexpected I/O');};}});}};}};
 const options={client,databaseName:'inert',backendId:'schema-fixture',collectionPrefix:'fixture',declaration:state.owner,receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:1000,transactionTimeoutMS:2000};
 const adapter=await createMongoDbStatefulIndexedAdapterV1(options,[{declaration:state.declaration,limits:state.native.limits}]);
 assert.throws(()=>selectMongoDbRoyaltyEngineeringAssemblyV1(adapter,'unrelated-profile'),/Explicit royalty engineering assembly/);
 assert.throws(()=>selectMongoDbRoyaltyEngineeringAssemblyV1(adapter,MONGODB_ROYALTY_ENGINEERING_PROFILE_V1),/Royalty engineering native emissions differ/);
 assert.throws(()=>selectMongoDbLinearHistoryEngineeringAssemblyV1(adapter,'unrelated-profile'),/Explicit linear history engineering assembly/);
 assert.throws(()=>selectMongoDbLinearHistoryEngineeringAssemblyV1({},MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1),/actual locally created/);
 assert.ok(selectMongoDbLinearHistoryEngineeringAssemblyV1(adapter,MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1));assert.equal(io,0);
});

import {selectMongoDbLinearHistoryEngineeringAssemblyV1,MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1} from '../dist/stateful-indexed-linear-history-engineering-v1.js';
