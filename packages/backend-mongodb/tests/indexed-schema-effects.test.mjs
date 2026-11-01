import assert from 'node:assert/strict';
import test from 'node:test';
import {BSON} from 'mongodb';
import {commitStatefulCandidate,rollbackStatefulStep} from '../dist/stateful-effects.js';
import {keyId} from '../dist/stateful-contract.js';
import {matchingIndexedCoverageV1} from '../dist/stateful-indexed-materialization-v1.js';
import {prepared,sidecars,InertCollection,put,del,candidate,next,schema,collection,assets,hex} from './indexed-schema-fixture.mjs';
const clone=row=>BSON.deserialize(BSON.serialize(row),{promoteLongs:false});
class CanonicalCollection extends InertCollection {
 find(filter){let rows=[...this.values.values()].filter(row=>Object.entries(filter).every(([key,value])=>row[key]===value));
  return {sort(){rows.sort((a,b)=>a._id<b._id?-1:a._id>b._id?1:0);return this;},limit(n){rows=rows.slice(0,n);return this;},async toArray(){return rows;}};}
 async deleteMany(filter){for(const [key,row] of this.values)if(Object.entries(filter).every(([name,value])=>row[name]===value))this.values.delete(key);}
}
async function effects(){
 const s=await prepared(),x=sidecars(s),rows=new CanonicalCollection('canonical rows'),images=new CanonicalCollection('canonical images');
 const state={...s,...x,rows,images,current:{checkpoint:s.view.checkpoint,revision:s.view.revision,pending:null,receipts:[],undo:[],floor:s.view.checkpoint,floorReceipt:null,rollback:null},active:false,failSave:false};
 const all=[rows,images,x.entry.rows,x.entry.coverage,x.entry.images];
 const io={declaration:s.projection,policy:{maxBlocks:2,maxBytes:4194304,maxBlockBytes:1048576,receiptRetention:4},rows,images,sidecars:x.hooks,
  async call(work){assert(state.active,'native effects must stay in original transaction');return work();},
  async load(session){assert.equal(session,x.session);return state.current;},
  async save(_before,changes,session){assert.equal(session,x.session);if(state.failSave)throw new Error('progress write failed');return state.current={...state.current,...changes};},
  async transaction(work){assert(!state.active);const saved=all.map(c=>new Map([...c.values].map(([id,row])=>[id,clone(row)]))),current=structuredClone(state.current);state.active=true;
   try{return await work(x.session);}catch(error){all.forEach((c,i)=>c.values=saved[i]);state.current=current;throw error;}finally{state.active=false;}},
  assertApply(){},assertView(){},replay(){return false;},duplicate(){},view:m=>({...s.view,revision:m.revision,checkpoint:m.checkpoint})};
 state.apply=async mutations=>{const view=io.view(state.current),n=view.checkpoint.blockNum+1,c=candidate(view,n,mutations),pending={sourceDigest:c.source.digest,candidateDigest:c.digest,block:next(view,n).checkpoint};
  state.current.pending=pending;return commitStatefulCandidate(io,c,pending);};
 state.rollback=async()=>{const from=state.current.checkpoint,ancestor={blockNum:from.blockNum-1,blockId:hex(from.blockNum-1)},revision=state.current.revision;
  state.current={...state.current,revision:hex(30),rollback:{operationId:hex(90),sourceRevision:revision,from,ancestor,status:'running'}};
  return rollbackStatefulStep(io,{declarationDigest:s.owner.digest,revision,operationId:hex(90),from,ancestor,maxBlocks:1});};
 return state;
}
test('canonical rows, model sidecars, before-coverage and progress share the same effect transaction',async()=>{
 const s=await effects();await s.apply([put('collection','c',collection()),put('schema','one',schema())]);
 assert.equal(s.rows.values.size,2);assert.equal(s.entry.rows.values.size,2);assert.equal(s.current.checkpoint.blockNum,1);
 const proof=s.entry.coverage.values.get(s.declaration.digest);assert.equal(proof.ready,true);assert.equal(proof.checkpoint.blockNum,1);
 assert.equal(s.entry.images.values.size,1);assert.equal([...s.entry.images.values.values()][0].before.checkpoint.blockNum,0);
 for(const call of s.entry.rows.calls)assert.equal(call.at(-1).session,s.session);
 for(const image of s.images.values.values())assert.deepEqual(Object.keys(image),['_id','blockId','target','before']);
 for(const row of s.rows.values.values())assert.deepEqual(Object.keys(row),['_id','kind','key','json']);
});
test('a failed final progress write rolls back both canonical and materialized changes',async()=>{
 const s=await effects();s.failSave=true;await assert.rejects(s.apply([put('schema','one',schema())]),/progress write failed/);
 assert.equal(s.rows.values.size,0);assert.equal(s.entry.rows.values.size,0);assert.equal(s.entry.images.values.size,0);
 assert.equal(s.entry.coverage.values.get(s.declaration.digest).checkpoint.blockNum,0);assert.equal(s.current.checkpoint.blockNum,0);
});
test('model-only invalid values poison coverage while the original canonical put commits',async()=>{
 const s=await effects(),bad={...collection(),authorized_accounts:[1]};await s.apply([put('collection','c',bad)]);
 assert.deepEqual(JSON.parse(s.rows.values.get(keyId({kind:'collection',key:'c'})).json).authorized_accounts,[1]);
 assert.equal(s.current.checkpoint.blockNum,1);assert.equal(s.entry.rows.values.size,0);assert.equal(s.entry.coverage.values.get(s.declaration.digest).ready,false);
 await s.rollback();assert.equal(s.rows.values.size,0);assert.equal(s.entry.coverage.values.get(s.declaration.digest).ready,true);
 assert.equal(s.entry.coverage.values.get(s.declaration.digest).revision,hex(30));
});
test('duplicate joined identity refuses only the model and rollback restores ready coverage',async()=>{
 const s=await effects();await s.apply([put('collection','c',collection()),put('schema','one',schema())]);
 await s.apply([put('collection','duplicate',collection())]);assert.equal(s.rows.values.size,3);assert.equal(s.entry.rows.values.size,2);
 assert.equal(s.entry.coverage.values.get(s.declaration.digest).ready,false);await s.rollback();
 assert.equal(s.rows.values.size,2);assert.equal(s.entry.coverage.values.get(s.declaration.digest).ready,true);assert.equal(s.entry.rows.values.size,2);
});
test('deletes, multiple updates and valid append-only fork alternatives reconstruct original typed rows',async()=>{
 const s=await effects();await s.apply([put('schema','one',schema()),put('collection','c',collection())]);
 await s.apply([put('schema','one',schema('one','2')),put('schema','one',schema('one','3')),del('collection','c'),put('schema-asset-count','a',assets('0'))]);
 assert.equal([...s.entry.rows.values.values()].find(row=>row.alias==='schema').v.created.toString(),'3');
 assert.equal([...s.entry.rows.values.values()].some(row=>row.alias==='collection'),false);
 await s.rollback();assert.equal([...s.entry.rows.values.values()].find(row=>row.alias==='schema').v.created.toString(),'9007199254740993');
 assert.equal([...s.entry.rows.values.values()].some(row=>row.alias==='collection'),true);assert.equal([...s.entry.rows.values.values()].some(row=>row.alias==='assets'),false);
 await s.apply([put('schema-asset-count','a',assets('7'))]);assert.equal([...s.entry.rows.values.values()].find(row=>row.alias==='assets').v.assets.toString(),'7');
});
test('missing old model history refuses indexed rollback coverage without blocking canonical undo',async()=>{
 const s=await effects();await s.apply([put('schema','one',schema())]);s.entry.images.values.clear();await s.rollback();
 assert.equal(s.rows.values.size,0);assert.equal(s.current.checkpoint.blockNum,0);assert.equal(s.entry.coverage.values.get(s.declaration.digest).ready,false);
});
test('coverage and model undo prune with the original retained canonical block',async()=>{
 const s=await effects();for(let i=1;i<=3;i++)await s.apply([put('schema','one',schema('one',String(i)))]);
 assert.equal(s.current.undo.length,2);assert.equal(s.entry.images.values.size,2);assert.equal([...s.entry.images.values.values()].some(row=>row.blockId===hex(1)),false);
});
test('coverage rejects another generation, checkpoint, representation, owner or revision',async()=>{
 const s=await effects(),proof=s.entry.coverage.values.get(s.declaration.digest);assert(matchingIndexedCoverageV1(s.entry,s.view,proof));
 for(const bad of [{...proof,generation:'other'},{...proof,revision:hex(999)},{...proof,owner:hex(999)},{...proof,representation:'old'},
 {...proof,checkpoint:{blockNum:1,blockId:hex(1)}}])assert.equal(matchingIndexedCoverageV1(s.entry,s.view,bad),false);
});
