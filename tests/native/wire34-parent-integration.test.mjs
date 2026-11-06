// Pure source/provenance/custody controls. Never import a native controller, runner or worker.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PLAN} from '../../scripts/qualification/atomic-managed-wire34-cbfb/contract.mjs';
import {PLAN as priorPlan} from '../../scripts/qualification/atomic-managed/contract.mjs';
import {observeManagedAssembly,assertManagedAssembly} from '../../scripts/qualification/atomic-managed-wire34-cbfb/assembly.mjs';
import {observeWire34CbfbSourceOptions,WIRE34_CBFB_MANIFEST as manifest,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE as profile} from '../unit/wire34-cbfb-source-admission.mjs';
import {sha} from '../../scripts/qualification/wire34-cbfb/build-parent-contract.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8'),json=path=>JSON.parse(read(path));
const integration=json('scripts/qualification/wire34-cbfb/parent-integration.json'),routing=json('scripts/qualification/atomic-managed-wire34-cbfb/preserved-routing.json');

test('combined source provenance retains both reviewed immutable patches and the explicit trigger exception',()=>{
 assert.equal(integration.base,'0d29df02420fa6a3adcb5ec4a932a2efd19da44c');assert.equal(integration.sourcePatches.length,2);
 assert.deepEqual(integration.sourcePatches.map(row=>row.commit),['434d1bc6b711bb62b4835972ea6a5e46e7d6f4c8','a5a0725a2d72c3dcc29f3c8de8e0c3b01dbdf2bb']);
 for(const row of integration.sourcePatches){assert.match(row.sha256,/^[a-f0-9]{64}$/);assert(row.bytes>100000);}
 assert.equal(integration.authorization.event,'evt_20261105T035149_613e40d89553');assert(Object.values(integration.acceptance).every(value=>value==='pending'));
});

test('old managed workflow is manual-only with an exact job body and a real Wire69 historical source ref',()=>{
 const prior=integration.historicalManagedSource,exception=routing.authorizedHistoricalWorkflowException,selected=read(prior.workflow),old=exception.historicalSource;
 assert.equal(prior.commit,'7b53542111709cf8b225b381077e498e25bc5d61');assert.equal(prior.Wire,'69a66064c077a405341f5aaf15e84b88b8d86ccb');assert.equal(exception.immutableGitRef,prior.commit);
 assert.equal(sha(old),prior.originalWorkflowSha256);assert.equal(sha(selected.slice(selected.indexOf('jobs:\n'))),prior.originalJobBodySha256);
 assert.equal(selected.slice(selected.indexOf('jobs:\n')),old.slice(old.indexOf('jobs:\n')));assert(selected.includes(prior.commit));
 const trigger=selected.slice(selected.indexOf('on:\n'),selected.indexOf('jobs:\n'));assert.equal(trigger,'on:\n  workflow_dispatch:\n');
 let exact=0;for(const row of routing.files)if(row.path!==prior.workflow){const bytes=readFileSync(new URL('../../'+row.path,import.meta.url));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256,row.path);exact++;}assert.equal(exact,13);
 for(const row of manifest.preservedWire69Files)assert.equal(sha(readFileSync(new URL('../../'+row.path,import.meta.url))),row.sha256,row.path);assert.equal(manifest.preservedWire69Files.length,35);
});

test('only the new current managed workflow has automatic PR routing and its input checkouts are ignored',()=>{
 const selected=read(integration.currentManagedSource.workflow);assert(selected.includes('  pull_request:'));assert(selected.includes('  workflow_dispatch:'));assert(!selected.includes('_qualification/'));
 for(const path of integration.currentManagedSource.inputRoots){assert(selected.includes('          path: '+path+'\n'));assert(selected.includes(path));}
 const ignored=execFileSync('git',['check-ignore','--no-index',...integration.currentManagedSource.inputRoots.map(path=>path+'/.git/HEAD')],{cwd:root,encoding:'utf8'}).trim().split('\n');assert.equal(ignored.length,2);
 assert(selected.includes('ref: '+integration.currentManagedSource.atomicCommit));assert(selected.includes('ref: '+integration.currentManagedSource.mixedCommit));
 assert(selected.includes('--profile '+integration.currentManagedSource.profile+' out/wire34-managed-inputs/atomic out/managed-atomic-wire34-cbfb-'));
 assert(!selected.includes('continue-on-error'));assert.equal(selected.split('timeout-minutes: 15').length,2);assert(selected.includes('node-version: [24.22.1, 26.4.0]'));
});

test('combined whole tracked census retains exactly the existing two global cycle exceptions',()=>{
 assert.deepEqual(manifest.sources.excludedToAvoidHashCycles,integration.globalCycleExceptions);assert.equal(integration.globalCycleExceptions.length,2);
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean).sort();assert.deepEqual(tracked,manifest.sources.trackedPaths);
 const classified=[...manifest.sources.files.map(row=>row.path),...manifest.sources.excludedToAvoidHashCycles,...manifest.sources.nonExecutionTrackedPaths.map(row=>row.path)].sort();assert.deepEqual(classified,tracked);assert.equal(new Set(classified).size,tracked.length);
 const observed=observeWire34CbfbSourceOptions({engineeringSourceProfile:profile});assert.equal(observed.sourceFiles,manifest.sources.files.length);assert.equal(observed.sourceBytes,manifest.sources.totalBytes);assert.equal(observed.runtimeAcceptance,'pending');
});

test('the final global census write leaves independently observed managed metadata exact',()=>{
 const observation=observeManagedAssembly(process.env.HYPERION_ATOMIC_ROOT);assert.equal(assertManagedAssembly(observation),observation);
 const native=json('scripts/qualification/indexed-schema-mongodb/wire34-cbfb-native-profile.json');assert.deepEqual(native.sourceClosure.inputs.selfPaths.filter(path=>path.includes('wire34')&&!path.endsWith('wire34-cbfb-native-profile.json')),integration.globalCycleExceptions);
 assert.deepEqual({...PLAN,profile:priorPlan.profile},priorPlan);assert.equal(PLAN.atomic.commit,integration.currentManagedSource.atomicCommit);
});

test('actual managed admission preserves source, clean census and observation failure order before effects',()=>{
 const source=read('scripts/qualification/atomic-managed-wire34-cbfb/assembly.mjs'),start=source.indexOf('export function admitManagedAssembly(atomicRoot){');assert(start>0);
 const body=source.slice(start).replace('export function','function');
 for(const fail of [undefined,'source','census','observation']){
  const calls=[],failure=new Error(fail??'unused'),census={genuine:'modeled read-only custody'},observation={model:'source-only'};
  const scope={assert,process:{platform:'linux',arch:'x64',env:{GITHUB_ACTIONS:'true'},versions:{bun:undefined},version:'v24.22.1',execPath:'/modeled/node'},PROFILE:integration.currentManagedSource.profile,
   admitWire34CbfbAssembly:()=>{calls.push('source');if(fail==='source')throw failure;return{wireSource:{wireRevision:'1e7547ff52740ecaa88d7867d3ec887a2febaa58'}};},
   readWire34SourceCensus:()=>{calls.push('census');if(fail==='census')throw failure;return census;},observeManagedAssembly:()=>{calls.push('observation');if(fail==='observation')throw failure;return observation;},assertManagedAssembly:value=>value,
   sha:()=> 'a'.repeat(64),read:()=>Buffer.alloc(0),assertSdk49Runtime:()=>calls.push('runtime')};
  const run=new Function(...Object.keys(scope),body+'return admitManagedAssembly;')(...Object.values(scope));
  if(fail){assert.throws(()=>run('/modeled/atomic'),error=>error===failure);assert.deepEqual(calls,['source','census','observation'].slice(0,['source','census','observation'].indexOf(fail)+1));}
  else{const result=run('/modeled/atomic');assert.equal(result.sourceCensus,census);assert.equal(result.observation,observation);assert.deepEqual(calls,['source','census','observation','runtime']);}
 }
 const ci=read('scripts/qualification/atomic-managed-wire34-cbfb/ci.mjs'),runner=read('scripts/qualification/atomic-managed-wire34-cbfb/runner.mjs');assert(ci.indexOf('report.assembly=admitManagedAssembly(atomicRoot)')<ci.indexOf('fixture=new OwnedMongoFixture()'));assert(runner.indexOf('admitManagedAssembly(options.atomicRoot)')<runner.indexOf('new MongoClient('));
});
