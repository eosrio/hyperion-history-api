// Pure emitted-host controls with inert timer tokens and scripted native-port answers.
// No Fastify instance, socket, database, controller or qualification workload is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import * as logical from '@eosrio/hyperion-sdk/projection-stateful';
import * as owner from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import * as indexed from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import * as metadata from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {protocolImmutableJson} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {statefulOwnerExpectationDigest} from '../../build/indexer/projection/stateful-expectation.js';
import {STATE_RESPONSE_HEADERS,stateResponseHeaders} from '../../build/api/helpers/state-headers.js';
import {STATEFUL_SOURCE_CAPABILITIES_V2} from '../../build/indexer/projection/stateful-source.js';
const atomic=process.env.HYPERION_ATOMIC_ROOT;assert(atomic);
const load=path=>import(pathToFileURL(join(atomic,path)));
const [{default:AtomicPlugin},{CompleteKindReference},{limits}]=await Promise.all([load('dist/index.js'),load('tests/fixtures/complete-kind-adapter.mjs'),load('tests/fixtures/config-component.mjs')]);
const hex=n=>n.toString(16).padStart(64,'0'),copy=structuredClone;
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
function emitted(path,scope,names){
 const source=read(path).replace(/^import [^\n]+\n/gm,'').replaceAll('export ','');
 return new Function(...Object.keys(scope),source+'\nreturn {'+names.join(',')+'};')(...Object.values(scope));
}
const plugin=new AtomicPlugin({limits:{...limits(),recordKinds:22,readKeys:64,readAttempts:128,mutations:256},ownedSchemaCounts:true,
 engineeringOwnedSchemaMongoComparison:true,engineeringRoyaltyTemplateQuery:true,engineeringRoyaltyTemplateMongoComparison:true});
const configuration={generation:'pure-managed-atomic',backend:{id:'h45_indexed_123456abcdef',database:'h45_indexed_123456abcdef'},
 recovery:{receipts:32,blocks:32,bytes:4*1024*1024,maxBlockBytes:1024*1024},operationTimeoutMS:5000,transactionTimeoutMS:15000,api:{timeoutMs:5000}};
const loader={plugins:[plugin],statefulPluginsV2:()=>[{plugin,configuration:plugin.baseConfig,hookArtifact:hex(2)}]};
const adapters=new Map(),errors=[],events=[];let sourceAvailable=true,coverage=true,offerAvailable=true,socket={};
const backend=async(options,completeLimits)=>{
 const adapter=new CompleteKindReference(options.declaration);
 adapter.completeKindCapabilities={family:owner.STATEFUL_COMPLETE_KIND_FAMILY_V1,interfaceVersion:1,limits:completeLimits};
 adapter.recovery=async()=>({initialized:true,owner:{identity:copy(adapter.identity),claimDigest:hex(41)},view:copy(adapter.view),gap:null,pending:null,rollback:null});
 adapters.set(options.declaration.projection.definition.id,adapter);return adapter;
};
const nativeIndexed=async(_options,models,_complete,adapter)=>{
 const methods={};for(const key of [...Object.keys(adapter),...Object.getOwnPropertyNames(CompleteKindReference.prototype)])
  if(key!=='constructor')methods[key]=typeof adapter[key]==='function'?adapter[key].bind(adapter):adapter[key];
 return Object.freeze({...methods,async indexedForModel(view,digest,guard){
  guard();assert(coverage,'Controlled native coverage retired');const model=models.find(x=>x.declaration.digest===digest);assert(model);
  assert.deepEqual(view,adapter.view);events.push({event:'offer',model:model.declaration.model.id});
  return Object.freeze({...methods,indexedCapabilities:{family:indexed.STATEFUL_INDEXED_QUERY_FAMILY_V1,interfaceVersion:1,
   queryDeclarationDigests:offerAvailable?[digest]:[],comparisonProfiles:offerAvailable?[model.declaration.model.textComparison]:[],limits:model.limits},
   async queryCompleted(read,expected,request,_remaining,chosen){
    adapter.use(read,expected);assert.equal(chosen.digest,digest);events.push({event:'query',model:model.declaration.model.id,request:copy(request)});
    return {view:copy(expected),queryDeclarationDigest:digest,attempts:1,result:request.kind==='count'?{kind:'count',exact:true,value:'0'}:{kind:'page',complete:true,rows:[]}};
   }});
 }});
};
const {StatefulProjectionRegistryV2}=emitted('build/indexer/projection/stateful-registry.js',{
 createHash,protocolImmutableJson,...logical,...owner,...indexed,...metadata,STATEFUL_SOURCE_CAPABILITIES_V2,
 installedRuntimeArtifacts:async()=>({executableSha256:hex(3)}),createMongoDbStatefulOwnerAdapterV2:backend,
 createMongoDbStatefulCompleteKindAdapterV1:backend,createMongoDbStatefulIndexedAdapterV1:nativeIndexed},['StatefulProjectionRegistryV2']);
const registry=await StatefulProjectionRegistryV2.create({chainId:hex(1),configuration,mongo:{},client:{},profile:{id:'controlled',profileId:'controlled',components:[]},completeKindMongo:async()=>({}),
 source:{async statefulSelectors(selectors){return {selectors:selectors.map(x=>({...x,abiDeployment:'controlled-source',abiSha256:hex(4)})),proof:{}};},
  async revalidate(){assert(sourceAvailable,'Controlled source unavailable');},async open(){return {};},async assertStatefulView(){assert(sourceAvailable,'Controlled source unavailable');}},
 onError:(projection,error)=>errors.push({projection,message:error.message})},loader);
await registry.initializeMissing();assert.deepEqual(errors,[]);

const hooks=new Map(),routes=[],timers=new Set();
const add=(method,url,options,handler)=>{const route=typeof url==='object'?url:{method,url,...(typeof options==='object'?options:{}),handler:handler??options};
 for(const hook of hooks.get('onRoute')??[])hook(route);routes.push(route);};
const server={supportedMethods:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'],addHook(name,hook){if(!hooks.has(name))hooks.set(name,[]);hooks.get(name).push(hook);},
 route:route=>add(undefined,route),get:(url,options,handler)=>add('GET',url,options,handler),all:(url,options,handler)=>add('GET',url,options,handler)};
const {installStatefulApiHostV2}=emitted('build/api/helpers/stateful-owner.js',{
 ...owner,...indexed,composeStatefulOwnerIndexedReadV1:async(...args)=>{try{return await indexed.composeStatefulOwnerIndexedReadV1(...args);}catch(error){events.push({event:'composition-error',message:error.message,stack:error.stack});throw error;}},protocolImmutableJson,statefulOwnerExpectationDigest,STATE_RESPONSE_HEADERS,stateResponseHeaders,AbortController,Buffer,performance:{now:()=>100},
 setTimeout:()=>{const token={};timers.add(token);return token;},clearTimeout:token=>{assert(timers.delete(token));}},['installStatefulApiHostV2']);
const context=installStatefulApiHostV2(server,{configuration,registry:async()=>registry,probe:{currentSocket:()=>socket,probe:async()=>sourceAvailable}});
plugin.addRoutes(server,context);

async function request(url,late){
 const route=routes.find(x=>x.url===url);assert(route,'Actual plugin route missing');
 const request={params:{collection_name:'cats'},query:{},raw:Object.assign(new EventEmitter(),{aborted:false})},headers={};
 const reply={statusCode:200,raw:Object.assign(new EventEmitter(),{writableEnded:false}),code(code){this.statusCode=code;return this;},
  header(name,value){headers[name.toLowerCase()]=value;return this;},headers(values){for(const [name,value]of Object.entries(values))this.header(name,value);return this;},
  removeHeader(name){delete headers[name];return this;},send(value){this.payload=value;return this;}};
 for(const hook of hooks.get('onRequest')??[])await hook(request,reply);
 await route.handler(request,reply);let payload=JSON.stringify(reply.payload);if(late){assert.equal(reply.statusCode,200,JSON.stringify(events));assert.equal(reply.payload.success,true);await late();}
 for(const hook of route.onSend??[])payload=await hook(request,reply,payload);
 reply.raw.writableEnded=true;for(const hook of hooks.get('onResponse')??[])await hook(request,reply);
 assert.equal(timers.size,0,'Every inert request deadline token is cleared');
 return {status:reply.statusCode,headers,body:JSON.parse(payload)};
}
const targets=[['atomicassets','atomicassets-owned-schemas','/atomicassets/v1/collections/:collection_name/schemas'],
 ['atomicassets:royalty-template-rules','atomicmarket-royalty-templates','/atomicmarket/v1/royalties/:collection_name/templates']];

test('shipping emitted registry captures actual Atomic77 models and actual plugin routes compose/publish through the single root SDK',async()=>{
 for(const [projection,model,url]of targets){
  assert(registry.entries.get(projection).indexed.models.has(model));const response=await request(url);
  assert.equal(response.status,200,JSON.stringify({projection,events}));assert.equal(response.body.success,true);assert.deepEqual(response.body.data,[]);
  assert.equal(response.headers['hyperion-state-block-num'],'1');assert.equal(response.headers['hyperion-state-last-valid'],'false');
  const adapter=adapters.get(projection);assert.equal(adapter.acquired,adapter.closed);assert(adapter.acquired>0);
 }
 assert(events.some(x=>x.event==='query'&&x.model==='atomicmarket-royalty-templates'));
});

test('actual final publication refuses late owner, coverage, source and connection changes without state headers',async()=>{
 for(const [projection,_model,url]of targets)for(const boundary of ['owner','coverage','source','connection']){
  const adapter=adapters.get(projection),priorOwner=copy(adapter.identity),priorSocket=socket;
  try{
   const response=await request(url,()=>{if(boundary==='owner')adapter.identity.generation='retired';if(boundary==='coverage')coverage=false;if(boundary==='source')sourceAvailable=false;if(boundary==='connection')socket={};});
   assert.equal(response.status,503,boundary);assert.equal(response.headers['cache-control'],'no-store');for(const name of STATE_RESPONSE_HEADERS)assert.equal(response.headers[name],undefined);
   assert.equal(adapter.acquired,adapter.closed);
  }finally{adapter.identity=priorOwner;coverage=true;sourceAvailable=true;socket=priorSocket;}
 }
});

test('actual genesis and modeled absent native comparison offers refuse publication before any query',async()=>{
 for(const [projection,_model,url]of targets)for(const boundary of ['genesis','offer']){const adapter=adapters.get(projection),prior=copy(adapter.view);const before=events.filter(x=>x.event==='query').length;
  try{if(boundary==='genesis')adapter.view.checkpoint={blockNum:0,blockId:hex(0)};else offerAvailable=false;const response=await request(url);assert.equal(response.status,503);assert.equal(events.filter(x=>x.event==='query').length,before);for(const name of STATE_RESPONSE_HEADERS)assert.equal(response.headers[name],undefined);}
  finally{adapter.view=prior;offerAvailable=true;}
 }
});
