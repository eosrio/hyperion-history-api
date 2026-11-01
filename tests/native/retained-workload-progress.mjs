// Observational fixture state only. No client, controller, timer, abort issuer or process lifecycle.
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';

const context=new AsyncLocalStorage();
export const RETAINED_PROGRESS_LIMITS=Object.freeze({events:65536,bytes:32*1024*1024,rowBytes:4096,activeSpans:16,resourceIntervalMS:1000});
const boundedError=error=>{let name='UninspectableThrownValue',message='Thrown value could not be inspected';
 try{name=String(error?.name??'Error').slice(0,64);}catch{}
 try{message=String(error?.message??error).slice(0,512);}catch{}
 return{name,message,thrownType:error===null?'null':typeof error};};
const secondary=(ledger,error,where)=>{try{ledger.noteFailure(error,where);}catch{/* A diagnostic recorder must never replace an active workload failure. */}};
const label=value=>{assert(typeof value==='string'&&/^[a-z][a-z0-9.-]{0,95}$/.test(value));return value;};

export function createRetainedProgress({emit,clock,resources,limits=RETAINED_PROGRESS_LIMITS}){
 assert.equal(typeof emit,'function');assert.equal(typeof clock,'function');assert.equal(typeof resources,'function');
 for(const key of ['events','bytes','rowBytes','activeSpans','resourceIntervalMS'])assert(Number.isSafeInteger(limits[key])&&limits[key]>0&&limits[key]<=RETAINED_PROGRESS_LIMITS[key]);
 const start=clock();assert(Number.isFinite(start));let previous=start,lastResource=-Infinity,sequence=0,bytes=0,nextSpan=0;
 const active=new Map(),positions={},timings={},sampledCounters=new Map();
 const diagnosticFailures=[];let firstDiagnosticSeen=false,firstDiagnostic,omittedDiagnosticFailures=0;
 const noteFailure=(error,where)=>{if(!firstDiagnosticSeen){firstDiagnosticSeen=true;firstDiagnostic=error;}
  if(diagnosticFailures.length<8)diagnosticFailures.push({where:String(where).slice(0,96),...boundedError(error)});else omittedDiagnosticFailures++;};
 const now=()=>{const value=clock();assert(Number.isFinite(value)&&value>=previous,'Monotonic fixture clock required');previous=value;return Math.round((value-start)*1000)/1000;};
 const snapshot=()=>({positions:{...positions},active:[...active.values()].map(({id,phase,height})=>({id,phase,...(height===undefined?{}:{height})})),timings:structuredClone(timings),diagnosticFailures:diagnosticFailures.map(value=>({...value})),omittedDiagnosticFailures});
 const record=(event,phase,extra={},forceResource=false)=>{
  assert(extra&&Object.getPrototypeOf(extra)===Object.prototype&&!Object.getOwnPropertySymbols(extra).length);
  for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(extra)))assert(descriptor.enumerable&&Object.hasOwn(descriptor,'value')&&!['schemaVersion','sequence','elapsedMS','event','phase','awaitLabel','activeDepth','positions','resources'].includes(key),'Diagnostic fields cannot override observed identity');
  label(event);label(phase);const elapsedMS=now(),row={schemaVersion:1,sequence:sequence+1,elapsedMS,event,phase,
   awaitLabel:[...active.values()].at(-1)?.phase??null,activeDepth:active.size,positions:{...positions},...extra};
  if(forceResource||elapsedMS-lastResource>=limits.resourceIntervalMS){const sample=resources();assert(sample&&Object.getPrototypeOf(sample)===Object.prototype);const observed={...sample};
   for(const [key,read]of sampledCounters){const value=read();assert(Number.isSafeInteger(value)&&value>=0);observed[key]=value;}
   for(const [key,value]of Object.entries(observed))assert(typeof key==='string'&&key.length<=64&&Number.isFinite(value)&&value>=0,'Finite nonnegative resource observation required');
   row.resources={...observed};lastResource=elapsedMS;}
  const raw=JSON.stringify(row)+'\n',size=Buffer.byteLength(raw);assert(size<=limits.rowBytes&&sequence<limits.events&&bytes+size<=limits.bytes,'Retained diagnostic evidence bound exceeded');
  emit(raw);sequence++;bytes+=size;return elapsedMS;
 };
 const position=patch=>{for(const [key,value]of Object.entries(patch)){assert(['requestedHeight','sourceHeight','readerThrough','requestedThrough','publishedHeight'].includes(key));assert(Number.isSafeInteger(value)&&value>=0&&value<=1480);positions[key]=value;}};
 const begin=(phase,height)=>{label(phase);if(height!==undefined)position({requestedHeight:height});assert(active.size<limits.activeSpans,'Retained diagnostic span bound exceeded');
  const id=++nextSpan,entry={id,phase,height,at:now()};active.set(id,entry);record('before',phase,{span:id,...(height===undefined?{}:{height})});return id;};
 const end=(id,status='returned',error)=>{const entry=active.get(id);assert(entry,'Unknown retained diagnostic span');assert(['returned','threw'].includes(status));
  const durationMS=Math.round((now()-entry.at)*1000)/1000;active.delete(id);if(!timings[entry.phase])assert(Object.keys(timings).length<64,'Retained diagnostic phase bound exceeded');const total=timings[entry.phase]??={completed:0,failed:0,totalMS:0,maximumMS:0};
  total.completed++;total.failed+=status==='threw'?1:0;total.totalMS=Math.round((total.totalMS+durationMS)*1000)/1000;total.maximumMS=Math.max(total.maximumMS,durationMS);
  record('after',entry.phase,{span:id,status,durationMS,...(status==='threw'?{error:boundedError(error)}:{})});};
 const counter=(key,read)=>{label(key);assert.equal(typeof read,'function');assert(!sampledCounters.has(key)&&sampledCounters.size<16);sampledCounters.set(key,read);};
 return Object.freeze({record,position,begin,end,counter,snapshot,noteFailure,firstFailure:()=>({seen:firstDiagnosticSeen,error:firstDiagnostic}),counts:()=>({events:sequence,bytes})});
}

export const withRetainedProgress=(ledger,operation)=>context.run(ledger,operation);
export function retainedPosition(patch){context.getStore()?.position(patch);}
export function retainedMark(event,phase,extra){context.getStore()?.record(event,phase,extra);}
export function retainedCounter(name,read){context.getStore()?.counter(name,read);}
export function retainedCall(phase,height,operation){
 const ledger=context.getStore();if(!ledger)return operation();
 const token=ledger.begin(phase,height);let value;
 try{value=operation();}catch(error){try{ledger.end(token,'threw',error);}catch(diagnostic){secondary(ledger,diagnostic,'operation-error-evidence');}throw error;}
 if(value&&typeof value.then==='function')return Promise.resolve(value).then(result=>{ledger.end(token);return result;},error=>{try{ledger.end(token,'threw',error);}catch(diagnostic){secondary(ledger,diagnostic,'operation-error-evidence');}throw error;});
 ledger.end(token);return value;
}

/** Only injected observational ports execute here; an active primary always owns its throw. */
export function finishRetainedProgress({ledger,primarySeen,primary,originalAborted,close,report}){
 let closed=false,localFailureSeen=false,localFailure;
 const failed=(error,where)=>{if(!localFailureSeen){localFailureSeen=true;localFailure=error;}secondary(ledger,error,where);};
 try{const {timings,diagnosticFailures,...summary}=ledger.snapshot();ledger.record('settled','retained-wire-workload',{status:primarySeen?'callback-threw':originalAborted?'callback-returned-after-original-abort':'callback-returned',
  ...(primarySeen?{error:boundedError(primary)}:{}),summary,diagnosticFailureCount:diagnosticFailures.length,firstDiagnosticFailure:diagnosticFailures[0]??null,
  phaseKinds:Object.keys(timings).length,counts:ledger.counts(),acceptance:'Original node:test verdict remains authoritative; diagnostic records grant no qualification'},true);}catch(error){failed(error,'callback-settlement-evidence');}
 try{close();closed=true;}catch(error){failed(error,'diagnostic-close');}
 try{const snapshot=ledger.snapshot();report({callbackThrew:primarySeen,originalSignalAborted:originalAborted,diagnosticFileClosed:closed,
  diagnosticFailures:snapshot.diagnosticFailures,omittedDiagnosticFailures:snapshot.omittedDiagnosticFailures});}catch(error){failed(error,'diagnostic-report');}
 if(!primarySeen){let first;try{first=ledger.firstFailure();}catch(error){failed(error,'diagnostic-failure-read');}
  if(first?.seen)throw first.error;if(localFailureSeen)throw localFailure;}
}
export function observeRetainedMethod(target,key,phase,height){
 const ledger=context.getStore();if(!ledger)return;
 const original=target[key];assert.equal(typeof original,'function');
 target[key]=function(...args){return retainedCall(phase,height?.(args),()=>Reflect.apply(original,this,args));};
}

export function summarizeRetainedProgress(raw){
 assert(typeof raw==='string'&&Buffer.byteLength(raw)<=RETAINED_PROGRESS_LIMITS.bytes);const lines=raw.trimEnd().split('\n');assert(lines.length>0&&lines.length<=RETAINED_PROGRESS_LIMITS.events);
 let previous=-1,abort=false,last,settled,resources=0;const timings={};for(let index=0;index<lines.length;index++){
  assert(Buffer.byteLength(lines[index]+'\n')<=RETAINED_PROGRESS_LIMITS.rowBytes);const row=JSON.parse(lines[index]);
  assert.equal(row.schemaVersion,1);assert.equal(row.sequence,index+1);label(row.event);label(row.phase);assert(Number.isFinite(row.elapsedMS)&&row.elapsedMS>=previous);previous=row.elapsedMS;
  for(const [key,value]of Object.entries(row.positions))assert(['requestedHeight','sourceHeight','readerThrough','requestedThrough','publishedHeight'].includes(key)&&Number.isSafeInteger(value)&&value>=0&&value<=1480);
  if(row.event==='after'&&row.durationMS!==undefined){assert(Number.isFinite(row.durationMS)&&row.durationMS>=0);if(!timings[row.phase])assert(Object.keys(timings).length<64);
   const total=timings[row.phase]??={completed:0,failed:0,totalMS:0,maximumMS:0};total.completed++;total.failed+=row.status==='threw'?1:0;total.totalMS+=row.durationMS;total.maximumMS=Math.max(total.maximumMS,row.durationMS);}
  if(row.resources)resources++;if(row.event==='abort')abort=true;if(row.event==='settled')settled=row;last=row;
 }
 return {events:lines.length,elapsedMS:previous,originalAbortObserved:abort,callbackStatus:settled?.status??'callback-terminal-unobserved',
  lastAwait:last.awaitLabel,lastPositions:last.positions,resourceSamples:resources,timings,summary:settled?.summary??null,qualification:'not-granted'};
}

export function assertRetainedProvenance({runtime,github,sourceReceipt,assemblyReceipt}){
 assert.match(github.sha,/^[a-f0-9]{40}$/);const git=sourceReceipt.value,assembly=assemblyReceipt.value;
 assert.equal(git.schemaVersion,1);assert.equal(git.source,github.sha);assert.equal(git.runId,github.runId);assert.equal(git.runAttempt,github.attempt);assert.equal(git.job,github.job);assert.equal(git.trackedAndClean,true);assert.match(git.tree,/^[a-f0-9]{40}$/);
 assert.equal(assembly.runtime.node,runtime.node);assert.equal(assembly.runtime.executable,runtime.executable);assert.equal(assembly.runtime.platform,runtime.platform);assert.equal(assembly.runtime.arch,runtime.arch);
 return{runtime,github,sourceReceipt,assemblyReceipt:{path:assemblyReceipt.path,bytes:assemblyReceipt.bytes,sha256:assemblyReceipt.sha256,profile:assembly.profile,runtime:assembly.runtime,
  sdkRevision:assembly.sdkRevision,nativeSDKRevision:assembly.nativeSDKRevision,runtimeAcceptance:assembly.runtimeAcceptance,engineeringRuntimeCandidate:assembly.engineeringRuntimeCandidate}};
}
