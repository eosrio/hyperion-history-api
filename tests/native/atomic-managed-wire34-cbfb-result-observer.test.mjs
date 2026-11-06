// Pure observer semantics; no HTTP instance, DB, worker or timer is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import {observeManagedIndexedResults} from '../../scripts/qualification/atomic-managed-wire34-cbfb/host.mjs';

test('managed observer preserves exact native facade this, handles, answer identity and failure objects',async()=>{
 const handle=Object.freeze({}),answer={view:{checkpoint:{blockNum:1}},result:{kind:'count',value:'0'}},primary=new Error('original native failure'),calls=[],observations=[];
 let reject=false;
 const selected={async completedRead(){assert.equal(this,selected);return handle;},indexedCapabilities:Object.freeze({queryDeclarationDigests:['actual']}),
  completedView(read){assert.equal(this,selected);assert.equal(read,handle);calls.push('view');return answer.view;},
  closeRead(read){assert.equal(this,selected);assert.equal(read,handle);calls.push('closed');},
  async queryCompleted(read,view,request){assert.equal(this,selected);assert.equal(read,handle);assert.equal(view,answer.view);assert.equal(request.kind,'count');if(reject)throw primary;return answer;}};
 const adapter={capabilities:Object.freeze({family:'controlled-port'}),async indexedForModel(view,digest,guard){assert.equal(this,adapter);assert.equal(view,answer.view);assert.equal(digest,'actual');guard();return selected;}};
 const reads=new Set(),facade=observeManagedIndexedResults(adapter,row=>{observations.push(row);row.answer.result.value='detached';row.query.kind='detached';},(event,read)=>{assert.equal(read,handle);if(event==='opened'){assert(!reads.has(read));reads.add(read);}else{assert.equal(event,'closed');assert(reads.delete(read));}});
 const bound=await facade.indexedForModel(answer.view,'actual',()=>calls.push('guard'));
 assert.equal(bound.indexedCapabilities,selected.indexedCapabilities);assert.equal(facade.capabilities,adapter.capabilities);
 assert.equal(await bound.completedRead(),handle);assert.equal(bound.completedView(handle),answer.view);const request={kind:'count'};
 assert.equal(await bound.queryCompleted(handle,answer.view,request),answer);assert.equal(answer.result.value,'0');assert.equal(request.kind,'count');assert.equal(observations.length,1);
 reject=true;await assert.rejects(bound.queryCompleted(handle,answer.view,request),error=>error===primary);assert.equal(observations.length,1);
 bound.closeRead(handle);assert.equal(reads.size,0);assert.deepEqual(calls,['guard','view','closed']);
});
