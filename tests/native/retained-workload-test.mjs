// Existing node:test timeout owns cancellation. This wrapper only records its observed events.
import originalTest from 'node:test';
import assert from 'node:assert/strict';
import {closeSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createRetainedProgress,withRetainedProgress,retainedCall,assertRetainedProvenance,RETAINED_PROGRESS_LIMITS} from './retained-workload-progress.mjs';

const retainedName='interleaved retained Wire 1..1480 reaches managed owner-v2 worker and request-scoped API with nonempty state';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function receipt(name){const path=join(root,name),stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024);const raw=readFileSync(path);return{path,bytes:raw.length,sha256:sha(raw),value:JSON.parse(raw)};}
function provenance(){
 const runtime={node:process.version,platform:process.platform,arch:process.arch,executable:process.execPath};
 if(process.env.GITHUB_ACTIONS!=='true')return{runtime,github:null,source:'not-an-actual-GHA-receipt'};
 const github={sha:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,job:process.env.GITHUB_JOB};assert.match(github.sha,/^[a-f0-9]{40}$/);
 const major=process.versions.node.split('.')[0],git=receipt('current-native-git-'+major+'.x.json'),assembly=receipt('current-native-source-'+major+'.x.json');
 return assertRetainedProvenance({runtime,github,sourceReceipt:git,assemblyReceipt:assembly});
}
export default function test(name,...args){
 if(name!==retainedName)return originalTest(name,...args);
 const [options,callback]=args;assert.equal(args.length,2);assert.equal(options.timeout,180000);assert.equal(typeof callback,'function');
 return originalTest(name,options,async testContext=>{
  const outputRoot=join(root,'out');mkdirSync(outputRoot,{recursive:true});const output=mkdtempSync(join(outputRoot,'wire-managed-diagnostic-')),fd=openSync(join(output,'progress.jsonl'),'wx');
  let writes=0,writeMS=0,writtenBytes=0,evidenceFailure,primary,settled=false;
  const ledger=createRetainedProgress({emit:raw=>{const at=performance.now(),bytes=Buffer.byteLength(raw),written=writeSync(fd,raw);writeMS+=performance.now()-at;assert.equal(written,bytes,'Complete diagnostic row write required');writes++;writtenBytes+=written;},clock:()=>performance.now(),resources:()=>{
   const cpu=process.cpuUsage(),memory=process.memoryUsage(),usage=process.resourceUsage();return{cpuUserUS:cpu.user,cpuSystemUS:cpu.system,rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,externalBytes:memory.external,
    maxRssKiB:usage.maxRSS,voluntaryContextSwitches:usage.voluntaryContextSwitches,involuntaryContextSwitches:usage.involuntaryContextSwitches,diagnosticWrites:writes,diagnosticWriteMS:writeMS,diagnosticBytes:writtenBytes};}});
  const aborted=()=>{try{ledger.record('abort','original-test-signal',{status:'original-test-abort-observed',active:ledger.snapshot().active,callbackSettled:settled,reason:String(testContext.signal.reason?.message??testContext.signal.reason).slice(0,512)},true);}catch(error){evidenceFailure??=error;}};
  testContext.signal.addEventListener('abort',aborted,{once:true});
  try{
   ledger.record('start','retained-wire-workload',{name,timeoutMS:options.timeout,through:1480,limits:RETAINED_PROGRESS_LIMITS,provenance:provenance()},true);
   await withRetainedProgress(ledger,()=>retainedCall('retained.callback',undefined,()=>callback(testContext)));
  }catch(error){primary=error;throw error;}
  finally{
   settled=true;testContext.signal.removeEventListener('abort',aborted);
   try{const {timings,...summary}=ledger.snapshot();ledger.record('settled','retained-wire-workload',{status:primary?'callback-threw':testContext.signal.aborted?'callback-returned-after-original-abort':'callback-returned',
    ...(primary?{error:{name:String(primary.name),message:String(primary.message).slice(0,512)}}:{}),summary,phaseKinds:Object.keys(timings).length,counts:ledger.counts(),acceptance:'Original node:test verdict remains authoritative; diagnostic records grant no qualification'},true);}catch(error){evidenceFailure??=error;}
   closeSync(fd);console.log(JSON.stringify({retainedWorkloadDiagnostics:output,originalSignalAborted:testContext.signal.aborted,callbackThrew:!!primary,evidenceFailure:evidenceFailure?String(evidenceFailure.message):null}));
   if(!primary&&evidenceFailure)throw evidenceFailure;
  }
 });
}
