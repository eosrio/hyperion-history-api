// Pure/source/mocked controls only. Never import native-runner, native-ci or their lifecycle dependencies.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as ts from 'typescript/unstable/ast';
import {Long} from 'mongodb';
import * as logical from '@eosrio/hyperion-sdk/projection-stateful';
import * as ownerSdk from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import * as indexed from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
import * as nativeOwnerSdk from '../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js';
import {receiveMongoIndexedModelV1,planMongoIndexedQueryV1,mongoIndexedIndexesV1} from '../../../packages/backend-mongodb/dist/stateful-indexed-model-v1.js';
import {PLAN,ORACLE,argumentsFor,dispatchCases,assertNativeCompletion,projectionDefinition,projectionLimits,schemaModel,corpus,page,count,assertCreatedPeers,assertCoveredAbsence,hex} from './native-contract.mjs';
import {NATIVE_PROFILE,observeNativeInputs,assertNativeInputs,assertNativeRuntime} from './native-assembly.mjs';
import {installIndexedCommandHooks} from './native-command-hooks.mjs';
import {verifyIndexedTrace,verifyCursorClosure,verifyExplain,bsonCopy} from './native-trace.mjs';
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
test('explain checks semantic index use and refuses scans, sort, spill or missing lookup access paths',()=>{
 const expected={baseHint:'base',lookupIndexes:['join-a','join-b']},explain={stages:[{$cursor:{queryPlanner:{winningPlan:{stage:'FETCH',inputStage:{stage:'IXSCAN',indexName:'base'}}}}},{$lookup:{indexesUsed:['join-a']}},{$lookup:{indexesUsed:['join-b']}}],command:{pipeline:[{$sort:{created:-1}}]}};
 assert.equal(verifyExplain(explain,expected).baseIndex,'base');
 for(const change of [x=>x.stages[0].$cursor.queryPlanner.winningPlan.stage='COLLSCAN',x=>x.stages[0].$cursor.queryPlanner.winningPlan.stage='SORT',x=>x.stages[1].$lookup.indexesUsed=[],x=>x.stages[2].$lookup.usedDisk=true]){const value=structuredClone(explain);change(value);assert.throws(()=>verifyExplain(value,expected));}
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
