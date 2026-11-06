// Pure driver-event custody. BSON is reconstructed from monitored driver documents,
// never represented as original wire bytes. No Mongo client or service is created here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const MAX_BYTES=32*1024*1024, MAX_EVENTS=8192;
export function createRoyaltyCustody({database,modelByPhase,current,serialize,deserialize,persist,load}) {
 assert.equal(typeof database,'string');assert(database);for(const f of [current,serialize,deserialize,persist,load])assert.equal(typeof f,'function');
 const refs=[],pending=new Map(),complete=new Set(),sealed=new Set();let total=0,firstError;
 const latch=e=>{firstError??=e instanceof Error?e:new Error(String(e));};
 function save(kind,event,phase,trace,doc){
  assert(refs.length<MAX_EVENTS,'custody event bound');const raw=Buffer.from(serialize(doc));assert(total+raw.length<=MAX_BYTES,'custody byte bound');
  const path=`${String(refs.length+1).padStart(5,'0')}-${kind}-${event.requestId}.bson`,sha256=hash(raw),receipt=persist(path,raw);
  assert.deepEqual(receipt,{path,length:raw.length,sha256});total+=raw.length;
  refs.push({kind,phase,trace,requestId:event.requestId,command:event.commandName,path,length:raw.length,sha256});
 }
 function started(event){try{
  const state=current();if(!state||!Object.hasOwn(modelByPhase,state.phase))return;
  const command=event.command;if(event.databaseName!==database||!['aggregate','getMore'].includes(event.commandName))return;
  assert(!sealed.has(state.phase),'native command after phase seal');
  assert(Number.isSafeInteger(event.requestId)&&!pending.has(event.requestId)&&!complete.has(event.requestId));
  assert.equal(command.comment?.hyperion,'stateful-indexed-v1');assert.equal(command.comment.model,modelByPhase[state.phase]);assert.equal(typeof command.comment.trace,'string');assert(command.comment.trace);
  save('started',event,state.phase,command.comment.trace,command);pending.set(event.requestId,{phase:state.phase,trace:command.comment.trace,command:event.commandName});
 }catch(e){latch(e);}}
 function terminal(event,kind){try{
  const row=pending.get(event.requestId);if(!row){assert(!complete.has(event.requestId),'replayed native terminal');return;}assert.equal(event.commandName,row.command);assert.equal(kind,'succeeded','native query command failed');
  save(kind,event,row.phase,row.trace,event.reply);pending.delete(event.requestId);complete.add(event.requestId);
 }catch(e){latch(e);}}
 function healthy(){if(firstError)throw firstError;}
 function seal(phase,{model,expectedRecords,baseAlias,collection}){
  healthy();assert(!sealed.has(phase),'native phase already sealed');assert(![...pending.values()].some(x=>x.phase===phase),'pending native command');assert.equal(modelByPhase[phase],model);assert(Array.isArray(expectedRecords));assert.equal(typeof baseAlias,'string');assert.equal(typeof collection,'string');assert(collection);
  const selected=refs.filter(x=>x.phase===phase);assert(selected.length>0&&selected.length%2===0,'missing native command evidence');
  const started=selected.filter(x=>x.kind==='started'),ended=selected.filter(x=>x.kind==='succeeded');assert.equal(started.length,ended.length);
  const traces=new Set(started.map(x=>x.trace));assert.equal(traces.size,1,'ambiguous native query trace');
  const records=[];let cursor;
  for(const begin of started){const end=ended.find(x=>x.requestId===begin.requestId);assert(end&&end.command===begin.command&&end.trace===begin.trace);
   const read=ref=>{const b=Buffer.from(load(ref.path));assert.equal(b.length,ref.length);assert.equal(hash(b),ref.sha256);return deserialize(b);};
   const command=read(begin),reply=read(end);assert.equal(command.comment.model,model);assert.equal(command.comment.trace,begin.trace);
   assert.equal(begin.command==='aggregate'?command.aggregate:command.collection,collection,'native collection differs');const c=reply.cursor;assert.equal(c?.ns,database+'.'+collection,'native cursor namespace differs');assert(c&&Array.isArray(begin.command==='aggregate'?c.firstBatch:c.nextBatch));
   if(begin.command==='aggregate')assert.equal(cursor,undefined,'multiple aggregates');else {assert(cursor!==undefined&&cursor!=='0','getMore without live aggregate');assert.equal(String(command.getMore),cursor,'foreign getMore cursor');}
   for(const row of (begin.command==='aggregate'?c.firstBatch:c.nextBatch)){assert.equal(row.base?.alias,baseAlias);assert.equal(typeof row.base?.json,'string');const value=JSON.parse(row.base.json);assert.deepEqual(Object.keys(row.joined??{}),[],'unexpected join requires explicit independent decoder');records.push(value);}
   const next=String(c.id);if(begin.command==='getMore')assert(next==='0'||next===cursor,'native cursor identity changed');cursor=next;
  }
  assert.equal(cursor,'0','native cursor did not exhaust');assert.deepEqual(records,expectedRecords,'decoded native rows differ from captured SDK records');
  sealed.add(phase);return {phase,model,baseAlias,records,trace:[...traces][0],references:selected.map(x=>({...x})),bytes:selected.reduce((n,x)=>n+x.length,0),format:'driver-event-reencoded-bson-v1'};
 }
 return {started,succeeded:e=>terminal(e,'succeeded'),failed:e=>terminal(e,'failed'),healthy,seal,summary:()=>({events:refs.length,bytes:total,pending:pending.size,error:firstError?.message??null})};
}

// Attach only to a client already owned by the admitting runner. The caller must
// keep the returned detach function through cleanup; this creates no client.
export function attachRoyaltyCustody(client,custody){
 assert.equal(typeof client?.on,'function');assert.equal(typeof client?.off,'function');
 const entries=[['commandStarted',custody.started],['commandSucceeded',custody.succeeded],['commandFailed',custody.failed]];
 for(const [name,fn] of entries){assert.equal(typeof fn,'function');client.on(name,fn);}
 let attached=true;return ()=>{assert(attached,'custody already detached');attached=false;for(const [name,fn] of entries)client.off(name,fn);};
}
