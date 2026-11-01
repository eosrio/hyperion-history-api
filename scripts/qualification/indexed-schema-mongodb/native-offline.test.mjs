// Pure/source/mocked controls only. Never import native-runner, native-ci or their lifecycle dependencies.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as ts from 'typescript/unstable/ast';
import {BSON,Long} from 'mongodb';
import * as logical from '@eosrio/hyperion-sdk/projection-stateful';
import * as ownerSdk from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import * as indexed from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import * as nativeOwnerSdk from '../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js';
import {receiveMongoIndexedModelV1,planMongoIndexedQueryV1,mongoIndexedIndexesV1} from '../../../packages/backend-mongodb/dist/stateful-indexed-model-v1.js';
import {createMongoDbStatefulCompleteKindAdapterV1} from '../../../packages/backend-mongodb/dist/stateful-complete-kind-v1.js';
import {createMongoDbStatefulIndexedAdapterV1} from '../../../packages/backend-mongodb/dist/stateful-indexed-v1.js';
import {selectMongoDbIndexedEngineeringAssemblyV1} from '../../../packages/backend-mongodb/dist/stateful-indexed-engineering-v1.js';
import {PLAN,ORACLE,argumentsFor,dispatchCases,assertNativeCompletion,persistNativeChildIntent,projectionDefinition,projectionLimits,schemaModel,corpus,page,count,assertCreatedPeers,assertCoveredAbsence,hex,sha} from './native-contract.mjs';
import {NATIVE_PROFILE,observeNativeInputs,assertNativeInputs,assertNativeRuntime} from './native-assembly.mjs';
import {ASSEMBLY} from './assembly.mjs';
import {sourceReferences,observeSourceClosure,assertSourceClosure} from './native-source-closure.mjs';
import {installIndexedCommandHooks} from './native-command-hooks.mjs';
import {verifyIndexedTrace,verifyCursorClosure,verifyExplain,bsonCopy,captureAndVerifyExplain,lookupIndexSpecs,verifyLookupCatalog} from './native-trace.mjs';

test('integrated native profile closes every static import, literal data input and all 18 declared SDK49 routes without evaluating them',()=>{
 const boundaries=new Set(ASSEMBLY.sources.map(row=>row.path));
 for(const [key,prefix]of Object.entries({rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'}))for(const row of ASSEMBLY.trees[key])boundaries.add(prefix+'/'+row.path);
 const closure=observeSourceClosure({root:fileURLToPath(new URL('../../../',import.meta.url)),ts,boundaries,...NATIVE_PROFILE.sourceClosure.inputs});
 assertSourceClosure(closure,NATIVE_PROFILE);
 for(const path of ['tests/unit/sdk49-indexed-source-admission.mjs','tests/fixtures/engineering-profiles/sdk49-indexed-linux.json','scripts/qualification/operator-list-mongodb/sdk49-source-profile.mjs'])assert(closure.files.some(row=>row.path===path));
 assert.equal(closure.edges.filter(row=>row.kind==='declared-route').length,18);
 for(const path of ['tests/unit/sdk49-indexed-source-admission.mjs','tests/fixtures/engineering-profiles/sdk49-indexed-linux.json']){
  const altered=structuredClone(NATIVE_PROFILE);altered.sourceFiles=altered.sourceFiles.filter(row=>row.path!==path);assert.throws(()=>assertSourceClosure(closure,altered),/transitive source\/data pin/);
 }
 const altered=structuredClone(closure);altered.edges.pop();assert.throws(()=>assertSourceClosure(altered,NATIVE_PROFILE),/complete graph/);
 const legacy=JSON.parse(readFileSync(new URL('./native-profile-v1.json',import.meta.url)));assert.equal(legacy.profile,NATIVE_PROFILE.supersedes.profile);assert.notEqual(legacy.profile,PLAN.profile);
 const argv=['--profile',legacy.profile,'--run','--allow-failpoints','--database','h45_indexed_'+'a'.repeat(12),'--output','new-dir','--source','b'.repeat(40),'--assembly-sha256','c'.repeat(64)];assert.throws(()=>argumentsFor(argv,{}));
});

test('source inspection rejects mismatched or stalled scanner APIs within an independent finite input bound',()=>{
 const source="// import './comment.mjs'\nimport {x} from './actual.mjs'; const a = new URL('./data.json',import.meta.url); import('./lazy.mjs');";
 assert.deepEqual(sourceReferences(ts,source),[{kind:'module',specifier:'./actual.mjs'},{kind:'data',specifier:'./data.json'},{kind:'module',specifier:'./lazy.mjs'}]);
 assert.throws(()=>sourceReferences({...ts,SyntaxKind:{...ts.SyntaxKind,EndOfFile:undefined}},source),/EOF API/);
 assert.throws(()=>sourceReferences({...ts,createScanner:()=>({getText:()=>'',scan:()=>2})},source),/text API/);
 let calls=0;const stalled={...ts,createScanner:()=>({getText:()=>source,scan:()=>{calls++;return 2;},getTokenEnd:()=>0,getTokenText:()=>'',getTokenValue:()=>''})};
 assert.throws(()=>sourceReferences(stalled,source),/advance/);assert.equal(calls,2);
 assert.throws(()=>sourceReferences({createScanner:()=>assert.fail('Oversized source reached scanner')},' '.repeat(1024*1024+1)),/finite input bound/);
});

function observedPlan(major){
 const dir='./fixtures/9d8-explain/';
 const raw=JSON.parse(readFileSync(new URL(dir+'node'+major+'-explain.json',import.meta.url),'utf8'))[0];
 const samples=JSON.parse(readFileSync(new URL(dir+'node'+major+'-samples.json',import.meta.url),'utf8'));
 const catalogBefore=samples.find(row=>row.case==='genesis-index-and-coverage').indexes;
 return {command:BSON.EJSON.deserialize(raw.actualCommand,{relaxed:false}),explanation:BSON.EJSON.deserialize(raw.explain,{relaxed:false}),sealedView:raw.sealedView,baseHint:raw.expected.baseHint,aliases:['collection','assets'],catalogBefore};
}
function verifyObserved(input){return verifyExplain(input.explanation,{...input,catalog:input.catalogBefore});}
function catalogControl(input){return catalog=>verifyLookupCatalog(catalog,lookupIndexSpecs(input.aliases));}
function after(input){return {view:structuredClone(input.sealedView),catalog:structuredClone(input.catalogBefore)};}
test('retained replay inputs match their official extraction provenance',()=>{
 const dir='./fixtures/9d8-explain/', provenance=JSON.parse(readFileSync(new URL(dir+'PROVENANCE.json',import.meta.url),'utf8'));
 assert.equal(provenance.run,41333567862);assert.equal(provenance.head,'9d8c11f57bceb6c9df297de60d86005a96022033');
 for(const [name,digest] of Object.entries(provenance.files))assert.equal(sha(readFileSync(new URL(dir+name,import.meta.url))),digest);
});
test('actual retained plans bind each lookup to its own catalog-verified index',()=>{
 for(const major of [24,26]){const input=observedPlan(major),checked=verifyObserved(input);assert.equal(checked.lookupIndexes.length,2);
  for(const row of checked.lookupIndexes)assert(row.indexes.every(name=>name.startsWith('h45_ix_j_')));
  const bindings=lookupIndexSpecs(input.aliases);for(const stage of input.explanation.stages.filter(x=>x.$lookup))stage.indexesUsed=[bindings.find(x=>'lookups.'+x.alias===stage.$lookup.as).indexes[1].name];
  assert(verifyObserved(input).lookupIndexes.every(row=>row.indexes.every(name=>name.startsWith('h45_ix_l_'))));
 }
});
test('a received invalid explain remains raw and checksummed while verification fails',async()=>{
 const input=observedPlan(24),records=[];input.explanation.stages.find(x=>x.$lookup).collectionScans=Long.ONE;
 await assert.rejects(captureAndVerifyExplain(records,input,async()=>after(input),catalogControl(input)),/collection scan/i);
 assert.equal(records.length,1);const saved=JSON.parse(JSON.stringify(records));assert.equal(saved[0].status,'received');assert.equal(saved[0].checked,undefined);
 assert.deepEqual(BSON.EJSON.deserialize(saved[0].actualCommand,{relaxed:false}),input.command);assert.deepEqual(BSON.EJSON.deserialize(saved[0].explain,{relaxed:false}),input.explanation);
 assert.deepEqual(saved[0].afterView,input.sealedView);assert(saved[0].catalogBefore&&saved[0].catalogAfter);
 for(const [key,value]of [['command',input.command],['explain',input.explanation]]){const pin=saved[0].bsonReserialization[key],bytes=Buffer.from(pin.base64,'base64');assert.equal(pin.bytes,bytes.length);assert.equal(pin.sha256,sha(bytes));assert.deepEqual(bytes,BSON.serialize(value));}
 const runner=readFileSync(new URL('./native-runner.mjs',import.meta.url),'utf8');const failure=runner.indexOf('}catch(error){primary=error;report.failure=failure(error);}'),write=runner.indexOf("['explain.json',explains]"),checksums=runner.indexOf("['trace.json','samples.json','explain.json','report.json'].map");assert(failure>=0&&write>failure&&checksums>write);
});
test('valid plans retain evidence and changed or unavailable post-view remains unverified',async()=>{
 const input=observedPlan(26),good=[];await captureAndVerifyExplain(good,input,async()=>after(input),catalogControl(input));assert.equal(good[0].status,'verified');
 for(const read of [async()=>({...after(input),view:{revision:'changed'}}),async()=>{throw new Error('view unavailable');}]){const rows=[];await assert.rejects(captureAndVerifyExplain(rows,input,read,catalogControl(input)));assert.equal(rows[0].status,'received');}
});

function actualMakePrefixes(){
 const source=readFileSync(new URL('./native-runner.mjs',import.meta.url),'utf8');assert(source.length<=512*1024);
 assert.equal(typeof ts.SyntaxKind.EndOfFile,'number');assert.equal(typeof ts.SyntaxKind.StringLiteral,'number');
 const scanner=ts.createScanner(true,ts.LanguageVariant.Standard,source);assert.equal(scanner.getText(),source);
 const tokens=[];let exhausted=false,previousEnd=-1;
 for(let steps=0;steps<=source.length*2;steps++){const kind=scanner.scan();if(kind===ts.SyntaxKind.EndOfFile){exhausted=true;break;}
  assert(scanner.getTokenEnd()>previousEnd);previousEnd=scanner.getTokenEnd();tokens.push({text:scanner.getTokenText(),kind,value:kind===ts.SyntaxKind.StringLiteral?scanner.getTokenValue():undefined});}
 assert(exhausted,'Fixture namespace scan exceeded its finite input bound');
 const definitions=tokens.map((token,i)=>token.text==='make'&&tokens[i+1]?.text==='='&&tokens[i+2]?.text==='async'?i:-1).filter(i=>i>=0);assert.equal(definitions.length,1);
 const start=definitions[0];assert.deepEqual(tokens.slice(start+3,start+8).map(token=>token.text),['(','client',',','prefix','=']);
 assert.equal(tokens[start+8].kind,ts.SyntaxKind.StringLiteral);const fallback=tokens[start+8].value,prefixes=[];
 for(let i=0;i<tokens.length;i++)if(tokens[i].text==='make'&&tokens[i-1]?.text==='await'&&tokens[i+1]?.text==='('){
  let end=i+2;for(;end<Math.min(tokens.length,i+16)&&![',',')'].includes(tokens[end].text);end++);assert(end<i+16);
  assert(['client','state.client'].includes(tokens.slice(i+2,end).map(token=>token.text).join('')),'Untested dynamic fixture client');
  if(tokens[end].text===')')prefixes.push(fallback);else{assert.equal(tokens[end+1].kind,ts.SyntaxKind.StringLiteral,'Untested dynamic fixture namespace');assert([',',')'].includes(tokens[end+2].text));prefixes.push(tokens[end+1].value);}
 }assert.equal(prefixes.length,8,'Every genuine fixture constructor callsite must be covered');return prefixes;
}

async function constructorOnly(){
 const operations=[],client={options:{retryReads:false,retryWrites:false,maxAdaptiveRetries:0},db(){return {collection(name){return new Proxy({collectionName:name},{get(target,key){if(key in target)return target[key];return()=>{operations.push([name,key]);throw new Error('Unexpected native operation in constructor-only control');};}});}};},
  startSession(){operations.push(['startSession']);throw new Error('Constructor control cannot open a native session');}};
 const projection=await logical.captureStatefulDeclaration(projectionDefinition(logical,'h45_indexed_aaaaaaaaaaaa'),projectionLimits()),declaration=await ownerSdk.captureStatefulOwnerDeclarationV2(projection,2);
 return {projection,operations,options:{client,databaseName:'h45_indexed_aaaaaaaaaaaa',backendId:'h45_indexed_aaaaaaaaaaaa',declaration,receiptRetention:4,rollbackRetentionBlocks:4,
  rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:PLAN.operationMS,transactionTimeoutMS:PLAN.transactionMS}};
}

test('all genuine runner namespace callsites construct through the actual owner and indexed factories without native I/O',async()=>{
 const s=await constructorOnly(),complete={readAttempts:12,responseRecords:8,responseBytes:65536};
 for(const collectionPrefix of actualMakePrefixes()){
  const options={...s.options,collectionPrefix},base=await createMongoDbStatefulCompleteKindAdapterV1(options,complete),owner=await ownerSdk.negotiateStatefulOwnerV2(s.projection,
   {family:ownerSdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported:ownerSdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2,limits:s.projection.limits},base.capabilities),
   declaration=await indexed.captureIndexedDeclarationV1(owner,'owned-native-fixture-v1',collectionPrefix==='sql_refusal'?{...schemaModel(),textComparison:'atomicassets-sql-en-us-utf8-unqualified'}:schemaModel()),
   adapter=await createMongoDbStatefulIndexedAdapterV1({...options,declaration:owner},[{declaration,limits:PLAN.limits}],complete,base);
  assert.deepEqual(adapter.indexedCapabilities.comparisonProfiles,[]);assert.deepEqual(adapter.indexedCapabilities.queryDeclarationDigests,[]);
  if(collectionPrefix==='sql_refusal'){
   const selected=selectMongoDbIndexedEngineeringAssemblyV1(adapter,PLAN.assembly),view={declarationDigest:owner.digest,backendId:options.backendId,generation:s.projection.definition.binding.generation,revision:hex(20),checkpoint:{blockNum:0,blockId:hex(0)}};
   await assert.rejects(selected.indexedForModel(view,declaration.digest,()=>{}),error=>error.code==='stateful.capability-unavailable'&&error.message==='This comparison profile has no native qualification');
  }
 }assert.deepEqual(s.operations,[]);
});

test('the unchanged actual owner constructor refuses malformed prefixes without normalization or native I/O',async()=>{
 const s=await constructorOnly(),complete={readAttempts:12,responseRecords:8,responseBytes:65536};
 for(const collectionPrefix of ['sql-refusal','covered-genesis','legacy-populated','new-generation','','Covered_genesis',' covered_genesis ','a'.repeat(33)]){
  await assert.rejects(createMongoDbStatefulCompleteKindAdapterV1({...s.options,collectionPrefix},complete),error=>error.code==='stateful.invalid-contract'&&error.message==='Explicit native owner configuration differs');
 }assert.deepEqual(s.operations,[]);
});

test('native invocation intent persists the exact immutable argv and scoped inputs before any launch can consume them',()=>{
 const argv=['runner.mjs','--profile',PLAN.profile,'--run','--allow-failpoints','--database','h45_indexed_aaaaaaaaaaaa','--output','output/native','--source','b'.repeat(40),'--assembly-sha256','c'.repeat(64)],
  input={executable:'/actual/node',argv,cwd:'/actual/workspace',source:'b'.repeat(40),runtime:{node:PLAN.runtimeVersions[0],platform:'linux',arch:'x64',executableSha256:'d'.repeat(64)},
   limits:{query:PLAN.limits,operationMS:PLAN.operationMS,transactionMS:PLAN.transactionMS,fixture:PLAN.fixture},environment:{HYPERION_INDEXED_MONGO_URI:'mongodb://127.0.0.1:32777/?directConnection=true&replicaSet=h45rs_'+'a'.repeat(32)}},writes=[];
 const intent=persistNativeChildIntent(input,value=>{writes.push(JSON.stringify(value));});assert.equal(writes.length,1);assert.equal(intent.argv,argv);
 assert.deepEqual(JSON.parse(writes[0]),intent);assert.equal(intent.status,'intent-only');assert.equal('pid'in intent,false);assert.equal('terminal'in intent,false);
 assert(Object.isFrozen(intent)&&Object.isFrozen(argv)&&Object.isFrozen(intent.limits.query));assert.throws(()=>argv.push('changed'));
 let consumed=false;assert.throws(()=>{const blocked=persistNativeChildIntent({...input,argv:[...argv]},()=>{throw new Error('intent storage failed');});consumed=true;return blocked;},/intent storage failed/);assert.equal(consumed,false);
 assert.throws(()=>persistNativeChildIntent({...input,argv:[...argv]},async()=>{}),/synchronously/);
 const ci=readFileSync(new URL('./native-ci.mjs',import.meta.url),'utf8');
 const written=ci.indexOf("intent=>json(join(output,'child-intent.json'),intent)"),launched=ci.indexOf('child=spawn(invocation.executable,invocation.argv'),terminal=ci.indexOf("json(join(output,'child-terminal.json'),report.child)"),admission=ci.indexOf('assertNativeCompletion(report.child');
 assert(written>=0&&launched>written);assert(terminal>=0&&admission>terminal);
 assert.match(ci,/child=spawn\(invocation\.executable,invocation\.argv,\{cwd:invocation\.cwd/);assert.match(ci,/Number\.isSafeInteger\(child\.pid\)&&child\.pid>0/);
 assert.match(ci,/return terminalChild\(child,/);assert(ci.indexOf("json(join(output,'child-process.json'),report.childProcess)")>ci.indexOf('return terminalChild(child,'));
});
test('actual fixture input observation admits raw bytes and each complete scoped driver/BSON inventory',()=>{
 const actual=observeNativeInputs(),receipt=assertNativeInputs(actual);assert.equal(receipt.profile,PLAN.profile);
 assert.deepEqual(Object.keys(actual.dependencies),['root:mongodb','root:bson','native:mongodb','native:bson']);
 for(const scope of ['root','native']){assert(actual.dependencies[scope+':mongodb'].files.length>10);assert(actual.dependencies[scope+':bson'].files.length>10);}
 for(const mutate of [x=>x.profile='current103',x=>x.sourceFiles.pop(),x=>x.sourceFiles[0].sha256='f'.repeat(64),x=>x.dependencies['root:bson'].files.pop(),
  x=>x.dependencies['native:mongodb'].files[0].sha256='f'.repeat(64),x=>x.baseAssemblySha256='f'.repeat(64)]){const copy=structuredClone(actual);mutate(copy);assert.throws(()=>assertNativeInputs(copy));}
});
test('Linux runtime admission uses exact versions and executable bytes without a Windows fallback',()=>{
 for(const pinned of NATIVE_PROFILE.runtimes){const value={node:pinned.node,platform:'linux',arch:'x64',executableSha256:pinned.executableSha256};assert.deepEqual(assertNativeRuntime(value),value);
  for(const changes of [{platform:'win32'},{arch:'arm64'},{node:'v24.19.0'},{executableSha256:'f'.repeat(64)}])assert.throws(()=>assertNativeRuntime({...value,...changes}));}
});
test('native arguments accept only the generated loopback replica and explicit profile',()=>{
 const run='a'.repeat(32),argv=['--profile',PLAN.profile,'--run','--allow-failpoints','--database','h45_indexed_'+run.slice(0,12),'--output','new-dir','--source','b'.repeat(40),'--assembly-sha256','c'.repeat(64)],
  env={HYPERION_INDEXED_MONGO_URI:'mongodb://127.0.0.1:32777/?directConnection=true&replicaSet=h45rs_'+run};
 assert.equal(argumentsFor(argv,env).member,'hyp-projection-'+run+'-replica:27017');assert.equal(argumentsFor(['--validate-plan'],{}),null);
 for(const uri of ['mongodb://example.com:32777/?directConnection=true&replicaSet=h45rs_'+run,env.HYPERION_INDEXED_MONGO_URI+'&retryReads=true',env.HYPERION_INDEXED_MONGO_URI.replace('32777','27017')])assert.throws(()=>argumentsFor(argv,{HYPERION_INDEXED_MONGO_URI:uri}));
 const wrong=[...argv];wrong[1]='old-profile';assert.throws(()=>argumentsFor(wrong,env));
});
test('generated native dispatch executes all eleven handlers once and refuses omissions, extras and reorder',async()=>{
 const visited=[],handlers=Object.fromEntries(PLAN.cases.map(name=>[name,async()=>visited.push(name)]));await dispatchCases(handlers,async(_,work)=>work());assert.deepEqual(visited,PLAN.cases);
 for(const input of [Object.fromEntries(Object.entries(handlers).slice(1)),{...handlers,extra:async()=>{}},Object.fromEntries(Object.entries(handlers).reverse())])await assert.rejects(dispatchCases(input,async(_,work)=>work()));
});
test('actual runner tokenized source binds generated case names to concrete handlers without executing/importing it',()=>{
 const source=readFileSync(new URL('./native-runner.mjs',import.meta.url),'utf8'),scanner=ts.createScanner(true,ts.LanguageVariant.Standard,source),tokens=[];
 assert.equal(typeof ts.SyntaxKind.EndOfFile,'number');assert.equal(scanner.getText(),source);let exhausted=false,previousEnd=-1;
 for(let steps=0;steps<=source.length*2;steps++){const kind=scanner.scan();if(kind===ts.SyntaxKind.EndOfFile){exhausted=true;break;}
  assert(scanner.getTokenEnd()>previousEnd,'Source scanner made no forward progress');previousEnd=scanner.getTokenEnd();
  tokens.push({kind,text:scanner.getTokenText(),value:kind===ts.SyntaxKind.StringLiteral?scanner.getTokenValue():scanner.getTokenText()});}
 assert(exhausted,'Source lexer did not settle within its finite input bound');
 const dispatch=tokens.map((token,index)=>token.text==='dispatchCases'&&tokens[index+1]?.text==='('?index:-1).filter(index=>index>=0);assert.equal(dispatch.length,1);
 assert.equal(tokens[dispatch[0]+2].text,'{');const names=[];let depth=0;
 for(let i=dispatch[0]+2;i<tokens.length;i++){const token=tokens[i];if(token.text==='{')depth++;else if(token.text==='}')depth--;if(depth===0)break;
  if(depth===1&&token.kind===ts.SyntaxKind.StringLiteral&&tokens[i+1]?.text===':'){assert.equal(tokens[i+2].text,'async');names.push(token.value);}}
 assert.deepEqual(names,PLAN.cases);
 for(const name of PLAN.cases)assert(source.includes("'"+name+"':async()=>{"));
 assert.match(source,/const direct=.*\n[^\n]*attest\(start,result,limits\.readAttempts\)/);assert.match(source,/async queryCompleted\(\.\.\.args\).*attest\(start,result,args\[3\]\.readAttempts\)/);
 assert.match(source,/assert\.equal\(process\.platform,'linux'\)/);assert.match(source,/admitNativeAssembly\(PLAN\.profile\)/);
 const ci=readFileSync(new URL('./native-ci.mjs',import.meta.url),'utf8');
 assert.match(ci,/terminalChild.*stateful-complete-kind-mongodb\/ci\.mjs/);assert(ci.indexOf('report.assembly=admitNativeAssembly')<ci.indexOf('fixture=new OwnedMongoFixture'));
 assert(!ci.includes('admitNativeApiSourceOptions'));assert(!ci.includes('admitOperatorListAssembly'));
 const workflow=readFileSync(new URL('../../../.github/workflows/indexed-schema-native.yml',import.meta.url),'utf8');
 for(const literal of ['ubuntu-22.04','timeout-minutes: 15',"node: ['24.22.1', '26.4.0']",'if: always()','if-no-files-found: error',PLAN.profile])assert(workflow.includes(literal));
 assert.equal(NATIVE_PROFILE.fixture.childDeadlineMS,300000);assert.equal(NATIVE_PROFILE.fixture.graceMS,10000);assert.equal(NATIVE_PROFILE.fixture.terminalMS,10000);
});
test('real SDK49 captures both generated models/corpus and the actual native planner retains Long offset/count and separate lookup indexes',async()=>{
 const projection=await logical.captureStatefulDeclaration(projectionDefinition(logical,'offline-native'),projectionLimits()),offer=supported=>({family:ownerSdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:projection.limits}),
  owner=await ownerSdk.negotiateStatefulOwnerV2(projection,offer(ownerSdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2),offer(ownerSdk.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const received=await nativeOwnerSdk.receiveStatefulOwnerDeclarationV2(owner),nativeOwner=await nativeOwnerSdk.negotiateStatefulOwnerV2(received.projection,{family:nativeOwnerSdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported:nativeOwnerSdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2,limits:received.projection.limits},offer(ownerSdk.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const digests=[];for(const control of [false,true]){const declaration=await indexed.captureIndexedDeclarationV1(owner,'owned-native-fixture-v1',schemaModel(control)),native=await receiveMongoIndexedModelV1(nativeOwner,declaration,PLAN.limits);digests.push(declaration.digest);
  const plan=planMongoIndexedQueryV1(native,page({offset:'9223372036854775807'},control),'offline_rows'),skip=plan.pipeline.find(stage=>stage.$skip!==undefined).$skip;
  assert(Long.isLong(skip));assert.equal(skip.toString(),'9223372036854775807');const counted=planMongoIndexedQueryV1(native,count(),'offline_rows');assert(Long.isLong(counted.pipeline.at(-1).$group.value.$sum));
  const indexes=mongoIndexedIndexesV1(native),lookup=indexes.filter(index=>index.name.startsWith('h45_ix_l_'));assert.equal(lookup.length,control?0:2);assert(lookup.every(index=>!index.partial&&!index.unique));
 }
 assert.notEqual(...digests);assert.equal(corpus().filter(row=>row.kind==='schema'&&row.value.contract==='atomicassets').length,7);assert.equal(ORACLE.joinedCount,'6');assert(corpus().some(row=>JSON.stringify(row.value).includes('雪')));
 assertCreatedPeers(['s:d','s:c','s:b','s:a','s:e','s:f'].map(key=>({key})));assert.throws(()=>assertCreatedPeers(ORACLE.schemaAscending.map(key=>({key}))));
});
function snapshotTrace(){const expected={declarationDigest:hex(1),generation:'g',revision:hex(2),checkpoint:{blockNum:1,blockId:hex(3)}},owner={id:'owner',generation:'one'},
 collection='bounded_ix1_'+hex(4)+'_r',shared={client:'managed',phase:'read',lsid:'real-session-evidence',txn:'1',transactional:true,expected,owner,ownerClaim:hex(5),ownerDeclaration:hex(1)};
 const start=(requestId,command,extra={})=>({event:'started',requestId,command,...structuredClone(shared),...extra});
 const rows=[start(1,'find',{collection:'bounded_stateful_v2_metadata',startsTransaction:true,readConcern:'snapshot'}),{event:'succeeded',client:'managed',phase:'read',requestId:1,command:'find',metadata:{...expected,owner,ownerClaim:hex(5),initialized:true,raw:false,pending:false,gap:false,rollback:null}},
  start(2,'find',{collection:collection.slice(0,-2)+'_c'}),{event:'succeeded',client:'managed',phase:'read',requestId:2,command:'find',coverage:{_id:hex(4),representation:'h45-owner-indexed-materialization-v1',owner:hex(1),model:hex(4),generation:'g',revision:hex(2),checkpoint:expected.checkpoint,ready:true,reason:null}},
  start(3,'aggregate',{collection,model:hex(4),tagged:true,comment:{model:hex(4),trace:'one'},batchSize:1,maxTimeMS:PLAN.operationMS,hint:'h45_ix_b_'+'a'.repeat(20),collation:{locale:'simple'},allowDiskUse:false}),
  {event:'succeeded',client:'managed',phase:'read',requestId:3,command:'aggregate',cursor:'0',batch:1,replyBsonBytes:512}];return rows.map((row,seq)=>({...row,seq}));}
test('indexed trace requires actual owner plus model coverage in the same snapshot and counts data commands',()=>{
 assert.equal(verifyIndexedTrace(snapshotTrace(),'read',{attempts:1,maximum:1,success:true}).actualDataAttempts,1);
 for(const mutate of [x=>x[4].transactional=false,x=>x[4].tagged=false,x=>x[3].coverage.ready=false,x=>x[3].coverage.revision=hex(99),
  x=>x[1].metadata.ownerClaim=hex(99),x=>x[4].lsid='foreign',x=>x[4].comment.model=hex(99),x=>x[4].batchSize=2,x=>x[4].collation.locale='en',x=>x[5].cursor='99']){
  const rows=snapshotTrace();mutate(rows);assert.throws(()=>verifyIndexedTrace(rows,'read',{maximum:1,success:true}));}
 assert.throws(()=>verifyIndexedTrace(snapshotTrace(),'read',{maximum:0}));
});
test('cursor closure proves original identity, successful kill or transaction abort and never accepts a live cursor',()=>{
 const rows=snapshotTrace();rows[5].cursor='7';assert.throws(()=>verifyCursorClosure(rows));const start={...rows[4],seq:6,requestId:4,command:'getMore',cursor:'7',maxTimeMS:null};
 const end={event:'succeeded',seq:7,client:'managed',phase:'read',requestId:4,command:'getMore',cursor:'0',batch:0};assert.deepEqual(verifyCursorClosure([...rows,start,end]),{opened:1,closed:1,live:0});
 const kill={...start,command:'killCursors',cursors:['7']},done={...end,command:'killCursors',closure:{cursorsKilled:['7'],cursorsNotFound:[],cursorsAlive:[],cursorsUnknown:[]}};
 assert.equal(verifyCursorClosure([...rows,kill,done]).live,0);assert.throws(()=>verifyCursorClosure([...rows,{...kill,client:'foreign'},done]));
 const bad=structuredClone(done);bad.closure.cursorsAlive=['7'];assert.throws(()=>verifyCursorClosure([...rows,kill,bad]));
 const abort={...start,command:'abortTransaction'},aborted={...end,command:'abortTransaction'};assert.equal(verifyCursorClosure([...rows,abort,aborted]).live,0);
});
test('successful callback retry exposes its failed original command, fresh transaction and cumulative attempts',()=>{
 const first=snapshotTrace();first[5]={...first[5],event:'failed',labels:['TransientTransactionError'],code:112};delete first[5].cursor;
 const next=snapshotTrace().map(row=>({...row,seq:row.seq+6,requestId:row.requestId+10,...(row.event==='started'?{txn:'2'}:{})})),rows=[...first,...next];
 assert.equal(verifyIndexedTrace(rows,'read',{attempts:2,maximum:2,success:true}).actualDataAttempts,2);
 assert.throws(()=>verifyIndexedTrace(rows,'read',{attempts:1,maximum:2,success:true}));
 const hidden=structuredClone(rows);hidden[5].labels=[];assert.throws(()=>verifyIndexedTrace(hidden,'read',{maximum:2,success:true}));
});
test('lookup proof refuses wrong aliases, incomplete stats, bad plans and altered catalog specifications',()=>{
 const mutations=[
 x=>x.explanation.stages.find(y=>y.$lookup).indexesUsed=[lookupIndexSpecs(x.aliases)[1].indexes[0].name],
 x=>x.explanation.stages.find(y=>y.$lookup).indexesUsed=[],x=>delete x.explanation.stages.find(y=>y.$lookup).totalDocsExamined,
 x=>x.explanation.stages.find(y=>y.$lookup).collectionScans=Long.ONE,x=>x.explanation.stages.splice(x.explanation.stages.findIndex(y=>y.$lookup),1),
 x=>x.explanation.stages[0].$cursor.queryPlanner.winningPlan.stage='COLLSCAN',x=>x.explanation.stages[0].$cursor.queryPlanner.winningPlan.stage='SORT',
 x=>x.explanation.stages.find(y=>y.$lookup).usedDisk=true,x=>x.explanation.stages.find(y=>y.$lookup).spills=Long.ONE,
 x=>x.command.allowDiskUse=true,x=>x.explanation.stages.find(y=>y.$lookup).$lookup.as='lookups.assets',
 x=>{const c=x.catalogBefore.find(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name);c.key={'joins.collection':1,alias:1};},
 x=>{const c=x.catalogBefore.find(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name);c.partialFilterExpression={alias:'assets'};},
 x=>{const c=x.catalogBefore.find(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name);c.unique=false;},
 x=>{const c=x.catalogBefore.find(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name);c.hidden=true;},
 x=>{const c=x.catalogBefore.find(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name);c.sparse=true;},
 x=>{const c=x.catalogBefore.find(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name);c.collation={locale:'en'};},
 x=>x.catalogBefore.splice(x.catalogBefore.findIndex(y=>y.name===lookupIndexSpecs(x.aliases)[0].indexes[0].name),1)
 ];for(const [i,mutate] of mutations.entries()){const input=observedPlan(24);mutate(input);assert.throws(()=>verifyObserved(input),`mutation ${i}`);}
 const native=bsonCopy({offset:Long.fromString('9007199254740993')});assert.equal(native.offset.toString(),'9007199254740993');assert(Long.isLong(native.offset));
});
test('command gates act only on the original owned client/session/model and restore without process or timer handles',async()=>{
 const seen=[],client={},session={client},collection='bounded_ix1_'+hex(4)+'_r',namespaces=new Map([[collection,hex(4)]]),server={async command(){return {ok:1};}},topology={async selectServer(){return server;}};client.topology=topology;server.topology=topology;
 const old=server.command,restore=installIndexedCommandHooks(client,'owned',namespaces,{beforeData:async()=>seen.push('before'),afterData:async()=>seen.push('after'),afterTransaction:async()=>seen.push('commit'),beforeSidecarInsert:async()=>seen.push('insert'),beforeSnapshot:async()=>seen.push('snapshot')});
 const selected=await topology.selectServer(),operation={commandName:'runCommand',ns:{db:'owned'},session,command:{aggregate:collection,comment:{hyperion:'stateful-indexed-v1',model:hex(4)}}};
 await selected.command(operation);await selected.command({...operation,command:{commitTransaction:1}});assert.deepEqual(seen,['before','after','commit']);
 for(const change of [{session:{client:{}}},{ns:{db:'foreign'}},{command:{aggregate:collection,comment:{hyperion:'stateful-indexed-v1',model:hex(99)}}}])await selected.command({...operation,...change});assert.equal(seen.length,3);
 await selected.command({commandName:'insert',ns:{db:'owned',collection},session});assert.equal(seen.at(-1),'insert');
 await selected.command({commandName:'find',ns:{db:'owned',collection:'bounded_stateful_v2_metadata'},session:{client,inTransaction:()=>true}});assert.equal(seen.at(-1),'snapshot');
 await selected.command({commandName:'find',ns:{db:'owned',collection:'bounded_stateful_v2_metadata'},session:{client,inTransaction:()=>false}});assert.equal(seen.at(-1),'snapshot');
 restore();restore();assert.equal(server.command,old);
});
test('native completion rejects missing cases, expanded acceptance and incomplete cleanup/terminal evidence',()=>{
 const terminal={code:0,signal:null,timedOut:false,terminal:true,streamsClosed:true},report={status:'passed-native-indexed-only',plan:PLAN,source:{observationSha256:hex(1)},server:{version:PLAN.server},traceEvents:64,
  successfulQueryAttestations:PLAN.cases.map(()=>({})),cases:PLAN.cases.map(name=>({name,status:'pass',successfulQueries:1})),
 cleanup:Object.fromEntries(['managedClientsClosed','sessionsEnded','readsClosed','cursorsClosed','failpointDisabled','databaseDropped','adminClosed'].map(name=>[name,true])),acceptance:{AtomicSQL:'pending',managedHTTP:'pending',productionOffers:'empty'}};
 assertNativeCompletion(terminal,report,hex(1));for(const mutate of [x=>x.cases.pop(),x=>x.cleanup.cursorsClosed=false,x=>x.acceptance.AtomicSQL='passed']){const value=structuredClone(report);mutate(value);assert.throws(()=>assertNativeCompletion(terminal,value,hex(1)));}
 assert.throws(()=>assertNativeCompletion({...terminal,timedOut:true},report,hex(1)));assert.throws(()=>assertNativeCompletion({...terminal,streamsClosed:false},report,hex(1)));
});
test('canonical genesis absence oracle uses the actual covered-absent protocol and rejects present or invented statuses',()=>{
 assertCoveredAbsence({results:[{status:'covered-absent'},{status:'covered-absent'}]},2);
 for(const result of [{results:[]},{results:[{status:'missing'},{status:'missing'}]},{results:[{status:'covered-absent'},{status:'present',value:{}}]}])assert.throws(()=>assertCoveredAbsence(result,2));
});
test('explain spill counters preserve BSON Long semantics across the EJSON artifact boundary',()=>{
 const input=observedPlan(24);input.explanation.spills=Long.ZERO;verifyObserved(input);
 for(const bad of [Long.ONE,'0']){input.explanation.spills=bad;assert.throws(()=>verifyObserved(input));}
});

