// Owned Linux/GHA physical runner. NEVER execute/import this entry point on Windows or from pure controls.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PROFILE,PLAN,sha,argumentsFor} from './contract.mjs';
import {admitCustodyAssembly} from './admission.mjs';
import {evidenceBudget} from './budget.mjs';import {verifyOriginalReports} from './original.mjs';import {createRoyaltyCustody,attachRoyaltyCustody} from './custody.mjs';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
const json=(path,value)=>{const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(bytes.length<=PLAN.evidenceBytes);writeFileSync(path,bytes,{flag:'wx'});};
export async function run(options){
 assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(options.source,process.env.GITHUB_SHA);
 const admitted=await admitCustodyAssembly(options.atomicRoot);assert.equal(admitted.managedSha256,options.assemblySha256);const git=(...args)=>execFileSync('git',args,{cwd:options.pgRoot,encoding:'utf8',timeout:10000}).trim();const pins=JSON.parse(readFileSync(new URL('./pg-pins.json',import.meta.url)));assert.equal(git('rev-parse','HEAD'),pins.head);assert.equal(git('rev-parse','HEAD^{tree}'),pins.tree);assert.equal(git('status','--porcelain=v1','--untracked-files=all'),'');const pgCheck=createRequire(join(options.pgRoot,'package.json'))('./harness/atomicassets/postgres/royalty-rule-gate.cjs').check;const original=verifyOriginalReports({pins,read:file=>readFileSync(join(options.pgReports,file)),readArchive:file=>readFileSync(join(options.pgReports,file)),check:pgCheck});
 const [{MongoClient,BSON},{selectMongoDbLinearHistoryEngineeringAssemblyV1,MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1},{createManagedAtomicHost,MANAGED_MODELS},{runRoyaltyPair},
  {monitorIndexed,verifyIndexedTrace,verifyCursorClosure},{default:AtomicPlugin},{limits}]=await Promise.all([
  import('mongodb'),import('@eosrio/hyperion-backend-mongodb/stateful-owner-indexed-query-v1/linear-history-engineering'),import('./host.mjs'),import('./driver.mjs'),
  import('../indexed-schema-mongodb/cbfb-native-trace.mjs'),import(pathToFileURL(join(options.atomicRoot,'dist/index.js'))),import(pathToFileURL(join(options.atomicRoot,'tests/fixtures/config-component.mjs')))]);
 assert(!existsSync(options.output));mkdirSync(options.output,{recursive:true});
 const report={schemaVersion:1,profile:PROFILE,status:'running',source:options.source,assemblySha256:admitted.managedSha256,runtime:admitted.runtime,acceptance:PLAN.acceptance},
  cleanup={httpClosed:false,clientsClosed:false,sessionsEnded:false,readsClosed:false,cursorsClosed:false,databaseDropped:false},events=[],trace=[],answers=[],sessions=[],namespaces=new Map(),
  marker=randomBytes(24).toString('hex'),proofs=new WeakSet(),published=new Map(),reads=new Set();
 let readsOpened=0,readsClosed=0;
 const onReadEvent=(event,read)=>{if(event==='opened'){assert(!reads.has(read));reads.add(read);readsOpened++;assert(readsOpened<=4096);}else{assert.equal(event,'closed');assert(reads.delete(read));readsClosed++;}};
 let phase={name:'preflight'},host,custody,primary,hasPrimary=false,owned=false,stopTrace,stopCustody,deadlineReached=false;
 const retainPrimary=error=>{if(!hasPrimary){hasPrimary=true;primary=error;}}; const safeFailure=error=>{try{return{name:String(error?.name??'Error'),message:String(error?.message??error),...(typeof error?.stack==='string'?{stack:error.stack}:{})};}catch{return{name:'Error',message:'Failure details unavailable'};}};
 const guard=()=>{assert(!deadlineReached,'Managed Atomic child deadline');},deadline=setTimeout(()=>{deadlineReached=true;},PLAN.fixture.childDeadlineMS);
 const persist=value=>{guard();assert(events.length<4096);events.push(value);assert(Buffer.byteLength(JSON.stringify(events))+(custody?.summary().bytes??0)<=PLAN.evidenceBytes,'combined evidence byte limit');};
 const client=new MongoClient(options.uri,{directConnection:true,retryReads:false,retryWrites:false,maxAdaptiveRetries:0,maxPoolSize:1,monitorCommands:true,
  serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,appName:options.database+'_managed',promoteLongs:false});
 const start=client.startSession.bind(client);client.startSession=(...args)=>{const session=start(...args),row={ended:false},end=session.endSession.bind(session);sessions.push(row);session.endSession=async(...args)=>{await end(...args);assert.equal(session.hasEnded,true);row.ended=true;};return session;};
 try{
  await client.connect();guard();const hello=await client.db('admin').command({hello:1}),info=await client.db('admin').command({buildInfo:1});
  assert.equal(info.version,PLAN.fixture.server);assert.equal(hello.setName,options.replicaSet);assert(hello.isWritablePrimary);assert.deepEqual(hello.hosts,[options.member]);report.server={version:info.version,hello};
  assert(!(await client.db().admin().listDatabases()).databases.some(row=>row.name===options.database));
  const db=client.db(options.database);await db.collection('_qualification_owner').insertOne({_id:marker,profile:PROFILE,source:options.source},{writeConcern:{w:'majority',j:true}});owned=true;
  stopTrace=monitorIndexed(client,options.database,'managed-native',()=>phase,trace,namespaces);
  const modelByPhase={},collectionByModel={},custodyDir=join(options.output,'bson');mkdirSync(custodyDir);custody=createRoyaltyCustody({database:options.database,modelByPhase,current:()=>phase,serialize:BSON.serialize,deserialize:b=>BSON.deserialize(b,{promoteLongs:false}),persist:(path,b)=>{writeFileSync(join(custodyDir,path),b,{flag:'wx'});return {path,length:b.length,sha256:sha(b)};},load:path=>readFileSync(join(custodyDir,path))});stopCustody=attachRoyaltyCustody(client,custody);
  const configuration={generation:'managed-atomic77',backend:{kind:'mongodb',id:options.database,database:options.database},recovery:{receipts:32,blocks:32,bytes:16*1024*1024,maxBlockBytes:1024*1024},
   maximumFramesPerDrain:8,operationTimeoutMS:PLAN.operationMS,transactionTimeoutMS:PLAN.transactionMS,api:{timeoutMs:PLAN.httpMS}};
  const config={limits:{...limits(),recordKinds:22,readKeys:64,readAttempts:128,mutations:256},ownedSchemaCounts:true,engineeringOwnedSchemaMongoComparison:true,engineeringRoyaltyTemplateQuery:true,engineeringRoyaltyTemplateMongoComparison:true},plugin=new AtomicPlugin(config),
   loader={plugins:[plugin],statefulPluginsV2:()=>[{plugin,configuration:config,hookArtifact:sha(readFileSync(join(options.atomicRoot,'dist/index.js')))}]},connection={};
  const source={async statefulSelectors(selectors){const proof=Object.freeze({});proofs.add(proof);return{proof,selectors:selectors.map(selector=>({...selector,abiDeployment:'controlled-managed-source-v1',abiSha256:sha('controlled-managed-source-v1')}))};},
   async open(checkpoint){guard();assert([...published.values()].some(row=>row.view.checkpoint.blockNum===checkpoint.blockNum&&row.view.checkpoint.blockId===checkpoint.blockId));const proof=Object.freeze({checkpoint:structuredClone(checkpoint)});proofs.add(proof);return proof;},
   async assertStatefulView(proof,declaration){assert(proofs.has(proof));assert(published.has(declaration.digest+':'+proof.checkpoint.blockNum+':'+proof.checkpoint.blockId));},async revalidate(proof){guard();assert(proofs.has(proof));}};
  host=await createManagedAtomicHost({loader,chainId:'1'.repeat(64),configuration,mongo:client,client:{},source,profile:{id:PROFILE,profileId:'controlled-synthetic-only',components:[]},
   probe:{currentSocket:()=>connection,probe:async()=>{guard();return true;}},selectEngineering:adapter=>selectMongoDbLinearHistoryEngineeringAssemblyV1(adapter,MONGODB_LINEAR_HISTORY_ENGINEERING_PROFILE_V1),persist,
   onQueryResult:row=>{answers.push(row);assert(answers.length<=128);},onReadEvent});
  assert.deepEqual(host.errors,[]);
  for(const entry of host.originals.values()){assert.deepEqual(entry.indexed.adapter.indexedCapabilities.queryDeclarationDigests,[]);assert.deepEqual(entry.indexed.adapter.indexedCapabilities.comparisonProfiles,[]);}
  const prefix='h45s_'+createHash('sha256').update(JSON.stringify(['1'.repeat(64),configuration.generation])).digest('hex').slice(0,24);
  for(const entry of host.registry.entries.values())for(const {declaration}of entry.indexed?.models.values()??[]){namespaces.set(prefix+'_ix1_'+declaration.digest+'_r',declaration.digest);collectionByModel[declaration.digest]=prefix+'_ix1_'+declaration.digest+'_r';}
  const publishSource=async row=>{guard();assert.deepEqual((await host.registry.entries.get(row.projection).adapter.recovery()).view,row.view);published.set(row.declaration.digest+':'+row.view.checkpoint.blockNum+':'+row.view.checkpoint.blockId,row);};
  report.result=await runRoyaltyPair({host,original,answers,custody,modelByPhase,collectionByModel,onPhase:value=>{phase=value;},publishSource,persist,guard});custody.healthy();report.custody=custody.summary();assert.equal(report.custody.pending,0);
  const phases=[...new Set(trace.filter(row=>row.event==='started'&&row.model&&['aggregate','getMore'].includes(row.command)).map(row=>row.phase))];
  for(const name of phases)verifyIndexedTrace(trace,name,{maximum:128,success:true});assert.equal(phases.length,7,'Every template phase requires actual tagged native query evidence');
  report.queries=answers.length;report.traceEvents=trace.length;report.nativeQueryPhases=phases;report.nativeCursors=verifyCursorClosure(trace);cleanup.cursorsClosed=true;
 }catch(error){retainPrimary(error);report.failure=safeFailure(error);}
 finally{
  const clean=async(name,operation)=>{try{await operation();}catch(error){retainPrimary(error);report[name]=safeFailure(error);}};
  await clean('deadlineCleanupFailure',async()=>{clearTimeout(deadline);});
  for(const key of ['httpClosed','sessionsEnded','readsClosed','cursorsClosed'])cleanup[key]=false;
  const resourceClosure={http:host?'unproved':'not-created',sessions:sessions.length?'unproved':'not-opened',reads:readsOpened?'unproved':'not-opened',cursors:'unproved'};
  await clean('httpCleanupFailure',async()=>{if(host){await host.close();cleanup.httpClosed=true;resourceClosure.http='closed';}});
  await clean('sessionCleanupFailure',async()=>{if(sessions.length){assert(sessions.every(row=>row.ended),'Actual adapter session left open');cleanup.sessionsEnded=true;resourceClosure.sessions='closed';}});
  await clean('readCleanupFailure',async()=>{if(readsOpened){assert.equal(reads.size,0);assert.equal(readsOpened,readsClosed);cleanup.readsClosed=true;resourceClosure.reads='closed';}});
  report.reads={opened:readsOpened,closed:readsClosed,live:reads.size};
  report.sessions={opened:sessions.length,closed:sessions.filter(row=>row.ended).length};
  await clean('cursorCleanupFailure',async()=>{const cursors=verifyCursorClosure(trace);report.nativeCursors=cursors;if(cursors.opened){assert.equal(cursors.live,0);assert.equal(cursors.opened,cursors.closed);cleanup.cursorsClosed=true;resourceClosure.cursors='closed';}else resourceClosure.cursors='not-opened';});
  report.resourceClosure=resourceClosure;
  if(!owned)report.databaseCleanupSkipped={reason:'owned-database-not-created'};
  else{
   const missing=['httpClosed','sessionsEnded','readsClosed','cursorsClosed'].filter(key=>cleanup[key]!==true);
   if(missing.length){report.databaseCleanupSkipped={reason:'closure-not-proved',missing,resourceClosure:{...resourceClosure}};retainPrimary(new Error('Owned database retained because managed resource closure is unproved'));}
   else await clean('databaseCleanupFailure',async()=>{const db=client.db(options.database),owner=await db.collection('_qualification_owner').findOne({_id:marker});assert.equal(owner?.profile,PROFILE);assert.equal(owner.source,options.source);await db.dropDatabase({writeConcern:{w:'majority',j:true}});assert.equal((await db.listCollections().toArray()).length,0);cleanup.databaseDropped=true;});
  }
  await clean('clientCleanupFailure',async()=>{await client.close();cleanup.clientsClosed=true;});await clean('traceDetachFailure',async()=>{stopTrace?.();stopCustody?.();});
  if(hasPrimary)report.failure??=safeFailure(primary);report.cleanup=cleanup;report.status=hasPrimary?'failed':'passed-bounded-royalty-driver-event-only';report.traceEvents=trace.length;
  let budgetOK=false;await clean('evidenceBudgetFailure',async()=>{evidenceBudget(custody?.summary().bytes??0,[['events.json',events],['trace.json',trace],['answers.json',answers],['report.json',report]],PLAN.evidenceBytes);budgetOK=true;});
  if(budgetOK){for(const [name,value]of [['events.json',events],['trace.json',trace],['answers.json',answers],['report.json',report]])await clean('evidenceFailure:'+name,async()=>{if(name==='report.json'){if(hasPrimary)report.failure??=safeFailure(primary);report.status=hasPrimary?'failed':'passed-bounded-royalty-driver-event-only';}json(join(options.output,name),value);});await clean('checksumEvidenceFailure',async()=>{json(join(options.output,'sha256.json'),['report.json','events.json','trace.json','answers.json'].map(path=>{const raw=readFileSync(join(options.output,path));return{path,bytes:raw.length,sha256:sha(raw)};}));});}else {report.failure??=safeFailure(primary);report.status='failed';await clean('evidenceFailure:report.json',async()=>json(join(options.output,'report.json'),report));}
  if(hasPrimary)report.failure??=safeFailure(primary);report.status=hasPrimary?'failed':'passed-bounded-royalty-driver-event-only';
 }if(hasPrimary)throw primary;return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const report=await run(argumentsFor(process.argv.slice(2),process.env));console.log(JSON.stringify({status:report.status,profile:PROFILE}));}catch(error){console.error(error);process.exitCode=1;}}
