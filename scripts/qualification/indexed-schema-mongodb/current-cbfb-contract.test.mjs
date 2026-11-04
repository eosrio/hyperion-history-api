// Pure installed-source controls. Never import a timer-bearing native fixture/controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CURRENT_CBFB_PROFILE,HISTORICAL_SDK49_SOURCE,ROUTING,restoreSdk49Routing,sha} from './current-cbfb-contract.mjs';
import {DESCRIPTOR,assertCbfbAssembly} from './cbfb-assembly.mjs';
import {CURRENT_CBFB_MANIFEST,observeCurrentCbfbSourceOptions,assertCurrentCbfbOptions,assertCurrentCbfbDependencies} from '../../../tests/unit/current-cbfb-source-admission.mjs';
import {STATEFUL_SDK49_SOURCE_PROFILE,observeSdk49SourceOptions} from '../../../tests/unit/sdk49-indexed-source-admission.mjs';
import {admitNativeApiSourceOptions} from '../../../tests/unit/stateful-engineering-source-admission.mjs';
const root=new URL('../../../',import.meta.url),raw=path=>readFileSync(new URL(path,root),'utf8');

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
