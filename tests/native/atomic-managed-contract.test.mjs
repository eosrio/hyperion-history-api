// Pure invocation/resource contracts. Never import or run the Linux controller/runner.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PROFILE,PLAN,argumentsFor,persistChildIntent,assertCompletion} from '../../scripts/qualification/atomic-managed/contract.mjs';
const hex=n=>n.toString(16).padStart(64,'0'),source='a'.repeat(40),replicaSet='h45rs_'+'b'.repeat(32),uri='mongodb://127.0.0.1:32001/?directConnection=true&replicaSet='+replicaSet,
 args=['--profile',PROFILE,'--database','h45_indexed_123456abcdef','--output','/owned/evidence','--source',source,'--assembly-sha256',hex(1),'--atomic-root','/owned/atomic','--replica-set',replicaSet],env={HYPERION_MANAGED_ATOMIC_MONGO_URI:uri};
test('only exact owned loopback CLI/replica/source inputs can form a managed child intent',()=>{
 const selected=argumentsFor(args,env);assert.equal(selected.source,source);assert.equal(selected.replicaSet,replicaSet);
 for(const change of [value=>value[1]='other',value=>value[3]='production',value=>value[7]='short',value=>value[9]='x',value=>value.push('--run')]){const value=[...args];change(value);assert.throws(()=>argumentsFor(value,env));}
 for(const bad of [uri.replace('127.0.0.1','other-host'),uri.replace('32001','27017'),uri+'&unexpected=1',uri.replace('true','false'),uri.replace('127.0.0.1','user:secret@127.0.0.1')])assert.throws(()=>argumentsFor(args,{...env,HYPERION_MANAGED_ATOMIC_MONGO_URI:bad}));
 let persisted;const intent=persistChildIntent({executable:'/reviewed/node',argv:['/owned/runner.mjs',...args],cwd:'/owned/hapi',source,runtime:{node:'v24.22.1'},limits:{assemblySha256:hex(1)},environment:env},value=>{persisted=value;});assert.equal(intent,persisted);assert.equal(intent.status,'intent-only');
 assert.throws(()=>persistChildIntent({...intent,unexpected:true},()=>{}));
});
test('a failed/timed-out child, missing cleanup or missing original oracle group can never be admitted by success metadata',()=>{
 const terminal={code:0,signal:null,timedOut:false,terminal:true,streamsClosed:true},report={status:'passed-controlled-managed-http-only',profile:PROFILE,assemblySha256:hex(1),
  result:{snapshots:Array(8).fill({}),royalty:{successes:Array(10).fill({}),refusals:Array(6).fill({}),invalidStatus:400},lateOwnerRefused:true,lateCoverageRefused:true,restoredCoverage:true},cleanup:Object.fromEntries(['httpClosed','clientsClosed','sessionsEnded','readsClosed','cursorsClosed','databaseDropped'].map(key=>[key,true])),acceptance:PLAN.acceptance,queries:18,traceEvents:180};
 assertCompletion(terminal,report,hex(1));
 for(const change of [value=>value.code=1,value=>value.timedOut=true,value=>value.streamsClosed=false]){const value={...terminal};change(value);assert.throws(()=>assertCompletion(value,report,hex(1)));}
 for(const key of Object.keys(report.cleanup)){const value=structuredClone(report);value.cleanup[key]=false;assert.throws(()=>assertCompletion(terminal,value,hex(1)));}
 for(const change of [value=>value.result.snapshots.pop(),value=>value.result.royalty.successes.pop(),value=>value.result.lateOwnerRefused=false,value=>value.acceptance.fullAtomicParity='passed']){const value=structuredClone(report);change(value);assert.throws(()=>assertCompletion(terminal,value,hex(1)));}
});
test('actual managed source entry points gate Linux and bind genuine GHA source before owned Docker/client effects',()=>{
 const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8'),ci=read('scripts/qualification/atomic-managed/ci.mjs'),runner=read('scripts/qualification/atomic-managed/runner.mjs');
 assert(ci.indexOf("assert.equal(process.platform,'linux')")<ci.indexOf('fixture=new OwnedMongoFixture()'));
 assert(ci.indexOf('report.assembly=admitManagedAssembly(atomicRoot)')<ci.indexOf('fixture=new OwnedMongoFixture()'));
 assert(ci.indexOf('assert.equal(report.checkout.commit,source)')<ci.indexOf('fixture=new OwnedMongoFixture()'));
 assert(ci.indexOf('persistChildIntent(')<ci.indexOf('child=spawn('));assert(runner.indexOf('admitManagedAssembly(options.atomicRoot)')<runner.indexOf('new MongoClient('));
 assert(ci.includes('assertCompletion(report.child,native,report.assembly.observationSha256)'));assert(ci.includes('await fixture.cleanup();assert.equal(fixture.cleanupResult.verified,true)'));
 assert(runner.includes('assert.equal(reads.size,0)'));assert(runner.includes('assert.equal(readsOpened,readsClosed)'));assert(runner.includes('verifyCursorClosure(trace)'));
});

test('actual all-CBFB observation closes complete scoped bytes and refuses changed SDK, Wire, Atomic, emitted and harness members',async()=>{
 const {observeManagedAssembly,assertManagedAssembly}=await import('../../scripts/qualification/atomic-managed/assembly.mjs'),observation=observeManagedAssembly(process.env.HYPERION_ATOMIC_ROOT);
 assert.equal(assertManagedAssembly(observation),observation);assert.equal(observation.api.pins.rootSDK,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk.root);assert.equal(observation.api.pins.nativeSDK,'git+https://github.com/eosrio/hyperion-sdk.git#'+PLAN.sdk.native);
 for(const change of [
  value=>value.packages['root:sdk'].dist[0].sha256='0'.repeat(64),value=>value.packages['native:sdk'].dist.pop(),value=>value.packages['root:mongodb'].files[0].bytes++,
  value=>value.packages['native:bson'].files.pop(),value=>value.packages.wire.sdk[0].sha256='0'.repeat(64),value=>value.api.trees.rootBuild[0].bytes++,
  value=>value.atomic.dist[0].bytes++,value=>value.atomic.sources.src[0].sha256='0'.repeat(64),value=>value.harness[0].bytes++,value=>value.controls[0].sha256='0'.repeat(64),value=>value.closure.files.pop()]){
  const changed=structuredClone(observation);change(changed);assert.throws(()=>assertManagedAssembly(changed),/Exact all-CBFB managed assembly differs/);
 }
});
