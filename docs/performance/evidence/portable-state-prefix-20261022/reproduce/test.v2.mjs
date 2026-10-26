import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, open, realpath} from 'node:fs/promises';
import {dirname, join, relative, resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeProfile, analyzeManifest, writeFreshAnalysis, sha256, LIMITS} from './analyze.v2.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const rules={applicationRoots:['/synthetic/app'],observerFiles:['/synthetic/app/observer.mjs']};
const frame=(functionName,url='',scriptId='0',lineNumber=-1,columnNumber=-1)=>({functionName,url,scriptId,lineNumber,columnNumber});
function profile() {
  const a=frame('A','file:///synthetic/app/source.mjs','11',10,0),b=frame('B','file:///synthetic/app/source.mjs','11',20,0);
  return {startTime:1000,endTime:1100,nodes:[
    {id:1,callFrame:frame('(root)'),children:[2,5,6,7,8,9,10]},
    {id:2,callFrame:a,children:[3]},{id:3,callFrame:b,children:[4]},{id:4,callFrame:{...a}},
    {id:5,callFrame:frame('(idle)')},{id:6,callFrame:frame('(garbage collector)')},
    {id:7,callFrame:frame('unattributed-native-or-builtin')},{id:8,callFrame:frame('runtime','node:internal/process/task_queues','1',1,1)},
    {id:9,callFrame:frame('observe','file:///synthetic/app/observer.mjs','12',5,0)},
    {id:10,callFrame:frame('dependency','file:///synthetic/app/node_modules/example/index.mjs','13',1,0)}],
    samples:[4,3,5,6,7,8,9,10],timeDeltas:[10,20,5,7,3,11,13,17]};
}
test('known raw/self/inclusive math, recursion deduplication, tail and exclusive categories',()=>{
  const result=analyzeProfile(profile(),rules),a=result.functions.find(row=>row.callFrame.functionName==='A'),b=result.functions.find(row=>row.callFrame.functionName==='B');
  assert.equal(result.rawSampleCount,8);assert.equal(result.sampledIntervalMicros,86);assert.equal(result.unweightedTailMicros,14);assert.equal(result.firstSampleOffsetMicros,10);
  assert.equal(a.selfRawSamples,1);assert.equal(a.selfIntervalMicros,10);assert.equal(a.inclusiveRawSamples,2);assert.equal(a.inclusiveIntervalMicros,30);
  assert.deepEqual(a.nodeIds,[2,4]);assert.equal(b.selfRawSamples,1);assert.equal(b.selfIntervalMicros,20);assert.equal(b.inclusiveRawSamples,2);assert.equal(b.inclusiveIntervalMicros,30);
  assert.equal(result.nodes.find(row=>row.id===2).inclusiveIntervalMicros,30);assert.equal(result.nodes.find(row=>row.id===4).inclusiveIntervalMicros,10);
  assert.equal(result.nodes.find(row=>row.id===1).inclusiveRawSamples,8);assert.equal(result.nodes.find(row=>row.id===1).inclusiveIntervalMicros,86);
  assert.deepEqual(result.categorySelf.application,{rawSamples:2,intervalMicros:30});
  for(const [key,weight] of Object.entries({idle:5,gc:7,'native-or-unattributed':3,runtime:11,observer:13,dependency:17}))
    assert.deepEqual(result.categorySelf[key],{rawSamples:1,intervalMicros:weight});
  assert.equal(Object.values(result.categorySelf).reduce((sum,row)=>sum+row.rawSamples,0),8);
  assert.deepEqual(result.stacks.find(row=>row.leafNodeId===4).nodeIds,[1,2,3,4]);
});
test('unequal timeDeltas change elapsed-weight ranking without changing raw tick counts',()=>{
  const input=profile();input.samples=[4,4,3];input.timeDeltas=[1,1,98];
  const result=analyzeProfile(input,rules),a=result.functions.find(row=>row.callFrame.functionName==='A'),b=result.functions.find(row=>row.callFrame.functionName==='B');
  assert.equal(a.selfRawSamples,2);assert.equal(a.selfIntervalMicros,2);assert.equal(a.selfIntervalPercent,2);
  assert.equal(b.selfRawSamples,1);assert.equal(b.selfIntervalMicros,98);assert.equal(b.selfIntervalPercent,98);
  assert.equal(result.functions[0].functionId,b.functionId);assert.equal(a.inclusiveRawSamples,3);assert.equal(a.inclusiveIntervalMicros,100);
});
test('same names in distinct scripts/locations are not merged and unknown locations remain explicit',()=>{
  const input=profile();input.nodes[3].callFrame={...input.nodes[1].callFrame,scriptId:'different-script'};
  input.nodes[0].children.push(11);input.nodes.push({id:11,callFrame:frame('unknown','custom:unmapped','14',0,0)});
  input.samples.push(11);input.timeDeltas.push(14);
  const result=analyzeProfile(input,rules);assert.equal(result.functions.filter(row=>row.callFrame.functionName==='A').length,2);
  assert.deepEqual(result.categorySelf.unknown,{rawSamples:1,intervalMicros:14});
});
const badProfiles=[
  ['duplicate node ID',value=>value.nodes.push(structuredClone(value.nodes[0]))],
  ['missing child',value=>value.nodes[0].children.push(999)],
  ['multiple parents',value=>value.nodes[0].children.push(4)],
  ['duplicate child edge',value=>value.nodes[0].children.push(2)],
  ['self cycle',value=>value.nodes[1].children.push(2)],
  ['connected cycle',value=>value.nodes[3].children=[1]],
  ['disconnected cycle',value=>{value.nodes.push({id:11,callFrame:frame('cycle1'),children:[12]},{id:12,callFrame:frame('cycle2'),children:[11]});}],
  ['multiple roots',value=>value.nodes.push({id:11,callFrame:frame('orphan')})],
  ['missing callFrame',value=>delete value.nodes[1].callFrame],
  ['invalid frame position',value=>value.nodes[1].callFrame.lineNumber=-2],
  ['wrong root marker',value=>value.nodes[0].callFrame.functionName='root'],
  ['unknown sample',value=>value.samples[0]=999],
  ['fractional sample ID',value=>value.samples[0]=2.5],
  ['negative delta',value=>value.timeDeltas[0]=-1],
  ['fractional delta',value=>value.timeDeltas[0]=1.5],
  ['nonfinite delta',value=>value.timeDeltas[0]=Infinity],
  ['mismatched sample/delta arrays',value=>value.timeDeltas.pop()],
  ['delta sum exceeds duration',value=>value.timeDeltas[0]=101],
  ['zero total elapsed weight',value=>value.timeDeltas.fill(0)],
  ['reversed time extent',value=>value.endTime=value.startTime],
  ['nonfinite extent',value=>value.startTime=NaN],
  ['duration bound',value=>value.endTime=value.startTime+LIMITS.durationMicros+1],
  ['empty samples',value=>{value.samples=[];value.timeDeltas=[];}]
];
for(const [name,mutate] of badProfiles)test('rejects '+name,()=>{const input=profile();mutate(input);assert.throws(()=>analyzeProfile(input,rules));});
test('node/sample/depth/traversal limits fail closed and cannot be raised',()=>{
  assert.throws(()=>analyzeProfile(profile(),rules,{nodes:2}));assert.throws(()=>analyzeProfile(profile(),rules,{samples:2}));
  assert.throws(()=>analyzeProfile(profile(),rules,{depth:1}));assert.throws(()=>analyzeProfile(profile(),rules,{frameVisits:2}));
  assert.throws(()=>analyzeProfile(profile(),rules,{nodes:LIMITS.nodes+1}));
});

async function safeRemove(directory) {
  const parent=await realpath(HERE),target=await realpath(directory),part=relative(parent,target);
  assert.ok(part&&!part.startsWith('..')&&!part.includes('/')&&!part.includes('\\')&&basename(target).startsWith('.synthetic-'));
  await rm(target,{recursive:true,force:true});
}
function numbered(pid,role,parentPid,enabled,children=[]) {
  const startAt=100,rows=[];
  const add=(kind,at,fields={})=>{const row={kind,pid,role,workerId:children.length?null:'1',sequence:rows.length+1,at,monotonicMs:at-startAt,...fields};rows.push(row);return row;};
  const start=add('start',startAt,{parentPid,runtime:{version:'v24.19.0',platform:'linux',arch:'x64'},executable:'/synthetic/node',execArgv:['--import','/synthetic/observer.mjs']});
  if(enabled)add('profile_started',200,{samplingIntervalMicros:10000,maximumDurationMs:900000});
  for(const childPid of children)add('worker_fork',300,{childPid,childClusterId:1});
  add('sample',1100,{cpuTotalMicros:{user:100000,system:1000},memory:{rss:1000000,heapUsed:100000}});
  add('sample',2900,{cpuTotalMicros:{user:110000,system:2000},memory:{rss:1100000,heapUsed:110000}});
  for(const childPid of children)add('worker_exit',3400,{childPid,childClusterId:1,code:0,signal:null});
  const profilePath=`/synthetic/observer/group-${pid}/worker-${pid}.cpuprofile`,bytes=Buffer.from(JSON.stringify(profile()));
  if(enabled)add('profile_saved',3500,{profilePath,bytes:bytes.length});
  const flush=add('flush',3600,{reason:'qualifier_shutdown',success:true,error:null,droppedRecords:0,profileState:enabled?'saved':'disabled',profilePath:enabled?profilePath:null});
  add('shutdown',3700,{success:true,children:children.length,exited:children.length,
    childExits:children.map(child=>({pid:child,code:0,signal:null,clusterId:1})),failedChildren:[],forced:[],unresolved:[]});
  add('exit',3800,{code:0,flushed:true,droppedRecords:0,profileState:enabled?'saved':'disabled'});
  return {pid,rows,start,flush,profilePath,bytes};
}
async function fixture(enabled=true) {
  const directory=await mkdtemp(join(HERE,'.synthetic-'));
  const put=async (name,value)=>{const path=join(directory,name);await mkdir(dirname(path),{recursive:true});const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));await writeFile(path,bytes);return {file:name,sha256:sha256(bytes)};};
  const inventory=[['master-0',100,101,'projection'],['api-0',200,201,'api']],groups=[],all=[];
  for(const [name,rootPid,childPid,role] of inventory) {
    const values=[numbered(rootPid,'master',99,enabled,[childPid]),numbered(childPid,role,rootPid,enabled)];
    const group={name,directory:'capture/observer/'+name,observers:[],profiles:[]};
    for(const value of values) {
      const log=Buffer.from(value.rows.map(row=>JSON.stringify(row)).join('\n')+'\n'),descriptor=await put(group.directory+`/worker-${value.pid}.jsonl`,log);
      group.observers.push({pid:value.pid,sha256:descriptor.sha256});
      if(enabled)group.profiles.push({pid:value.pid,sha256:(await put(group.directory+`/worker-${value.pid}.cpuprofile`,value.bytes)).sha256});
      all.push({...value,name});
    }
    groups.push(group);
  }
  const phase={name:'profile-prefix-288',branch:'A',through:288,physical:[{rows:[]},{rows:[]},{rows:[]}],responses:[],note:'SYNTHETIC TEST: no actual physical state'};
  const stage=await put('capture/stages/profile-prefix-288.json',phase);
  const paths=['build/indexer/launcher.js','build/indexer/workers/projection.js','build/api/server.js','packages/backend-mongodb/dist/index.js',
    'package-lock.json','packages/backend-mongodb/package-lock.json','scripts/qualification/portable-state-recovery.ts','scripts/qualification/es955-worker-observer.mjs','scripts/qualification/portable-state-recovery-observer.mjs'];
  const emission=paths.map(path=>({path,bytes:1,sha256:sha256('SYNTHETIC EMISSION '+path)}));
  const report={status:'profiled-prefix',profileOnly:true,gitHead:'a'.repeat(40),
    runtime:{node:'v24.19.0',executable:'/synthetic/node',sha256:sha256('SYNTHETIC RUNTIME'),execArgv:['--experimental-transform-types']},
    inputHashes:{'SYNTHETIC-input':sha256('SYNTHETIC INPUT')},oracleHashes:{'SYNTHETIC-oracle':sha256('SYNTHETIC ORACLE')},
    planSha256:sha256('SYNTHETIC PLAN'),manifestSha256:sha256('SYNTHETIC FIXTURE MANIFEST'),
    errors:[],limits:{nodeAuthenticatedFork:false,wireTestnetReleaseQualified:false,fixture:'SYNTHETIC TEST ONLY'},
    startedAt:new Date(0).toISOString(),completedAt:new Date(4000).toISOString(),
    cleanup:inventory.map(([name,rootPid])=>({name,ok:true,shutdown:all.find(value=>value.pid===rootPid).rows.find(row=>row.kind==='shutdown')})),
    stages:[{name:'profile-prefix-288',file:'stages/profile-prefix-288.json',sha256:stage.sha256}],
    profiling:{prefix:288,firstBlock:1,sourcePacingBlocks:32,emptyTargetTablePrefix:true,completed:true,stable:true,fullRecoveryScenarioExecuted:false,
      firstReleaseAt:1000,stableAt:3000,cpuSamplingIntervalMicros:10000,maximumDurationMs:900000,maximumProfileBytes:32*1024*1024,
      cpuCapture:{verified:true,requested:enabled,enabled,observerFlag:enabled?'1':'0'},
      sourcePins:{chainId:'b'.repeat(64),profileId:'SYNTHETIC-TEST-ONLY',upstreamRevision:'c'.repeat(40),components:[{id:'SYNTHETIC'}]},
      pins:{files:emission,totalBytes:emission.length,inventorySha256:sha256(JSON.stringify(emission)),trackedDiffBytes:0,trackedDiffSha256:sha256(Buffer.alloc(0))},
      cpuProfiles:enabled?all.map(value=>({pid:value.pid,role:value.start.role,start:value.start,flush:value.flush,file:value.profilePath,
        bytes:value.bytes.length,sha256:sha256(value.bytes),samples:8,startTime:1000,endTime:1100})):[],
      observerCompletion:inventory.map(([name])=>({name,events:all.filter(value=>value.name===name).flatMap(value=>value.rows.filter(row=>['start','profile_started','profile_saved','flush','exit'].includes(row.kind)))}))}};
  const manifest={schemaVersion:1,dataKind:'synthetic-test',classification:rules,runReport:await put('capture/report.json',report),phaseEvidence:stage,groups};
  const save=async()=>{manifest.runReport=await put('capture/report.json',report);const descriptor=await put('analysis-manifest.json',manifest);return {path:join(directory,descriptor.file),sha256:descriptor.sha256};};
  return {directory,manifest,report,put,save,all};
}
async function withFixture(operation,enabled=true) {const value=await fixture(enabled);try{await operation(value);}finally{await safeRemove(value.directory);}}

test('SHA-pinned complete synthetic process families preserve pins and separate observer CPU from V8 wall weights',async()=>withFixture(async value=>{
  const pin=await value.save(),result=await analyzeManifest(pin.path,pin.sha256);
  assert.equal(result.dataKind,'synthetic-test');assert.match(result.observationStatus,/SYNTHETIC ONLY/);assert.equal(result.processes.length,4);
  assert.deepEqual(result.groups[0].expectedPids,[100,101]);assert.equal(result.capturePins.gitHead,'a'.repeat(40));
  assert.equal(result.phaseBounds.firstReleaseAt,1000);assert.equal(result.phaseBounds.stableAt,3000);
  const item=result.processes[0];assert.equal(item.observerCpu.observedSpan.cpuMicros,11000);assert.equal(item.observerCpu.observedSpan.elapsedMs,1800);
  assert.equal(item.profile.sampledIntervalMicros,86);assert.notEqual(item.profile.sampledIntervalMicros,item.observerCpu.observedSpan.cpuMicros);
  assert.equal(result.cpuCaptureEnabled,true);assert.equal(result.rawEvidence.length,11);
}));
test('disabled synthetic control keeps complete process/CPU evidence and produces no fake V8 profile',async()=>withFixture(async value=>{
  const pin=await value.save(),result=await analyzeManifest(pin.path,pin.sha256);
  assert.equal(result.cpuCaptureEnabled,false);assert.ok(result.processes.every(row=>row.profile===null));assert.equal(result.processes.length,4);
},false));
test('expanded parent lifecycle report receipts are reconciled with raw records',async()=>withFixture(async value=>{
  for(const group of value.report.profiling.observerCompletion)group.events=value.all.filter(item=>item.name===group.name)
    .flatMap(item=>item.rows.filter(row=>['start','profile_started','profile_saved','flush','exit','worker_fork','worker_exit','shutdown'].includes(row.kind)));
  const pin=await value.save(),result=await analyzeManifest(pin.path,pin.sha256);assert.equal(result.processes.length,4);
}));
test('leaf shutdown receipts are required and cannot hide descendants or cleanup failure',async()=>{
  for(const mode of ['absent','children','exit','failed','forced'])await withFixture(async value=>{
    const item=value.all.find(row=>row.pid===101),leaf=item.rows.find(row=>row.kind==='shutdown');
    if(mode==='absent')item.rows=item.rows.filter(row=>row!==leaf);
    if(mode==='children')leaf.children=1;
    if(mode==='exit')leaf.childExits.push({pid:999,code:0,signal:null});
    if(mode==='failed')leaf.success=false;
    if(mode==='forced')leaf.forced.push(999);
    item.rows.forEach((row,index)=>row.sequence=index+1);
    const group=value.manifest.groups[0];
    group.observers.find(row=>row.pid===101).sha256=(await value.put(group.directory+'/worker-101.jsonl',
      Buffer.from(item.rows.map(row=>JSON.stringify(row)).join('\n')+'\n'))).sha256;
    const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),
      mode==='absent'?/Expected one shutdown/:/Leaf shutdown claims/);
  });
});
test('fresh-only output refuses overwrite and paths outside this private folder',async()=>withFixture(async value=>{
  const output=join(value.directory,'result.json'),result={dataKind:'synthetic-test',note:'NO ACTUAL OBSERVATIONS'};
  const descriptor=await writeFreshAnalysis(result,output);assert.equal(descriptor.sha256,sha256(await readFile(output)));
  await assert.rejects(writeFreshAnalysis(result,output),/EEXIST/);
  await assert.rejects(writeFreshAnalysis(result,resolve(HERE,'..','outside-analysis.json')),/inside the private helper folder/);
}));
test('manifest SHA mismatch is rejected before analysis',async()=>withFixture(async value=>{
  const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,'0'.repeat(64)),/SHA-256 mismatch/);
}));
test('profile SHA corruption is rejected',async()=>withFixture(async value=>{
  const file=join(value.directory,value.manifest.groups[0].directory,'worker-100.cpuprofile');await writeFile(file,'{}');
  const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/SHA-256 mismatch/);
}));
test('missing child cannot disappear even when surviving profile descriptors and completion events omit it',async()=>withFixture(async value=>{
  const group=value.manifest.groups[0];group.observers=group.observers.filter(row=>row.pid!==101);group.profiles=group.profiles.filter(row=>row.pid!==101);
  value.report.profiling.cpuProfiles=value.report.profiling.cpuProfiles.filter(row=>row.pid!==101);
  value.report.profiling.observerCompletion[0].events=value.report.profiling.observerCompletion[0].events.filter(row=>row.pid!==101);
  await rm(join(value.directory,group.directory,'worker-101.jsonl'));await rm(join(value.directory,group.directory,'worker-101.cpuprofile'));
  const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/Owned observer is missing or foreign/);
}));
test('disabled control also rejects a missing real child observer',async()=>withFixture(async value=>{
  const group=value.manifest.groups[0];group.observers=group.observers.filter(row=>row.pid!==101);
  value.report.profiling.observerCompletion[0].events=value.report.profiling.observerCompletion[0].events.filter(row=>row.pid!==101);
  await rm(join(value.directory,group.directory,'worker-101.jsonl'));
  const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/Owned observer is missing or foreign/);
},false));
test('foreign artifact and disabled-control stray profile are rejected',async()=>{
  await withFixture(async value=>{await value.put(value.manifest.groups[0].directory+'/worker-999.cpuprofile',Buffer.from('{}'));
    const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/directory inventory differs/);});
  await withFixture(async value=>{await value.put(value.manifest.groups[0].directory+'/worker-100.cpuprofile',Buffer.from('{}'));
    const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/directory inventory differs/);},false);
});
test('re-pinned malformed JSON profile fails semantic validation rather than only its digest',async()=>withFixture(async value=>{
  const group=value.manifest.groups[0],entry=value.report.profiling.cpuProfiles.find(row=>row.pid===100),rows=value.all.find(row=>row.pid===100).rows;
  const input=profile();delete input.nodes[1].callFrame;const bytes=Buffer.from(JSON.stringify(input));
  group.profiles[0].sha256=(await value.put(group.directory+'/worker-100.cpuprofile',bytes)).sha256;entry.sha256=sha256(bytes);entry.bytes=bytes.length;
  rows.find(row=>row.kind==='profile_saved').bytes=bytes.length;
  group.observers[0].sha256=(await value.put(group.directory+'/worker-100.jsonl',Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'))).sha256;
  const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/Missing V8 callFrame/);
}));
test('partial observer tail and missing sequence are rejected even with new manifest pins',async()=>{
  for(const mode of ['partial','sequence'])await withFixture(async value=>{
    const group=value.manifest.groups[0],name=group.directory+'/worker-101.jsonl',bytes=await readFile(join(value.directory,name));
    const changed=mode==='partial'?bytes.subarray(0,-1):Buffer.from(bytes.toString().split('\n').filter((_,index)=>index!==2).join('\n'));
    group.observers.find(row=>row.pid===101).sha256=(await value.put(name,changed)).sha256;
    const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),mode==='partial'?/partial final record/:/contiguous sequence mismatch/);
  });
});
test('profile file bound and path traversal are rejected before unbounded reading',async()=>{
  await withFixture(async value=>{
    const path=join(value.directory,value.manifest.groups[0].directory,'worker-100.cpuprofile'),handle=await open(path,'r+');
    await handle.truncate(LIMITS.profileBytes+1);await handle.close();
    const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256),/size outside bound/);
  });
  await withFixture(async value=>{const pin=await value.save();value.manifest.runReport.file='../outside.json';
    const next=await value.put('analysis-manifest.json',value.manifest);await assert.rejects(analyzeManifest(pin.path,next.sha256),/ordinary relative/);});
});
test('failed qualification, dirty source inventory and inconsistent phase pins are not analyzed as completed captures',async()=>{
  for(const mode of ['failed','dirty','phase'])await withFixture(async value=>{
    if(mode==='failed')value.report.status='failed';if(mode==='dirty')value.report.profiling.pins.trackedDiffBytes=1;
    if(mode==='phase')value.manifest.phaseEvidence.sha256='0'.repeat(64);
    const pin=await value.save();await assert.rejects(analyzeManifest(pin.path,pin.sha256));
  });
});
