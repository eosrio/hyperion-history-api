import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open, lstat, readdir, realpath, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const AUTHOR = 'windows:codex:hyperion-tools';
const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({manifestBytes: MiB, reportBytes: 16*MiB, stageBytes: 16*MiB,
  logBytes:24*MiB, profileBytes:32*MiB, aggregateBytes:512*MiB, outputBytes:64*MiB,
  processes:64, logRecords:200000, logRecordBytes:64*1024, observerSamples:5000,
  nodes:100000, samples:200000, depth:2048, frameVisits:2000000, durationMicros:900000000});
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const categories = ['application','dependency','observer','runtime','native-or-unattributed','gc','idle','unknown'];
const fatalUtf8 = new TextDecoder('utf-8', {fatal:true});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, message) {if (!condition) throw new Error(message);}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum=0) => Number.isSafeInteger(value) && value >= minimum;
const finite = value => typeof value === 'number' && Number.isFinite(value);
function text(value, name, maximum=16384, allowEmpty=false) {
  requireValue(typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maximum, 'Invalid '+name);
  return value;
}
function hash(value, name) {requireValue(typeof value === 'string' && HEX64.test(value), 'Invalid SHA-256 '+name);return value;}
function pidList(values, name) {
  requireValue(Array.isArray(values) && values.length <= LIMITS.processes && values.every(value=>integer(value,1)), 'Invalid PID list '+name);
  requireValue(new Set(values).size===values.length, 'Duplicate PID in '+name);
  return [...values].sort((a,b)=>a-b);
}
const equal = (actual, expected, message) => requireValue(isDeepStrictEqual(actual,expected),message);
const one = (rows, kind) => {const values=rows.filter(row=>row.kind===kind);requireValue(values.length===1,'Expected one '+kind+' receipt');return values[0];};
function location(value) {
  if (value.startsWith('file:')) {try {const url=new URL(value),host=url.host&&url.host!=='localhost'?'//'+url.host:'';return (host+decodeURIComponent(url.pathname)).replace(/^\/([A-Za-z]:\/)/,'$1').replaceAll('\\','/');}catch{throw new Error('Invalid file URL in classification');}}
  return value.replaceAll('\\','/');
}
function classificationRules(input) {
  requireValue(record(input),'Classification rules are required');
  for (const key of ['applicationRoots','observerFiles']) requireValue(Array.isArray(input[key]) && input[key].length>0 && input[key].length<=64,'Explicit '+key+' required');
  return {applicationRoots:input.applicationRoots.map(value=>location(text(value,'application root')).replace(/\/$/,'')),
    observerFiles:input.observerFiles.map(value=>location(text(value,'observer file')))};
}
function category(frame,rules) {
  if(frame.functionName==='(idle)')return 'idle';
  if(frame.functionName==='(garbage collector)')return 'gc';
  if(['(root)','(program)'].includes(frame.functionName))return 'runtime';
  const url=location(frame.url);
  if(rules.observerFiles.includes(url))return 'observer';
  if(url.startsWith('node:')||url.startsWith('internal/'))return 'runtime';
  if(!url)return 'native-or-unattributed';
  if(url.includes('/node_modules/'))return 'dependency';
  if(rules.applicationRoots.some(root=>url===root||url.startsWith(root+'/')))return 'application';
  return 'unknown';
}

/** Pure math entry point. Files supplied to the CLI also pass mandatory SHA and receipt gates below. */
export function analyzeProfile(profile, classification, smallerLimits={}) {
  const rules=classificationRules(classification), limits={...LIMITS};
  for(const [key,value] of Object.entries(smallerLimits)) {
    requireValue(Object.hasOwn(LIMITS,key)&&integer(value,1)&&value<=LIMITS[key],'Limit overrides may only lower a hard bound');limits[key]=value;
  }
  requireValue(record(profile)&&Array.isArray(profile.nodes)&&profile.nodes.length>0&&profile.nodes.length<=limits.nodes,'Invalid profile node count');
  requireValue(Array.isArray(profile.samples)&&profile.samples.length>0&&profile.samples.length<=limits.samples,'Invalid profile sample count');
  requireValue(Array.isArray(profile.timeDeltas)&&profile.timeDeltas.length===profile.samples.length,'Sample/timeDelta lengths differ');
  requireValue(integer(profile.startTime)&&integer(profile.endTime)&&profile.endTime>profile.startTime,'Invalid profile time extent');
  const durationMicros=profile.endTime-profile.startTime;
  requireValue(durationMicros<=limits.durationMicros,'Profile duration exceeds bound');
  const nodes=new Map(),parents=new Map(),functions=new Map();
  for(const input of profile.nodes) {
    requireValue(record(input)&&integer(input.id,1)&&!nodes.has(input.id),'Invalid or duplicate profile node ID');
    const value=input.callFrame;requireValue(record(value),'Missing V8 callFrame');
    const frame={functionName:text(value.functionName,'functionName',16384,true),scriptId:text(value.scriptId,'scriptId',256),
      url:text(value.url,'callFrame URL',16384,true),lineNumber:value.lineNumber,columnNumber:value.columnNumber};
    requireValue(integer(frame.lineNumber,-1)&&integer(frame.columnNumber,-1),'Invalid callFrame position');
    const children=input.children??[];requireValue(Array.isArray(children)&&children.length<=profile.nodes.length,'Invalid node children');
    requireValue(children.every(id=>integer(id,1))&&new Set(children).size===children.length,'Invalid or duplicate child edge');
    if(input.hitCount!==undefined)requireValue(integer(input.hitCount),'Invalid hitCount');
    const functionKey=JSON.stringify([frame.functionName,frame.scriptId,frame.url,frame.lineNumber,frame.columnNumber]);
    const functionId=sha256(functionKey),kind=category(frame,rules);
    const node={id:input.id,children,callFrame:frame,functionId,category:kind,selfRawSamples:0,selfIntervalMicros:0,inclusiveRawSamples:0,inclusiveIntervalMicros:0};
    nodes.set(input.id,node);
    if(!functions.has(functionId))functions.set(functionId,{functionId,callFrame:frame,category:kind,nodeIds:[],selfRawSamples:0,selfIntervalMicros:0,inclusiveRawSamples:0,inclusiveIntervalMicros:0});
    functions.get(functionId).nodeIds.push(input.id);
  }
  for(const node of nodes.values())for(const child of node.children) {
    requireValue(nodes.has(child),'Node references missing child');
    requireValue(child!==node.id&&!parents.has(child),'Cycle or multiple-parent/duplicate child edge');parents.set(child,node.id);
  }
  const roots=[...nodes.keys()].filter(id=>!parents.has(id));requireValue(roots.length===1,'Profile graph must have exactly one root');
  const rootId=roots[0];requireValue(nodes.get(rootId).callFrame.functionName==='(root)','V8 root marker is missing');
  const visited=new Set(),pending=[[rootId,0]];
  while(pending.length) {
    const [id,depth]=pending.pop();requireValue(!visited.has(id),'Cycle in profile graph');requireValue(depth<=limits.depth,'Profile stack depth exceeds bound');
    visited.add(id);for(const child of nodes.get(id).children)pending.push([child,depth+1]);
  }
  requireValue(visited.size===nodes.size,'Profile graph has unreachable nodes or a disconnected cycle');
  let sampledIntervalMicros=0;
  for(let index=0;index<profile.samples.length;index++) {
    const id=profile.samples[index],delta=profile.timeDeltas[index];
    requireValue(integer(id,1)&&nodes.has(id),'Sample references unknown/noninteger node');
    requireValue(integer(delta),'Invalid timeDelta; require nonnegative integer microseconds');
    sampledIntervalMicros+=delta;requireValue(Number.isSafeInteger(sampledIntervalMicros)&&sampledIntervalMicros<=durationMicros,'timeDeltas exceed profile extent');
    const node=nodes.get(id);node.selfRawSamples++;node.selfIntervalMicros+=delta;
  }
  requireValue(sampledIntervalMicros>0,'Profile has no positive sampled interval weight');
  const categorySelf=Object.fromEntries(categories.map(key=>[key,{rawSamples:0,intervalMicros:0}])),stacks=[];
  let visits=0;
  for(const leaf of nodes.values()) {
    if(!leaf.selfRawSamples)continue;
    const self=functions.get(leaf.functionId);self.selfRawSamples+=leaf.selfRawSamples;self.selfIntervalMicros+=leaf.selfIntervalMicros;
    categorySelf[leaf.category].rawSamples+=leaf.selfRawSamples;categorySelf[leaf.category].intervalMicros+=leaf.selfIntervalMicros;
    const seenFunctions=new Set(),nodeIds=[];
    for(let id=leaf.id;id!==undefined;id=parents.get(id)) {
      requireValue(++visits<=limits.frameVisits,'Aggregated stack traversal exceeds bound');const node=nodes.get(id);nodeIds.push(id);
      node.inclusiveRawSamples+=leaf.selfRawSamples;node.inclusiveIntervalMicros+=leaf.selfIntervalMicros;
      if(!seenFunctions.has(node.functionId)) {
        const value=functions.get(node.functionId);value.inclusiveRawSamples+=leaf.selfRawSamples;value.inclusiveIntervalMicros+=leaf.selfIntervalMicros;seenFunctions.add(node.functionId);
      }
    }
    stacks.push({leafNodeId:leaf.id,nodeIds:nodeIds.reverse(),rawSamples:leaf.selfRawSamples,intervalMicros:leaf.selfIntervalMicros});
  }
  const compare=(a,b)=>b.selfIntervalMicros-a.selfIntervalMicros||b.selfRawSamples-a.selfRawSamples||a.functionId.localeCompare(b.functionId);
  const ranked=[...functions.values()].sort(compare);
  for(const row of ranked) {
    row.nodeIds.sort((a,b)=>a-b);row.selfRawPercent=100*row.selfRawSamples/profile.samples.length;
    row.selfIntervalPercent=100*row.selfIntervalMicros/sampledIntervalMicros;
    row.inclusiveRawPercent=100*row.inclusiveRawSamples/profile.samples.length;
    row.inclusiveIntervalPercent=100*row.inclusiveIntervalMicros/sampledIntervalMicros;
  }
  assert.equal([...nodes.values()].reduce((sum,node)=>sum+node.selfRawSamples,0),profile.samples.length);
  assert.equal(Object.values(categorySelf).reduce((sum,value)=>sum+value.intervalMicros,0),sampledIntervalMicros);
  return {clock:'V8 profile microseconds; independent of wall/observer monotonic epochs',rootId,
    startTime:profile.startTime,endTime:profile.endTime,durationMicros,rawSampleCount:profile.samples.length,sampledIntervalMicros,
    unweightedTailMicros:durationMicros-sampledIntervalMicros,firstSampleOffsetMicros:profile.timeDeltas[0],
    weightConvention:'Each tick receives its preceding timeDelta, including start-to-first-tick. Unsampled end tail is unweighted. These are sampled elapsed intervals, not measured process CPU.',
    inclusiveConvention:'Context nodes include descendants; function totals deduplicate identical call frames once per sampled stack, including recursive frames. Inclusive totals overlap and must not be summed.',
    categoryConvention:'Exclusive leaf/self partition only. Blank-URL nonmarkers are native-or-unattributed, not proven native stacks.',
    categorySelf,functions:ranked,nodes:[...nodes.values()].sort((a,b)=>a.id-b.id).map(node=>({...node,parentId:parents.get(node.id)??null})),
    stacks:stacks.sort((a,b)=>b.intervalMicros-a.intervalMicros||a.leafNodeId-b.leafNodeId),aggregatedFrameVisits:visits};
}

function safeRelative(value) {
  text(value,'relative artifact path',4096);requireValue(!isAbsolute(value)&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..'),'Artifact paths must be ordinary relative slash paths');return value;
}
async function readerAt(inputDirectory) {
  const base=await realpath(inputDirectory);requireValue((await lstat(base)).isDirectory(),'Artifact root is not a directory');
  let totalBytes=0;const evidence=[];
  const pathOf=async (name,directory=false)=>{
    safeRelative(name);let path=base;const parts=name.split('/');
    for(let index=0;index<parts.length;index++) {
      path=join(path,parts[index]);const info=await lstat(path);
      requireValue(!info.isSymbolicLink()&&(index<parts.length-1||directory?info.isDirectory():info.isFile()),'Nonordinary artifact path');
    }
    requireValue(!relative(base,path).startsWith('..'),'Artifact escaped supplied root');return path;
  };
  const read=async (name,expectedHash,maximum)=>{
    hash(expectedHash,name);const path=await pathOf(name);const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const before=await handle.stat();requireValue(before.isFile()&&before.size>0&&before.size<=maximum,'Artifact size outside bound: '+name);
      totalBytes+=before.size;requireValue(totalBytes<=LIMITS.aggregateBytes,'Aggregate input bytes exceed bound');
      const bytes=Buffer.alloc(before.size);let offset=0;
      while(offset<bytes.length) {const value=await handle.read(bytes,offset,bytes.length-offset,offset);requireValue(value.bytesRead>0,'Artifact shortened during read');offset+=value.bytesRead;}
      const extra=await handle.read(Buffer.alloc(1),0,1,bytes.length),after=await handle.stat();
      requireValue(extra.bytesRead===0&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'Artifact changed during bounded read');
      requireValue(sha256(bytes)===expectedHash,'SHA-256 mismatch: '+name);evidence.push({file:name,sha256:expectedHash,bytes:bytes.length});return bytes;
    } finally {await handle.close();}
  };
  const json=async (descriptor,maximum)=>{requireValue(record(descriptor),'Missing artifact descriptor');return JSON.parse(fatalUtf8.decode(await read(descriptor.file,descriptor.sha256,maximum)));};
  const list=async name=>{const entries=await readdir(await pathOf(name,true),{withFileTypes:true});requireValue(entries.length<=2*LIMITS.processes,'Observer directory inventory exceeds bound');
    requireValue(entries.every(entry=>entry.isFile()&&!entry.isSymbolicLink()),'Observer artifacts must be ordinary files');return entries.map(entry=>entry.name).sort();};
  return {read,json,list,evidence,get totalBytes(){return totalBytes;}};
}
function hashMap(value,name) {
  requireValue(record(value)&&Object.keys(value).length>0&&Object.keys(value).length<=4096,'Invalid '+name);
  for(const [key,digest] of Object.entries(value)) {text(key,name+' key',4096);hash(digest,name);}return value;
}
function validateReport(report) {
  requireValue(record(report)&&report.status==='profiled-prefix'&&report.profileOnly===true,'Require a completed qualified prefix report');
  requireValue(typeof report.gitHead==='string'&&HEX40.test(report.gitHead),'Missing capture commit');
  requireValue(record(report.runtime)&&/^v(?:22|24)\./.test(report.runtime.node),'Missing qualified capture runtime');
  text(report.runtime.executable,'capture runtime executable',4096);hash(report.runtime.sha256,'runtime binary');
  requireValue(Array.isArray(report.runtime.execArgv)&&report.runtime.execArgv.length<=64&&report.runtime.execArgv.every(value=>typeof value==='string'&&value.length<=4096),'Missing capture runtime flags');
  hashMap(report.inputHashes,'input hashes');hashMap(report.oracleHashes,'oracle hashes');hash(report.planSha256,'plan');hash(report.manifestSha256,'fixture manifest');
  const p=report.profiling;requireValue(record(p)&&p.prefix===288&&p.firstBlock===1&&p.sourcePacingBlocks===32&&p.emptyTargetTablePrefix===true,'Require the declared empty-table 1-288 workload');
  requireValue(p.completed===true&&p.stable===true&&p.fullRecoveryScenarioExecuted===false,'Prefix completion/finality limits are missing');
  requireValue(integer(p.firstReleaseAt)&&integer(p.stableAt)&&p.stableAt>=p.firstReleaseAt,'Invalid source/physical phase bounds');
  requireValue(p.cpuSamplingIntervalMicros===10000&&p.maximumDurationMs===900000&&p.maximumProfileBytes===LIMITS.profileBytes,'Unexpected capture bounds');
  requireValue(record(p.cpuCapture)&&p.cpuCapture.verified===true&&typeof p.cpuCapture.enabled==='boolean'&&p.cpuCapture.requested===p.cpuCapture.enabled,'Unverified CPU capture mode');
  requireValue(p.cpuCapture.observerFlag===(p.cpuCapture.enabled?'1':'0'),'Capture flag mismatch');
  requireValue(record(p.sourcePins)&&HEX64.test(p.sourcePins.chainId)&&typeof p.sourcePins.profileId==='string'&&HEX40.test(p.sourcePins.upstreamRevision)
    &&Array.isArray(p.sourcePins.components)&&p.sourcePins.components.length>0&&p.sourcePins.components.length<=64,'Missing original protocol/source pins');
  requireValue(Array.isArray(report.errors)&&report.errors.length===0&&report.error===undefined,'Qualification report has errors');
  requireValue(Array.isArray(report.cleanup)&&report.cleanup.length>0&&report.cleanup.length<=128&&report.cleanup.every(row=>row.ok===true),'Qualification cleanup is incomplete');
  requireValue(record(report.limits)&&report.limits.nodeAuthenticatedFork===false&&report.limits.wireTestnetReleaseQualified===false,'Qualification scope limits are missing');
  const pins=p.pins;requireValue(record(pins)&&Array.isArray(pins.files)&&pins.files.length>0&&pins.files.length<=4096,'Missing emission inventory');
  const names=new Set();let bytes=0;
  for(const file of pins.files) {requireValue(record(file)&&integer(file.bytes,1)&&file.bytes<=16*MiB,'Invalid emission inventory entry');
    safeRelative(file.path);requireValue(!names.has(file.path),'Duplicate emission path');names.add(file.path);hash(file.sha256,'emission');bytes+=file.bytes;}
  requireValue(bytes<=128*MiB&&bytes===pins.totalBytes,'Emission byte accounting differs');
  for(const name of ['build/indexer/launcher.js','build/indexer/workers/projection.js','build/api/server.js','packages/backend-mongodb/dist/index.js',
    'package-lock.json','packages/backend-mongodb/package-lock.json','scripts/qualification/portable-state-recovery.ts','scripts/qualification/es955-worker-observer.mjs','scripts/qualification/portable-state-recovery-observer.mjs'])
    requireValue(names.has(name),'Missing pinned emission/collector '+name);
  requireValue(sha256(Buffer.from(JSON.stringify(pins.files)))===pins.inventorySha256,'Emission inventory digest differs');
  requireValue(pins.trackedDiffBytes===0&&pins.trackedDiffSha256===sha256(Buffer.alloc(0)),'Capture tracked source was dirty');
  requireValue(Array.isArray(p.cpuProfiles)&&p.cpuProfiles.length<=LIMITS.processes&&Array.isArray(p.observerCompletion),'Missing profile/observer report inventory');
  return report;
}
function parseObserver(bytes,pid) {
  const source=fatalUtf8.decode(bytes);requireValue(source.endsWith('\n'),'Observer log has a partial final record');
  const lines=source.slice(0,-1).split('\n');requireValue(lines.length>0&&lines.length<=LIMITS.logRecords,'Observer record count outside bound');
  const kept=[];let sequence=0,monotonic=-1;
  const keep=new Set(['start','profile_started','profile_saved','flush','exit','worker_fork','worker_exit','worker_online','shutdown','sample','observer_error']);
  for(const line of lines) {
    requireValue(line.length>0&&Buffer.byteLength(line)<=LIMITS.logRecordBytes,'Empty or oversized observer record');const row=JSON.parse(line);
    requireValue(record(row)&&row.pid===pid&&row.sequence===++sequence,'Observer PID or contiguous sequence mismatch');
    requireValue(integer(row.at)&&finite(row.monotonicMs)&&row.monotonicMs>=monotonic,'Invalid observer timestamp/monotonic ordering');monotonic=row.monotonicMs;
    if(keep.has(row.kind))kept.push(row);
  }
  requireValue(kept[0]?.kind==='start'&&kept[0].sequence===1,'Observer start is missing');
  requireValue(!kept.some(row=>row.kind==='observer_error'),'Observer recorded an error');return kept;
}
function sampleCpu(rows,phase) {
  const samples=rows.filter(row=>row.kind==='sample');requireValue(samples.length>=2&&samples.length<=LIMITS.observerSamples,'Insufficient/bounded process CPU samples');
  let prior;for(const row of samples) {
    requireValue(record(row.cpuTotalMicros)&&integer(row.cpuTotalMicros.user)&&integer(row.cpuTotalMicros.system),'Invalid observer CPU counters');
    requireValue(record(row.memory)&&integer(row.memory.rss)&&integer(row.memory.heapUsed),'Invalid observer memory sample');
    if(prior)requireValue(row.cpuTotalMicros.user>=prior.cpuTotalMicros.user&&row.cpuTotalMicros.system>=prior.cpuTotalMicros.system&&row.monotonicMs>prior.monotonicMs,'Process counters regressed');prior=row;
  }
  const span=values=>{
    if(values.length<2)return null;const first=values[0],last=values.at(-1),elapsedMs=last.monotonicMs-first.monotonicMs;
    const userMicros=last.cpuTotalMicros.user-first.cpuTotalMicros.user,systemMicros=last.cpuTotalMicros.system-first.cpuTotalMicros.system;
    return {samples:values.length,firstWallAt:first.at,lastWallAt:last.at,firstMonotonicMs:first.monotonicMs,lastMonotonicMs:last.monotonicMs,
      elapsedMs,userMicros,systemMicros,cpuMicros:userMicros+systemMicros,averagePercentOneCore:(userMicros+systemMicros)/(elapsedMs*1000)*100};
  };
  const wallClockMonotonic=samples.every((row,index)=>!index||row.at>=samples[index-1].at);
  const inPhase=wallClockMonotonic?samples.filter(row=>row.at>=phase.firstReleaseAt&&row.at<=phase.stableAt):[];
  return {scope:'Observed process CPU counters within one PID/monotonic clock. Includes native/helper-thread/observer work; not inferred from V8 ticks.',
    observedSpan:span(samples),rssBytes:{min:Math.min(...samples.map(row=>row.memory.rss)),max:Math.max(...samples.map(row=>row.memory.rss))},
    heapUsedBytes:{min:Math.min(...samples.map(row=>row.memory.heapUsed)),max:Math.max(...samples.map(row=>row.memory.heapUsed))},
    phaseSelection:{wallClockMonotonic,clock:'same-host wall stamps select samples; elapsed uses only the PID monotonic clock',
      firstSampleAfterReleaseMs:inPhase.length?inPhase[0].at-phase.firstReleaseAt:null,lastSampleBeforeStableMs:inPhase.length?phase.stableAt-inPhase.at(-1).at:null,
      cpu:span(inPhase),limitation:'No exact V8 tick-to-phase alignment is claimed. Endpoint margins and unavailable/clock-regressing spans remain explicit.'}};
}
function validateProcessReceipts(rows,pid,rootPid,report,profileEntry) {
  const start=one(rows,'start'),flush=one(rows,'flush'),exit=one(rows,'exit'),p=report.profiling,enabled=p.cpuCapture.enabled;
  requireValue(pid===rootPid||start.parentPid===rootPid,'Child observer parent differs');
  requireValue(start.runtime?.version===report.runtime.node&&start.executable===report.runtime.executable,'Capture runtime differs across process');
  requireValue(flush.reason==='qualifier_shutdown'&&flush.at>=p.stableAt&&flush.success===true&&flush.error===null&&flush.droppedRecords===0,'Incomplete/premature observer flush');
  requireValue(exit.code===0&&exit.flushed===true&&exit.droppedRecords===0&&exit.sequence>flush.sequence,'Incomplete process exit receipt');
  requireValue(flush.profileState===(enabled?'saved':'disabled')&&exit.profileState===flush.profileState,'Observer capture mode mismatch');
  const began=rows.filter(row=>row.kind==='profile_started'),saved=rows.filter(row=>row.kind==='profile_saved');
  if(enabled) {
    requireValue(began.length===1&&saved.length===1&&record(profileEntry),'Missing CPU capture receipts/report entry');
    requireValue(began[0].samplingIntervalMicros===p.cpuSamplingIntervalMicros&&began[0].maximumDurationMs===p.maximumDurationMs&&began[0].at<=p.stableAt,'Capture configuration/coverage differs');
    requireValue(began[0].sequence<saved[0].sequence&&saved[0].sequence<flush.sequence,'CPU capture receipt ordering differs');
    requireValue(saved[0].profilePath===profileEntry.file&&flush.profilePath===profileEntry.file,'Saved profile identity differs');
    equal(profileEntry.start,start,'Profile start differs from pinned run report');equal(profileEntry.flush,flush,'Profile flush differs from pinned run report');
  } else requireValue(began.length===0&&saved.length===0&&flush.profilePath===null,'Disabled control contains CPU capture receipts');
  return {start,flush,exit,saved:saved[0]};
}

/** Analyze only explicitly named, locally archived artifacts. Never queries a service or discovers a remote host. */
export async function analyzeManifest(manifestFile,expectedManifestSha256) {
  const absolute=resolve(manifestFile),reader=await readerAt(dirname(absolute));
  const manifest=await reader.json({file:basename(absolute),sha256:expectedManifestSha256},LIMITS.manifestBytes);
  requireValue(record(manifest)&&manifest.schemaVersion===1&&['actual-capture','synthetic-test'].includes(manifest.dataKind),'Invalid analysis manifest schema/data kind');
  const rules=classificationRules(manifest.classification); // Validate explicit roots now; retain raw rule strings below.
  void rules;
  const report=validateReport(await reader.json(manifest.runReport,LIMITS.reportBytes)),p=report.profiling;
  const phases=report.stages?.filter(stage=>stage.name==='profile-prefix-288');requireValue(phases?.length===1,'Missing independent stable physical/HTTP stage');
  requireValue(manifest.phaseEvidence?.sha256===phases[0].sha256,'Phase evidence pin differs from report');
  const phase=await reader.json(manifest.phaseEvidence,LIMITS.stageBytes);
  requireValue(phase.name==='profile-prefix-288'&&phase.branch==='A'&&phase.through===288,'Wrong physical/source phase evidence');
  const shutdowns=report.cleanup.filter(row=>row.shutdown);requireValue(shutdowns.length>0&&shutdowns.length<=8,'Missing independent parent shutdown inventory');
  requireValue(Array.isArray(manifest.groups)&&manifest.groups.length===shutdowns.length,'Analysis group inventory differs');
  const groupNames=manifest.groups.map(group=>text(group.name,'group name',128));requireValue(new Set(groupNames).size===groupNames.length,'Duplicate group');
  equal([...groupNames].sort(),shutdowns.map(row=>row.name).sort(),'Analysis groups omit a qualified parent');
  equal(report.profiling.observerCompletion.map(row=>row.name).sort(),[...groupNames].sort(),'Report observer groups differ');
  const allPids=new Set(),processes=[],groupResults=[];
  const reportProfiles=new Map();for(const entry of p.cpuProfiles) {requireValue(integer(entry.pid,1)&&!reportProfiles.has(entry.pid),'Duplicate/invalid report profile PID');reportProfiles.set(entry.pid,entry);}
  for(const group of manifest.groups) {
    const cleanup=shutdowns.find(row=>row.name===group.name),shutdown=cleanup.shutdown,rootPid=shutdown.pid;
    requireValue(integer(rootPid,1)&&shutdown.success===true&&Array.isArray(shutdown.childExits),'Invalid qualified parent receipt');
    for(const key of ['failedChildren','forced','unresolved'])equal(shutdown[key],[],'Qualified shutdown has unresolved children');
    requireValue(shutdown.childExits.every(row=>row.code===0&&row.signal===null),'Qualified child did not exit cleanly');
    const children=pidList(shutdown.childExits.map(row=>row.pid),'shutdown children'),expected=pidList([rootPid,...children],'expected processes');
    requireValue(shutdown.children===children.length&&shutdown.exited===children.length,'Shutdown child count mismatch');
    requireValue(Array.isArray(group.observers)&&Array.isArray(group.profiles),'Missing explicit artifact inventories');
    equal(pidList(group.observers.map(row=>row.pid),'observer descriptors'),expected,'Owned observer is missing or foreign');
    equal(pidList(group.profiles.map(row=>row.pid),'profile descriptors'),p.cpuCapture.enabled?expected:[],'Owned CPU profile is missing or foreign');
    requireValue(allPids.size+expected.length<=LIMITS.processes,'Process count exceeds bound');
    for(const pid of expected) {requireValue(!allPids.has(pid),'PID appears in multiple capture groups');allPids.add(pid);}
    const wanted=expected.map(pid=>`worker-${pid}.jsonl`).concat(p.cpuCapture.enabled?expected.map(pid=>`worker-${pid}.cpuprofile`):[]).sort();
    equal(await reader.list(group.directory),wanted,'Actual observer directory inventory differs');
    const byPid=new Map();
    for(const item of group.observers) {
      const name=group.directory+`/worker-${item.pid}.jsonl`;byPid.set(item.pid,parseObserver(await reader.read(name,item.sha256,LIMITS.logBytes),item.pid));
    }
    const parentRows=byPid.get(rootPid),forks=parentRows.filter(row=>row.kind==='worker_fork'),exits=parentRows.filter(row=>row.kind==='worker_exit');
    equal(pidList(forks.map(row=>row.childPid),'actual forks'),children,'Parent fork receipts differ from independent child inventory');
    equal(pidList(exits.map(row=>row.childPid),'actual child exits'),children,'Actual exit receipts differ from independent child inventory');
    requireValue(exits.every(row=>row.code===0&&row.signal===null),'Actual child exit failed');equal(one(parentRows,'shutdown'),shutdown,'Raw shutdown differs from report');
    for(const [pid,rows] of byPid)if(pid!==rootPid) {
      requireValue(!rows.some(row=>['worker_fork','worker_exit'].includes(row.kind)),'Unsupported/unaccounted nested process group');
      // The collector also records successful shutdown in workers with no children.
      // Validate that receipt rather than treating its presence as a nested fork.
      const leaf=one(rows,'shutdown');
      requireValue(leaf.success===true&&leaf.children===0&&leaf.exited===0&&
        ['childExits','failedChildren','forced','unresolved'].every(key=>Array.isArray(leaf[key])&&leaf[key].length===0),
        'Leaf shutdown claims children or unsuccessful cleanup');
    }
    const recorded=report.profiling.observerCompletion.find(row=>row.name===group.name).events;
    requireValue(Array.isArray(recorded),'Missing observer completion receipts');
    const receiptKinds=new Set(['start','profile_started','profile_saved','flush','exit']);
    const supportedReceiptKinds=new Set([...receiptKinds,'worker_fork','worker_exit','worker_online','shutdown']);
    requireValue(recorded.every(row=>record(row)&&supportedReceiptKinds.has(row.kind)),'Unknown reported lifecycle receipt');
    // New harness revisions retain parent lifecycle receipts too. Validate every declared
    // kind, while always requiring the complete core receipts of every expected PID.
    for(const row of recorded)receiptKinds.add(row.kind);
    const sortReceipts=rows=>[...rows].sort((a,b)=>a.pid-b.pid||a.sequence-b.sequence);
    equal(sortReceipts([...byPid.values()].flat().filter(row=>receiptKinds.has(row.kind))),sortReceipts(recorded),'Raw observer completion differs from pinned run report');
    for(const pid of expected) {
      const rows=byPid.get(pid),entry=reportProfiles.get(pid),receipts=validateProcessReceipts(rows,pid,rootPid,report,entry);
      const output={pid,group:group.name,parentPid:receipts.start.parentPid,role:receipts.start.role,workerId:receipts.start.workerId,
        captureStart:receipts.start,observerCpu:sampleCpu(rows,p),profile:null};
      if(p.cpuCapture.enabled) {
        const descriptor=group.profiles.find(row=>row.pid===pid);requireValue(descriptor.sha256===entry.sha256,'Manifest profile SHA differs from report');
        const bytes=await reader.read(group.directory+`/worker-${pid}.cpuprofile`,descriptor.sha256,LIMITS.profileBytes);
        requireValue(bytes.length===entry.bytes&&bytes.length===receipts.saved.bytes,'Saved profile byte accounting differs');
        const result=analyzeProfile(JSON.parse(fatalUtf8.decode(bytes)),manifest.classification);
        requireValue(result.rawSampleCount===entry.samples&&result.startTime===entry.startTime&&result.endTime===entry.endTime,'Profile extent/sample accounting differs from report');
        output.profile={sha256:descriptor.sha256,bytes:bytes.length,...result};
      }
      processes.push(output);
    }
    groupResults.push({name:group.name,rootPid,expectedPids:expected,rawForkAndExitInventoryVerified:true,shutdown});
  }
  equal([...reportProfiles.keys()].sort((a,b)=>a-b),p.cpuCapture.enabled?[...allPids].sort((a,b)=>a-b):[],'Report profile inventory differs from complete worker groups');
  return {schemaVersion:1,author:AUTHOR,dataKind:manifest.dataKind,generatedAt:new Date().toISOString(),analysisRuntime:{node:process.version,platform:process.platform,arch:process.arch},
    analyzerSha256:sha256(await readFile(fileURLToPath(import.meta.url))),manifestSha256:expectedManifestSha256,
    observationStatus:manifest.dataKind==='synthetic-test'?'SYNTHETIC ONLY: no real capture observations':'Offline analysis of caller-supplied pinned capture; no service contact',
    cpuCaptureEnabled:p.cpuCapture.enabled,rawEvidence:reader.evidence,inputBytes:reader.totalBytes,
    capturePins:{gitHead:report.gitHead,runtime:report.runtime,sourceManifest:report.source,sourcePins:p.sourcePins,inputHashes:report.inputHashes,oracleHashes:report.oracleHashes,
      planSha256:report.planSha256,manifestSha256:report.manifestSha256,emission:p.pins,serviceInspections:report.inspections,limits:report.limits,
      note:'Pins are preserved from the hash-verified qualification report. This helper does not re-execute the build or independently rehash archived runtime/emission/source artifacts.'},
    workload:{prefix:p.prefix,firstBlock:p.firstBlock,sourcePacingBlocks:p.sourcePacingBlocks,emptyTargetTablePrefix:p.emptyTargetTablePrefix,
      finality:report.finality,fixture:report.limits.fixture,sourceMetrics:report.sourceMetrics,sourceRequests:report.sourceRequests,
      brokerAcks:report.brokerAcks,captureOverheadNote:p.overhead,fullRecoveryScenarioExecuted:p.fullRecoveryScenarioExecuted},
    phaseBounds:{firstReleaseAt:p.firstReleaseAt,stableAt:p.stableAt,startedAt:report.startedAt,completedAt:report.completedAt,
      evidence:manifest.phaseEvidence,physicalAndHttpStage:phase,profileTickAlignment:'Not inferred: V8 timestamps and driver wall/observer monotonic epochs are not subtracted.'},
    classification:manifest.classification,groups:groupResults,processes,
    limitations:['TimeDelta weights are sampled elapsed intervals, including idle/GC/unattributed time; they are not actual process CPU seconds.',
      'Per-PID observer CPU counters are separate process measurements. V8 profiles do not cover every native/helper thread or other services.',
      'Inclusive function totals overlap; recursion is deduplicated per sampled stack. Self category totals are exclusive; inclusive totals must not be summed.',
      'Blank URL frames are native-or-unattributed, not a native stack attribution. Unknown paths retain their original call frame.',
      'Profiles include startup, empty-target-table prefix 1-288, drain and shutdown. This does not measure row mutation/fork/restart/busy-chain performance.',
      'Existing observers/proxies and CPU sampling add unquantified overhead. No runtime ranking, improvement, selected optimization or release qualification follows.',
      'Completeness covers the declared indexer/API process families reconciled against independent parent receipts; driver, database/broker/cache and host CPU are outside these V8 families.']};
}

/** CLI output is confined to this private helper directory and created exclusively. */
export async function writeFreshAnalysis(result, outputFile) {
  const here=await realpath(dirname(fileURLToPath(import.meta.url))),path=resolve(outputFile),part=relative(here,path);
  requireValue(part&&part!=='..'&&!part.startsWith('../')&&!part.startsWith('..\\')&&!isAbsolute(part),'Analysis output must be inside the private helper folder');
  const parents=relative(here,dirname(path)).split(/[\\/]/).filter(Boolean);let parent=here;
  for(const segment of parents) {parent=join(parent,segment);const info=await lstat(parent);requireValue(info.isDirectory()&&!info.isSymbolicLink(),'Output parent must be an ordinary existing directory');}
  const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');requireValue(bytes.length<=LIMITS.outputBytes,'Analysis output exceeds bound');
  const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  return {file:part.replaceAll('\\','/'),bytes:bytes.length,sha256:sha256(bytes)};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length===5,'usage: node analyze.mjs RELATIVE_OR_ABSOLUTE_MANIFEST SHA256 NEW_OUTPUT_INSIDE_HELPER_FOLDER');
    const result=await analyzeManifest(process.argv[2],process.argv[3]),output=await writeFreshAnalysis(result,process.argv[4]);
    process.stdout.write(JSON.stringify({status:'analyzed',dataKind:result.dataKind,processes:result.processes.length,captureCommit:result.capturePins.gitHead,output})+'\n');
  } catch(error) {process.stderr.write(JSON.stringify({status:'rejected',error:String(error.message)})+'\n');process.exitCode=1;}
}
