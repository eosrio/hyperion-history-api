// Pure installed-source controls. Never import a timer-bearing native fixture/controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {posix,matchesGlob} from 'node:path';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {assertRetainedProvenance} from '../../../tests/native/retained-workload-progress.mjs';
import {ALL_CBFB_PROFILE,HISTORICAL_SDK49_SOURCE,ROUTING,restoreMixedRouting,restoreSdk49Routing,sha} from './all-cbfb-contract.mjs';
import {DESCRIPTOR,assertAllCbfbAssembly} from './all-cbfb-assembly.mjs';
import {ALL_CBFB_MANIFEST,observeAllCbfbSourceOptions,assertAllCbfbOptions,assertAllCbfbDependencies} from '../../../tests/unit/all-cbfb-source-admission.mjs';
import {STATEFUL_SDK49_SOURCE_PROFILE,observeSdk49SourceOptions} from '../../../tests/unit/sdk49-indexed-source-admission.mjs';
import {admitNativeApiSourceOptions} from '../../../tests/unit/stateful-engineering-source-admission.mjs';
const root=new URL('../../../',import.meta.url),raw=path=>readFileSync(new URL(path,root),'utf8');

test('actual Bun wrapper accepts the successor complete 54-check result without changing child or test budgets',async()=>{
 const path='tests/unit/stateful-engineering-source-admission.test.ts',source=raw(path).replace(/^import [^\n]+\n/gm,'')
  .replaceAll('import.meta.url',JSON.stringify(new URL(path,root).href));let completion;
 const report={cases:54,sealedEngineeringOption:true,default716Preserved:true,artifactAndSourceSetChecked:true,
  unknownRevisionPackageTreeArtifactRefused:true,defaultOverrideRefusedBeforeEffects:true,services:false,defaultDistributionQualified:false,launchQualified:false};
 runInNewContext(source,{URL,fileURLToPath,Response,process:{env:{}},
  test:(_name,run,timeout)=>{assert.equal(timeout,65000);completion=run();},
  Bun:{spawn:(argv,options)=>{assert(argv[1].endsWith('all-cbfb-source-admission-native.mjs'));assert.equal(options.timeout,60000);
   return{exited:Promise.resolve(0),stdout:Buffer.from(JSON.stringify(report)),stderr:Buffer.alloc(0)};}},
  expect:value=>({toEqual:expected=>assert.deepEqual(value,expected),toBe:expected=>assert.equal(value,expected)})
 });
 assert(completion);await completion;
});

test('standalone CBFB packed consumer explicitly selects its profile for every child without external environment help',()=>{
 const source=raw('scripts/check-indexed-cbfb-package.mjs'),start=source.indexOf('env={'),end=source.indexOf('\nasync function run(',start);
 assert(start>0&&end>start);
 for(const profile of [undefined,'sdk49']){
  const environment={PATH:'/modeled/bin',NODE_OPTIONS:'modeled-old-options',NODE_PATH:'modeled-old-path',...(profile?{HYPERION_INDEXED_TEST_PROFILE:profile}:{})};
  const result=runInNewContext('const '+source.slice(start,end)+'\nenv;',{process:{env:environment,execPath:'/modeled/node'},dirname:posix.dirname,delimiter:':'});
  assert.equal(result.HYPERION_INDEXED_TEST_PROFILE,'cbfb');assert.equal(result.NODE_OPTIONS,undefined);assert.equal(result.NODE_PATH,undefined);
  assert.equal(environment.HYPERION_INDEXED_TEST_PROFILE,profile,'The parent environment is unchanged');
 }
});

// PR430 historical route remains covered. PR440 metadata is verified at head3b04/baseC1.
// GitHub evaluates the complete PR diff; each cohort uses its actual changed-file witnesses.
for(const {pr,target,changed}of [
 {pr:430,target:'test/indexed-native-mongodb-415',changed:['.github/workflows/build.yml',
  '.github/workflows/indexed-schema-finite.yml','.github/workflows/indexed-schema-native.yml','packages/backend-mongodb/src/stateful-indexed-model-v1.ts']},
 {pr:440,target:'feat/indexed-int64-tested-49dfe-20261104',changed:['.github/workflows/build.yml',
  '.github/workflows/indexed-schema-finite.yml','.github/workflows/indexed-schema-native.yml','package.json']}
])test('PR'+pr+' actual target and changed paths reach all required current workflow jobs',()=>{
 for(const [path,jobs] of [
  ['.github/workflows/build.yml',['build','projection-mongodb','operator-lists-mongodb','action-sequences-design','action-source-journal','historical-mixed-cbfb-admission','historical-sdk49-admission','es955-fixture']],
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
  assert(!branches||branches.includes(target),path+' must admit the actual PR'+pr+' base');
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
   source:{profile:ALL_CBFB_PROFILE,runtime:{node:'v'+version,platform:'linux',arch:'x64',executable},runtimeAcceptance:'pending'}};
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

test('all-CBFB shipping routes reverse to the actual frozen mixed checkout and original SDK49 bodies',()=>{
 assert.equal(ROUTING.base,'c1b98a52a872b6c070ada32243c8286607e86883');
 assert.equal(ROUTING.files.length,19);
 for(const row of ROUTING.files){assert.equal(restoreMixedRouting(row.path,raw(row.path)),row.historicalSource);assert.equal(sha(row.historicalSource),row.historicalSha256);assert.throws(()=>restoreMixedRouting(row.path,raw(row.path)+'\n'),/routing source differs/);restoreSdk49Routing(row.path,raw(row.path));}
 for(const path of ['tests/unit/wire-managed-state-v2-native.mjs','tests/unit/protocol-abi-history-native.mjs','tests/fixtures/portable-mapping-retry.mjs'])assert(raw(path).includes('STATEFUL_ALL_CBFB_SOURCE_PROFILE'));
 const workflow=raw('.github/workflows/build.yml'),active=workflow.slice(0,workflow.indexOf('  historical-mixed-cbfb-admission:'));
 const main=workflow.slice(workflow.indexOf('\n  build:'),workflow.indexOf('\n  projection-mongodb:'));assert.match(main,/^    strategy:\n      fail-fast: false\n      matrix:\n        node-version: \["24\.22\.1", "26\.4\.0"\]/m,'Each actual Node major must retain its independent full-build outcome');
 for(const command of ['all-cbfb-ci-source-check.mjs','all-cbfb-source-admission.mjs --admit-all-cbfb','all-cbfb-source-admission-native.mjs','all-cbfb-source-profile.mjs','all-cbfb-codec-profile.test.mjs','npm test','stateful-complete-kind-mongodb/ci.mjs','operator-list-mongodb/ci.mjs'])assert(active.includes(command),command);
 assert(!active.includes('current-cbfb-'),'Active shipping jobs must not dispatch the mixed profile');
 assert(workflow.includes('ref: '+ROUTING.base));assert(workflow.includes('ref: '+HISTORICAL_SDK49_SOURCE));
 const historical=workflow.slice(workflow.indexOf('  historical-mixed-cbfb-admission:'),workflow.indexOf('  historical-sdk49-admission:'));
 for(const family of ['current-cbfb-contract.test.mjs','current-cbfb-codec-profile.test.mjs','current-cbfb-source-tamper.test.mjs','current-cbfb-caller-routing.test.mjs','current-cbfb-source-admission-native.mjs'])assert(historical.includes(family));
 assert(!historical.includes('GITHUB_SHA:'),'Historical checkout never impersonates current workflow source');
 const dedicated=active.slice(active.indexOf('\n  operator-lists-mongodb:'),active.indexOf('\n  action-sequences-design:'));
 assert(dedicated.indexOf('all-cbfb-source-profile.mjs --diagnostics')<dedicated.indexOf('operator-list-mongodb/ci.mjs'));
 assert(dedicated.includes('operator-list-assembly-${{ matrix.node-version }}/')&&dedicated.includes('if: always()'));
 assert(workflow.includes('HYPERION_INDEXED_TEST_PROFILE: cbfb'));
 for(const path of ['.github/workflows/indexed-schema-native.yml','.github/workflows/indexed-schema-finite.yml']){
  const dedicated=raw(path);assert(dedicated.includes('all-cbfb-assembly.mjs --profile indexed-schema-all-cbfb-root-native-wire69-engineering-v1'));assert(dedicated.includes('npm run test:indexed:finite'));assert(dedicated.includes('npm run test:indexed:cbfb:package'));
  if(path.includes('native'))assert(dedicated.includes('all-cbfb-native-ci.mjs --profile indexed-schema-mongodb-all-cbfb-linux-gha-v1'));
 }
});

test('current observer independently captures split SDK sources, all emissions, scoped drivers and Wire bytes',()=>{
 const observed=observeAllCbfbSourceOptions({engineeringSourceProfile:ALL_CBFB_PROFILE});
 assert.equal(observed.profile,ALL_CBFB_PROFILE);assert.equal(observed.sdkRevision,observed.nativeSDKRevision);
 assert.equal(observed.sdkRevision,'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');assert.equal(observed.nativeSDKRevision,'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');
 assert.deepEqual(observed.observation,DESCRIPTOR.observation);assert.equal(observed.wireRevision,'69a66064c077a405341f5aaf15e84b88b8d86ccb');
 assert.equal(observed.wireSdkRevision,'58d68c5cea81490bbb1c9a7736d633d465bab3ef');assert(observed.wireSdkFiles.files>0);
 assert.deepEqual(Object.keys(observed.dependencies),['root:mongodb','root:bson','native:mongodb','native:bson']);
 assert.equal(observed.runtimeAcceptance,'pending');for(const value of Object.values(observed.acceptance))assert.equal(value,'pending');
 assert.throws(()=>observeSdk49SourceOptions({engineeringSourceProfile:STATEFUL_SDK49_SOURCE_PROFILE}),/routing source/);
 if(process.platform!=='linux')assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:ALL_CBFB_PROFILE}),/runtime platform/);
});

test('every whole driver inventory and emission tree rejects omitted, unexpected or modified bytes',()=>{
 const actual=observeAllCbfbSourceOptions({engineeringSourceProfile:ALL_CBFB_PROFILE});
 for(const name of Object.keys(actual.dependencies))for(const mutate of [x=>x[name].files.pop(),x=>x[name].files[0].sha256='0'.repeat(64),x=>x[name].files.push({...x[name].files[0],path:'unexpected'})]){
  const value=structuredClone(actual.dependencies);mutate(value);assert.throws(()=>assertAllCbfbDependencies(value),/scoped MongoDB\/BSON packages/);
 }
 for(const name of Object.keys(actual.observation.trees))for(const mutate of [x=>x.trees[name].pop(),x=>x.trees[name][0].sha256='f'.repeat(64)]){
  const value=structuredClone(actual.observation);mutate(value);assert.throws(()=>assertAllCbfbAssembly(value),/assembly differs/);
 }
});

test('unknown/default/accessor options cannot become an admission or select expected bytes',()=>{
 let calls=0;
 for(const input of [{},Object.create(null),{engineeringSourceProfile:STATEFUL_SDK49_SOURCE_PROFILE},{engineeringSourceProfile:'unknown'},
  {engineeringSourceProfile:ALL_CBFB_PROFILE,nativeMarker:'true'},{get engineeringSourceProfile(){calls++;return ALL_CBFB_PROFILE;}},
  {engineeringSourceProfile:ALL_CBFB_PROFILE,expectedSha256:'0'.repeat(64)}])assert.throws(()=>assertAllCbfbOptions(input));
 assert.equal(calls,0);assert.deepEqual(assertAllCbfbOptions({engineeringSourceProfile:ALL_CBFB_PROFILE,nativeMarker:false}),{nativeMarker:false});
 assert.equal(ALL_CBFB_MANIFEST.routeSources.length,58);
});

test('normal root install owns native dependency installation before build and current CI uses that supported path',()=>{
 const pkg=JSON.parse(raw('package.json'));assert.equal(pkg.scripts.postinstall,'npm ci --prefix packages/backend-mongodb && npm run build && npm run fix-permissions');
 const full=raw('.github/workflows/build.yml'),job=name=>{const start=full.indexOf('\n  '+name+':\n');assert(start>0);return full.slice(start+1).split(/\n(?=  [a-z][a-z0-9-]*:)/)[0];};
 for(const [name,source]of [...['build','projection-mongodb','operator-lists-mongodb','action-source-journal'].map(name=>[name,job(name)]),...['.github/workflows/indexed-schema-finite.yml','.github/workflows/indexed-schema-native.yml','.github/workflows/atomic-managed.yml'].map(path=>[path,raw(path)])]){
  const install=source.indexOf('npm ci --allow-git=all');assert(install>=0,name+' must use normal root installation with lifecycle scripts');
  const admission=source.search(/node (?:scripts\/qualification\/indexed-schema-mongodb\/all-cbfb-(?:ci-source-check|assembly)|scripts\/qualification\/operator-list-mongodb\/all-cbfb-source-profile|scripts\/qualification\/atomic-managed\/ci)/);assert(admission>install,name+' must install before admission');
  assert(!source.slice(install,admission).includes('npm ci --prefix packages/backend-mongodb'),name+' must qualify the automatically installed native scope');
 }
});

test('managed Atomic and indexed native workflows select the same explicit Ubuntu22 cohort',()=>{
 const runner=path=>/^    runs-on: ([A-Za-z0-9_.-]+)$/m.exec(raw(path))?.[1];
 assert.equal(runner('.github/workflows/atomic-managed.yml'),'ubuntu-22.04');
 assert.equal(runner('.github/workflows/indexed-schema-native.yml'),'ubuntu-22.04');
});
