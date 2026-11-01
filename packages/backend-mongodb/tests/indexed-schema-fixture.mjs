// Inert finite values and collection/cursor ports. No database, controller, timer, child or socket.
import * as stateful from '@eosrio/hyperion-sdk/projection-stateful';
import * as ownerSdk from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import * as indexed from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import {receiveMongoIndexedModelV1,MONGO_SIMPLE_INDEXED_COMPARISON_V1} from '../dist/stateful-indexed-model-v1.js';
import {createMongoIndexedSidecarsV1,indexedCoverageV1} from '../dist/stateful-indexed-materialization-v1.js';
export const hex=n=>n.toString(16).padStart(64,'0');
export const limits=()=>({value:{depth:32,nodes:10000,fields:64,arrayElements:512,stringBytes:65536,recordBytes:262144,integerFields:8,pathSegments:16},
 envelope:{depth:48,nodes:100000,fields:64,arrayElements:2048,stringBytes:2097152,recordBytes:4194304,integerFields:8,pathSegments:16},
 selectors:8,recordKinds:8,inputOccurrences:512,inputBytes:1048576,keyBytes:1024,readKeys:32,readAttempts:128,mutations:512,candidateBytes:4194304,responseRecords:32,responseBytes:4194304});
export const totals=()=>({readAttempts:12,responseRecords:8,responseBytes:65536,queryBytes:8192,predicates:12,orderTerms:8,setValues:16});
export const definition=()=>({family:stateful.STATEFUL_FAMILY,interfaceVersion:1,id:'native-schema-tracer',
 binding:{chainId:hex(10),backendId:'schema-fixture',generation:'fresh-explicit-generation',mappingRevision:hex(11),hookArtifact:hex(12),hookRevision:hex(13),codecRevision:hex(14),normalizerRevision:hex(15)},
 selectors:[{id:'changes',kind:'action',contract:'fixture',name:'changes',abiDeployment:'synthetic-1',abiSha256:hex(16)}],records:[
 {kind:'schema',integers:[{path:['created_at_time'],type:'int64',vector:false}]},
 {kind:'collection',integers:[]},{kind:'schema-asset-count',integers:[{path:['assets'],type:'int64',vector:false}]}]});
export const model=()=>({id:'schema-list',base:{alias:'schema',kind:'schema'},joins:[
 {alias:'collection',kind:'collection',mode:'inner-one',on:[{basePath:['contract'],joinedPath:['contract']},{basePath:['collection_name'],joinedPath:['collection_name']}]},
 {alias:'assets',kind:'schema-asset-count',mode:'left-one',on:[{basePath:['contract'],joinedPath:['contract']},{basePath:['collection_name'],joinedPath:['collection_name']},{basePath:['schema_name'],joinedPath:['schema_name']}]}
 ],fields:[
 {id:'contract',alias:'schema',path:['contract'],type:'text',nullable:false,operators:['eq']},
 {id:'collection',alias:'schema',path:['collection_name'],type:'text',nullable:false,operators:['eq','in','not-in']},
 {id:'schema',alias:'schema',path:['schema_name'],type:'text',nullable:false,operators:['eq','in','not-in']},
 {id:'created',alias:'schema',path:['created_at_time'],type:'int64',nullable:false,operators:['eq','gte','gt','lt']},
 {id:'authorized',alias:'collection',path:['authorized_accounts'],type:'text-vector',nullable:false,operators:[]},
 {id:'assets',alias:'assets',path:['assets'],type:'int64',nullable:true,operators:[]}],textComparison:MONGO_SIMPLE_INDEXED_COMPARISON_V1,
 orders:[[{field:'created',direction:'desc',nulls:'last'}],[{field:'schema',direction:'asc',nulls:'last'}]]});
export const page=(changes={})=>({kind:'page',where:[{field:'contract',op:'eq',value:'atomicassets'}],order:model().orders[0],offset:'0',limit:2,
 select:['schema','created','authorized','assets'],records:['schema','collection','assets'],...changes});
export const count=(changes={})=>({kind:'count',exact:true,where:[{field:'contract',op:'eq',value:'atomicassets'}],...changes});
export const schema=(name='one',created='9007199254740993')=>({contract:'atomicassets',collection_name:'collection',schema_name:name,created_at_time:created,format:[{name:'author',type:'string'}]});
export const collection=()=>({contract:'atomicassets',collection_name:'collection',authorized_accounts:['alice','雪'],data:{name:'雪\n"\\'}});
export const assets=(value='0')=>({contract:'atomicassets',collection_name:'collection',schema_name:'one',assets:value});
export async function prepared(changes={}) {
 const l=limits(),projection=await stateful.captureStatefulDeclaration(definition(),l),offer=supported=>({family:ownerSdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:l});
 const owner=await ownerSdk.negotiateStatefulOwnerV2(projection,offer(ownerSdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2),offer(ownerSdk.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const declaration=await indexed.captureIndexedDeclarationV1(owner,'schema-tracer-v1',changes.model??model()),native=await receiveMongoIndexedModelV1(owner,declaration,changes.totals??totals());
 const view={declarationDigest:owner.digest,backendId:'schema-fixture',generation:projection.definition.binding.generation,revision:hex(20),checkpoint:{blockNum:0,blockId:hex(0)}};
 return {projection,owner,declaration,native,view};
}
export class InertCollection {
 constructor(name){this.collectionName=name;this.values=new Map();this.calls=[];}
 async findOne(filter,options){this.calls.push(['findOne',filter,options]);return [...this.values.values()].find(row=>Object.entries(filter).every(([key,value])=>{
  const actual=key.split('.').reduce((current,part)=>current?.[part],row);return value&&typeof value==='object'&&'$nin'in value?!value.$nin.includes(actual):actual===value;
 }))??null;}
 async insertOne(row,options){this.calls.push(['insertOne',row,options]);if(this.values.has(row._id))throw new Error('duplicate id');this.values.set(row._id,row);return {acknowledged:true};}
 async replaceOne(filter,row,options){this.calls.push(['replaceOne',filter,options]);this.values.set(filter._id,row);return {acknowledged:true};}
 async deleteOne(filter,options){this.calls.push(['deleteOne',filter,options]);this.values.delete(filter._id);return {acknowledged:true};}
}
export function sidecars(s){
 const entry={model:s.native,rows:new InertCollection('rows'),coverage:new InertCollection('coverage'),images:new InertCollection('images')};
 entry.coverage.values.set(s.declaration.digest,indexedCoverageV1(entry,s.view,true,null));
 return {entry,hooks:createMongoIndexedSidecarsV1([entry],1048576),session:Object.freeze({tag:'same canonical transaction'}),call:work=>work()};
}
export const put=(kind,key,value)=>({kind:'put',target:{kind,key},value});
export const del=(kind,key)=>({kind:'delete',target:{kind,key}});
export const next=(view,n,revision=view.revision)=>({...view,revision,checkpoint:{blockNum:n,blockId:hex(n)}});
export const candidate=(before,n,mutations)=>({source:{source:{block:{blockNum:n,blockId:hex(n),previousBlockId:before.checkpoint.blockId}},digest:hex(50+n)},digest:hex(70+n),view:before,observations:[],mutations});
