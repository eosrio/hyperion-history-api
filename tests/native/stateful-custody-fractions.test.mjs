import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,admit,execute} from '../../packages/backend-mongodb/tests/stateful-owner-v2-fixture.mjs';
import {frontierMemoryClient} from '../unit/protocol-frontier-memory.mjs';
import {captureStatefulDeclaration} from '@eosrio/hyperion-sdk/projection-stateful';
import {captureStatefulOwnerDeclarationV2} from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {createStatefulCandidateCustodyV2} from '../../build/indexer/projection/stateful-custody.js';
import {ImmutableProtocolBundleStore,protocolImmutableJson} from '../../build/indexer/protocol/immutable-bundle-store.js';
async function fixture(value){
 const state=await setup(),target=await admit(state,1);await execute(state,target,async port=>port.put('collection','x',value));
 const candidate=[...state.custody.entries.values()][0],projection=await captureStatefulDeclaration(state.declaration.projection.definition,state.declaration.projection.limits),declaration=await captureStatefulOwnerDeclarationV2(projection,2);
 const memory=frontierMemoryClient(),chain='fraction-control',custody=createStatefulCandidateCustodyV2(memory.client,chain,0,declaration),id=`h45statecandidate2:${candidate.declarationDigest}:${candidate.source.digest}`;
 return {candidate,declaration,memory,chain,custody,id};
}
test('actual candidate custody round trips finite fractions and revalidates metadata',async()=>{
 const {candidate,declaration,memory,custody}=await fixture({fraction:0.1,negative:-1.25});
 assert.throws(()=>protocolImmutableJson(candidate),/not portable JSON/);await custody.retain(candidate);const read=await custody.load(declaration.digest,candidate.source.digest);assert.deepEqual(JSON.parse(JSON.stringify(read)),candidate);
 const writes=memory.calls.filter(x=>x.method==='index').length;await custody.retain(candidate);assert.ok(memory.calls.filter(x=>x.method==='index').length>writes,'repeat must reassert durable receipts');
 memory.faults.settings=(settings,request)=>({[request.index]:{settings:{...settings,'index.translog.durability':'async'}}});await assert.rejects(custody.load(declaration.digest,candidate.source.digest),/durability/);
});
test('historical canonical integer candidate stays readable and immutable',async()=>{
 const {candidate,declaration,memory,chain,custody,id}=await fixture({value:12});const max=declaration.projection.limits.candidateBytes,chunk=Math.min(512*1024,max);
 const legacy=new ImmutableProtocolBundleStore(memory.client,chain,0,'stateful-candidate-v2','stateful-candidates-v2',{chunkBytes:chunk,maximumBytes:max,maximumChunks:Math.ceil(max/chunk)});
 await legacy.prepare(id,candidate);assert.deepEqual(JSON.parse(JSON.stringify(await custody.load(declaration.digest,candidate.source.digest))),candidate);await custody.retain(candidate);
});
test('corrupt or incomplete custody never falls back to missing or authorizes a new write',async()=>{
 for(const corruption of ['chunk','manifest']){const {candidate,declaration,memory,custody,id,chain}=await fixture({value:0.1});await custody.retain(candidate);const index=chain+'-stateful-candidates-v2',manifest=memory.documents.get(memory.key(index,id));const key=memory.key(index,manifest.document.chunk_ids[0]);
  if(corruption==='missing')memory.documents.delete(key);else if(corruption==='chunk')memory.documents.get(key).document.payload='AAAA';else manifest.document.digest='0'.repeat(64);
  const before=structuredClone([...memory.documents]);await assert.rejects(custody.load(declaration.digest,candidate.source.digest));await assert.rejects(custody.retain(candidate));assert.deepEqual([...memory.documents],before);
 }
});
test('candidate raw-byte cap and opaque methods reject oversize and foreign kinds before effects',async()=>{
 const memory=frontierMemoryClient(),bounds={chunkBytes:8,maximumBytes:8,maximumChunks:1},store=new ImmutableProtocolBundleStore(memory.client,'bounded',0,'stateful-candidate-v2','stateful-candidates-v2',bounds);
 await assert.rejects(store.prepareCandidateBytes('h45statecandidate2:'+'a'.repeat(64)+':'+'b'.repeat(64),Buffer.alloc(9)),/raw byte bound/);assert.equal(memory.calls.length,0);
 await assert.rejects(store.prepareCandidateBytes('foreign',Buffer.from('{}')),/Invalid candidate/);assert.equal(memory.calls.length,0);
 const other=new ImmutableProtocolBundleStore(memory.client,'bounded',0,'unrelated','other',bounds);await assert.rejects(other.prepareCandidateBytes('h45statecandidate2:'+'a'.repeat(64)+':'+'b'.repeat(64),Buffer.from('{}')),/Invalid candidate/);assert.equal(memory.calls.length,0);
});
test('same source with a different valid fixed candidate remains an immutable conflict',async()=>{
 const first=await fixture({value:0.1}),second=await fixture({value:0.2});assert.equal(first.candidate.source.digest,second.candidate.source.digest);assert.notEqual(first.candidate.digest,second.candidate.digest);
 await first.custody.retain(first.candidate);const writes=first.memory.calls.filter(x=>x.method==='create').length;await assert.rejects(first.custody.retain(second.candidate),/immutable.*conflict/i);assert.equal(first.memory.calls.filter(x=>x.method==='create').length,writes);
});
test('valid bundle receipts cannot authorize noncanonical or malformed UTF-8 candidate bytes',async()=>{
 for(const kind of ['noncanonical','utf8']){const {candidate,declaration,memory,chain,custody,id}=await fixture({value:12}),max=declaration.projection.limits.candidateBytes,chunk=Math.min(512*1024,max);
  const store=new ImmutableProtocolBundleStore(memory.client,chain,0,'stateful-candidate-v2','stateful-candidates-v2',{chunkBytes:chunk,maximumBytes:max,maximumChunks:Math.ceil(max/chunk)});
  const raw=Buffer.from(JSON.stringify(candidate));const payload=kind==='noncanonical'?Buffer.concat([Buffer.from(' '),raw]):Buffer.concat([Buffer.from([0xff]),raw]);
  await store.prepareCandidateBytes(id,payload);await assert.rejects(custody.load(declaration.digest,candidate.source.digest));
 }
});

test('matching stored bytes cannot replace a fresh complete write receipt',async()=>{
 const {candidate,memory,custody}=await fixture({value:0.1});await custody.retain(candidate);
 memory.faults.receipt=(result,request)=>request.if_seq_no===undefined?result:{...result,_shards:{...result._shards,successful:0,failed:1}};
 await assert.rejects(custody.retain(candidate),/Incomplete ABI observation durable write receipt/);
});
test('missing previously prepared chunk can be repaired by fresh immutable prepare',async()=>{
 const {candidate,declaration,memory,custody,id,chain}=await fixture({value:0.1});await custody.retain(candidate);const index=chain+'-stateful-candidates-v2',manifest=memory.documents.get(memory.key(index,id));memory.documents.delete(memory.key(index,manifest.document.chunk_ids[0]));
 await assert.rejects(custody.load(declaration.digest,candidate.source.digest),/missing chunk/);await custody.retain(candidate);assert.equal((await custody.load(declaration.digest,candidate.source.digest)).digest,candidate.digest);
});
test('generic and opaque reads refuse cancellation between byte assembly and decoding',async()=>{
 for(const method of ['read','readCandidateBytes']){
  const memory=frontierMemoryClient(),store=new ImmutableProtocolBundleStore(memory.client,'cancel-control',0,'stateful-candidate-v2','stateful-candidates-v2'),id='h45statecandidate2:'+'a'.repeat(64)+':'+'b'.repeat(64);
  await store.prepare(id,{value:12});
  const controller=new AbortController(),readParts=store.readParts.bind(store);let assembled=false;
  store.readParts=async(...args)=>{const value=await readParts(...args);assembled=true;queueMicrotask(()=>controller.abort());return value;};
  await assert.rejects(store[method](id,controller.signal),error=>error.name==='AbortError');
  assert.equal(assembled,true,'Race must happen after real bundle assembly');
 }
});
