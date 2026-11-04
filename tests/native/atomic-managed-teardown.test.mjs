// Pure exact-finally controls. Never import or execute the native runner entry point.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {PLAN,PROFILE,sha} from '../../scripts/qualification/atomic-managed/contract.mjs';
const source=readFileSync(process.env.HYPERION_MANAGED_RUNNER_SOURCE??new URL('../../scripts/qualification/atomic-managed/runner.mjs',import.meta.url),'utf8'),
 start=source.indexOf(' finally{'),end=source.indexOf(' }if(',start);assert(start>0&&end>start);
const body=source.slice(start+' finally{'.length,end),records=new Map();
const catchStart=source.indexOf(' }catch(error){'),caught=source.slice(catchStart+' }catch(error){'.length,start).trim().replace(/\}$/,''),retain=/ const retainPrimary=error=>\{[^\n]+\};/.exec(source)?.[0]??'';assert(catchStart>0);
const execute=new Function('assert','PLAN','PROFILE','sha','join','readFileSync','verifyCursorClosure','clearTimeout',
 'return async function(model){let {host,cleanup,report,sessions,reads,readsOpened,readsClosed,primary,hasPrimary,owned,client,options,marker,trace,events,answers,deadline,stopTrace,json}=model;'+retain+'try{if(model.injectTryFailure)throw model.thrown;}catch(error){'+caught+'}'+body+'return {primary,hasPrimary,report};}')(
 assert,PLAN,PROFILE,sha,join,path=>Buffer.from(JSON.stringify(records.get(path))),trace=>{if(trace.failure)throw trace.failure;return trace.cursor;},deadline=>{if(deadline.failure)throw deadline.failure;});
function setup(changes={}){
 records.clear();
 const operations=[],primary=new Error('original primary'),marker='owned-marker',options={database:'h45_indexed_123456abcdef',source:'a'.repeat(40),output:'/owned/evidence'},
  cleanup={httpClosed:false,clientsClosed:false,sessionsEnded:false,readsClosed:false,cursorsClosed:false,databaseDropped:false},
  db={collection(){operations.push('marker-read');return{async findOne(){return{profile:PROFILE,source:options.source};}};},async dropDatabase(){operations.push('drop');},listCollections(){return{async toArray(){return[];}};}};
 const model={primary,hasPrimary:true,options,marker,cleanup,report:{acceptance:PLAN.acceptance},sessions:[{ended:true}],reads:new Set(),readsOpened:1,readsClosed:1,owned:true,
  host:{async close(){operations.push('http-close');}},client:{db(){return db;},async close(){operations.push('client-close');}},trace:Object.assign([],{cursor:{opened:1,closed:1,live:0}}),
  events:[],answers:[],deadline:{},stopTrace(){operations.push('trace-stop');},json(path,value){assert(!records.has(path),'Evidence is written once');records.set(path,value);},...changes};
 return{model,operations,primary};
}
test('proved closure allows owned DB cleanup while preserving an original primary failure',async()=>{
 const {model,operations,primary}=setup(),result=await execute(model);assert.equal(result.primary,primary);assert.equal(result.report.status,'failed');
 assert.equal(result.report.cleanup.databaseDropped,true);assert.deepEqual(operations,['http-close','marker-read','drop','client-close','trace-stop']);
});
for(const boundary of ['http','session','read','cursor'])test('actual finally retains owned DB when '+boundary+' closure is unproved and keeps the original failure',async()=>{
 const {model,operations,primary}=setup();
 if(boundary==='http')model.host.close=async()=>{throw new Error('HTTP close failure');};
 if(boundary==='session')model.sessions[0].ended=false;
 if(boundary==='read')model.reads.add({});
 if(boundary==='cursor')model.trace.failure=new Error('Cursor still live');
 const result=await execute(model);assert.equal(result.primary,primary);assert.equal(result.report.status,'failed');assert.equal(result.report.cleanup.databaseDropped,false);
 assert.equal(operations.includes('marker-read'),false);assert.equal(operations.includes('drop'),false);assert(operations.includes('client-close'));
 assert.equal(result.report.databaseCleanupSkipped.reason,'closure-not-proved');assert(result.report.databaseCleanupSkipped.missing.length>0);
});
test('no-resource failure remains distinct from proved closure and never invents successful resource flags',async()=>{
 const {model,operations,primary}=setup({host:undefined,owned:false,sessions:[],readsOpened:0,readsClosed:0,trace:Object.assign([],{cursor:{opened:0,closed:0,live:0}})}),result=await execute(model);
 assert.equal(result.primary,primary);assert.equal(operations.includes('drop'),false);assert.equal(result.report.databaseCleanupSkipped.reason,'owned-database-not-created');
 for(const key of ['httpClosed','sessionsEnded','readsClosed','cursorsClosed','databaseDropped'])assert.equal(result.report.cleanup[key],false,key);
 assert.equal(result.report.resourceClosure.http,'not-created');assert.equal(result.report.resourceClosure.sessions,'not-opened');assert.equal(result.report.resourceClosure.reads,'not-opened');assert.equal(result.report.resourceClosure.cursors,'not-opened');
});
test('first actual cleanup failure object remains primary even when later resource checks also fail',async()=>{
 const failure=new Error('first HTTP close failure'),{model}=setup({primary:undefined,hasPrimary:false});model.host.close=async()=>{throw failure;};model.sessions[0].ended=false;
 const result=await execute(model);assert.equal(result.primary,failure);assert.equal(result.report.failure.message,failure.message);assert.equal(result.report.cleanup.databaseDropped,false);
});
for(const value of [undefined,null,0,false,''])for(const origin of ['try','cleanup'])test('actual catch/finally preserves first falsy '+String(value)+' from '+origin+' despite secondary failures',async()=>{
 const {model}=setup({primary:undefined,hasPrimary:false});
 if(origin==='try'){model.injectTryFailure=true;model.thrown=value;model.host.close=async()=>{throw new Error('secondary HTTP cleanup failure');};}
 else model.host.close=async()=>{throw value;};
 model.sessions[0].ended=false;
 const result=await execute(model);assert.equal(result.hasPrimary,true);assert.equal(result.primary,value);assert.equal(result.report.status,'failed');assert.equal(result.report.failure.message,String(value));assert.equal(result.report.cleanup.databaseDropped,false);
});
test('actual catch/finally can report success only after no primary failure and all real resource closures',async()=>{
 const {model}=setup({primary:undefined,hasPrimary:false}),result=await execute(model);assert.equal(result.hasPrimary,false);assert.equal(result.report.status,'passed-controlled-managed-http-only');assert.equal(result.report.cleanup.databaseDropped,true);
});
test('a previous cursor flag cannot authorize DB drop after final cursor closure verification fails',async()=>{
 const {model,operations}=setup();model.cleanup.cursorsClosed=true;model.trace.failure=new Error('final cursor check failed');const result=await execute(model);
 assert.equal(result.report.cleanup.cursorsClosed,false);assert.equal(result.report.cleanup.databaseDropped,false);assert.equal(operations.includes('drop'),false);
});
const controller=readFileSync(process.env.HYPERION_MANAGED_CONTROLLER_SOURCE??new URL('../../scripts/qualification/atomic-managed/ci.mjs',import.meta.url),'utf8'),cs=controller.indexOf(' }catch(error){'),cf=controller.indexOf(' finally{',cs),ce=controller.indexOf(' }if(',cf);assert(cs>0&&cf>cs&&ce>cf);
const controllerCatch=controller.slice(cs+' }catch(error){'.length,cf).trim().replace(/\}$/,''),controllerFinally=controller.slice(cf+' finally{'.length,ce),controllerRetain=/ const retainPrimary=error=>\{[^\n]+\};/.exec(controller)?.[0]??'';
const executeController=new Function('assert','PROFILE','process','join','return async function(model){let {primary,hasPrimary,fixture,report,output,json,stop}=model;'+controllerRetain+'try{if(model.injectTryFailure)throw model.thrown;}catch(error){'+controllerCatch+'}'+controllerFinally+'return {primary,hasPrimary,report};}')(assert,PROFILE,{off(){}},join);
for(const value of [undefined,null,0,false,''])for(const origin of ['try','cleanup'])test('actual controller catch/finally retains falsy '+String(value)+' from '+origin+' with failed evidence/cleanup',async()=>{
 const secondary=new Error('secondary controller failure'),model={primary:undefined,hasPrimary:false,report:{},output:'/owned/evidence',json(){},stop(){},injectTryFailure:origin==='try',thrown:value,
  fixture:{diagnostics(){if(origin==='try')throw secondary;return{};},async cleanup(){throw origin==='cleanup'?value:secondary;},cleanupResult:{verified:false}}};
 const result=await executeController(model);assert.equal(result.hasPrimary,true);assert.equal(result.primary,value);assert.equal(result.report.status,'failed');assert.equal(result.report.failure.message,String(value));
});
for(const [name,text,at]of [['runner',source,end],['controller',controller,ce]])test('actual '+name+' post-finally return cannot swallow any falsy primary failure',()=>{
 const tail=text.slice(at+2,text.indexOf('return report;',at)+'return report;'.length),finish=new Function('primary','hasPrimary','report',tail);
 for(const value of [undefined,null,0,false,'']){let threw=false;try{finish(value,true,{status:'failed'});}catch(error){threw=true;assert.equal(error,value);}assert.equal(threw,true);}
 const report={status:'passed-controlled-managed-http-only'};assert.equal(finish(undefined,false,report),report);
});
for(const value of [new Error('original sink boundary failure'),undefined,null,0,false,''])for(const sink of ['deadline','trace-detach','events','report','checksums'])test('actual runner preserves primary '+String(value)+' when '+sink+' finalization throws',async()=>{
 const secondary=new Error('secondary '+sink),{model}=setup({primary:value,hasPrimary:true});
 if(sink==='deadline')model.deadline.failure=secondary;
 if(sink==='trace-detach')model.stopTrace=()=>{throw secondary;};
 if(['events','report','checksums'].includes(sink)){const json=model.json;model.json=(path,value)=>{if(basename(path)===({events:'events.json',report:'report.json',checksums:'sha256.json'}[sink]))throw secondary;return json(path,value);};}
 const result=await execute(model);assert.equal(result.hasPrimary,true);assert.equal(result.primary,value);assert.equal(result.report.status,'failed');assert.equal(result.report.failure.message,String(value?.message??value));
 const field={deadline:'deadlineCleanupFailure','trace-detach':'traceDetachFailure',events:'evidenceFailure:events.json',report:'evidenceFailure:report.json',checksums:'checksumEvidenceFailure'}[sink];assert.equal(result.report[field].message,secondary.message,'Intended sink must actually throw');
});
for(const value of [undefined,null,0,false,''])test('first runner evidence failure remains the exact falsy primary '+String(value),async()=>{
 const {model}=setup({primary:undefined,hasPrimary:false}),json=model.json;model.json=(path,body)=>{if(basename(path)==='events.json')throw value;return json(path,body);};
 const result=await execute(model);assert.equal(result.hasPrimary,true);assert.equal(result.primary,value);assert.equal(result.report.status,'failed');
});
for(const value of [new Error('original controller sink failure'),undefined,null,0,false,''])test('actual controller final-report write cannot replace primary '+String(value),async()=>{
 const secondary=new Error('secondary final report'),model={primary:undefined,hasPrimary:false,report:{},output:'/owned/evidence',stop(){},injectTryFailure:true,thrown:value,
  json(path){if(basename(path)==='controller.json')throw secondary;},fixture:{diagnostics(){return{};},async cleanup(){},cleanupResult:{verified:true}}};
 const result=await executeController(model);assert.equal(result.hasPrimary,true);assert.equal(result.primary,value);assert.equal(result.report.status,'failed');
});
for(const value of [undefined,null,0,false,''])test('first controller final-report write failure is retained for falsy '+String(value),async()=>{
 const model={primary:undefined,hasPrimary:false,report:{},output:'/owned/evidence',stop(){},injectTryFailure:false,
  json(path){if(basename(path)==='controller.json')throw value;},fixture:{diagnostics(){return{};},async cleanup(){},cleanupResult:{verified:true}}};
 const result=await executeController(model);assert.equal(result.hasPrimary,true);assert.equal(result.primary,value);assert.equal(result.report.status,'failed');
});

const diagnosticFailures=[...['name','message','stack'].map(field=>[field,()=>Object.defineProperty({},field,{get(){throw new Error('diagnostic getter '+field);}})]),['string',()=>Object.create(null)]];
for(const [field,make]of diagnosticFailures)for(const origin of ['try','cleanup']){
 test('actual runner preserves the first '+field+' diagnostic fault value from '+origin,async()=>{
  const value=make(),{model,operations}=setup({primary:undefined,hasPrimary:false});
  if(origin==='try'){model.injectTryFailure=true;model.thrown=value;}else model.host.close=async()=>{throw value;};
  const result=await execute(model);assert.equal(result.primary,value);assert.equal(result.hasPrimary,true);assert.equal(result.report.status,'failed');assert(operations.includes('client-close'));assert.equal(result.report.failure.message,'Failure details unavailable');
 });
 test('actual controller preserves the first '+field+' diagnostic fault value from '+origin,async()=>{
  const value=make(),model={primary:undefined,hasPrimary:false,report:{},output:'/owned/evidence',json(){},stop(){},injectTryFailure:origin==='try',thrown:value,
   fixture:{diagnostics(){return{};},async cleanup(){if(origin==='cleanup')throw value;},cleanupResult:{verified:true}}};
  const result=await executeController(model);assert.equal(result.primary,value);assert.equal(result.hasPrimary,true);assert.equal(result.report.status,'failed');assert.equal(result.report.failure.message,'Failure details unavailable');
 });
}
test('runner secondary diagnostic getters cannot replace the original failure or interrupt final client closure',async()=>{
 const {model,primary,operations}=setup();model.host.close=async()=>{throw diagnosticFailures[0][1]();};const result=await execute(model);assert.equal(result.primary,primary);assert(operations.includes('client-close'));assert.equal(result.report.httpCleanupFailure.message,'Failure details unavailable');
});
test('controller secondary diagnostic getters cannot replace the original failure or interrupt owned cleanup',async()=>{
 const value=new Error('original controller failure'),operations=[],model={primary:value,hasPrimary:true,report:{},output:'/owned/evidence',json(){},stop(){},
  fixture:{diagnostics(){throw diagnosticFailures[0][1]();},async cleanup(){operations.push('cleanup');},cleanupResult:{verified:true}}};
 const result=await executeController(model);assert.equal(result.primary,value);assert.deepEqual(operations,['cleanup']);assert.equal(result.report.evidenceFailure,'Failure details unavailable');
});
