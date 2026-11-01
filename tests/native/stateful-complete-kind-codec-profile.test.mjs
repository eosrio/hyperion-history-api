// Pure installed-source admission checks: no child process, temporary copy or service.
import assert from 'node:assert/strict';
import test from 'node:test';
import {admitNativeApiSourceOptions,admitCoordinatedNativeSourceOptions,STATEFUL_SDK49_SOURCE_PROFILE as profile,
 STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE as priorTrace,STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE as priorCleanup,
 STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE as priorSnapshot,STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE as priorCurrent,
 STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE as priorCodec,STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE as metadata,
 STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as first,STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as commands,
 STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as executor} from '../unit/stateful-engineering-source-admission.mjs';
import {ASSEMBLY} from '../../scripts/qualification/indexed-schema-mongodb/assembly.mjs';
import {assertSdk49Options,assertSdk49Dependencies,assertSdk49Runtime,observeSdk49SourceOptions} from '../unit/sdk49-indexed-source-admission.mjs';

test('SDK49 captures complete pinned source, SDK, native, Wire and dependency inventories before platform admission',()=>{
 const options={engineeringSourceProfile:profile},observed=observeSdk49SourceOptions(options);
 const actual=process.platform==='linux'?admitNativeApiSourceOptions(options):observed;
 assert.equal(actual.profile,profile);assert.equal(actual.qualificationOnly,true);assert.equal(actual.wireRevision,'69a66064c077a405341f5aaf15e84b88b8d86ccb');
 assert.equal(actual.sdkRevision,'dc20a03f2b60ba05a3369d677222a9cf0d65d299');assert.equal(actual.nativeSDKRevision,actual.sdkRevision);
 assert.equal(actual.wireSdkRevision,'58d68c5cea81490bbb1c9a7736d633d465bab3ef');assert.deepEqual(actual.observation.trees,ASSEMBLY.trees);
 assert.deepEqual(actual.observation.sources,ASSEMBLY.sources);assert.deepEqual(actual.observation.pins,ASSEMBLY.pins);
 assert.equal(actual.dependencies['root:mongodb'].version,'7.2.0');assert.equal(actual.dependencies['native:mongodb'].version,'7.2.0');
 assert.equal(actual.dependencies['root:bson'].version,'7.2.0');assert.equal(actual.dependencies['native:bson'].version,'7.3.3');
 assert.equal(actual.runtimeAcceptance,'pending');
 if(process.platform==='linux')assert.deepEqual(admitCoordinatedNativeSourceOptions(options),actual);
 else assert.throws(()=>admitCoordinatedNativeSourceOptions(options),/runtime platform/);
});
test('explicit selection and every scoped dependency inventory fail closed',()=>{
 let accessed=0;
 for(const input of [{},{engineeringSourceProfile:'unknown'},{engineeringSourceProfile:profile,nativeMarker:'true'},
  {get engineeringSourceProfile(){accessed++;return profile;}},{engineeringSourceProfile:profile,extra:true}])assert.throws(()=>assertSdk49Options(input));
 assert.equal(accessed,0);assert.deepEqual(assertSdk49Options({engineeringSourceProfile:profile,nativeMarker:false}),{nativeMarker:false});
 const actual=observeSdk49SourceOptions({engineeringSourceProfile:profile}).dependencies;
 for(const name of ['root:mongodb','root:bson','native:mongodb','native:bson'])for(const mutation of [
  value=>value[name].version='0.0.0',value=>value[name].files[0].sha256='0'.repeat(64),
  value=>value[name].files.pop(),value=>value[name].files.push({...value[name].files[0],path:'unexpected'})]){
  const value=structuredClone(actual);mutation(value);assert.throws(()=>assertSdk49Dependencies(value),/scoped MongoDB\/BSON packages/);
 }
});
test('Linux runtime admission uses reviewed executable identities and retains the separate 26.13 candidate',()=>{
 const base={platform:'linux',arch:'x64',node:'v24.22.1',sha256:'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'};
 assert.deepEqual(assertSdk49Runtime(base),{engineeringRuntimeCandidate:false,runtimeAcceptance:'pending'});
 assert.deepEqual(assertSdk49Runtime({...base,node:'v26.13.0',sha256:'a'.repeat(64)}),{engineeringRuntimeCandidate:true,runtimeAcceptance:'pending'});
 for(const value of [{...base,platform:'win32'},{...base,arch:'arm64'},{...base,node:'v24.19.0'},{...base,sha256:'a'.repeat(64)}])assert.throws(()=>assertSdk49Runtime(value));
});
test('historical complete-kind profiles remain frozen and refuse the installed SDK49 assembly',()=>{
 for(const prior of [priorTrace,priorCleanup,priorSnapshot,priorCurrent])
  assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:prior}),/Git-LF helper/);
 assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:priorCodec}),/Unqualified coordinated lock source/);
 for(const prior of [first,commands,executor,metadata])assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:prior}),/Wire source revision/);
});
