// Pure route/source controls. Never import either physical controller or runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PLAN,PROFILE,sha,argumentsFor} from '../../scripts/qualification/atomic-managed-wire34-cbfb/contract.mjs';
import {PLAN as historicalPlan,PROFILE as historicalProfile} from '../../scripts/qualification/atomic-managed/contract.mjs';
import {observeManagedAssembly,assertManagedAssembly} from '../../scripts/qualification/atomic-managed-wire34-cbfb/assembly.mjs';
import {observeManagedAssembly as observeHistorical,assertManagedAssembly as assertHistorical} from '../../scripts/qualification/atomic-managed/assembly.mjs';

const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const routing=JSON.parse(read('scripts/qualification/atomic-managed-wire34-cbfb/preserved-routing.json'));

test('thirteen frozen managed files remain exact while the authorized historical workflow trigger alone is retired',()=>{
 assert.equal(routing.files.length,14);assert.equal(routing.routes.length,12);
 assert.equal(new Set(routing.files.map(row=>row.path)).size,routing.files.length);
 for(const row of routing.files){
  if(row.path===routing.authorizedHistoricalWorkflowException.path){
   const exception=routing.authorizedHistoricalWorkflowException,selected=read(row.path);assert.equal(exception.historicalSha256,row.sha256);assert.equal(sha(exception.historicalSource),row.sha256);
   assert.equal(sha(selected),exception.selectedSha256);assert.equal(selected.slice(selected.indexOf('jobs:\n')),exception.historicalSource.slice(exception.historicalSource.indexOf('jobs:\n')));
   assert(!selected.includes('  pull_request:'));assert(selected.includes('  workflow_dispatch:'));assert(selected.includes(exception.immutableGitRef));
  }else{const bytes=readFileSync(new URL('../../'+row.path,import.meta.url));assert.equal(bytes.length,row.bytes,row.path);assert.equal(sha(bytes),row.sha256,row.path);}
 }
});

test('every successor executable/control/workflow differs only by its complete declared reversible routing edits',()=>{
 for(const row of routing.routes){
  let selected=row.historicalPath===routing.authorizedHistoricalWorkflowException.path?routing.authorizedHistoricalWorkflowException.historicalSource:read(row.historicalPath);assert.equal(sha(selected),row.historicalSha256,row.historicalPath);
  for(const edit of row.changes){assert.equal(selected.split(edit.historical).length-1,edit.count,row.currentPath);selected=selected.split(edit.historical).join(edit.current);}
  assert.equal(selected,read(row.currentPath),'Undeclared workload/assertion/deadline/cleanup edit: '+row.currentPath);
 }
 assert.deepEqual({...PLAN,profile:historicalPlan.profile},historicalPlan);
 assert.equal(PLAN.atomic.commit,'1bc686bd7ed7d433b2cb7c3a04a762c0c832ad97');
 assert.equal(PLAN.fixture.childDeadlineMS,300000);assert.equal(PLAN.acceptance.WireAuthority,'none');assert.equal(PLAN.acceptance.fullAtomicParity,'pending');
});

test('current managed source inventory explicitly admits Wire34 and never relabels the frozen Wire69 assembly',()=>{
 const observation=observeManagedAssembly(process.env.HYPERION_ATOMIC_ROOT);assertManagedAssembly(observation);
 assert.equal(PROFILE,'managed-atomic77-hapi-wire34-cbfb-linux-engineering-v1');
 assert.equal(observation.api.pins.Wire,'git+https://github.com/eosrio/hyperion-wire-plugin.git#1e7547ff52740ecaa88d7867d3ec887a2febaa58');
 assert.equal(observation.api.pins.rootSDK,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk.root);
 assert.equal(observation.api.pins.nativeSDK,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk.native);
 assert.throws(()=>assertHistorical(observeHistorical(process.env.HYPERION_ATOMIC_ROOT)),/Exact all-CBFB managed assembly differs/);
 for(const mutate of [
  value=>value.api.pins.Wire=value.api.pins.Wire.replace('1e7547ff52740ecaa88d7867d3ec887a2febaa58','69a66064c077a405341f5aaf15e84b88b8d86ccb'),
  value=>value.packages.wire.dist.pop(),value=>value.packages.wire.sdk.pop(),value=>value.atomic.commit='f'.repeat(40),
  value=>value.atomic.sources.harness.pop(),value=>value.harness.pop(),value=>value.controls.pop(),value=>value.closure.edges.pop()
 ]){const changed=structuredClone(observation);mutate(changed);assert.throws(()=>assertManagedAssembly(changed),/Exact all-CBFB managed assembly differs/);}
});

test('selected Wire34 source and clean complete Git census both precede managed fixture/client effects',()=>{
 const assembly=read('scripts/qualification/atomic-managed-wire34-cbfb/assembly.mjs'),ci=read('scripts/qualification/atomic-managed-wire34-cbfb/ci.mjs'),runner=read('scripts/qualification/atomic-managed-wire34-cbfb/runner.mjs');
 assert(assembly.includes('wireSource=admitWire34CbfbAssembly(),sourceCensus=readWire34SourceCensus()'));
 assert(assembly.includes("assert.equal(wireSource.wireSource.wireRevision,'1e7547ff52740ecaa88d7867d3ec887a2febaa58')"));
 assert(ci.indexOf('report.assembly=admitManagedAssembly(atomicRoot)')<ci.indexOf('fixture=new OwnedMongoFixture()'));
 assert(runner.indexOf('admitManagedAssembly(options.atomicRoot)')<runner.indexOf('new MongoClient('));
 assert(assembly.indexOf("assert.equal(process.platform,'linux')")<assembly.indexOf('wireSource=admitWire34CbfbAssembly()'));
 assert(assembly.includes('runtime,observation,wireSource:wireSource.wireSource,sourceCensus'));
 const selected=read('.github/workflows/atomic-managed-wire34-cbfb.yml');
 assert(selected.includes('--profile '+PROFILE));assert(selected.includes('ref: '+PLAN.atomic.commit));assert(selected.includes('ref: '+PLAN.mixedHistoricalSource));
 assert(selected.includes('tests/native/atomic-managed-wire34-cbfb-migration.test.mjs'));assert(!selected.includes('continue-on-error'));
 const args=['--profile',historicalProfile,'--database','h45_indexed_123456abcdef','--output','/owned/evidence','--source','a'.repeat(40),'--assembly-sha256','b'.repeat(64),'--atomic-root','/owned/atomic','--replica-set','h45rs_'+'c'.repeat(32)];
 assert.throws(()=>argumentsFor(args,{HYPERION_MANAGED_ATOMIC_MONGO_URI:'mongodb://127.0.0.1:32001/?directConnection=true&replicaSet=h45rs_'+'c'.repeat(32)}));
});

test('managed inventory closes its whole harness and controls while retaining only the same two global cycle exceptions',()=>{
 const profile=JSON.parse(read('scripts/qualification/atomic-managed-wire34-cbfb/profile.json')),observed=profile.observation;
 assert.deepEqual(observed.harness.map(row=>row.path).sort(),['README.md','assembly.mjs','ci.mjs','contract.mjs','driver.mjs','host.mjs','preserved-routing.json','runner.mjs']);
 assert.equal(observed.controls.length,8);
 assert.deepEqual(observed.controls.map(row=>row.path).sort(),[
  '.github/workflows/atomic-managed-wire34-cbfb.yml',
  ...['contract','host-publication','migration','result-observer','sdk-boundary','teardown'].map(name=>'tests/native/atomic-managed-wire34-cbfb-'+name+'.test.mjs'),
  'tests/native/wire34-parent-integration.test.mjs'
 ].sort());
 const files=new Set(observed.closure.files.map(row=>row.path));
 for(const name of ['assembly','ci','contract','driver','host','runner'])assert(files.has('scripts/qualification/atomic-managed-wire34-cbfb/'+name+'.mjs'));
 for(const path of ['scripts/qualification/projection-fixture.mjs','scripts/qualification/stateful-complete-kind-mongodb/ci.mjs','scripts/qualification/operator-list-mongodb/contract.mjs'])assert(files.has(path),path);
 const exceptions=['tests/fixtures/engineering-profiles/wire34-cbfb-linux.json','tests/unit/wire34-cbfb-source-admission.mjs'];
 for(const path of exceptions)assert(!files.has(path));
 assert(observed.closure.edges.some(row=>row.path===exceptions[1]));
 const assembly=read('scripts/qualification/atomic-managed-wire34-cbfb/assembly.mjs');
 assert(assembly.includes('selfPaths:[PROFILE_PATH,'+exceptions.map(path=>"'"+path+"'").join(',')+']'));
 assert.equal(observed.api.profile,PROFILE);assert.equal(profile.plan.profile,PROFILE);
});
