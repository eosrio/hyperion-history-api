// Runs only inside a reviewed owned Linux fixture. No database, listener or process is created here.
import assert from 'node:assert/strict';
import * as owner from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {captureStatefulSourceV2} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {royaltyInputs} from './source.mjs';import {pairRoyaltyRows,templateCases} from './pair.mjs';
const copy=structuredClone,hex=n=>n.toString(16).padStart(64,'0');
export function royaltyPhase(current,state,phase){assert(current?.owner?.claimDigest);assert(state?.entry?.declaration?.digest);return {name:phase,phase,expected:current.view,owner:state.identity,ownerClaim:current.owner.claimDigest,ownerDeclaration:state.entry.declaration.digest};}
export async function runRoyaltyPair({host,original,answers,custody,modelByPhase,collectionByModel,onPhase,publishSource,persist,guard}){
 for(const f of [onPhase,publishSource,persist,guard])assert.equal(typeof f,'function');assert(Array.isArray(answers));
 assert.equal(original.events.length,4);assert(original.reports.length>=2);
 const states=new Map();let serial=200;
 for(const [table,projection,model] of [['royaltytemp','atomicassets:royalty-template-rules','atomicmarket-royalty-templates']]){
  const entry=host.registry.entries.get(projection);assert(entry);const selected=entry.indexed.models.get(model);assert(selected);
  const identity={id:'controlled-royalty-custody',generation:table},lease=await entry.adapter.acquireOwner({expected:null,nextOwner:identity},guard);
  states.set(table,{entry,selected,identity,lease,candidates:new Map()});
 }
 for(const event of original.events){
  for(const [table,state] of states){const rows=event.rows.filter(row=>row.table===table);assert(rows.length>0);const declaration=state.entry.declaration,previous=(await state.entry.adapter.recovery()).view,id=++serial;
   const block={blockNum:previous.checkpoint.blockNum+1,blockId:hex(id),previousBlockId:previous.checkpoint.blockId};
   const target=await owner.captureStatefulRawTargetV2(declaration,{schemaVersion:2,chainId:declaration.projection.definition.binding.chainId,declarationDigest:declaration.digest,owner:state.identity,previous,block,
    rawSource:{commitId:'royalty-custody:'+id,selectionId:'royalty-custody:'+id,observationId:'royalty-custody:'+id,observationDigest:hex(id+1000)}});
   await state.entry.adapter.admitRaw(state.lease,target);
   const source={previous:copy(previous.checkpoint),block:{...block,timeMs:String(Date.parse(event.block.timestamp+'Z'))},inputs:royaltyInputs(declaration,rows,id)};
   const captured=await captureStatefulSourceV2(declaration,source);let candidate;
   const store={async load(digest,sourceDigest){return state.candidates.get(digest+':'+sourceDigest)??null;},async retain(value){const key=value.declarationDigest+':'+value.source.digest;assert(!state.candidates.has(key));state.candidates.set(key,copy(value));candidate=value;}};
   const result=await owner.executeStatefulOwnerBlockV2(declaration,state.entry.adapter,state.lease,target.digest,source,store,state.entry.reduce,guard);
   assert.equal(result.status,'applied');assert(candidate);assert.equal(candidate.source.digest,captured.digest);
   await state.entry.adapter.retireRaw(state.lease,target.digest,candidate.source.digest,candidate.digest);const view=(await state.entry.adapter.recovery()).view;
   await publishSource({projection:declaration.projection.definition.id,declaration,view,source,candidate});
   await persist({event:'royalty-source-committed',table,stage:event.stage,originalBlock:event.block,source,candidateDigest:candidate.digest,view});
  }
 }
 const pairs=[];
 for(const pg of templateCases(original.responses)){
  const state=states.get('royaltytemp'),current=await state.entry.adapter.recovery(),view=current.view,phase='royalty:'+pg.name;
  modelByPhase[phase]=state.selected.declaration.digest;onPhase(royaltyPhase(current,state,phase));
  const before=answers.length,url='/atomicmarket/v1/royalties/oracle/'+pg.route;
  const response=await host.observe(url,view,{method:pg.method??'GET',query:pg.query??{},...(pg.body?{payload:pg.body}:{})});
  assert.equal(response.statusCode,200);assert.equal(answers.length,before+1,'Expected exactly one managed indexed answer');const observed=answers.at(-1),answer=observed.answer.result;
  assert.equal(answer.kind,'page');assert.equal(answer.complete,true);const alias=state.selected.declaration.model.base.alias;
  const expectedRecords=answer.rows.map(row=>row.records[alias]);const native=custody.seal(phase,{model:state.selected.declaration.digest,baseAlias:alias,collection:collectionByModel[state.selected.declaration.digest],expectedRecords});
  const pair=pairRoyaltyRows({route:pg.route,decodedRecords:native.records,originalHttp:pg,managedHttp:{status:response.statusCode,body:response.json()}});
  const receipt={case:pg.name,view,originalReports:original.reports.map(x=>({file:x.file,sha256:x.sha256})),query:observed.query,managedStatus:response.statusCode,native,pair};
  await persist({event:'royalty-independent-pair',receipt});pairs.push(receipt);
 }
 assert.deepEqual(pairs.map(x=>x.case),['template-all','template-one','template-two','template-ten','template-eleven','template-weak','template-body-query']);
 return {status:'passed-bounded-royalty-driver-event-only',pairs,fullParity:false,sourceAuthority:'constructed-only'};
}
