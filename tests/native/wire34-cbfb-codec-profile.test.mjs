// Wire34 successor source/installed-byte controls. No child, timer, controller or database.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as profiles from '../unit/stateful-engineering-source-admission.mjs';
import {createHash} from 'node:crypto';
import {admitNativeApiSourceOptions,admitCoordinatedNativeSourceOptions,STATEFUL_ALL_CBFB_SOURCE_PROFILE as priorWire69,
 STATEFUL_NATIVE_CLEANUP_TRACE_API_SOURCE_PROFILE as priorTrace,STATEFUL_NATIVE_CLEANUP_API_SOURCE_PROFILE as priorCleanup,
 STATEFUL_NATIVE_SNAPSHOT_API_SOURCE_PROFILE as priorSnapshot,STATEFUL_CURRENT_NATIVE_API_SOURCE_PROFILE as priorCurrent,
 STATEFUL_COMPLETE_KIND_CODEC_API_SOURCE_PROFILE as priorCodec,STATEFUL_COMPLETE_KIND_METADATA_API_SOURCE_PROFILE as metadata,
 STATEFUL_COMPLETE_KIND_API_SOURCE_PROFILE as first,STATEFUL_COMPLETE_KIND_COMMANDS_API_SOURCE_PROFILE as commands,
 STATEFUL_COMPLETE_KIND_EXECUTOR_API_SOURCE_PROFILE as executor} from '../unit/stateful-engineering-source-admission.mjs';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE as profile,observeWire34CbfbSourceOptions,WIRE34_CBFB_MANIFEST as manifest} from '../unit/wire34-cbfb-source-admission.mjs';
import {assertWire34Options,assertWire34Runtime,WIRE34_SOURCE,CBFB_SDK,WIRE_SDK} from '../../scripts/qualification/wire34-cbfb/contract.mjs';
import {DESCRIPTOR} from '../../scripts/qualification/indexed-schema-mongodb/wire34-cbfb-assembly.mjs';
import {OPERATOR_LIST_ASSEMBLY as operatorAssembly} from '../../scripts/qualification/operator-list-mongodb/wire34-cbfb-source-profile.mjs';
import {OPERATOR_LIST_ASSEMBLY as historicalOperatorAssembly} from '../../scripts/qualification/operator-list-mongodb/linux-cleanup-source-profile.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const options={engineeringSourceProfile:profile};

test('Wire34 operator-list metadata binds exact current emissions and distinct receiving SDK and drivers',()=>{
 const actual=observeWire34CbfbSourceOptions(options),paths={rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'};
 assert.equal(operatorAssembly.profile,profile);assert.deepEqual(operatorAssembly.pins,DESCRIPTOR.observation.pins);
 assert.deepEqual(Object.keys(operatorAssembly.trees),Object.keys(actual.emissions));
 for(const [name,rows]of Object.entries(actual.emissions))assert.deepEqual(operatorAssembly.trees[name],{path:paths[name],files:rows.length,sha256:sha(JSON.stringify(rows)),textLF:false});
 assert.deepEqual(Object.fromEntries(Object.entries(operatorAssembly.trees).map(([name,value])=>[name,value.files])),{rootBuild:552,nativeBuild:66,rootSDK:37,nativeSDK:37});
 assert(new Set(operatorAssembly.sourceFiles.map(row=>row.path)).size===operatorAssembly.sourceFiles.length);
 for(const row of operatorAssembly.sourceFiles){const bytes=readFileSync(new URL('../../'+row.path,import.meta.url));assert.equal(bytes.length,row.bytes,row.path);assert.equal(sha(bytes),row.sha256,row.path);}
 assert.deepEqual(operatorAssembly.ciIdentitySourcePaths,['tests/unit/wire34-cbfb-source-admission.mjs','tests/fixtures/engineering-profiles/wire34-cbfb-linux.json']);
 for(const field of ['fixture','platform','runtimeEvidence','engineeringCandidate'])assert.deepEqual(operatorAssembly[field],historicalOperatorAssembly[field]);
 assert.equal(operatorAssembly.wire.commit,WIRE34_SOURCE.commit);assert.equal(operatorAssembly.wire.tree,WIRE34_SOURCE.tree);
 assert(Object.isFrozen(operatorAssembly)&&Object.isFrozen(operatorAssembly.trees.nativeBuild)&&Object.isFrozen(operatorAssembly.sourceFiles));
});

test('Wire34 observes complete source, SDK, native, Wire and four dependency scopes before platform admission',()=>{
 const observed=observeWire34CbfbSourceOptions(options),actual=process.platform==='linux'?admitNativeApiSourceOptions(options):observed;
 assert.equal(actual.profile,profile);assert.equal(actual.qualificationOnly,true);assert.equal(actual.wireRevision,WIRE34_SOURCE.commit);
 assert.equal(actual.sdkRevision,CBFB_SDK);assert.equal(actual.nativeSDKRevision,CBFB_SDK);assert.equal(actual.wireSdkRevision,WIRE_SDK);
 assert.deepEqual(actual.emissions,manifest.trees);assert.deepEqual(actual.dependencies,manifest.dependencies);
 assert.equal(actual.sourceFiles,manifest.sources.files.length);assert.equal(actual.sourceBytes,manifest.sources.totalBytes);
 for(const [name,dep]of Object.entries(actual.dependencies)){assert.match(dep.packageSha256,/^[a-f0-9]{64}$/);assert(Array.isArray(dep.files)&&dep.files.length>0,name);}
 assert.deepEqual(Object.keys(actual.dependencies).sort(),['native:bson','native:mongodb','root:bson','root:mongodb']);
 assert.equal(actual.runtimeAcceptance,'pending');assert(Object.values(actual.acceptance).every(value=>value==='pending'));
 if(process.platform==='linux')assert.deepEqual(admitCoordinatedNativeSourceOptions(options),actual);
 else assert.throws(()=>admitCoordinatedNativeSourceOptions(options),/runtime.platform|runtime executable|linux/);
});

test('Wire34 explicit inert selection refuses foreign profiles, accessors, inherited values and extras',()=>{
 let accessed=0;
 for(const input of [{},Object.create(null),{engineeringSourceProfile:priorWire69},{engineeringSourceProfile:'unknown'},
  {engineeringSourceProfile:profile,nativeMarker:'true'},{get engineeringSourceProfile(){accessed++;return profile;}},
  {engineeringSourceProfile:profile,extra:true},Object.create({engineeringSourceProfile:profile})])assert.throws(()=>assertWire34Options(input));
 assert.equal(accessed,0);assert.deepEqual(assertWire34Options({...options,nativeMarker:false}),{nativeMarker:false});
});

test('Wire34 exact Linux runtime pins refuse Windows, foreign architecture, versions and executable bytes',()=>{
 for(const [node,hash]of [['v24.22.1','e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb'],['v26.4.0','4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94']]){
  const value={platform:'linux',arch:'x64',node,sha256:hash};assert.deepEqual(assertWire34Runtime(value),{runtimeAcceptance:'pending'});
  for(const mutation of [{platform:'win32'},{arch:'arm64'},{node:'v26.13.0'},{node:'v24.19.0'},{sha256:'0'.repeat(64)}])assert.throws(()=>assertWire34Runtime({...value,...mutation}));
 }
});

test('Wire34 keeps historical profiles frozen and unable to admit current source',()=>{
 assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:priorWire69}));
 for(const prior of [priorTrace,priorCleanup,priorSnapshot,priorCurrent])assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:prior}),/Git-LF helper/);
 assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:priorCodec}),/Unqualified coordinated lock source|Unqualified Wire source revision/);
 for(const prior of [first,commands,executor,metadata])assert.throws(()=>admitNativeApiSourceOptions({engineeringSourceProfile:prior}),/Wire source revision/);
});

test('actual Linux admission-runner prefix retains every historical rejection before temporary or child effects',()=>{
 const text=readFileSync(new URL('../unit/wire34-cbfb-source-admission-native.mjs',import.meta.url),'utf8');
 const clause=/import \{([^\n]+)\} from '\.\/stateful-engineering-source-admission\.mjs';/.exec(text);assert(clause);
 const bindings=Object.fromEntries(clause[1].split(',').map(part=>{const [name,alias=name]=part.trim().split(/\s+as\s+/);return[alias,profiles[name]];}));
 bindings.admitNativeApiSourceOptions=input=>Object.getOwnPropertyDescriptor(input??{},'engineeringSourceProfile')?.value===profile
  ?observeWire34CbfbSourceOptions(input):admitNativeApiSourceOptions(input);
 const begin=text.indexOf('assert.equal(process.versions.bun,'),end=text.indexOf('const parent = realpathSync(tmpdir())',begin);assert(begin>0&&end>begin);
 const scope={assert,process,WIRE34_CBFB_MANIFEST:manifest,...bindings};
 const count=new Function(...Object.keys(scope),text.slice(begin,end)+'return cases;')(...Object.values(scope));assert.equal(count,16);
 assert(text.includes('cases++;'));assert(text.includes('callerBeforeEffectsNegatives: 8'));assert(text.includes('qualificationBeforeEffectsNegatives: 6'));
});
