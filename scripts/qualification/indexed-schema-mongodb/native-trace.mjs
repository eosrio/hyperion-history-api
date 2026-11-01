// Pure trace observation/verification. Imports BSON value utilities only; never constructs a client.
import assert from 'node:assert/strict';
import {BSON,Long} from 'mongodb';
import {PLAN,plain,sha} from './native-contract.mjs';
const id=value=>value?BSON.serialize({value}).toString('hex'):null;
const number=value=>value===undefined||value===null?null:value.toString();
export const bsonCopy=value=>BSON.deserialize(BSON.serialize(value),{promoteLongs:false});
export const bsonEvidence=value=>BSON.EJSON.serialize(value,{relaxed:false});
export function monitorIndexed(client,database,label,current,rows,namespaces){
 const starts=new Map();
 const push=row=>{assert(rows.length<PLAN.traceEvents,'Indexed trace bound');row.seq=rows.length;rows.push(row);return row;};
 const started=event=>{if(event.databaseName!==database&&!['commitTransaction','abortTransaction','killCursors'].includes(event.commandName))return;
  const c=event.command,p=current(),collection=c.aggregate??c.find??c.collection??c.killCursors??null;
  const row=push({event:'started',client:label,phase:p.name,requestId:event.requestId,command:event.commandName,database:event.databaseName,collection,
   lsid:id(c.lsid),txn:number(c.txnNumber),transactional:c.autocommit===false,startsTransaction:c.startTransaction===true,readConcern:c.readConcern?.level??null,
   maxTimeMS:c.maxTimeMS??null,batchSize:c.cursor?.batchSize??c.batchSize??null,cursor:number(c.getMore),cursors:(c.cursors??[]).map(number),
   tagged:c.comment?.hyperion==='stateful-indexed-v1',comment:plain(c.comment??null),expected:plain(p.expected??null),owner:plain(p.owner??null),ownerClaim:p.ownerClaim??null,
   model:namespaces.get(collection)??null,ownerDeclaration:p.ownerDeclaration??null,
   ...(c.aggregate!==undefined?{hint:c.hint,collation:plain(c.collation),allowDiskUse:c.allowDiskUse,pipeline:bsonEvidence(c.pipeline),pipelineSha256:sha(BSON.serialize({pipeline:c.pipeline}))}:{})});starts.set(event.requestId,row);
 };
 const finish=(event,success)=>{const begin=starts.get(event.requestId);if(!begin)return;starts.delete(event.requestId);const reply=event.reply,batch=reply?.cursor?.firstBatch??reply?.cursor?.nextBatch;
  const metadata=begin.collection?.endsWith('_stateful_v2_metadata')&&batch?.length===1?batch[0]:null;
  const coverage=begin.collection?.endsWith('_c')&&begin.collection.includes('_ix1_')&&batch?.length===1?batch[0]:null;
  push({event:success?'succeeded':'failed',client:label,phase:begin.phase,requestId:event.requestId,command:begin.command,
   ...(success?{replyBsonBytes:BSON.calculateObjectSize(reply),...(reply?.cursor?{cursor:number(reply.cursor.id),batch:batch.length,
    countTypes:batch.filter(x=>Object.hasOwn(x,'value')&&Object.hasOwn(x,'invalid')).map(x=>({value:Long.isLong(x.value)?'Long':typeof x.value,invalid:Long.isLong(x.invalid)?'Long':typeof x.invalid}))}:{}),
    ...(metadata?{metadata:{declarationDigest:metadata.declarationDigest,revision:metadata.revision,checkpoint:plain(metadata.checkpoint),owner:plain(metadata.owner?.identity),ownerClaim:metadata.owner?.claimDigest,
     initialized:metadata.initialized,raw:metadata.raw!==null,pending:metadata.pending!==null,gap:metadata.gap!==null,rollback:metadata.rollback?.status??null}}:{}),
    ...(coverage?{coverage:plain(coverage)}:{}),...(begin.command==='killCursors'?{closure:Object.fromEntries(['cursorsKilled','cursorsNotFound','cursorsAlive','cursorsUnknown'].map(key=>[key,(reply[key]??[]).map(number)]))}:{})}
   :{code:event.failure?.code??null,name:String(event.failure?.name??'Error'),labels:[...(event.failure?.errorLabels??[])],message:String(event.failure?.message??'Native failure').slice(0,512)})});
 };
 const succeeded=e=>finish(e,true),failed=e=>finish(e,false);client.on('commandStarted',started);client.on('commandSucceeded',succeeded);client.on('commandFailed',failed);
 return()=>{client.off('commandStarted',started);client.off('commandSucceeded',succeeded);client.off('commandFailed',failed);};
}
const replyFor=(rows,start)=>rows.find(row=>row.seq>start.seq&&row.client===start.client&&row.requestId===start.requestId&&['succeeded','failed'].includes(row.event));
export function verifyIndexedTrace(trace,phase,{maximum=PLAN.limits.readAttempts,attempts,success=false}={}){
 const all=trace.filter(row=>row.phase===phase),data=all.filter(row=>row.event==='started'&&row.model&&['aggregate','getMore'].includes(row.command));
 assert(data.length<=maximum,'Actual indexed attempt allowance exceeded');if(attempts!==undefined)assert.equal(data.length,attempts);
 for(const row of data){
  assert.equal(row.tagged,true,'Unclassified indexed data read');assert.equal(row.comment.model,row.model);assert.equal(row.transactional,true);assert(row.lsid&&row.txn!==null);
  assert.equal(row.batchSize,1);assert.equal(row.maxTimeMS,row.command==='aggregate'?PLAN.operationMS:null);
  const start=all.find(x=>x.event==='started'&&x.client===row.client&&x.lsid===row.lsid&&x.txn===row.txn&&x.startsTransaction);assert(start&&start.seq<row.seq);assert.equal(start.readConcern,'snapshot');
  const meta=all.findLast(x=>x.event==='started'&&x.seq<row.seq&&x.client===row.client&&x.lsid===row.lsid&&x.txn===row.txn&&x.transactional&&x.collection?.endsWith('_stateful_v2_metadata'));
  const mr=meta&&replyFor(all,meta);assert(mr?.metadata&&mr.seq<row.seq,'No owner inspection in the data snapshot');const m=mr.metadata;
  assert.equal(m.declarationDigest,row.expected.declarationDigest);assert.equal(m.revision,row.expected.revision);assert.deepEqual(m.checkpoint,row.expected.checkpoint);
  assert.deepEqual(m.owner,row.owner);assert.equal(m.ownerClaim,row.ownerClaim);assert.equal(m.initialized,true);assert.equal(m.raw,false);assert.equal(m.pending,false);assert.equal(m.gap,false);assert(m.rollback===null||m.rollback==='complete');
  const cover=all.findLast(x=>x.event==='started'&&x.seq<row.seq&&x.client===row.client&&x.lsid===row.lsid&&x.txn===row.txn&&x.transactional&&x.collection===row.collection.slice(0,-2)+'_c');
  const cr=cover&&replyFor(all,cover);assert(cr?.coverage&&cr.seq<row.seq,'No model coverage inspection in data snapshot');const c=cr.coverage;
  assert.equal(c.owner,row.ownerDeclaration);assert.equal(c.model,row.model);assert.equal(c._id,row.model);assert.equal(c.representation,'h45-owner-indexed-materialization-v1');
  assert.equal(c.generation,row.expected.generation);assert.equal(c.revision,row.expected.revision);assert.deepEqual(c.checkpoint,row.expected.checkpoint);assert.equal(c.ready,true);assert.equal(c.reason,null);
  const reply=replyFor(all,row);assert(reply,'Missing native terminal command event');
  if(success&&reply.event==='failed'){
   assert(reply.labels?.includes('TransientTransactionError'),'Successful read hid a nontransaction-retry failure');
   assert(data.some(next=>next.seq>row.seq&&next.client===row.client&&next.lsid===row.lsid&&next.txn!==row.txn&&next.comment.trace===row.comment.trace&&next.command==='aggregate'),
    'Failed callback attempt lacks an observed fresh transaction');
  }
  if(reply.batch!==undefined)assert(reply.batch<=1);if(row.command==='aggregate'){assert.equal(row.collation.locale,'simple');assert.equal(row.allowDiskUse,false);assert.match(row.hint,/^h45_ix_b_[a-f0-9]{20}$/);}
 }
 if(success){assert(data.length>0);for(const query of new Set(data.map(row=>row.comment.trace))){const last=data.filter(row=>row.comment.trace===query).at(-1);assert.equal(replyFor(all,last)?.cursor,'0','Successful query did not genuinely exhaust');}}
 return {actualDataAttempts:data.length,replyBsonBytes:all.filter(row=>row.event==='succeeded').reduce((sum,row)=>sum+(row.replyBsonBytes??0),0)};
}
export function verifyCursorClosure(trace){
 const live=new Map();let opened=0,closed=0;
 const key=(r,cursor)=>[r.client,r.lsid,r.txn,r.collection,cursor].join('|');
 for(const row of trace.filter(r=>r.event==='started')){
  const reply=replyFor(trace,row);if(!reply)continue;
  if(row.model&&['aggregate','getMore'].includes(row.command)){
   if(row.command==='getMore')assert(live.has(key(row,row.cursor)),'Foreign/untracked indexed getMore cursor');
   if(reply.event==='succeeded'){
    if(row.command==='getMore'&&reply.cursor==='0'){assert(live.delete(key(row,row.cursor)));closed++;}
    else if(reply.cursor&&reply.cursor!=='0'&&!live.has(key(row,reply.cursor))){live.set(key(row,reply.cursor),row);opened++;}
   }else if(reply.code===43&&row.command==='getMore'&&live.delete(key(row,row.cursor)))closed++;
  }else if(row.command==='killCursors'){
   const owned=row.cursors.filter(cursor=>live.has(key(row,cursor)));if(!owned.length||reply.event!=='succeeded')continue;
   assert.deepEqual(reply.closure.cursorsAlive,[]);assert.deepEqual(reply.closure.cursorsUnknown,[]);const terminal=[...reply.closure.cursorsKilled,...reply.closure.cursorsNotFound];
   assert.deepEqual(new Set(terminal),new Set(owned));assert.equal(terminal.length,owned.length);for(const cursor of owned){assert(live.delete(key(row,cursor)));closed++;}
  }else if(row.command==='abortTransaction'&&(reply.event==='succeeded'||reply.code===251)){
   for(const [name,origin]of live)if(origin.client===row.client&&origin.lsid===row.lsid&&origin.txn===row.txn){live.delete(name);closed++;}
  }
 }
 assert.equal(live.size,0,'Original native cursors remain unclosed');assert.equal(opened,closed);return {opened,closed,live:0};
}
export function verifyExplain(explain,{baseHint,lookupIndexes}){
 const indexes=new Set(),lookups=new Set();let visited=0;
 const visit=(value,path=[])=>{if(value===null||typeof value!=='object')return;assert(++visited<32768,'Explain shape bound');
  assert.notEqual(value.stage,'COLLSCAN','Unindexed native scan');assert.notEqual(value.stage,'SORT','Order was not supplied by the admitted index');
  assert.notEqual(value.usedDisk,true);if(Object.hasOwn(value,'spills')){
   assert(typeof value.spills==='number'&&Number.isSafeInteger(value.spills)||Long.isLong(value.spills)||value.spills?._bsontype==='Int32','Malformed native spill counter');
   assert.equal(value.spills.toString(),'0','Native explain spilled');
  }
  if(typeof value.indexName==='string')indexes.add(value.indexName);for(const name of value.indexesUsed??[])lookups.add(name);
  for(const [name,child]of Object.entries(value))if(name!=='command'){if(name==='$sort')assert.fail('Blocking aggregate sort');visit(child,[...path,name]);}
 };visit(explain);assert(indexes.has(baseHint),'Hinted base index not observed');for(const name of lookupIndexes)assert(lookups.has(name)||indexes.has(name),'Lookup index not observed: '+name);
 return {baseIndex:baseHint,lookupIndexes:[...lookups],planNodes:visited};
}

/** Retain each received native command/explain before the sealed-view and plan assertions. */
export async function captureAndVerifyExplain(records,{command,explanation,sealedView,baseHint,lookupIndexes},readView){
 assert(Array.isArray(records)&&records.length<3,'Explain attempt count bound');
 const pin=value=>{const raw=BSON.serialize(value);return {bytes:raw.length,sha256:sha(raw),base64:raw.toString('base64')};};
 const attempt={status:'received',pipelineSha256:sha(BSON.serialize({pipeline:command.pipeline})),
  actualCommand:bsonEvidence(command),explain:bsonEvidence(explanation),
  bsonReserialization:{method:'mongodb-bson-serialize-not-wire-bytes',command:pin(command),explain:pin(explanation)},
  sealedView,expected:{baseHint,lookupIndexes:[...lookupIndexes]}};
 assert(Buffer.byteLength(JSON.stringify([...records,attempt],null,2)+'\n')<=PLAN.evidenceBytes,'Explain evidence byte bound');
 records.push(attempt);
 attempt.afterView=await readView();assert.deepEqual(attempt.afterView,sealedView);
 attempt.checked=verifyExplain(explanation,{baseHint,lookupIndexes});attempt.status='verified';return attempt;
}
