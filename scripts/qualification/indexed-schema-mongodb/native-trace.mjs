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
export function lookupIndexSpecs(aliases){
 assert(Array.isArray(aliases)&&new Set(aliases).size===aliases.length);
 return aliases.map(alias=>{assert(/^[a-z][a-z0-9_]*$/.test(alias));const suffix=sha(alias).slice(0,20);
  return {alias,indexes:[{name:'h45_ix_j_'+suffix,key:{alias:1,['joins.'+alias]:1},unique:true,partial:{alias}},
   {name:'h45_ix_l_'+suffix,key:{['joins.'+alias]:1,alias:1},unique:false}]};});
}
export function verifyLookupCatalog(catalog,bindings){
 assert(Array.isArray(catalog)&&catalog.length<=128,'Bounded actual index catalog required');
 for(const binding of bindings)for(const expected of binding.indexes){
  const matches=catalog.filter(row=>row.name===expected.name);assert.equal(matches.length,1,'Missing or ambiguous lookup index specification');const actual=matches[0];
  assert.equal(JSON.stringify(actual.key),JSON.stringify(expected.key),'Lookup index key differs');assert.equal(!!actual.unique,expected.unique,'Lookup index uniqueness differs');
  assert.deepEqual(actual.partialFilterExpression,expected.partial,'Lookup index partial filter differs');assert(!actual.hidden&&!actual.sparse&&actual.expireAfterSeconds===undefined,'Lookup index visibility differs');
  assert(!actual.collation||actual.collation.locale==='simple','Lookup index collation differs');
 }
}
function nonnegative(value,label){
 assert(typeof value==='number'&&Number.isSafeInteger(value)||Long.isLong(value)||value?._bsontype==='Int32','Missing or malformed '+label);
 const n=BigInt(value.toString());assert(n>=0n,'Negative '+label);return n;
}
export function verifyExplain(explain,{baseHint,command,aliases,catalog}){
 assert(command&&command.hint===baseHint&&command.allowDiskUse===false,'Exact base hint and no-disk-use required');
 const bindings=lookupIndexSpecs(aliases);verifyLookupCatalog(catalog,bindings);
 const indexes=new Set(),lookups=new Set();let visited=0;
 const visit=(value,path=[])=>{if(value===null||typeof value!=='object')return;assert(++visited<32768,'Explain shape bound');
  assert.notEqual(value.stage,'COLLSCAN','Unindexed native scan');assert.notEqual(value.stage,'SORT','Order was not supplied by the admitted index');
  assert.notEqual(value.usedDisk,true);if(Object.hasOwn(value,'spills')){
   assert(typeof value.spills==='number'&&Number.isSafeInteger(value.spills)||Long.isLong(value.spills)||value.spills?._bsontype==='Int32','Malformed native spill counter');
   assert.equal(value.spills.toString(),'0','Native explain spilled');
  }
  if(typeof value.indexName==='string')indexes.add(value.indexName);for(const name of value.indexesUsed??[])lookups.add(name);
  for(const [name,child]of Object.entries(value))if(name!=='command'){if(name==='$sort')assert.fail('Blocking aggregate sort');visit(child,[...path,name]);}
 };visit(explain);assert(indexes.has(baseHint),'Hinted base index not observed');
 const cursor=explain.stages?.filter(row=>row.$cursor)??[];assert.equal(cursor.length,1,'Single base cursor required');
 const winning=cursor[0].$cursor.queryPlanner?.winningPlan;assert(winning,'Missing winning base plan');const baseScans=[];
 const findBase=value=>{if(value&&typeof value==='object'){if(value.stage==='IXSCAN'&&value.indexName===baseHint)baseScans.push(value);for(const child of Object.values(value))findBase(child);}};findBase(winning);assert.equal(baseScans.length,1,'Hinted base index absent or ambiguous in winning plan');
 const baseIndexes=catalog.filter(row=>row.name===baseHint);assert.equal(baseIndexes.length,1,'Missing or ambiguous base index specification');const base=baseIndexes[0];
 assert.equal(JSON.stringify(base.key),JSON.stringify(baseScans[0].keyPattern),'Base index key differs from winning plan');assert(!base.unique&&!base.hidden&&!base.sparse&&base.partialFilterExpression===undefined&&base.expireAfterSeconds===undefined,'Base index options differ');
 assert(!base.collation||base.collation.locale==='simple','Base index collation differs');
 assert(Array.isArray(command.pipeline),'Actual command pipeline required');const commanded=command.pipeline.filter(row=>row.$lookup),stages=(explain.stages??[]).filter(row=>row.$lookup);
 assert.equal(commanded.length,bindings.length,'Command lookup count differs');assert.equal(stages.length,bindings.length,'Explain lookup count differs');
 const selected=[];
 for(const {alias,indexes:allowed} of bindings){
  const target='lookups.'+alias,commands=commanded.filter(row=>row.$lookup.as===target),actual=stages.filter(row=>row.$lookup.as===target);
  assert.equal(commands.length,1,'Missing or duplicate commanded lookup');assert.equal(actual.length,1,'Missing or duplicate explain lookup');
  const lookup=commands[0].$lookup,stage=actual[0];assert.deepEqual(stage.$lookup,lookup,'Explain lookup differs from actual command');
  assert.deepEqual(Object.keys(lookup).sort(),['as','from','let','pipeline']);assert.equal(lookup.from,command.aggregate);assert.deepEqual(lookup.let,{joinKey:'$joins.'+alias});
  assert.equal(lookup.pipeline?.length,2);assert.deepEqual(Object.keys(lookup.pipeline[0]??{}),['$match']);assert.deepEqual(Object.keys(lookup.pipeline[0].$match??{}).sort(),['$expr','alias']);assert.deepEqual(Object.keys(lookup.pipeline[1]??{}),['$limit']);assert.equal(lookup.pipeline[0].$match.alias,alias);
  assert.deepEqual(lookup.pipeline[0].$match.$expr,{$eq:['$joins.'+alias,'$$joinKey']});assert.equal(nonnegative(lookup.pipeline[1]?.$limit,'lookup limit'),2n);
  assert.equal(nonnegative(stage.collectionScans,'collectionScans'),0n,'Lookup performed collection scan');
  for(const field of ['totalKeysExamined','totalDocsExamined','nReturned'])nonnegative(stage[field],field);
  assert(Array.isArray(stage.indexesUsed)&&stage.indexesUsed.length>0&&new Set(stage.indexesUsed).size===stage.indexesUsed.length,'Lookup indexes missing or duplicated');
  assert(stage.indexesUsed.every(name=>allowed.some(index=>index.name===name)),'Lookup selected an unadmitted or wrong-alias index');selected.push({alias,indexes:[...stage.indexesUsed]});
 }
 return {baseIndex:baseHint,lookupIndexes:selected,planNodes:visited};
}

/** Retain each received native command/explain before the sealed-view and plan assertions. */
export async function captureAndVerifyExplain(records,{command,explanation,sealedView,baseHint,aliases,catalogBefore},readAfter,validateCatalog){
 assert(Array.isArray(records)&&records.length<3,'Explain attempt count bound');
 const pin=value=>{const raw=BSON.serialize(value);return {bytes:raw.length,sha256:sha(raw),base64:raw.toString('base64')};};
 const attempt={status:'received',pipelineSha256:sha(BSON.serialize({pipeline:command.pipeline})),
  actualCommand:bsonEvidence(command),explain:bsonEvidence(explanation),
  bsonReserialization:{method:'mongodb-bson-serialize-not-wire-bytes',command:pin(command),explain:pin(explanation)},
  sealedView,catalogBefore:bsonEvidence(catalogBefore),expected:{baseHint,aliases:[...aliases]}};
 assert(Buffer.byteLength(JSON.stringify([...records,attempt],null,2)+'\n')<=PLAN.evidenceBytes,'Explain evidence byte bound');
 records.push(attempt);
 const after=await readAfter();attempt.afterView=after.view;attempt.catalogAfter=bsonEvidence(after.catalog);assert.deepEqual(attempt.afterView,sealedView);
 assert.equal(typeof validateCatalog,'function','Native model index validator required');validateCatalog(catalogBefore);validateCatalog(after.catalog);
 const bindings=lookupIndexSpecs(aliases);verifyLookupCatalog(catalogBefore,bindings);verifyLookupCatalog(after.catalog,bindings);
 attempt.checked=verifyExplain(explanation,{baseHint,command,aliases,catalog:after.catalog});attempt.status='verified';return attempt;
}
