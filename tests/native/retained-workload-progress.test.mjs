// Inert ledger/hooks only. No legacy fixture/controller import, timers, timeout or process lifecycle.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {databaseFixture} from '../../packages/backend-mongodb/tests/fixture.mjs';
import {createRetainedProgress,withRetainedProgress,retainedCall,retainedPosition,retainedCounter,observeRetainedMethod,RETAINED_PROGRESS_LIMITS,summarizeRetainedProgress,assertRetainedProvenance,finishRetainedProgress,retainedFixtureCopyObserver} from './retained-workload-progress.mjs';
function setup(changes={}){let time=0,samples=0;const rows=[],ledger=createRetainedProgress({emit:raw=>rows.push(JSON.parse(raw)),clock:()=>time,resources:()=>{samples++;return{rssBytes:100,cpuUserUS:20};},...changes});return{ledger,rows,advance:n=>time+=n,samples:()=>samples};}

test('retained diagnostic persists the active await before invoking the unchanged synchronous operation',()=>{
 const s=setup();let calls=0;const result=withRetainedProgress(s.ledger,()=>retainedCall('source.decode-result',222,()=>{calls++;assert.equal(s.rows.length,1);assert.equal(s.rows[0].event,'before');assert.equal(s.rows[0].awaitLabel,'source.decode-result');s.advance(7);return 'actual';}));
 assert.equal(result,'actual');assert.equal(calls,1);assert.equal(s.rows[1].status,'returned');assert.equal(s.rows[1].durationMS,7);assert.equal(s.rows[0].positions.requestedHeight,222);
});
test('nested asynchronous proof and owner spans settle normally while preserving their actual result',async()=>{
 const s=setup();const result=await withRetainedProgress(s.ledger,()=>retainedCall('owner.drain',222,()=>retainedCall('proof.open',222,()=>Promise.resolve('actual-proof'))));
 assert.equal(result,'actual-proof');assert.deepEqual(s.rows.map(row=>[row.event,row.phase]),[['before','owner.drain'],['before','proof.open'],['after','proof.open'],['after','owner.drain']]);assert.deepEqual(s.ledger.snapshot().active,[]);
});
test('diagnostic observation preserves the original synchronous and asynchronous error objects',async()=>{
 for(const asynchronous of [false,true]){const s=setup(),original=new Error('original failure');
  const operation=()=>withRetainedProgress(s.ledger,()=>retainedCall('proof.observation',223,()=>{if(asynchronous)return Promise.reject(original);throw original;}));
  if(asynchronous)await assert.rejects(operation,error=>error===original);else assert.throws(operation,error=>error===original);
  assert.equal(s.rows.at(-1).status,'threw');assert.equal(s.rows.at(-1).error.message,original.message);assert.deepEqual(s.ledger.snapshot().active,[]);
 }
});
test('per-instance method observation preserves this, arguments and the existing returned object',()=>{
 const s=setup(),value={actual:true},target={base:12,method(n){assert.equal(this,target);assert.equal(n,4);return value;}},original=target.method;
 observeRetainedMethod(target,'method','owner.drain');assert.equal(target.method,original);
 withRetainedProgress(s.ledger,()=>{observeRetainedMethod(target,'method','owner.drain',args=>args[0]);assert.equal(target.method(4),value);});assert.equal(s.rows[0].height,4);
});
test('inactive fixture hooks preserve direct operations and never read inactive diagnostic counters',()=>{
 const original=Promise.resolve('same-promise');let read=false;retainedCounter('fixture.native.commands',()=>{read=true;return 0;});retainedPosition({sourceHeight:2000});assert.equal(retainedCall('source.advance',2000,()=>original),original);assert.equal(read,false);
});
test('resource samples are event-driven and include observed fixture command counts without timers',()=>{
 const s=setup(),commands=[];withRetainedProgress(s.ledger,()=>retainedCounter('fixture.native.commands',()=>commands.length));
 s.ledger.record('before','source.prepare');commands.push('command');s.advance(999);s.ledger.record('after','source.prepare');assert.equal(s.samples(),1);
 s.advance(1);s.ledger.record('before','owner.drain');assert.equal(s.samples(),2);assert.equal(s.rows.at(-1).resources['fixture.native.commands'],1);
});
test('diagnostic input and identity bounds refuse forged positions, reserved fields and nonmonotonic clocks',()=>{
 const s=setup();assert.throws(()=>s.ledger.position({sourceHeight:1481}));assert.throws(()=>s.ledger.record('before','owner.drain',{sequence:9}),/override/);
 assert.throws(()=>s.ledger.record('before','owner.drain',{get status(){assert.fail('Getter read');}}));s.advance(-1);assert.throws(()=>s.ledger.record('before','owner.drain'),/Monotonic/);
});
test('finite event bound fails before invoking more workload rather than silently dropping evidence',()=>{
 const s=setup({limits:{...RETAINED_PROGRESS_LIMITS,events:1}});s.ledger.record('start','retained.callback');let invoked=false;
 assert.throws(()=>withRetainedProgress(s.ledger,()=>retainedCall('owner.drain',1,()=>{invoked=true;})),/evidence bound/);assert.equal(invoked,false);assert.equal(s.rows.length,1);
});
test('abort and missing terminal summaries retain uncertainty and grant no qualification',()=>{
 const s=setup();s.ledger.record('start','retained.callback');s.ledger.begin('owner.drain',1472);s.ledger.position({readerThrough:1480,sourceHeight:1471});s.ledger.record('abort','original-test-signal',{active:s.ledger.snapshot().active},true);
 const read=()=>summarizeRetainedProgress(s.rows.map(row=>JSON.stringify(row)+'\n').join(''));assert.equal(read().originalAbortObserved,true);assert.equal(read().callbackStatus,'callback-terminal-unobserved');assert.equal(read().lastAwait,'owner.drain');assert.equal(read().lastPositions.readerThrough,1480);assert.equal(read().qualification,'not-granted');
 s.ledger.record('settled','retained-wire-workload',{status:'callback-returned-after-original-abort',summary:s.ledger.snapshot()});assert.equal(read().originalAbortObserved,true);assert.equal(read().qualification,'not-granted');
 const forged=structuredClone(s.rows);forged[1].sequence=1;assert.throws(()=>summarizeRetainedProgress(forged.map(row=>JSON.stringify(row)+'\n').join('')));
});
test('original test wrapper forwards the existing timeout and callback and uses only its observed abort signal',()=>{
 const source=readFileSync(new URL('./retained-workload-test.mjs',import.meta.url),'utf8');
 assert(source.includes('originalTest(name,options,async testContext=>'));assert(source.includes("testContext.signal.addEventListener('abort',aborted,{once:true})"));
 for(const forbidden of ['setTimeout(','setInterval(','AbortController','SIGTERM','SIGKILL','process.kill','child_process'])assert(!source.includes(forbidden));
 assert(source.includes('finishRetainedProgress({ledger,primarySeen,primary,originalAborted:testContext.signal.aborted'));
 assert(source.includes('primarySeen=true;primary=error;throw error;'));
 assert.equal(source.split('close:()=>closeSync(fd)').length,2);assert(!source.replace('close:()=>closeSync(fd)','').includes('closeSync('));
 assert(!/!primary\b|\bprimary\s*\?/.test(source),'Actual wrapper must not infer failure presence from thrown-value truthiness');
 assert(source.includes("mkdtempSync(join(outputRoot,'wire-managed-diagnostic-'))"));
});
test('observed GHA source and runtime receipts must match the actual supplied environment, including a PR merge identity',()=>{
 const runtime={node:'v24.22.1',platform:'linux',arch:'x64',executable:'/actual/node',pid:123,ppid:120,execArgv:['--cpu-prof','--cpu-prof-dir=/profile']},github={sha:'a'.repeat(40),runId:'123',attempt:'1',job:'build'},
  input={runtime,github,sourceReceipt:{path:'actual-git.json',bytes:267,sha256:'b'.repeat(64),value:{schemaVersion:1,source:github.sha,runId:github.runId,runAttempt:github.attempt,job:github.job,trackedAndClean:true,tree:'c'.repeat(40)}},
   assemblyReceipt:{path:'actual-source.json',bytes:1000,sha256:'d'.repeat(64),value:{profile:'inert-source-control',runtime:{...runtime,sha256:'e'.repeat(64)},runtimeAcceptance:'pending',engineeringRuntimeCandidate:false}}};
 assert.equal(assertRetainedProvenance(input).sourceReceipt.value.source,github.sha);assert.equal(assertRetainedProvenance(input).runtime.pid,123);assert.deepEqual(assertRetainedProvenance(input).runtime.execArgv,runtime.execArgv);
 for(const change of [x=>x.sourceReceipt.value.source='f'.repeat(40),x=>x.sourceReceipt.value.runAttempt='2',x=>x.sourceReceipt.value.trackedAndClean=false,x=>x.assemblyReceipt.value.runtime.node='v26.4.0',x=>x.assemblyReceipt.value.runtime.executable='/other/node']){const copy=structuredClone(input);change(copy);assert.throws(()=>assertRetainedProvenance(copy));}
});
test('all bounded phase aggregates remain in the typed rows while the terminal summary stays within its row cap',()=>{
 const s=setup();for(let n=0;n<64;n++){const token=s.ledger.begin('phase.'+n);s.advance(1);s.ledger.end(token);}
 const {timings,...summary}=s.ledger.snapshot();s.ledger.record('settled','retained-wire-workload',{status:'callback-returned',summary,phaseKinds:Object.keys(timings).length});
 const observed=summarizeRetainedProgress(s.rows.map(row=>JSON.stringify(row)+'\n').join(''));assert.equal(Object.keys(observed.timings).length,64);assert.equal(observed.qualification,'not-granted');
});
test('end and emit faults preserve every synchronous and asynchronous primary thrown value',async()=>{
 for(const fault of ['end','emit'])for(const asynchronous of [false,true])for(const primary of [undefined,null,false,0,0n,'',Symbol('primary'),new Error('primary')]){
  const secondary=new Error('secondary '+fault),s=setup(fault==='emit'?{emit:raw=>{if(JSON.parse(raw).event==='after')throw secondary;}}:{}),ledger=fault==='end'?{...s.ledger,end(){throw secondary;}}:s.ledger;
  let caught=false,value;try{await withRetainedProgress(ledger,()=>retainedCall('owner.drain',222,()=>{if(asynchronous)return Promise.reject(primary);throw primary;}));}catch(error){caught=true;value=error;}
  assert(caught);assert.equal(value,primary);assert.equal(s.ledger.firstFailure().error,secondary);assert.equal(s.ledger.snapshot().diagnosticFailures[0].where,'operation-error-evidence');
 }
});
test('primary values with throwing diagnostic accessors keep their identity',()=>{
 const primary=Object.defineProperties({},{name:{get(){throw new Error('name getter');}},message:{get(){throw new Error('message getter');}}}),s=setup();
 assert.throws(()=>withRetainedProgress(s.ledger,()=>retainedCall('owner.drain',222,()=>{throw primary;})),error=>error===primary);
 assert.equal(s.rows.at(-1).error.name,'UninspectableThrownValue');assert.equal(s.rows.at(-1).error.thrownType,'object');
});
test('finalization preserves primary identity through close failure, including falsy thrown values',()=>{
 for(const primary of [undefined,null,false,0,'',Symbol('primary'),new Error('primary')]){const s=setup(),closeError=new Error('close'),reports=[];let caught=false,value,closes=0;
  try{try{throw primary;}finally{finishRetainedProgress({ledger:s.ledger,primarySeen:true,primary,originalAborted:true,close(){closes++;throw closeError;},report:row=>reports.push(row)});}}catch(error){caught=true;value=error;}
  assert(caught);assert.equal(value,primary);assert.equal(closes,1);assert.equal(reports[0].callbackThrew,true);assert.equal(reports[0].diagnosticFileClosed,false);assert.equal(reports[0].originalSignalAborted,true);assert.equal(reports[0].diagnosticFailures[0].where,'diagnostic-close');
 }
});
test('failed settlement, close and report remain secondary to primary, and fail otherwise-successful work',()=>{
 for(const primarySeen of [false,true]){const emitError=new Error('emit'),closeError=new Error('close'),reportError=new Error('report'),primary=new Error('primary'),s=setup({emit:()=>{throw emitError;}});let closes=0;
  const finish=()=>finishRetainedProgress({ledger:s.ledger,primarySeen,primary,originalAborted:false,close(){closes++;throw closeError;},report(){throw reportError;}});
  if(primarySeen)assert.doesNotThrow(finish);else assert.throws(finish,error=>error===emitError);assert.equal(closes,1);
  assert.deepEqual(s.ledger.snapshot().diagnosticFailures.map(row=>row.where),['callback-settlement-evidence','diagnostic-close','diagnostic-report']);
 }
});
test('secondary diagnostics have an explicit bounded inventory and omitted count',()=>{
 const s=setup(),first=new Error('first');for(let n=0;n<10;n++)s.ledger.noteFailure(n===0?first:new Error('extra '+n),'inert-fault');
 assert.equal(s.ledger.snapshot().diagnosticFailures.length,8);assert.equal(s.ledger.snapshot().omittedDiagnosticFailures,2);assert.equal(s.ledger.firstFailure().error,first);
});

test('fixture copy counters observe actual isolated reads, writes, snapshots and retry without changing results',async()=>{
 const s=setup(),fixture=databaseFixture(),db=fixture.client.db();await db.createCollection('rows');const col=db.collection('rows');
 await col.insertOne({_id:'one',nested:{n:1}},{});await col.insertOne({_id:'two',nested:{n:2}},{});
 assert.equal(retainedFixtureCopyObserver(),undefined);
 await withRetainedProgress(s.ledger,async()=>{fixture.copyObserver=retainedFixtureCopyObserver();const session=fixture.client.startSession();fixture.retryTransaction=true;let calls=0;
  await session.withTransaction(async()=>{calls++;const value=await col.findOne({_id:'one'},{session});value.nested.n=99;assert.equal((await col.findOne({_id:'one'},{session})).nested.n,1);await col.updateOne({_id:'one'},{$set:{nested:{n:3}}},{session});});
  await session.endSession();assert.equal(calls,2);s.ledger.record('after','fixture.copy-test',{},true);});
 const resource=s.rows.at(-1).resources;assert.equal(resource['fixture.copy.transaction'],2);assert.equal(resource['fixture.copy.findone'],4);assert.equal(resource['fixture.copy.update'],2);
 assert.equal(resource['fixture.copy.snapshotcollections'],2);assert.equal(resource['fixture.copy.snapshotdocuments'],4);assert.equal(resource['fixture.copy.maxsnapshotdocuments'],2);assert.equal((await col.findOne({_id:'one'})).nested.n,3);
});

test('copy observation leaves transaction isolation and rollback unchanged under external mutation',async()=>{
 for(const enabled of [false,true]){const s=setup(),fixture=databaseFixture(),db=fixture.client.db();await db.createCollection('rows');const col=db.collection('rows');await col.insertOne({_id:'one',nested:{n:1}},{});
  await withRetainedProgress(s.ledger,async()=>{if(enabled)fixture.copyObserver=retainedFixtureCopyObserver();const session=fixture.client.startSession();
   await assert.rejects(session.withTransaction(async()=>{fixture.storage.get('rows').get('one').nested.n=2;assert.equal((await col.findOne({_id:'one'},{session})).nested.n,1);
    await col.replaceOne({_id:'one'},{_id:'one',nested:{n:3}},{session});assert.equal((await col.findOne({_id:'one'},{session})).nested.n,3);throw new Error('expected rollback');}),/expected rollback/);
   await session.endSession();assert.equal((await col.findOne({_id:'one'})).nested.n,2);});}
});
