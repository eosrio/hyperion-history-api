// Pure installed-source controls. Never import a timer-bearing native fixture/controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {posix,matchesGlob} from 'node:path';
import {runInNewContext} from 'node:vm';
import {assertRetainedProvenance} from '../../../tests/native/retained-workload-progress.mjs';
import {CURRENT_CBFB_PROFILE,HISTORICAL_SDK49_SOURCE,ROUTING,restoreSdk49Routing,sha} from './current-cbfb-contract.mjs';
import {DESCRIPTOR,assertCbfbAssembly} from './cbfb-assembly.mjs';
import {CURRENT_CBFB_MANIFEST,observeCurrentCbfbSourceOptions,assertCurrentCbfbOptions,assertCurrentCbfbDependencies} from '../../../tests/unit/current-cbfb-source-admission.mjs';
import {STATEFUL_SDK49_SOURCE_PROFILE,observeSdk49SourceOptions} from '../../../tests/unit/sdk49-indexed-source-admission.mjs';
import {admitNativeApiSourceOptions} from '../../../tests/unit/stateful-engineering-source-admission.mjs';
const root=new URL('../../../',import.meta.url),raw=path=>readFileSync(new URL(path,root),'utf8');

test('PR430 actual target and changed paths reach all required current workflow jobs',()=>{
 // Confirmed against PR430 metadata/file list at head fb891e04, base e19fc9af.
 // GitHub evaluates the complete PR diff; these are actual changed-file witnesses.
 const target='test/indexed-native-mongodb-415',changed=['.github/workflows/build.yml',
  '.github/workflows/indexed-schema-finite.yml','.github/workflows/indexed-schema-native.yml',
  'packages/backend-mongodb/src/stateful-indexed-model-v1.ts'];
 for(const [path,jobs] of [
  ['.github/workflows/build.yml',['build','projection-mongodb','operator-lists-mongodb','action-sequences-design','action-source-journal','historical-sdk49-admission','es955-fixture']],
  ['.github/workflows/indexed-schema-finite.yml',['finite-cbfb']],
  ['.github/workflows/indexed-schema-native.yml',['indexed-native']]]){
  const workflow=raw(path),start=workflow.indexOf('  pull_request:\n');assert(start>0,path+' must handle pull_request');
  const filter=workflow.slice(start+'  pull_request:\n'.length).split(/\n(?=  [A-Za-z_-]+:|[A-Za-z_-]+:)/)[0],
   branchMatch=/^    branches: (\[[^\n]+\])/m.exec(filter),branches=branchMatch?JSON.parse(branchMatch[1]):undefined,
   patterns=[...filter.matchAll(/^      - '([^']+)'$/gm)].map(match=>match[1]);
  assert(!/^    (?:branches-ignore|paths-ignore):/m.test(filter),'Review explicit exclusions before extending trigger controls');
  if(/^    branches:/m.test(filter))assert(branchMatch,'Unsupported branch filter layout');
  if(/^    paths:/m.test(filter))assert(patterns.length>0,'Unsupported path filter layout');
  assert(patterns.every(pattern=>!pattern.startsWith('!')),'Review path exclusions explicitly');
  assert(!branches||branches.includes(target),path+' must admit the actual PR430 base');
  assert(patterns.length===0||changed.some(file=>patterns.some(pattern=>matchesGlob(file,pattern))),path+' must admit actual changed paths');
  for(const job of jobs)assert(workflow.includes('\n  '+job+':\n'),path+' missing required job '+job);
  if(path.endsWith('/build.yml')){assert.equal(branches.filter(branch=>branch===target).length,1);assert(branches.includes('feat/stateful-indexed-schema-415'));}
  else assert.equal(branches,undefined,'Preserve the existing unrestricted base routing for '+path);
 }
});

for(const version of ['24.22.1','26.4.0'])test('actual CI receipt producers satisfy the unchanged retained consumer on Node '+version,()=>{
 // Model receipt inputs only. Never generate a source-admission receipt, invoke
 // the node:test workload wrapper, or set the real process's GitHub environment.
 const workflow=raw('.github/workflows/build.yml'),start=workflow.indexOf('      - name: Record the explicit current Linux assembly and actual runtime candidate\n'),
  end=workflow.indexOf('      - name: Check explicit current profile',start),producer=workflow.slice(start,end);
 assert(start>0&&end>start);assert(workflow.includes('node-version: ["24.22.1", "26.4.0"]'));
 const names=[...producer.matchAll(/ > (current-native-(git|source)-\$\{\{ matrix\.node-version \}\}\.json)$/gm)];assert.equal(names.length,2);
 const marker="          node --input-type=module <<'NODE'\n";assert.equal(producer.split(marker).length,2);
 const block=producer.split(marker)[1].split('\n          NODE\n');assert.equal(block.length,2);
 const aliasCode=block[0].split('\n').map(line=>{assert(line.startsWith('          '));return line.slice(10);}).join('\n'),
  importLine="import {copyFileSync} from 'node:fs';\n";assert.equal(aliasCode.split(importLine).length,2);
 const files=new Map(),copies=[],major=version.split('.')[0],directory='/modeled-ci',executable='/modeled/node',
  github={sha:'a'.repeat(40),runId:'modeled-run',attempt:'1',job:'build'},
  values={git:{schemaVersion:1,source:github.sha,runId:github.runId,runAttempt:github.attempt,job:github.job,trackedAndClean:true,tree:'b'.repeat(40)},
   source:{profile:CURRENT_CBFB_PROFILE,runtime:{node:'v'+version,platform:'linux',arch:'x64',executable},runtimeAcceptance:'pending'}};
 for(const [,template,kind] of names)files.set(posix.join(directory,template.replace('${{ matrix.node-version }}',version)),Buffer.from(JSON.stringify(values[kind])+'\n'));
 const wrapper=raw('tests/native/retained-workload-test.mjs'),receiptStart=wrapper.indexOf('function receipt(name){'),receiptEnd=wrapper.indexOf('export default function test(',receiptStart);
 assert(receiptStart>0&&receiptEnd>receiptStart);const readNames=[];
 const consumer=()=>runInNewContext(wrapper.slice(receiptStart,receiptEnd)+'\nprovenance();',{
  root:directory,join:posix.join,assert,sha,assertRetainedProvenance,
  lstatSync:path=>{readNames.push(path);const bytes=files.get(path);if(!bytes)throw Object.assign(new Error('Missing receipt '+path),{code:'ENOENT'});return{isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length};},
  readFileSync:path=>files.get(path),
  process:{versions:{node:version},version:'v'+version,platform:'linux',arch:'x64',execPath:executable,pid:123,ppid:120,execArgv:[],
   env:{GITHUB_ACTIONS:'true',GITHUB_SHA:github.sha,GITHUB_RUN_ID:github.runId,GITHUB_RUN_ATTEMPT:github.attempt,GITHUB_JOB:github.job}}
 });
 assert.throws(consumer,error=>error.code==='ENOENT');
 runInNewContext(aliasCode.replace(importLine,''),{process:{versions:{node:version}},copyFileSync:(from,to)=>{
  const bytes=files.get(posix.join(directory,from));assert(bytes,'Producer source must be an existing exact-version receipt');
  files.set(posix.join(directory,to),Buffer.from(bytes));copies.push({from,to});
 }});
 assert.equal(copies.length,2);
 for(const kind of ['git','source']){
  const exact=`current-native-${kind}-${version}.json`,alias=`current-native-${kind}-${major}.x.json`;
  assert(copies.some(row=>row.from===exact&&row.to===alias));assert(files.get(posix.join(directory,exact)).equals(files.get(posix.join(directory,alias))));
  assert(workflow.includes(`            current-native-${kind}-*.x.json\n`));
 }
 const result=consumer();assert.equal(result.sourceReceipt.value.source,github.sha);assert.equal(result.sourceReceipt.value.runId,github.runId);
 assert.equal(result.assemblyReceipt.runtime.node,'v'+version);assert(readNames.every(path=>path.endsWith('-'+major+'.x.json')));
 const alias=posix.join(directory,`current-native-git-${major}.x.json`),original=files.get(alias);
 files.set(alias,Buffer.from(JSON.stringify({...values.git,source:'c'.repeat(40)})));assert.throws(consumer,/Expected values to be strictly equal/);files.set(alias,original);
});

test('all current routing changes reverse to exact baseline workloads and deadlines',()=>{
 assert.equal(ROUTING.base,'2f636372bd8fe82c86ebd46179cc96fbe9d81241');assert.equal(ROUTING.historicalSdk49,HISTORICAL_SDK49_SOURCE);
 assert.equal(ROUTING.files.length,15);
 for(const row of ROUTING.files){const original=restoreSdk49Routing(row.path,raw(row.path));assert.equal(sha(original),row.historicalSha256);assert.throws(()=>restoreSdk49Routing(row.path,raw(row.path)+'\n'),/routing source differs/);}
 for(const path of ['tests/unit/wire-managed-state-v2-native.mjs','tests/unit/protocol-abi-history-native.mjs']){
  const source=raw(path);assert(source.includes('STATEFUL_CURRENT_CBFB_SOURCE_PROFILE'));assert(!source.includes('STATEFUL_SDK49_SOURCE_PROFILE'));
 }
 const workflow=raw('.github/workflows/build.yml');
 for(const command of ['current-cbfb-ci-source-check.mjs','current-cbfb-source-admission.mjs --admit-current-cbfb','current-cbfb-source-admission-native.mjs',
  'current-cbfb-source-profile.mjs','current-cbfb-codec-profile.test.mjs','npm test','stateful-complete-kind-mongodb/ci.mjs','operator-list-mongodb/ci.mjs'])assert(workflow.includes(command),command);
 assert(workflow.includes('ref: '+HISTORICAL_SDK49_SOURCE));
 assert(workflow.includes('node tests/unit/stateful-complete-kind-source-admission-native.mjs'));
 const dedicated=workflow.slice(workflow.indexOf('\n  operator-lists-mongodb:'),workflow.indexOf('\n  action-sequences-design:'));
 assert(dedicated.includes('current-cbfb-source-profile.mjs --diagnostics operator-list-assembly-${{ matrix.node-version }}'));
 assert(dedicated.indexOf('current-cbfb-source-profile.mjs --diagnostics')<dedicated.indexOf('operator-list-mongodb/ci.mjs'));
 assert(dedicated.includes('operator-list-assembly-${{ matrix.node-version }}/')&&dedicated.includes('if: always()'));
 assert(workflow.includes('HYPERION_INDEXED_TEST_PROFILE: cbfb'));
});

test('current observer independently captures split SDK sources, all emissions, scoped drivers and Wire bytes',()=>{
 const observed=observeCurrentCbfbSourceOptions({engineeringSourceProfile:CURRENT_CBFB_PROFILE});
 assert.equal(observed.profile,CURRENT_CBFB_PROFILE);assert.notEqual(observed.sdkRevision,observed.nativeSDKRevision);
 assert.equal(observed.sdkRevision,'dc20a03f2b60ba05a3369d677222a9cf0d65d299');assert.equal(observed.nativeSDKRevision,'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');
 assert.deepEqual(observed.observation,DESCRIPTOR.observation);assert.equal(observed.wireRevision,'69a66064c077a405341f5aaf15e84b88b8d86ccb');
 assert.equal(observed.wireSdkRevision,'58d68c5cea81490bbb1c9a7736d633d465bab3ef');assert(observed.wireSdkFiles.files>0);
 assert.deepEqual(Object.keys(observed.dependencies),['root:mongodb','root:bson','native:mongodb','native:bson']);
 assert.equal(observed.runtimeAcceptance,'pending');for(const value of Object.values(observed.acceptance))assert.equal(value,'pending');
 assert.throws(()=>observeSdk49SourceOptions({engineeringSourceProfile:STATEFUL_SDK49_SOURCE_PROFILE}),/routing source/);
 if(process.platform!=='linux')assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:CURRENT_CBFB_PROFILE}),/runtime platform/);
});

test('every whole driver inventory and emission tree rejects omitted, unexpected or modified bytes',()=>{
 const actual=observeCurrentCbfbSourceOptions({engineeringSourceProfile:CURRENT_CBFB_PROFILE});
 for(const name of Object.keys(actual.dependencies))for(const mutate of [x=>x[name].files.pop(),x=>x[name].files[0].sha256='0'.repeat(64),x=>x[name].files.push({...x[name].files[0],path:'unexpected'})]){
  const value=structuredClone(actual.dependencies);mutate(value);assert.throws(()=>assertCurrentCbfbDependencies(value),/scoped MongoDB\/BSON packages/);
 }
 for(const name of Object.keys(actual.observation.trees))for(const mutate of [x=>x.trees[name].pop(),x=>x.trees[name][0].sha256='f'.repeat(64)]){
  const value=structuredClone(actual.observation);mutate(value);assert.throws(()=>assertCbfbAssembly(value),/profile differs/);
 }
});

test('unknown/default/accessor options cannot become an admission or select expected bytes',()=>{
 let calls=0;
 for(const input of [{},Object.create(null),{engineeringSourceProfile:STATEFUL_SDK49_SOURCE_PROFILE},{engineeringSourceProfile:'unknown'},
  {engineeringSourceProfile:CURRENT_CBFB_PROFILE,nativeMarker:'true'},{get engineeringSourceProfile(){calls++;return CURRENT_CBFB_PROFILE;}},
  {engineeringSourceProfile:CURRENT_CBFB_PROFILE,expectedSha256:'0'.repeat(64)}])assert.throws(()=>assertCurrentCbfbOptions(input));
 assert.equal(calls,0);assert.deepEqual(assertCurrentCbfbOptions({engineeringSourceProfile:CURRENT_CBFB_PROFILE,nativeMarker:false}),{nativeMarker:false});
 assert.equal(CURRENT_CBFB_MANIFEST.routeSources.length,41);
});
