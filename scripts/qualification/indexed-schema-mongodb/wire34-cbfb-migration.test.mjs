// Pure source/route controls. Never import a native controller or runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PLAN,sha} from './wire34-cbfb-native-contract.mjs';
import {PLAN as priorPlan} from './all-cbfb-native-contract.mjs';
import {admitAllCbfbAssembly,observeAllCbfbAssembly,assertAllCbfbAssembly} from './all-cbfb-assembly.mjs';
import {admitWire34CbfbAssembly,observeWire34CbfbAssembly,assertWire34CbfbAssembly,PROFILE} from './wire34-cbfb-assembly.mjs';
import {NATIVE_PROFILE} from './wire34-cbfb-native-assembly.mjs';
import {assertWire34SourceCensus} from './wire34-cbfb-assembly.mjs';
import {WIRE34_CBFB_MANIFEST} from '../../../tests/unit/wire34-cbfb-source-admission.mjs';
const read=name=>readFileSync(new URL('./'+name,import.meta.url),'utf8');
const preserved=JSON.parse(read('wire34-cbfb-preserved.json'));
test('frozen Wire69 modules, profiles and source predicates retain every original byte',()=>{
 assert.equal(preserved.files.length,19);
 for(const row of preserved.files){const bytes=readFileSync(new URL('../../../'+row.path,import.meta.url));assert.equal(bytes.length,row.bytes,row.path);assert.equal(sha(bytes),row.sha256,row.path);}
});
test('current Wire34 graph is admitted separately and every frozen Wire69 gate still refuses it',()=>{
 const observed=observeWire34CbfbAssembly();assert.equal(observed.profile,PROFILE);assert.equal(observed.pins.Wire,'git+https://github.com/eosrio/hyperion-wire-plugin.git#1e7547ff52740ecaa88d7867d3ec887a2febaa58');
 assertWire34CbfbAssembly(observed);assert.throws(()=>assertAllCbfbAssembly(observeAllCbfbAssembly()),/Exact all-CBFB/);assert.throws(()=>admitAllCbfbAssembly(),/Exact all-CBFB/);
 const actual=admitWire34CbfbAssembly();assert.equal(actual.wireSource.wireRevision,'1e7547ff52740ecaa88d7867d3ec887a2febaa58');assert.equal(actual.wireSource.sourceAcceptance,'pending');assert.equal(actual.integratedNativeMongo,'pending');
 for(const mutate of [x=>x.pins.Wire=x.pins.Wire.replace('1e7547ff52740ecaa88d7867d3ec887a2febaa58','69a66064c077a405341f5aaf15e84b88b8d86ccb'),x=>x.sources.pop(),x=>x.trees.rootSDK.pop()]){const value=structuredClone(observed);mutate(value);assert.throws(()=>assertWire34CbfbAssembly(value));}
});
test('Wire34 native namespace changes only explicit imports, profile identity and runner path',()=>{
 for(const name of ['runner','ci','contract']){
  const current=read('wire34-cbfb-native-'+name+'.mjs'),original=read('all-cbfb-native-'+name+'.mjs');
  const restored=current.replaceAll('./wire34-cbfb-native-','./all-cbfb-native-').replaceAll('indexed-schema-mongodb-wire34-cbfb-linux-gha-v1','indexed-schema-mongodb-all-cbfb-linux-gha-v1');
  assert.equal(restored,original,'Every original native assertion/case/lifecycle operation is preserved: '+name);
 }
 assert.deepEqual({...PLAN,profile:priorPlan.profile},priorPlan);assert.equal(PLAN.cases.length,12);assert.equal(PLAN.fixture.childDeadlineMS,300000);
});
test('active finite/native jobs change only declared profile routes and teardown source selections',()=>{
 for(const [path,original] of Object.entries(preserved.workflowSources)){
  let current=readFileSync(new URL('../../../'+path,import.meta.url),'utf8');
  current=current.replace(/      - run: \|\n          mkdir -p out\n          node ([^\n]+)\n/g,'      - run: node $1\n').replaceAll('out/indexed-wire34-cbfb','indexed-cbfb').replaceAll('indexed-wire34-cbfb','indexed-cbfb');
  current=current.replaceAll(' scripts/qualification/indexed-schema-mongodb/wire34-cbfb-migration.test.mjs','');
  if(path.includes('native'))current=current.replace("      - env:\n          HYPERION_NATIVE_RUNNER_SOURCE: scripts/qualification/indexed-schema-mongodb/wire34-cbfb-native-runner.mjs\n          HYPERION_NATIVE_CONTROLLER_SOURCE: scripts/qualification/indexed-schema-mongodb/wire34-cbfb-native-ci.mjs\n        run: node --test",'      - run: node --test');
  current=current.replaceAll('wire34-cbfb-assembly.mjs --profile indexed-schema-all-cbfb-root-native-wire34-engineering-v1','all-cbfb-assembly.mjs --profile indexed-schema-all-cbfb-root-native-wire69-engineering-v1')
   .replaceAll('wire34-cbfb-assembly.test.mjs','all-cbfb-assembly.test.mjs').replaceAll('wire34-cbfb-native-offline.test.mjs','all-cbfb-native-offline.test.mjs')
   .replaceAll('wire34-cbfb-native-ci.mjs --profile indexed-schema-mongodb-wire34-cbfb-linux-gha-v1','all-cbfb-native-ci.mjs --profile indexed-schema-mongodb-all-cbfb-linux-gha-v1');
  assert.equal(current,original,path);assert(!current.includes('continue-on-error'));
 }
});
test('new native route capture and static closure make only the existing two global hash-cycle exceptions',()=>{
 const routes=JSON.parse(read('wire34-cbfb-native-routes.json'));assert.equal(routes.routeSources.length,58);
 for(const row of routes.routeSources){const bytes=readFileSync(new URL('../../../'+row.path,import.meta.url));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);}
 assert.equal(NATIVE_PROFILE.sourceClosure.inputs.manifestPath,'scripts/qualification/indexed-schema-mongodb/wire34-cbfb-native-routes.json');
 const globals=NATIVE_PROFILE.sourceClosure.inputs.selfPaths.filter(path=>path.includes('wire34')&&!path.endsWith('wire34-cbfb-native-profile.json'));
 assert.deepEqual(globals,['tests/fixtures/engineering-profiles/wire34-cbfb-linux.json','tests/unit/wire34-cbfb-source-admission.mjs']);
 assert(NATIVE_PROFILE.sourceClosure.inputs.seeds.includes('scripts/qualification/indexed-schema-mongodb/wire34-cbfb-native-runner.mjs'));
 assert(NATIVE_PROFILE.sourceClosure.inputs.seeds.includes('scripts/qualification/indexed-schema-mongodb/wire34-cbfb-native-ci.mjs'));
});
test('actual census contract refuses mismatched source, incomplete inventories and foreign job identity',()=>{
 const environment={GITHUB_ACTIONS:'true',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'indexed-native'};
 const value={schemaVersion:1,qualificationOnly:true,trackedAndClean:true,source:environment.GITHUB_SHA,tree:'b'.repeat(40),files:WIRE34_CBFB_MANIFEST.sources.trackedPaths.length,hashedFiles:WIRE34_CBFB_MANIFEST.sources.files.length,passivePaths:WIRE34_CBFB_MANIFEST.sources.nonExecutionTrackedPaths.length,runId:'42',runAttempt:'1',job:'indexed-native',workloadAcceptance:'pending'};
 assert.equal(assertWire34SourceCensus(value,environment),value);
 for(const change of [{source:'f'.repeat(40)},{tree:'not-a-tree'},{files:value.files+1},{hashedFiles:value.hashedFiles-1},{passivePaths:value.passivePaths+1},{trackedAndClean:false},{runId:'other'},{runAttempt:'2'},{job:'other'},{workloadAcceptance:'passed'}])assert.throws(()=>assertWire34SourceCensus({...value,...change},environment));
 assert.throws(()=>assertWire34SourceCensus(value,{...environment,GITHUB_ACTIONS:'false'}));
 const native=read('wire34-cbfb-native-assembly.mjs'),controller=read('wire34-cbfb-native-ci.mjs');assert(native.includes('sourceCensus=readWire34SourceCensus()'));assert(controller.indexOf('report.assembly=admitNativeAssembly')<controller.indexOf('fixture=new OwnedMongoFixture'));
});
