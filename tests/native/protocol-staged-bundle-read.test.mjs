/** Actual emitted journal/bundles over controlled ES receipts. No server, engine or Wire qualification. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {gzipSync,deflateSync} from 'node:zlib';
import {Client,Serializer,BaseConnection,errors} from '@elastic/elasticsearch';
import {frontierMemoryClient} from '../unit/protocol-frontier-memory.mjs';
import {ImmutableProtocolBundleStore} from '../../build/indexer/protocol/immutable-bundle-store.js';
import {ActionHistorySourceJournal} from '../../build/indexer/history/action-source-journal.js';
import {ProofConsumerScope} from '../../build/indexer/protocol/proof-consumer-scope.js';
const hash=v=>createHash('sha256').update(v).digest('hex'), hex=c=>c.repeat(64), MiB=1024*1024;
const writes=calls=>calls.filter(c=>['create','index'].includes(c.method));
async function bundles(records=[{value:'one'},{value:'two'}],bounds){
 const memory=frontierMemoryClient(1),store=new ImmutableProtocolBundleStore(memory.client,'fixture',1,'batch','batch-v1',bounds);
 for(const [i,record]of records.entries())await store.prepare('record:'+i,record);
 return {memory,store,records,ids:records.map((_,i)=>'record:'+i)};
}
async function journal(n=8){
 const memory=frontierMemoryClient(1),store=new ActionHistorySourceJournal(memory.client,'fixture',1,{stagedReads:true});
 const plan={schemaVersion:1,source:{chainId:hex('1'),blockNum:12,blockId:hex('2'),previousBlockId:hex('3'),captureSha256:hex('4')},
  producer:{protocolId:'antelope',profileId:'controlled',codeRevision:'5'.repeat(40),configurationSha256:hex('6'),pluginsSha256:hex('7')},
  target:{name:'fixture-action-v1-000001',uuid:'controlled-target'},transactions:Array.from({length:n},(_,i)=>({transactionId:hash('transaction'+i),traceOrdinal:i,traceSha256:hash('trace'+i),disposition:'no-effects'}))};
 const {id}=await store.preparePlan(plan);for(const t of plan.transactions)await store.recordFragment(id,t.transactionId,[]);
 return{memory,store,plan,id};
}
test('actual journal reads preserve values and2N fresh metadata while reducing only document acquisition',async()=>{
 for(const n of [1,2,8,64]){
  const f=await journal(n);let responseBytes=0;const getIndex=f.memory.client.indices.get.bind(f.memory.client.indices);
  const observe=value=>{responseBytes+=Buffer.byteLength(JSON.stringify(value));return value;};
  f.memory.client.indices.get=async(...args)=>observe(await getIndex(...args));f.memory.faults.read=observe;f.memory.faults.mget=observe;
  f.memory.calls.length=0;const sequential=[],beforeCpu=process.cpuUsage(),beforeTime=performance.now();
  for(const t of f.plan.transactions)sequential.push(await f.store.readFragment(f.id,t.transactionId,f.plan));
  const old=[...f.memory.calls],oldBytes=responseBytes,oldCpu=process.cpuUsage(beforeCpu),oldMs=performance.now()-beforeTime;
  f.memory.calls.length=0;responseBytes=0;const staged=[],stageCpu=process.cpuUsage(),stageTime=performance.now();
  for(let offset=0;offset<n;offset+=4)staged.push(...await f.store.readFragments(f.id,f.plan.transactions.slice(offset,offset+4),f.plan,128*MiB));
  assert.deepEqual(staged,sequential);const calls=f.memory.calls;
  assert.equal(old.length,6*n);assert.equal(calls.length,2*n+4*Math.ceil(n/4));assert.equal(calls.filter(c=>c.method==='getIndex').length,2*n);
  console.log(JSON.stringify({component:'journal-fragment-read',transactions:n,sequentialRequests:old.length,stagedRequests:calls.length,freshMetadata:2*n,sequentialResponseJsonBytes:oldBytes,stagedResponseJsonBytes:responseBytes,
   sequentialRequestJsonBytes:old.reduce((sum,c)=>sum+Buffer.byteLength(JSON.stringify(c.request)),0),
   stagedRequestJsonBytes:calls.reduce((sum,c)=>sum+Buffer.byteLength(JSON.stringify(c.request)),0),
   sequentialCpuMicroseconds:oldCpu,stagedCpuMicroseconds:process.cpuUsage(stageCpu),sequentialMs:oldMs,stagedMs:performance.now()-stageTime,
   sampledMemory:process.memoryUsage(),instrumentation:'inclusive method JSON wrappers; Windows CPU quantized; no speedup claim',controlledTransport:true,wireQualification:false}));
 }
});
test('opted-in complete seal and manifest reread retain every fresh all-copy write boundary',async()=>{
 const f=await journal();const result=await f.store.seal(f.id);assert.equal((await f.store.readManifest(f.id)).id,result.id);
 const before=f.memory.calls.length;f.memory.faults.receipt=(r)=>({...r,_shards:{total:2,successful:1,failed:0}});
 await assert.rejects(f.store.seal(f.id),/durable write receipt/);assert.ok(writes(f.memory.calls.slice(before)).length>0);
 delete f.memory.faults.receipt;assert.equal((await f.store.seal(f.id)).id,result.id);
});
for(const [name,change]of[
 ['item error after missing',r=>{r.docs[0]={_id:r.docs[0]._id,_index:r.docs[0]._index,found:false};r.docs[1].error={type:'unavailable_shards_exception'};}],
 ['foreign index',r=>{r.docs[0]._index='foreign';}],['wrong ID',r=>{r.docs[0]._id='wrong';}],
 ['reordered items',r=>r.docs.reverse()],['partial response',r=>{r.partial=true;}],['missing item',r=>r.docs.pop()],
 ['duplicate item',r=>{r.docs[1]=r.docs[0];}],['bad found flag',r=>{r.docs[0].found=1;}],
 ['unsafe sequence',r=>{r.docs[0]._seq_no=Number.MAX_SAFE_INTEGER+1;}],['missing source',r=>{delete r.docs[0]._source;}],
 ['absent item with source',r=>{r.docs[0].found=false;}],
])test('full-source stage refuses '+name+' without false absence or writes',async()=>{
 const f=await bundles();f.memory.faults.mget=r=>{change(r);return r;};const before=f.memory.calls.length;
 await assert.rejects(f.store.readMany(f.ids,128*MiB),error=>!['missing','incomplete'].includes(error.code));
 assert.equal(writes(f.memory.calls.slice(before)).length,0);delete f.memory.faults.mget;
 assert.deepEqual(await f.store.readMany(f.ids,128*MiB),f.records);
});
for(const mode of ['missing-manifest','missing-chunk','corrupt-chunk','foreign-link-manifest'])test(mode+' between dependency stages grants no seal',async()=>{
 const f=await journal(4);let changed=false;
 f.memory.faults.mget=(r,request)=>{
  if(changed||request._source!==true)return r;changed=true;
  const manifests=[...f.memory.documents.entries()].filter(([,e])=>e.document.kind==='manifest'&&e.document.bundle_id.startsWith('h45actionfragment1:'));
  const [key,e]=manifests[0],chunk=f.memory.key(f.store.index,e.document.chunk_ids[0]);
  if(mode==='missing-manifest')f.memory.documents.delete(key);
  else if(mode==='missing-chunk')f.memory.documents.delete(chunk);
  else if(mode==='corrupt-chunk')f.memory.documents.get(chunk).document.payload='AA==';
  else r.docs[0]._source.bundle_id='foreign';
  return r;
 };
 await assert.rejects(f.store.seal(f.id));
 assert.ok(![...f.memory.documents.values()].some(e=>e.document.kind==='manifest'&&e.document.bundle_id.startsWith('h45actionseal1:')));
});
test('every new logical read rechecks metadata, including fragment dependency reads',async()=>{
 const f=await journal(4);f.memory.faults.mget=(r,q)=>{if(q._source===true)f.memory.settings.get(f.store.index)['index.translog.durability']='async';return r;};
 const before=f.memory.calls.length;await assert.rejects(f.store.seal(f.id),/durability or retention/);assert.equal(writes(f.memory.calls.slice(before)).length,0);
});
test('size-aware packs preserve multichunk records and reserve aggregate bytes before payload acquisition',async()=>{
 const records=Array.from({length:4},(_,i)=>({payload:String(i).repeat(2*MiB+19)})),f=await bundles(records);
 f.memory.calls.length=0;assert.deepEqual(await f.store.readMany(f.ids,16*MiB),records);
 const requests=f.memory.calls.filter(c=>c.method==='mget');assert.ok(requests.length>2);
 f.memory.calls.length=0;await assert.rejects(f.store.readMany(f.ids,4*MiB),/aggregate retained/);
 assert.equal(f.memory.calls.filter(c=>c.method==='mget').length,1,'reservation refusal precedes every chunk fetch');
 console.log(JSON.stringify({component:'large-bundle-stage',records:4,logicalRecordBytes:records.reduce((s,r)=>s+Buffer.byteLength(JSON.stringify(r)),0),documentRequests:requests.length,sampledMemory:process.memoryUsage(),hardRssCapClaim:false}));
});
test('all256 chunks remain readable with a full declared record budget',async()=>{
 const record={payload:'x'.repeat(256*128-14)},f=await bundles([record],{chunkBytes:128,maximumBytes:128*MiB,maximumChunks:256});
 const manifest=f.memory.documents.get(f.memory.key(f.store.index,f.ids[0])).document;assert.equal(manifest.chunk_ids.length,256);
 assert.deepEqual(await f.store.readMany(f.ids,128*MiB),[record]);
});
for(const mode of ['abort','owner-fence','fork-cancel'])test(mode+' after full-source acquisition preserves failure and physically drains',async()=>{
 const f=await bundles(),controller=new AbortController(),scope=new ProofConsumerScope('full-source-'+mode),reason=Error(mode);
 f.memory.faults.mget=r=>{if(mode==='owner-fence')scope.fence();else controller.abort(reason);return r;};
 await assert.rejects(scope.run(()=>f.store.readMany(f.ids,128*MiB,controller.signal)),mode==='owner-fence'?/worker attempt/:e=>e===reason);
 await scope.closeAndDrain();assert.equal(scope.snapshot().state,'drained');
});
function pinned(f,options={}){
 const calls=[],parsed=[],closed=[];
 class S extends Serializer{deserialize(text){parsed.push(Buffer.byteLength(text));return super.deserialize(text);}}
 class C extends BaseConnection{
  async close(){closed.push(this);}
  async request(params,opts){calls.push({params,opts,connection:this,headers:{...this.headers,...params.headers}});
   const[index,route]=params.path.slice(1).split('/').map(decodeURIComponent);
   if(route==='_mget'){const q=new URLSearchParams(params.querystring);return f.memory.client.mget({index,...JSON.parse(params.body),_source:q.get('_source')==='true'},{asStream:opts.asStream});}
   return{statusCode:200,headers:{'content-type':'application/json','x-elastic-product':'Elasticsearch'},body:JSON.stringify({[index]:{mappings:f.memory.mappings.get(index),settings:f.memory.settings.get(index)}})};
  }
 }
 const client=new Client({node:'http://controlled.invalid:9200',Connection:C,Serializer:S,maxRetries:0,...options});
 return{client,calls,parsed,closed,store:new ImmutableProtocolBundleStore(client,'fixture',1,'batch','batch-v1',undefined,{readOnly:true})};
}
test('pinned client uses full realtime source and bounds compressed data before its configured Serializer',async()=>{
 const f=await bundles(),p=pinned(f);try{
  assert.deepEqual(await p.store.readMany(f.ids,128*MiB),f.records);const c=p.calls.find(c=>c.params.path.endsWith('/_mget')),q=new URLSearchParams(c.params.querystring);
  assert.equal(q.get('_source'),'true');assert.equal(q.get('realtime'),'true');assert.equal(c.opts.asStream,true);assert.equal(c.opts.maxResponseSize,MiB);assert.equal(c.opts.maxCompressedResponseSize,MiB);
  for(const encoding of ['gzip','deflate']){
   f.memory.faults.mgetStream=r=>{r.body.destroy();return{...r,headers:{...r.headers,'content-encoding':encoding},body:Readable.from([(encoding==='gzip'?gzipSync:deflateSync)(Buffer.from(JSON.stringify({docs:[{error:'x'.repeat(2*MiB)}]})))])};};
   await assert.rejects(p.store.readMany(f.ids,128*MiB),e=>e.code==='ERR_BUFFER_TOO_LARGE');
  }
  assert.ok(p.parsed.every(n=>n<=MiB));
 }finally{await p.client.close();}
});
test('product rejection owns a held body until destroy settles and never closes or mutates the parent pool',async()=>{
 const f=await bundles(),p=pinned(f),pool=p.client.connectionPool,connection=pool.connections[0],request=connection.request,markAlive=pool.markAlive,markDead=pool.markDead;
 let entering,release;const entered=new Promise(resolve=>{entering=resolve;});
 const body=new Readable({read(){},destroy(error,cb){release=()=>cb(error);entering();}});
 f.memory.faults.mgetStream=r=>{r.body.destroy();const headers={...r.headers};delete headers['x-elastic-product'];return{...r,headers,body};};
 let settled=false;const work=p.store.readMany(f.ids,128*MiB).then(()=>assert.fail('unexpected success'),error=>{settled=true;assert.ok(error instanceof errors.ProductNotSupportedError);});
 await entered;assert.equal(settled,false);assert.equal(p.closed.length,0);release();await work;
 assert.equal(p.client.connectionPool,pool);assert.equal(connection.request,request);assert.equal(pool.markAlive,markAlive);assert.equal(pool.markDead,markDead);
 await p.client.close();assert.equal(p.closed.length,1);
});
test('full-source retries retain original connection/authentication and join every acquired response',async()=>{
 const f=await bundles(),p=pinned(f,{maxRetries:1,retryBackoff:()=>0,resurrectStrategy:'optimistic',auth:{username:'fixture',password:'fixture'}});
 let fail=true;f.memory.faults.beforeMget=()=>{if(fail){fail=false;throw new errors.ConnectionError('controlled retry');}};
 try{assert.deepEqual(await p.store.readMany(f.ids,128*MiB),f.records);assert.ok(p.calls.every(c=>c.connection===p.client.connectionPool.connections[0]));
  assert.ok(p.calls.every(c=>c.headers.authorization==='Basic '+Buffer.from('fixture:fixture').toString('base64')));
 }finally{await p.client.close();}
});

test('full-source decoding keeps configured Serializer prototype protection',async()=>{
 const f=await bundles(),p=pinned(f,{disablePrototypePoisoningProtection:false});
 f.memory.faults.mgetStream=r=>{r.body.destroy();return{...r,body:Readable.from([Buffer.from('{"docs":[{"__proto__":{"polluted":true}}]}')])};};
 try{await assert.rejects(p.store.readMany(f.ids,128*MiB),/prototype|proto|Deserialization/i);assert.ok(p.parsed.length>=2);assert.equal({}.polluted,undefined);}
 finally{await p.client.close();}
});
for(const encoding of ['gzip','deflate'])test('valid compressed '+encoding+' full-source stages preserve exact records',async()=>{
 const f=await bundles(),p=pinned(f);
 f.memory.faults.mgetStream=async r=>{const parts=[];for await(const part of r.body)parts.push(part);const raw=Buffer.concat(parts);return{...r,headers:{...r.headers,'content-encoding':encoding},body:Readable.from([(encoding==='gzip'?gzipSync:deflateSync)(raw)])};};
 try{assert.deepEqual(await p.store.readMany(f.ids,128*MiB),f.records);}finally{await p.client.close();}
});
test('a retried full-source SDK acquisition joins the abandoned body before returning or draining its scope',async()=>{
 const f=await bundles(),p=pinned(f,{maxRetries:1,retryBackoff:()=>0,resurrectStrategy:'optimistic'}),scope=new ProofConsumerScope('retried-full-source');
 let entering,release,count=0,first=true;const entered=new Promise(resolve=>{entering=resolve;});
 const held=new Readable({read(){},destroy(error,cb){release=()=>cb(error);entering();}});
 f.memory.faults.mgetStream=r=>{if(++count!==1)return r;r.body.destroy();return{...r,body:held};};
 const fault=(error,result)=>{if(!error&&first&&result.meta.request.params.path.endsWith('/_mget')){first=false;throw new errors.ConnectionError('retry acquired response');}};
 p.client.diagnostic.on('response',fault);
 let returned=false;const work=scope.run(()=>p.store.readMany(f.ids,128*MiB));void work.finally(()=>{returned=true;}).catch(()=>{});
 try{await entered;assert.equal(returned,false);assert.ok(scope.snapshot().pendingOperations>0);release();assert.deepEqual(await work,f.records);await scope.closeAndDrain();assert.equal(held.closed,true);}
 finally{p.client.diagnostic.off('response',fault);await p.client.close();}
});
test('owned abort during full-source body delivery cannot manufacture a drained end',async()=>{
 const f=await bundles(),p=pinned(f),scope=new ProofConsumerScope('held-body-abort');let entering,destroying,release;
 const entered=new Promise(resolve=>{entering=resolve;}),destroyed=new Promise(resolve=>{destroying=resolve;});
 const body=new Readable({read(){entering();},destroy(error,cb){release=()=>cb(error);destroying();}});
 f.memory.faults.mgetStream=r=>{r.body.destroy();return{...r,body};};
 const work=scope.run(()=>p.store.readMany(f.ids,128*MiB));await entered;scope.fence();await destroyed;let drained=false;
 const drain=scope.closeAndDrain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);release();await assert.rejects(work,/worker attempt/);await drain;assert.equal(drained,true);await p.client.close();
});
test('the complete128MiB record range remains accepted in isolated sequential and staged native controls',()=>{
 for(const mode of ['sequential','staged']){
  const child=spawnSync(process.execPath,['--expose-gc','--max-old-space-size=4096',fileURLToPath(new URL('./protocol-staged-bundle-range.mjs',import.meta.url)),mode],
   {encoding:'utf8',timeout:180000,windowsHide:true,maxBuffer:1024*1024});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.recordBytes,128*MiB);assert.equal(result.chunks,256);assert.equal(result.passed,true);
  console.log(JSON.stringify(result));
 }
});

test('constructor-supported1MiB chunks remain valid without imposing a1MiB record/response cap',async()=>{
 const record={payload:'x'.repeat(2*MiB+31)},f=await bundles([record],{chunkBytes:MiB,maximumBytes:128*MiB,maximumChunks:256});
 assert.deepEqual(await f.store.readMany(f.ids,128*MiB),[record]);
});
for(const mode of ['wire','json','content-type'])test('pinned full-source '+mode+' failure is bounded and never becomes missing',async()=>{
 const f=await bundles(),p=pinned(f);f.memory.faults.mgetStream=r=>{r.body.destroy();return{...r,
  headers:mode==='content-type'?{...r.headers,'content-type':'text/plain'}:r.headers,
  body:Readable.from([Buffer.from(mode==='wire'?'x'.repeat(MiB+1):mode==='json'?'{bad':'{}')])};};
 try{await assert.rejects(p.store.readMany(f.ids,128*MiB),error=>!['missing','incomplete'].includes(error.code));}
 finally{await p.client.close();}
});

test('fencing after the final dependency resolves still prevents the public manifest result from escaping',async()=>{
 const f=await journal(4);await f.store.seal(f.id);const scope=new ProofConsumerScope('last-fragment-fence');
 const original=f.store.readFragments.bind(f.store);f.store.readFragments=async(...args)=>{const values=await original(...args);scope.fence();return values;};
 await assert.rejects(scope.run(()=>f.store.readManifest(f.id)),/worker attempt/);await scope.closeAndDrain();
});
