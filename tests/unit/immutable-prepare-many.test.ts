import {describe,it,expect} from 'bun:test';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r});return {promise,release}};
const setup=()=>{const memory=frontierMemoryClient();const store=new ImmutableProtocolBundleStore(memory.client as any,'batch-fixture',0,'batch','batch-v1');return {memory,store}};
const items=[{id:'first',record:{value:'a'}},{id:'second',record:{value:'b'},after:['first']}];
describe('bounded immutable prepareMany',()=>{
 it('overlaps independent chunks but gates each ordered manifest on complete receipts',async()=>{
  const {memory,store}=setup(),hold=gate(),entered=gate();let chunks=0;
  memory.faults.beforeWrite=async(req:any)=>{if(req.document.kind==='chunk'){chunks++;if(chunks===2)entered.release();await hold.promise}};
  const running=store.prepareMany(items);await entered.promise;expect(chunks).toBe(2);expect(memory.calls.filter((c:any)=>c.request.document?.kind==='manifest')).toHaveLength(0);hold.release();await running;
  const writes=memory.calls.filter((c:any)=>c.method==='create').map((c:any)=>[c.request.document.kind,c.request.document.bundle_id]);expect(writes.slice(-2)).toEqual([['manifest','first'],['manifest','second']]);expect(await store.read('first')).toEqual({value:'a'});expect(await store.read('second')).toEqual({value:'b'});
 });
 it('waits for all launched writes on failure and publishes no manifests',async()=>{
  const {memory,store}=setup(),hold=gate(),entered=gate();let count=0;memory.faults.beforeWrite=async(req:any)=>{if(req.document.kind==='chunk'){count++;if(count===2)entered.release();if(req.document.bundle_id==='first')throw Error('controlled failure');await hold.promise}};
  let settled=false;const running=store.prepareMany(items).finally(()=>{settled=true});running.catch(()=>{});await entered.promise;await Promise.resolve();expect(settled).toBe(false);hold.release();await expect(running).rejects.toThrow('controlled failure');expect(memory.calls.filter((c:any)=>c.request.document?.kind==='manifest')).toHaveLength(0);
 });
 it('refuses partial receipts and conflicting stored bytes without a manifest',async()=>{
  const {memory,store}=setup();memory.faults.receipt=(receipt:any,req:any)=>req.document.kind==='chunk'?{...receipt,_shards:{...receipt._shards,successful:0,failed:1}}:receipt;
  await expect(store.prepareMany(items)).rejects.toThrow();expect(memory.calls.filter((c:any)=>c.request.document?.kind==='manifest')).toHaveLength(0);delete memory.faults.receipt;await store.prepareMany(items);
  await expect(store.prepareMany([{id:'first',record:{value:'different'}}])).rejects.toThrow();
 });
 it('drains every in-flight write after cancellation before refusing publication',async()=>{
  const {memory,store}=setup(),hold=gate(),entered=gate();let count=0,settled=false;const controller=new AbortController();
  memory.faults.beforeWrite=async(req:any)=>{if(req.document.kind==='chunk'){count++;if(count===2)entered.release();await hold.promise}};
  const running=store.prepareMany(items,controller.signal).finally(()=>{settled=true});running.catch(()=>{});await entered.promise;controller.abort(Error('late cancel'));await Promise.resolve();expect(settled).toBe(false);hold.release();await expect(running).rejects.toThrow('late cancel');expect(memory.calls.filter((c:any)=>c.request.document?.kind==='manifest')).toHaveLength(0);
 });
 it('refuses later manifest publication after owner checkpoint revocation',async()=>{
  const {memory,store}=setup();let revoked=false;
  memory.faults.receipt=(receipt:any,req:any)=>{if(req.document.kind==='manifest'&&req.document.bundle_id==='first')revoked=true;return receipt};
  await expect(store.prepareMany(items,undefined,async()=>{if(revoked)throw Error('owner revoked')})).rejects.toThrow('owner revoked');
  const manifests=memory.calls.filter((c:any)=>c.method==='create'&&c.request.document?.kind==='manifest').map((c:any)=>c.request.document.bundle_id);expect(manifests).toEqual(['first']);
 });
 it('uses one bounded bulk request for a two-chunk wave with unchanged durability',async()=>{
  const {memory,store}=setup();await store.prepareMany(items);const calls=memory.calls.filter((c:any)=>c.method==='bulk');expect(calls).toHaveLength(1);expect(calls[0].request.operations).toHaveLength(4);expect(calls[0].request.wait_for_active_shards).toBe('all');expect(calls[0].request.refresh).toBe(false);expect(calls[0].request.pipeline).toBe('_none');
 });
 it('rejects malformed, reordered, short and partial per-item bulk receipts before any manifest',async()=>{
  const variants=[(r:any)=>({...r,items:r.items.slice(0,1)}),(r:any)=>({...r,items:[...r.items].reverse()}),
   (r:any)=>({...r,items:r.items.map((v:any,i:number)=>i?v:{create:{...v.create,_shards:{...v.create._shards,successful:0,failed:1}}})}),
   (r:any)=>({...r,items:r.items.map((v:any,i:number)=>i?v:{create:{...v.create,_primary_term:0}})}),
   (r:any)=>({...r,items:r.items.map((v:any,i:number)=>i?v:{create:{...v.create,_id:'wrong'}})}),
   (r:any)=>({...r,items:r.items.map((v:any,i:number)=>i?v:{create:{...v.create,_index:'wrong'}})}),
   (r:any)=>({...r,items:r.items.map((v:any,i:number)=>i?v:{create:{...v.create,status:409,error:{type:'wrong-conflict'}}}),errors:true}),
   (r:any)=>({...r,errors:true})];
  for(const variant of variants){const {memory,store}=setup();memory.faults.bulkReceipt=variant;await expect(store.prepareMany(items)).rejects.toThrow();expect(memory.calls.filter((c:any)=>c.method==='create'&&c.request.document?.kind==='manifest')).toHaveLength(0)}
 });
 it('reasserts each bulk conflict with fresh CAS receipt and rejects partial reassertion',async()=>{
  const {memory,store}=setup();await store.prepareMany(items);const start=memory.calls.length;await store.prepareMany(items);
  const writes=memory.calls.slice(start);expect(writes.filter((c:any)=>c.method==='bulk')).toHaveLength(1);expect(writes.filter((c:any)=>c.method==='index'&&c.request.document?.kind==='chunk')).toHaveLength(2);
  memory.faults.receipt=(receipt:any,req:any)=>req.document.kind==='chunk'?{...receipt,_shards:{...receipt._shards,successful:0,failed:1}}:receipt;
  const before=memory.calls.length;await expect(store.prepareMany(items)).rejects.toThrow();expect(memory.calls.slice(before).filter((c:any)=>c.method==='create'&&c.request.document?.kind==='manifest')).toHaveLength(0);
 });
 it('rejects invalid dependency order and a pre-aborted operation before writes',async()=>{
  const {memory,store}=setup();await expect(store.prepareMany([{id:'second',record:{},after:['missing']}])).rejects.toThrow();const controller=new AbortController();controller.abort(Error('cancelled'));await expect(store.prepareMany(items,controller.signal)).rejects.toThrow('cancelled');expect(memory.calls.filter((c:any)=>['create','index'].includes(c.method))).toHaveLength(0);
 });
});
