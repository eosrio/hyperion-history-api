// Real emitted HTTP host + SDK composition, inert owner/query/probe ports only.
// No native clients, controllers, worker stop hooks, process signals, or timeout experiments.
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import {STATEFUL_OWNER_FAMILY_V2,STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2,STATEFUL_OWNER_HOST_CAPABILITIES_V2,negotiateStatefulOwnerV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {STATEFUL_INDEXED_QUERY_FAMILY_V1,captureIndexedDeclarationV1} from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import {prepared,page,count,schema,collection,totals,hex} from '../../packages/backend-mongodb/tests/indexed-schema-fixture.mjs';
import {installStatefulApiHostV2} from '../../build/api/helpers/stateful-owner.js';
const plain=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>assert.deepEqual(plain(a),plain(b));
async function fixture(options={}){
 const s=await prepared();
 // Root/native can resolve two copies of the same SDK. Recapture through the actual root module,
 // as the registry does; DTO equality never transports the native module's negotiation WeakSets.
 const projection=await captureStatefulDeclaration(s.projection.definition,s.projection.limits),ownerOffer=supported=>({family:STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:projection.limits});
 s.projection=projection;s.owner=await negotiateStatefulOwnerV2(projection,ownerOffer(STATEFUL_OWNER_HOST_CAPABILITIES_V2),ownerOffer(STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 s.declaration=await captureIndexedDeclarationV1(s.owner,s.declaration.modelRevision,s.declaration.model);
 const view={...s.view,checkpoint:{blockNum:1,blockId:hex(1)}},identity={id:'finite-owner',generation:'one'},owner={identity,claimDigest:hex(50)};
 const native={opened:0,closed:0,queries:0,keyed:0,probes:0,failed:false,flags:{},remaining:[],queryHook:options.queryHook,publicationHook:options.publicationHook};
 const active=new WeakMap(),offer={family:STATEFUL_INDEXED_QUERY_FAMILY_V1,interfaceVersion:1,queryDeclarationDigests:[s.declaration.digest],comparisonProfiles:[s.declaration.model.textComparison],limits:totals()};
 const check=read=>{const scope=active.get(read);assert(scope,'actual locally issued completed capability required');scope.guard();same(scope.owner,identity);same(scope.view,view);if(native.failed)throw new Error('native unavailable');};
 const adapter={capabilities:{family:STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported:STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2,limits:s.projection.limits},
  indexedCapabilities:offer,async recovery(){return {initialized:true,owner:plain(owner),view:plain(view),gap:null,rollback:null};},
  async indexedForModel(expected,digest,guard){guard();same(expected,view);assert.equal(digest,s.declaration.digest);
   if(native.flags.profile||native.flags.coverage)throw new Error('selected model unqualified');return adapter;},
  async completedRead(expected,selected,guard){guard();same(expected,identity);same(selected,view);const read=Object.freeze({});active.set(read,{guard,owner:plain(identity),view:plain(view)});native.opened++;return read;},
  async completedView(read){check(read);return view;},closeRead(read){if(active.delete(read))native.closed++;},
  async readCompleted(read,expected,keys){check(read);same(expected,view);native.keyed++;return {view,results:keys.map(()=>({status:'present',value:collection()}))};},
  async queryCompleted(read,expected,request,available,selected){check(read);same(expected,view);assert.equal(selected.digest,s.declaration.digest);native.queries++;native.remaining.push(available);
   await native.queryHook?.({native,request,read,view,owner});check(read);
   return {view,queryDeclarationDigest:selected.digest,attempts:1,result:request.kind==='count'?{kind:'count',exact:true,value:'9007199254740993'}:{kind:'page',complete:true,rows:[
    {key:'one',fields:{schema:'one',created:'9007199254740993',authorized:['alice','雪'],assets:null},records:{schema:schema(),collection:collection(),assets:null}}]}};}
 };
 const entry={declaration:s.owner,adapter,sourceMetadata:{},reduce:async()=>{},indexed:{adapter,models:new Map([['schema-list',{declaration:s.declaration,limits:totals()}]])}},registry={entries:new Map([[s.projection.definition.id,entry]]),async initializeMissing(){},async assertSourceView(){if(native.flags.source)throw new Error('source/mapping/fork changed');}};
 let socket={};const app=Fastify(),context=installStatefulApiHostV2(app,{configuration:{api:{timeoutMs:2000}},registry:async()=>registry,
  probe:{currentSocket:()=>socket,async probe(target,signal){assert.match(target,/^[a-f0-9]{64}$/);assert.equal(signal.aborted,false);native.probes++;return !native.flags.probe;}}});
 app.get('/schema',{onSend:[async(_request,_reply,payload)=>{const replacement=await native.publicationHook?.({native,view,owner,replaceSocket:()=>{socket={};}});return typeof replacement==='string'?replacement:payload;}]},async request=>{
  const host=await context.statefulIndexedQueryHost(request,s.projection.definition.id,'schema-list');
  const result=await host.compose(s.projection.definition.id,async read=>{
   if(options.caught){try{await read.query({...page(),where:[{field:'unknown',op:'eq',value:'x'}]});}catch{}return {caught:true};}
   if(options.dropped){void read.query(page());return {dropped:true};}
   return {success:true,data:await read.query(page()),count:await read.query(count())};
  });return result.value;
 });
 app.get('/get',async request=>(await context.statefulQueryHost(request).compose(s.projection.definition.id,async read=>({data:await read.get('collection','c')}))).value);
 app.get('/unknown',async request=>(await context.statefulIndexedQueryHost(request,s.projection.definition.id,'other')).indexedCapabilities);
 app.get('/unrelated',async()=>({ok:true}));
 return {...s,view,native,adapter,app,context,entry,close:()=>app.close()};
}
test('page plus count share one actual completed view and cumulative totals in the existing request scope',async()=>{
 const s=await fixture();try{const response=await s.app.inject('/schema');assert.equal(response.statusCode,200,JSON.stringify(s.native)+' '+response.payload);const body=response.json();assert.equal(body.count.value,'9007199254740993');assert.equal(body.data.rows[0].fields.assets,null);
 assert.equal(s.native.opened,1);assert.equal(s.native.closed,1);assert.equal(s.native.queries,2);assert.equal(s.native.keyed,0);assert(s.native.probes>=3);
 assert.equal(s.native.remaining[1].readAttempts,s.native.remaining[0].readAttempts-1);assert.equal(s.native.remaining[1].responseRecords,s.native.remaining[0].responseRecords-1);
 assert(s.native.remaining[1].responseBytes<s.native.remaining[0].responseBytes);assert(s.native.remaining[1].queryBytes<s.native.remaining[0].queryBytes);
 }finally{await s.close();}
});
test('unqualified selected profile/coverage does not disable existing get or unrelated endpoints',async()=>{
 for(const flag of ['profile','coverage']){const s=await fixture();try{s.native.flags[flag]=true;assert.equal((await s.app.inject('/schema')).statusCode,503);
 assert.equal(s.native.opened,0);assert.equal((await s.app.inject('/get')).statusCode,200);assert.equal((await s.app.inject('/unrelated')).statusCode,200);
 }finally{await s.close();}}
});
test('unknown model refuses with no completed-read issuance',async()=>{
 const s=await fixture();try{assert.equal((await s.app.inject('/unknown')).statusCode,503);assert.equal(s.native.opened,0);assert.equal((await s.app.inject('/get')).statusCode,200);}finally{await s.close();}
});
test('caught invalid query still poisons composition and closes its original capability',async()=>{
 const s=await fixture({caught:true});try{assert.equal((await s.app.inject('/schema')).statusCode,503);assert.equal(s.native.closed,1);assert.equal(s.native.queries,0);}finally{await s.close();}
});
test('dropped query work is refused and settles normally without a blocked fixture gate',async()=>{
 const s=await fixture({dropped:true});try{assert.equal((await s.app.inject('/schema')).statusCode,503);assert.equal(s.native.closed,1);}finally{await s.close();}
});
test('source/mapping/fork and owner/checkpoint changes during query refuse the response and close',async()=>{
 for(const change of [x=>x.native.flags.source=true,x=>x.owner.identity.generation='two',x=>x.view.checkpoint.blockId=hex(9)]){
 const s=await fixture({queryHook:async x=>change(x)});try{assert.equal((await s.app.inject('/schema')).statusCode,503);assert.equal(s.native.closed,1);}finally{await s.close();}}
});
test('last onSend catches owner probe, source, checkpoint or connection changes after successful composition',async()=>{
 for(const change of [x=>x.native.flags.probe=true,x=>x.native.flags.source=true,x=>x.native.flags.coverage=true,x=>x.native.flags.profile=true,
  x=>x.view.checkpoint.blockId=hex(8),x=>x.replaceSocket()]){
 const s=await fixture({publicationHook:async x=>change(x)});try{const response=await s.app.inject('/schema');assert.equal(response.statusCode,503);assert.equal(response.headers['cache-control'],'no-store');
 assert.equal(s.native.closed,1);assert.equal(response.headers['x-hyperion-state-block'],undefined);}finally{await s.close();}}
});
test('the final serialized HTTP payload has the original declaration byte bound',async()=>{
 let maximum;const s=await fixture({publicationHook:()=> 'x'.repeat(maximum+1)});maximum=s.projection.limits.responseBytes;
 try{const response=await s.app.inject('/schema');assert.equal(response.statusCode,503);assert.equal(response.headers['cache-control'],'no-store');assert.equal(s.native.closed,1);}finally{await s.close();}
});
