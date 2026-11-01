// Actual owned Linux/GHA MongoDB runner; NEVER import/execute on Windows or in offline controls.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PLAN,ORACLE,argumentsFor,dispatchCases,projectionDefinition,projectionLimits,schemaModel,corpus,page,count,assertCreatedPeers,assertCoveredAbsence,plain,hex,sha,failure} from './native-contract.mjs';
import {admitNativeAssembly} from './native-assembly.mjs';
import {installIndexedCommandHooks} from './native-command-hooks.mjs';
import {monitorIndexed,verifyIndexedTrace,verifyCursorClosure,verifyExplain,bsonCopy,bsonEvidence} from './native-trace.mjs';
const json=(path,value)=>{const raw=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(raw.length<=PLAN.evidenceBytes);writeFileSync(path,raw,{flag:'wx'});};
export async function run(options){
 assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(options.source,process.env.GITHUB_SHA);
 const admitted=admitNativeAssembly(PLAN.profile);assert.equal(admitted.observationSha256,options.assemblySha256);
 const [{MongoClient,Long,BSON},logical,ownerSdk,indexed,nativeOwner,nativeIndexed,nativeEngineering,modelNative,managed,nativeOwnerSdk]=await Promise.all([
  import('mongodb'),import('@eosrio/hyperion-sdk/projection-stateful'),import('@eosrio/hyperion-sdk/projection-stateful-owner-v2'),import('@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1'),
  import('../../../packages/backend-mongodb/dist/stateful-complete-kind-v1.js'),import('../../../packages/backend-mongodb/dist/stateful-indexed-v1.js'),
  import('../../../packages/backend-mongodb/dist/stateful-indexed-engineering-v1.js'),import('../../../packages/backend-mongodb/dist/stateful-indexed-model-v1.js'),
  import('../../../build/indexer/connections/stateful-complete-kind-client.js'),import('../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js')]);
 assert(!existsSync(options.output));mkdirSync(options.output,{recursive:true});
 const trace=[],samples=[],explains=[],cases=[],ledger=[],attestations=[],namespaces=new Map(),sessions=[],clients=[],reads=new Set(),pools=[],stops=[],captured=[],custody=new Map();
 let phase={name:'preflight'},gate,afterData,afterTransaction,beforeInsert,beforeSnapshot,state,owned=false,failpointGranted=false,primary,serial=100;
 const marker=randomBytes(24).toString('hex'),app=options.database+'_bounded',completeLimits={readAttempts:12,responseRecords:8,responseBytes:65536},noCancel=()=>{};
 const recordClient=(client,label)=>{const item={label,closed:false};clients.push(item);const start=client.startSession.bind(client),close=client.close.bind(client);
  client.startSession=(...args)=>{const session=start(...args),end=session.endSession.bind(session),record={label,ended:false};sessions.push(record);session.endSession=async(...args)=>{try{return await end(...args);}finally{record.ended=session.hasEnded;}};return session;};
  client.close=async(...args)=>{try{return await close(...args);}finally{item.closed=true;}};stops.push(monitorIndexed(client,options.database,label,()=>phase,trace,namespaces));return client;};
 const admin=recordClient(new MongoClient(options.uri,{retryReads:false,retryWrites:false,maxAdaptiveRetries:0,maxPoolSize:2,minPoolSize:0,serverSelectionTimeoutMS:PLAN.operationMS,connectTimeoutMS:PLAN.operationMS,monitorCommands:true,appName:options.database+'_admin'}),'admin');
 const newPool=()=>{const pool=new managed.StatefulCompleteKindMongoClient(()=>({uri:options.uri,options:{monitorCommands:true,appName:app}}),(uri,config)=>recordClient(new MongoClient(uri,config),'managed-'+pools.length));pools.push(pool);return pool;};
 const storage={async load(declaration,source){return custody.get(declaration+source)??null;},async retain(candidate){const key=candidate.declarationDigest+candidate.source.digest,before=custody.get(key);if(before)assert.equal(before.digest,candidate.digest);else custody.set(key,plain(candidate));}};
 const failpoint=data=>admin.db('admin').command({configureFailPoint:'failCommand',mode:{times:1},data:{appName:app,...data}});
 const disable=()=>admin.db('admin').command({configureFailPoint:'failCommand',mode:'off'});
 const configFor=(client,declaration,prefix)=>({client,databaseName:options.database,backendId:options.database,collectionPrefix:prefix,declaration,receiptRetention:4,rollbackRetentionBlocks:4,
  rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:PLAN.operationMS,transactionTimeoutMS:PLAN.transactionMS});
 const make=async(client,prefix='bounded',generation='fresh-indexed-generation',models=[schemaModel(),schemaModel(true)])=>{
  const projection=await logical.captureStatefulDeclaration(projectionDefinition(logical,options.database,generation),projectionLimits()),draft=await ownerSdk.captureStatefulOwnerDeclarationV2(projection,2);
  const config=configFor(client,draft,prefix),base=await nativeOwner.createMongoDbStatefulCompleteKindAdapterV1(config,completeLimits),owner=await ownerSdk.negotiateStatefulOwnerV2(projection,
   {family:ownerSdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported:ownerSdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2,limits:projection.limits},base.capabilities);
  const declarations=await Promise.all(models.map(model=>indexed.captureIndexedDeclarationV1(owner,'owned-native-fixture-v1',model))),requirements=declarations.map(declaration=>({declaration,limits:PLAN.limits}));
  const adapter=await nativeIndexed.createMongoDbStatefulIndexedAdapterV1({...config,declaration:owner},requirements,completeLimits,base),engineering=nativeEngineering.selectMongoDbIndexedEngineeringAssemblyV1(adapter,PLAN.assembly);
  const received=await nativeOwnerSdk.receiveStatefulOwnerDeclarationV2(owner),nativeCapturedOwner=await nativeOwnerSdk.negotiateStatefulOwnerV2(received.projection,
   {family:nativeOwnerSdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported:nativeOwnerSdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2,limits:received.projection.limits},base.capabilities);
  assert.equal(nativeCapturedOwner.digest,owner.digest);
  const entries=await Promise.all(declarations.map(async declaration=>({declaration,native:await modelNative.receiveMongoIndexedModelV1(nativeCapturedOwner,declaration,PLAN.limits),collection:prefix+'_ix1_'+declaration.digest+'_r',coverage:prefix+'_ix1_'+declaration.digest+'_c',undo:prefix+'_ix1_'+declaration.digest+'_u'})));
  for(const entry of entries)namespaces.set(entry.collection,entry.declaration.digest);
  return {client,projection,owner,nativeCapturedOwner,config:{...config,declaration:owner},base,adapter,engineering,entries,identity:{id:prefix+'-owner',generation:'one'}};
 };
 const setExpected=async s=>{const recovery=await s.adapter.recovery();phase={...phase,expected:recovery.view,owner:s.identity,ownerClaim:recovery.owner?.claimDigest,ownerDeclaration:s.owner.digest};return recovery;};
 const closeRead=(adapter,read)=>{adapter.closeRead(read);reads.delete(read);};
 const open=async(s=state,which=0,guard=noCancel)=>{const current=await setExpected(s),entry=s.entries[which],adapter=await s.engineering.indexedForModel(current.view,entry.declaration.digest,guard),read=await adapter.completedRead(s.identity,current.view,guard);reads.add(read);return {adapter,read,expected:current.view,entry};};
 const attest=(start,result,maximum)=>{const evidence=verifyIndexedTrace(trace.slice(start),phase.name,{attempts:result.attempts,maximum,success:true});assert(attestations.length<1024);
  attestations.push({phase:phase.name,model:result.queryDeclarationDigest,view:result.view,trace:[start,trace.length],maximum,...evidence});};
 const direct=async(request,limits=PLAN.limits,which=0,s=state,guard=noCancel)=>{const active=await open(s,which,guard),start=trace.length;
  try{const result=await active.adapter.queryCompleted(active.read,active.expected,request,limits,active.entry.declaration);attest(start,result,limits.readAttempts);return result;}finally{closeRead(active.adapter,active.read);}};
 const compose=async(use,limits=PLAN.limits,which=0,s=state,guard=noCancel)=>{const current=await setExpected(s),entry=s.entries[which],adapter=await s.engineering.indexedForModel(current.view,entry.declaration.digest,guard);
  const selection=indexed.negotiateIndexedQueryV1(entry.declaration,limits,{family:indexed.STATEFUL_INDEXED_QUERY_FAMILY_V1,interfaceVersion:1,queryDeclarationDigests:[entry.declaration.digest],comparisonProfiles:[PLAN.comparison],limits:PLAN.limits},adapter.indexedCapabilities);
  // Track the very same locally issued completed read without wrapping its capability or minting authority.
  const wrapped=Object.freeze({...adapter,async completedRead(...args){const read=await adapter.completedRead(...args);reads.add(read);return read;},closeRead(read){closeRead(adapter,read);},
   async queryCompleted(...args){const start=trace.length,result=await adapter.queryCompleted(...args);attest(start,result,args[3].readAttempts);assert(ledger.length<1024);ledger.push({phase:phase.name,kind:args[2].kind,remaining:args[3],attempts:result.attempts,
    resultSlots:result.result.kind==='count'?1:result.result.rows.length,rawBytes:Buffer.byteLength(JSON.stringify(result)),rawCharacters:JSON.stringify(result).length});return result;}});
  return indexed.composeStatefulOwnerIndexedReadV1(selection,wrapped,s.identity,current.view,use,guard);
 };
 const raw=async(s=state,id=++serial)=>{const previous=(await s.adapter.recovery()).view;return ownerSdk.captureStatefulRawTargetV2(s.owner,{schemaVersion:2,chainId:s.projection.definition.binding.chainId,declarationDigest:s.owner.digest,owner:s.identity,previous,
  block:{blockNum:previous.checkpoint.blockNum+1,blockId:hex(id),previousBlockId:previous.checkpoint.blockId},rawSource:{commitId:'synthetic:'+hex(id),selectionId:'synthetic-selection:'+hex(id),observationId:'synthetic-observation:'+hex(id),observationDigest:hex(id+1000)}});};
 const apply=async(changes,s=state,target)=>{target??=await raw(s);await s.adapter.admitRaw(s.lease,target);const source={previous:target.target.previous.checkpoint,block:{...target.target.block,timeMs:'1001'},inputs:[]};
  await ownerSdk.executeStatefulOwnerBlockV2(s.owner,s.adapter,s.lease,target.digest,source,storage,async port=>{for(const change of changes)if(change.remove)port.delete(change.kind,change.key);else port.put(change.kind,change.key,change.value);},noCancel);
  const candidate=[...custody.values()].find(value=>value.source.source.block.blockId===target.target.block.blockId&&value.declarationDigest===s.owner.digest);assert(candidate);
  await s.adapter.retireRaw(s.lease,target.digest,candidate.source.digest,candidate.digest);return target;};
 const renew=async(s=state)=>{const recovery=await s.adapter.recovery();s.identity={...s.identity,generation:'owner-'+(++serial)};s.lease=await s.adapter.acquireOwner({expected:{version:recovery.version,view:recovery.view,owner:recovery.owner},nextOwner:s.identity},noCancel);};
 const rollback=async(ancestor,s=state)=>{const before=await s.adapter.recovery();await s.adapter.rollbackOwned(s.lease,{declarationDigest:s.owner.digest,revision:before.view.revision,operationId:hex(++serial),from:before.view.checkpoint,ancestor,maxBlocks:before.view.checkpoint.blockNum-ancestor.blockNum});await renew(s);};
 const legacy=async(s=state,kind='schema')=>{const current=await setExpected(s),read=await s.adapter.completedRead(s.identity,current.view,noCancel);reads.add(read);try{return await s.adapter.readCompletedKind(read,current.view,kind,completeLimits);}finally{closeRead(s.adapter,read);}};
 const phaseWork=async(suffix,work)=>{const previous=phase;phase={...phase,name:previous.name+':'+suffix};try{return await work();}finally{phase=previous;}};
 const verify=(answer,success=true)=>verifyIndexedTrace(trace,phase.name,{attempts:answer?.attempts,maximum:PLAN.limits.readAttempts,success});
 const specOptions=spec=>({name:spec.name,unique:spec.unique,...(spec.partial?{partialFilterExpression:spec.partial}:{}),collation:{locale:'simple'},maxTimeMS:PLAN.operationMS,timeoutMS:PLAN.operationMS});
 const rowCollection=entry=>admin.db(options.database).collection(entry.collection);
 const coverageCollection=entry=>admin.db(options.database).collection(entry.coverage);
 const report={schemaVersion:1,status:'running',plan:PLAN,source:admitted,database:options.database,cases,acceptance:{...PLAN.acceptance},sourceAuthority:'Synthetic empty-input SDK/native effects only; no Antelope/Wire or managed HTTP authority',
  runtime:{node:process.version,executableSha256:sha(readFileSync(process.execPath))},metrics:{attempts:'Actual tagged indexed aggregate/getMore; authority/index/explain/cleanup recorded separately',responseBytes:'Complete UTF-8 native envelopes and SDK composition, including counts',replyBsonBytes:'Monitored BSON document estimates; not wire or compression bytes'}};
 const caseRun=async(name,work)=>{phase={name};const start=trace.length,attested=attestations.length;try{const value=await work();cases.push({name,status:'pass',...value,trace:[start,trace.length],successfulQueries:attestations.length-attested});}catch(error){cases.push({name,status:'failed',error:failure(error),trace:[start,trace.length]});throw error;}finally{gate=afterData=afterTransaction=beforeInsert=beforeSnapshot=undefined;}};
 try{
  await admin.connect();const hello=await admin.db('admin').command({hello:1}),build=await admin.db('admin').command({buildInfo:1});assert.equal(build.version,PLAN.server);assert.equal(hello.isWritablePrimary,true);assert.equal(hello.setName,options.replicaSet);assert.equal(hello.me,options.member);assert.deepEqual(hello.hosts,[options.member]);report.server={version:build.version,replicaSet:hello.setName,member:hello.me};
  const baseline=await admin.db('admin').command({getParameter:1,'failpoint.failCommand':1});assert.equal(baseline['failpoint.failCommand'].mode,0);failpointGranted=true;
  assert.deepEqual(await admin.db(options.database).listCollections().toArray(),[]);await admin.db(options.database).collection('_qualification_owner').insertOne({_id:marker,scope:PLAN.scope},{writeConcern:{w:'majority',j:true}});owned=true;
  const pool=newPool(),client=await pool.get(PLAN.operationMS);state=await make(client);state.pool=pool;
  const hookClient=s=>stops.push(installIndexedCommandHooks(s.client,options.database,namespaces,{beforeData:async(input,session)=>{captured.push({phase:phase.name,input:bsonCopy(input)});await gate?.(input,session);},
   afterData:async(...args)=>await afterData?.(...args),afterTransaction:async(...args)=>await afterTransaction?.(...args),beforeSidecarInsert:async(...args)=>await beforeInsert?.(...args),beforeSnapshot:async(...args)=>await beforeSnapshot?.(...args)}));hookClient(state);
  await dispatchCases({
   'default-profile-and-genuine-binding':async()=>{
    assert.deepEqual(state.adapter.indexedCapabilities.comparisonProfiles,[]);assert.deepEqual(state.adapter.indexedCapabilities.queryDeclarationDigests,[]);
    assert.throws(()=>nativeEngineering.selectMongoDbIndexedEngineeringAssemblyV1(state.adapter,'current103'));
    const view={declarationDigest:state.owner.digest,backendId:options.database,generation:state.projection.definition.binding.generation,revision:hex(20),checkpoint:{blockNum:0,blockId:hex(0)}};
    await assert.rejects(state.adapter.indexedForModel(view,state.entries[0].declaration.digest,noCancel));
    for(const changes of [{client:admin},{databaseName:options.database+'_other'},{collectionPrefix:'foreign'},{receiptRetention:3},{operationTimeoutMS:4999}]){
     const before=trace.length;await assert.rejects(nativeIndexed.createMongoDbStatefulIndexedAdapterV1({...state.config,...changes},state.entries.map(entry=>({declaration:entry.declaration,limits:PLAN.limits})),completeLimits,state.base));assert.equal(trace.length,before);
    }
    const sql=await make(client,'sql_refusal','fresh-indexed-generation',[{...schemaModel(),textComparison:'atomicassets-sql-en-us-utf8-unqualified'}]);const before=trace.length;
    await assert.rejects(sql.engineering.indexedForModel(view,sql.entries[0].declaration.digest,noCancel));assert.equal(trace.length,before);
    for(const model of [{...schemaModel(),orders:[[{field:'assets',direction:'desc',nulls:'last'}]]},{...schemaModel(),fields:schemaModel().fields.map(field=>field.id==='authorized'?{...field,operators:['contains']}:field)},
     {...schemaModel(),fields:schemaModel().fields.map(field=>field.id==='schema'?{...field,operators:['gte']}:field)}]){
     await assert.rejects(async()=>{const declaration=await indexed.captureIndexedDeclarationV1(state.owner,'unsupported',model),native=await modelNative.receiveMongoIndexedModelV1(state.nativeCapturedOwner,declaration,PLAN.limits);modelNative.mongoIndexedIndexesV1(native);});
    }return {defaultProductionOffers:'empty',genuineNamespaceAndPolicyMismatches:5,SQLComparison:'refused'};
   },
   'genesis-index-and-coverage':async()=>{
    state.lease=await state.adapter.acquireOwner({expected:null,nextOwner:state.identity},noCancel);const entry=state.entries[0],result=await direct(count());assert.equal(result.result.value,'0');verify(result);
    const spec=modelNative.mongoIndexedIndexesV1(entry.native).find(x=>x.name.startsWith('h45_ix_b_')),collection=rowCollection(entry);
    for(const mode of ['missing','hidden','wrong-key','partial','non-simple'])await phaseWork(mode,async()=>{
     if(mode==='hidden')await admin.db(options.database).command({collMod:entry.collection,index:{name:spec.name,hidden:true}});else{await collection.dropIndex(spec.name);if(mode!=='missing')await collection.createIndex(mode==='wrong-key'?{alias:1}:spec.key,{...specOptions(spec),...(mode==='partial'?{partialFilterExpression:{alias:'schema'}}:{}),...(mode==='non-simple'?{collation:{locale:'en',strength:3}}:{})});}
     try{await assert.rejects(direct(count()));assert.equal((await direct(count(),PLAN.limits,1)).result.value,'0');assert.deepEqual((await legacy()).rows,[]);}
     finally{if(mode==='hidden')await admin.db(options.database).command({collMod:entry.collection,index:{name:spec.name,hidden:false}});else{if(mode!=='missing')await collection.dropIndex(spec.name);await collection.createIndex(spec.key,specOptions(spec));}}
    });
    const coverage=coverageCollection(entry),original=await coverage.findOne({_id:entry.declaration.digest});
    for(const patch of [{ready:false,reason:'qualification-refusal'},{generation:'old-generation'},{representation:'old-v0'},{revision:hex(999)},{checkpoint:{blockNum:0,blockId:hex(999)}}]){
     await coverage.replaceOne({_id:original._id},{...original,...patch});try{await assert.rejects(direct(count()));assert.equal((await direct(count(),PLAN.limits,1)).result.value,'0');}finally{await coverage.replaceOne({_id:original._id},original);}
    }samples.push({case:phase.name,indexes:await collection.listIndexes().toArray(),genesisCoverage:original});return {independentModelReadiness:true,indexRefusals:5,coverageRefusals:5};
   },
   'typed-transactional-materialization':async()=>{
    await apply(corpus());const entry=state.entries[0],sidecar=await rowCollection(entry).findOne({_id:modelNative.indexedRowIdV1(entry.declaration.digest,'schema','s:a')},{promoteLongs:false});
    assert(Long.isLong(sidecar.v.created));assert.equal(sidecar.v.created.toString(),'9007199254740993');const canonical=await admin.db(options.database).collection('bounded_stateful_v2_r_'+state.owner.digest).findOne({kind:'schema',key:'s:a'});assert.equal(sidecar.json,canonical.json);
    samples.push({case:phase.name,canonical,sidecar:bsonEvidence(sidecar),coverage:await coverageCollection(entry).findOne({_id:entry.declaration.digest})});
    const before=await state.adapter.recovery(),coverageBefore=await coverageCollection(entry).findOne({_id:entry.declaration.digest}),target=await raw(),seed=corpus().find(row=>row.key==='s:a'),change={...seed,value:{...seed.value,format:[{name:'transaction-fault-sentinel',type:'string'}]}};
    beforeInsert=async()=>{beforeInsert=undefined;await failpoint({failCommands:['insert'],errorCode:2,errorLabels:[]});};
    await assert.rejects(apply([change],state,target));assert.equal(beforeInsert,undefined,'Actual sidecar insert failure gate not reached');assert.deepEqual((await state.adapter.recovery()).view.checkpoint,before.view.checkpoint);
    const afterFailure=await rowCollection(entry).findOne({_id:sidecar._id},{promoteLongs:false}),canonicalAfterFailure=await admin.db(options.database).collection('bounded_stateful_v2_r_'+state.owner.digest).findOne({kind:'schema',key:'s:a'});
    assert.equal(afterFailure.json,sidecar.json);assert.equal(canonicalAfterFailure.json,canonical.json);assert.deepEqual(await coverageCollection(entry).findOne({_id:entry.declaration.digest}),coverageBefore);
    await disable();await apply([change],state,target);const repairedCanonical=await admin.db(options.database).collection('bounded_stateful_v2_r_'+state.owner.digest).findOne({kind:'schema',key:'s:a'}),repairedSidecar=await rowCollection(entry).findOne({_id:sidecar._id},{promoteLongs:false});
    assert.notEqual(repairedCanonical.json,canonical.json);assert.equal(repairedSidecar.json,repairedCanonical.json);assert.match(repairedCanonical.json,/transaction-fault-sentinel/);
    samples.push({case:phase.name,failedChangedSentinel:{canonicalBefore:canonical,canonicalAfterFailure,sidecarBefore:bsonEvidence(sidecar),sidecarAfterFailure:bsonEvidence(afterFailure),coverageBefore,repairedCanonical,repairedSidecar:bsonEvidence(repairedSidecar)}});
    for(const changes of [[{...corpus().find(row=>row.key==='c:one'),value:{...corpus().find(row=>row.key==='c:one').value,authorized_accounts:123}}],[{...corpus().find(row=>row.key==='c:one'),key:'c:duplicate'}]]){
     const ancestor=(await state.adapter.recovery()).view.checkpoint;await apply(changes);await assert.rejects(direct(count()));assert.equal((await direct(count(),PLAN.limits,1)).result.value,ORACLE.controlCount);
     assert((await legacy(state,'collection')).rows.some(row=>row.key===changes[0].key));await rollback(ancestor);assert.equal((await direct(count())).result.value,ORACLE.joinedCount);
    }return {physicalLong:true,atomicStorageFailure:true,modelLocalPoisonAndRollback:true};
   },
   'page-count-and-model-dispatch':async()=>{
    const result=await compose(async read=>({page:await read.query(page()),count:await read.query(count()),second:await read.query(page({offset:'3'}))}));assert.equal(result.value.count.value,ORACLE.joinedCount);assert.equal(result.value.page.rows[0].key,ORACLE.firstJoined);
    const all=await direct(page({limit:8})),control=await direct(page({},true),PLAN.limits,1);assert.equal(control.result.rows[0].key,ORACLE.firstControl);assert.equal((await direct(count(),PLAN.limits,1)).result.value,ORACLE.controlCount);
    assert.equal(all.result.rows.find(row=>row.key==='s:c').fields.assets,null);assert.equal(all.result.rows.find(row=>row.key==='s:a').fields.assets,'0');assert.equal(all.result.rows.find(row=>row.key==='s:d').fields.assets,'9007199254740993');
    assert(!all.result.rows.some(row=>['s:orphan','s:foreign'].includes(row.key)));return {joinedCount:ORACLE.joinedCount,controlCount:ORACLE.controlCount,pageAndCountOneOwnerView:true,composedBytes:Buffer.byteLength(JSON.stringify(result))};
   },
   'windows-order-and-int64':async()=>{
    for(const [name,request,keys]of [['empty',page({where:[{field:'contract',op:'eq',value:'absent'}]}),[]],['short',page({offset:'5',limit:2}),['s:f']],['full',page({offset:'3',limit:2}),['s:a','s:e']],['beyond',page({offset:'99'}),[]],['large-int64-offset',page({offset:'9223372036854775807'}),[]],['schema-order',page({order:schemaModel().orders[1],limit:8}),ORACLE.schemaAscending]])await phaseWork(name,async()=>{const result=await direct(request);assert.deepEqual(result.result.rows.map(row=>row.key),keys);verify(result);});
    await phaseWork('created-peers',async()=>{const result=await direct(page({limit:8}));assertCreatedPeers(result.result.rows);verify(result);});
    const counted=await direct(count());assert.equal(counted.result.value,'6');const replies=trace.filter(row=>row.phase===phase.name&&row.countTypes?.length);assert(replies.length);assert(replies.every(row=>row.countTypes.every(x=>x.value==='Long'&&x.invalid==='Long')));return {nativeSimpleOnly:true,hugePhysicalCardinality:'not-claimed'};
   },
   'sealed-explain':async()=>{
    for(const request of [page(),page({order:schemaModel().orders[1]}),count()]){
     const before=await state.adapter.recovery(),start=captured.length;await direct(request);const actual=captured.slice(start).find(row=>row.input.aggregate).input;
     const command={aggregate:actual.aggregate,pipeline:actual.pipeline,hint:actual.hint,collation:actual.collation,allowDiskUse:actual.allowDiskUse,cursor:{batchSize:1},maxTimeMS:PLAN.operationMS};
     const explanation=await admin.db(options.database).command({explain:command,verbosity:'executionStats'},{promoteLongs:false,signal:AbortSignal.timeout(PLAN.operationMS)});
     assert.deepEqual((await state.adapter.recovery()).view,before.view);const checked=verifyExplain(explanation,{baseHint:actual.hint,lookupIndexes:modelNative.mongoIndexedIndexesV1(state.entries[0].native).filter(row=>row.name.startsWith('h45_ix_l_')).map(row=>row.name)});
     explains.push({pipelineSha256:sha(BSON.serialize({pipeline:actual.pipeline})),actualCommand:bsonEvidence(command),explain:bsonEvidence(explanation),checked,sealedView:before.view});
    }return {actualBsonPipelines:explains.length,explainOutsideServingTransaction:true};
   },
   'update-delete-and-canonical-fork':async()=>{
    const ancestor=(await state.adapter.recovery()).view.checkpoint,original=corpus().find(row=>row.key==='s:a');await apply([{...original,value:{...original.value,format:[{name:'updated',type:'string'}]}}]);
    await apply([{kind:'collection',key:'c:one',remove:true}]);assert.equal((await direct(count())).result.value,'1');await apply([corpus().find(row=>row.key==='c:one')]);assert.equal((await direct(count())).result.value,'6');
    await apply([{kind:'schema',key:'s:e',remove:true}]);assert.equal((await direct(count())).result.value,'5');await rollback(ancestor);
    assert.equal((await direct(count())).result.value,'6');const bbb=await apply([{...original,value:{...original.value,created_at_time:'9007199254740999'}}]);assert.equal((await direct(page())).result.rows[0].key,'s:a');
    await rollback(ancestor);const ccc=await apply([{...original,value:{...original.value,created_at_time:'9007199254740990'}}]);assert.notEqual(bbb.target.block.blockId,ccc.target.block.blockId);assert.equal((await direct(page())).result.rows[0].key,'s:d');
    // Original retention is four blocks: old history refuses, without a reconstructed kind scan.
    const genesis=await make(state.client,'covered_genesis','covered-genesis-generation');genesis.lease=await genesis.adapter.acquireOwner({expected:null,nextOwner:genesis.identity},noCancel);
    const coveredZero=(await genesis.adapter.recovery()).view.checkpoint;await apply(corpus(),genesis);assert.equal((await direct(count(),PLAN.limits,0,genesis)).result.value,'6');
    await rollback(coveredZero,genesis);assert.equal((await direct(count(),PLAN.limits,0,genesis)).result.value,'0');assert.deepEqual((await direct(page(),PLAN.limits,0,genesis)).result.rows,[]);
    const zero=await setExpected(genesis),zeroRead=await genesis.adapter.completedRead(genesis.identity,zero.view,noCancel);reads.add(zeroRead);
    try{const keyed=await genesis.adapter.readCompleted(zeroRead,zero.view,corpus().map(row=>({kind:row.kind,key:row.key})));assertCoveredAbsence(keyed,corpus().length);}
    finally{closeRead(genesis.adapter,zeroRead);}
    const cleared=[];for(const entry of genesis.entries){let checked=0;for(const row of corpus())for(const alias of [entry.declaration.model.base,...entry.declaration.model.joins].filter(alias=>alias.kind===row.kind)){
     const present=await rowCollection(entry).findOne({_id:modelNative.indexedRowIdV1(entry.declaration.digest,alias.alias,row.key)},{projection:{_id:1}});assert.equal(present,null);checked++;}
     const coverage=await coverageCollection(entry).findOne({_id:entry.declaration.digest});assert.deepEqual(coverage,{_id:entry.declaration.digest,representation:'h45-owner-indexed-materialization-v1',owner:genesis.owner.digest,
      model:entry.declaration.digest,generation:zero.view.generation,revision:zero.view.revision,checkpoint:zero.view.checkpoint,ready:true,reason:null});cleared.push({model:entry.declaration.digest,absentTypedRows:checked,coverage});}
    samples.push({case:phase.name,coveredGenesis:{view:zero.view,absentCanonicalKeys:corpus().length,emptyPageAndCount:true,typedModels:cleared}});
    const retention=await make(state.client,'retention','retention-generation');retention.lease=await retention.adapter.acquireOwner({expected:null,nextOwner:retention.identity},noCancel);
    const oldAncestor=(await retention.adapter.recovery()).view.checkpoint,targets=[];for(let i=0;i<5;i++)targets.push(await apply([],retention));
    const undo=[];for(const [index,target]of targets.entries())for(const entry of retention.entries){const image=await admin.db(options.database).collection(entry.undo).findOne({_id:sha(target.target.block.blockId)});
     assert.equal(image!==null,index>0);undo.push({model:entry.declaration.digest,block:target.target.block,imagePresent:image!==null});}
    samples.push({case:phase.name,retained:await retention.adapter.retainedCheckpoints(retention.lease),undo});await assert.rejects(rollback(oldAncestor,retention));return {actualRollbackAndReplacement:true,coveredGenesisRollback:true,versionedUndoPruned:true,oldHistoryRefused:true};
   },
   'reopen-and-generation-refusal':async()=>{
    const old=await open(),previous=state;closeRead(old.adapter,old.read);await previous.pool.close();await assert.rejects(previous.pool.get(PLAN.operationMS));
    const pool=newPool(),client=await pool.get(PLAN.operationMS);state=await make(client);state.pool=pool;hookClient(state);await renew(state);assert.equal((await direct(count())).result.value,'6');await assert.rejects(state.engineering.queryCompleted(old.read,old.expected,count(),PLAN.limits,state.entries[0].declaration));
    const legacyState=await make(client,'legacy_populated','legacy-generation');
    // Populate through its genuine get/complete-kind base before indexed owner initialization.
    legacyState.lease=await legacyState.base.acquireOwner({expected:null,nextOwner:legacyState.identity},noCancel);
    const baseAdapter=legacyState.adapter;legacyState.adapter=legacyState.base;await apply([corpus().find(row=>row.key==='s:a')],legacyState);legacyState.adapter=baseAdapter;await renew(legacyState);
    await assert.rejects(direct(count(),PLAN.limits,0,legacyState));assert.equal((await legacy(legacyState)).rows.length,1);
    const next=await make(client,'new_generation','explicit-new-generation');next.lease=await next.adapter.acquireOwner({expected:null,nextOwner:next.identity},noCancel);assert.equal((await direct(count(),PLAN.limits,0,next)).result.value,'0');
    const changed=await make(client,'bounded','different-mapping-generation');await assert.rejects(changed.adapter.recovery());return {freshClientAndOwner:true,populatedGenerationRefused:true,newEmptyGenerationExplicit:true};
   },
   'cumulative-and-receiving-budgets':async()=>{
    const active=await open();try{
     for(const [request,budget]of [[count(),{responseRecords:0}],[page(),{queryBytes:1}],[page(),{predicates:0}],[page(),{orderTerms:0}],
      [page({where:[{field:'contract',op:'eq',value:'atomicassets'},{field:'schema',op:'in',values:['Alpha','beta']}]}),{setValues:1}]]){
      const before=trace.length;await assert.rejects(active.adapter.queryCompleted(active.read,active.expected,request,{...PLAN.limits,...budget},active.entry.declaration));assert.equal(trace.length,before,'Insufficient syntax/count allowance performed native work');
     }
    }finally{closeRead(active.adapter,active.read);}
    const boundary=page({limit:1}),baseline=await direct(boundary),bytes=Buffer.byteLength(JSON.stringify(baseline));assert.equal((await direct(boundary,{...PLAN.limits,responseBytes:bytes})).result.rows.length,1);await assert.rejects(direct(boundary,{...PLAN.limits,responseBytes:bytes-1}));
    await assert.rejects(direct(page(),{...PLAN.limits,responseRecords:1}));
    await assert.rejects(compose(async read=>({page:await read.query(page()),count:await read.query(count())}),{...PLAN.limits,responseRecords:2}));
    await assert.rejects(compose(async read=>({page:await read.query(page()),count:await read.query(count())}),{...PLAN.limits,readAttempts:1}));
    const callback=async read=>({page:await read.query(boundary),count:await read.query(count())}),start=ledger.length,one=await compose(callback),charged=ledger.slice(start);
    assert.equal(charged.length,2);assert.equal(charged[1].resultSlots,1);assert(charged[0].rawBytes>charged[0].rawCharacters,'UTF-8 byte control did not distinguish characters');
    const totalBytes=charged.reduce((sum,row)=>sum+row.rawBytes,0)+Buffer.byteLength(JSON.stringify(one));await compose(callback,{...PLAN.limits,responseBytes:totalBytes});await assert.rejects(compose(callback,{...PLAN.limits,responseBytes:totalBytes-1}));
    samples.push({case:phase.name,budgetLedger:ledger.filter(row=>row.phase===phase.name),composedEnvelopeBytes:Buffer.byteLength(JSON.stringify(one)),cumulativeBytes:totalBytes});
    const aggregate=trace.filter(row=>row.phase===phase.name&&row.event==='started'&&row.model&&['aggregate','getMore'].includes(row.command));assert(aggregate.length);
    let triggered=false;gate=async input=>{if(input.aggregate===undefined)return;gate=undefined;triggered=true;await failpoint({failCommands:['aggregate'],errorCode:112,errorLabels:['TransientTransactionError']});};
    await phaseWork('callback-retry',async()=>{const result=await direct(page());assert(triggered);assert(result.attempts>=3);verify(result);});
    return {receivingPreIORefusals:5,exactEnvelopeBytes:bytes,composedCountBytes:Buffer.byteLength(JSON.stringify(one)),retryAttemptsDoNotReset:true};
   },
   'native-failure-deadline-and-cleanup':async()=>{
    for(const command of ['aggregate','getMore'])await phaseWork(command,async()=>{gate=async input=>{if(input[command]===undefined)return;gate=undefined;await failpoint({failCommands:[command],errorCode:2,errorLabels:['SystemOverloadedError','RetryableError']});};
     await assert.rejects(direct(page()));assert.equal(gate,undefined);const evidence=verify(undefined,false);assert.equal(trace.filter(row=>row.phase===phase.name&&row.event==='failed'&&row.command===command).length,1);assert(evidence.actualDataAttempts<=2);});
    await phaseWork('deadline',async()=>{gate=async input=>{if(input.aggregate===undefined)return;gate=undefined;await failpoint({failCommands:['aggregate'],blockConnection:true,blockTimeMS:PLAN.operationMS*2});};const started=Date.now();await assert.rejects(direct(page()));assert.equal(gate,undefined);
     assert(trace.some(row=>row.phase===phase.name&&row.event==='failed'&&row.command==='aggregate'));samples.push({case:phase.name,elapsedMS:Date.now()-started,operationMS:PLAN.operationMS});await disable();});
    await phaseWork('late-cancel',async()=>{let cancelled=false;afterData=async()=>{afterData=undefined;cancelled=true;};await assert.rejects(direct(page(),PLAN.limits,0,state,()=>{if(cancelled)throw new Error('qualification-cancelled-after-native-reply');}));assert(cancelled);verify(undefined,false);});
    return {originalCursorClosure:verifyCursorClosure(trace),managedRetries:false};
   },
   'owner-source-and-publication-fences':async()=>{
    await phaseWork('coverage-before-snapshot',async()=>{const entry=state.entries[0],collection=coverageCollection(entry),original=await collection.findOne({_id:entry.declaration.digest});
     beforeSnapshot=async()=>{beforeSnapshot=undefined;await collection.replaceOne({_id:original._id},{...original,ready:false,reason:'changed-before-data-snapshot'});};
     try{await assert.rejects(direct(page()));assert.equal(beforeSnapshot,undefined);assert.equal(verify(undefined,false).actualDataAttempts,0);}finally{await collection.replaceOne({_id:original._id},original);}});
    await phaseWork('advance-after-data',async()=>{afterData=async()=>{afterData=undefined;await apply([]);};await assert.rejects(direct(page()));assert.equal(afterData,undefined);verify(undefined,false);});
    await phaseWork('gap-after-data',async()=>{let pending;afterData=async()=>{afterData=undefined;pending=await raw();await state.adapter.admitRaw(state.lease,pending);await state.adapter.markRawFailure(state.lease,pending.digest,'qualification-native-gap');};await assert.rejects(direct(page()));assert(pending);await apply([],state,pending);});
    await phaseWork('takeover-after-data',async()=>{afterData=async()=>{afterData=undefined;await renew();};await assert.rejects(direct(page()));assert.equal(afterData,undefined);});
    await phaseWork('index-after-commit',async()=>{const entry=state.entries[0],spec=modelNative.mongoIndexedIndexesV1(entry.native).find(x=>x.name.startsWith('h45_ix_b_'));afterTransaction=async()=>{afterTransaction=undefined;await rowCollection(entry).dropIndex(spec.name);};
     try{await assert.rejects(direct(page()));assert.equal(afterTransaction,undefined,'Actual indexed commit gate not reached');}finally{await rowCollection(entry).createIndex(spec.key,specOptions(spec));}});
    let cancelled=false;const result=await compose(async read=>({count:await read.query(count())}),PLAN.limits,0,state,()=>{if(cancelled)throw new Error('Original publication guard cancelled');});indexed.assertIndexedQueryPublicationV1(result);cancelled=true;assert.throws(()=>indexed.serializeIndexedQueryResultV1(result));
    return {actualOwnerSourceFences:true,nativePublicationRevocation:true,actualManagedHTTP:'pending'};
   }
  },caseRun);
 }catch(error){primary=error;report.failure=failure(error);}
 finally{
  phase={name:'cleanup'};const cleanup={managedClientsClosed:false,sessionsEnded:false,readsClosed:reads.size===0,cursorsClosed:false,failpointDisabled:false,databaseDropped:false,adminClosed:false};report.cleanup=cleanup;
  const clean=async(name,work)=>{try{await work();}catch(error){primary??=error;cleanup[name]=failure(error);}};
  await clean('failpointFailure',async()=>{if(failpointGranted){await disable();cleanup.failpointDisabled=true;}});
  await clean('managedClientFailure',async()=>{for(const pool of pools)await pool.close();cleanup.managedClientsClosed=clients.filter(row=>row.label.startsWith('managed-')).every(row=>row.closed);assert(cleanup.managedClientsClosed);});
  await clean('sessionFailure',async()=>{cleanup.sessionsEnded=sessions.every(row=>row.ended);assert(cleanup.sessionsEnded);assert(cleanup.readsClosed);cleanup.sessionCount=sessions.length;});
  await clean('cursorFailure',async()=>{cleanup.cursors=verifyCursorClosure(trace);cleanup.cursorsClosed=true;});
  await clean('databaseFailure',async()=>{if(owned){const record=await admin.db(options.database).collection('_qualification_owner').findOne({_id:marker});assert.equal(record?.scope,PLAN.scope);await admin.db(options.database).dropDatabase({writeConcern:{w:'majority',j:true}});assert.deepEqual(await admin.db(options.database).listCollections().toArray(),[]);cleanup.databaseDropped=true;}});
  await clean('adminFailure',async()=>{await admin.close();cleanup.adminClosed=clients.find(row=>row.label==='admin').closed;assert(cleanup.adminClosed);});for(const stop of stops)stop();
  report.status=primary?'failed':'passed-native-indexed-only';report.traceEvents=trace.length;report.successfulQueryAttestations=attestations;report.acceptance.nativeMongoDB=primary?'failed':'passed-native-indexed-only';if(primary)report.failure??=failure(primary);
  for(const [name,value]of [['trace.json',trace],['samples.json',samples],['explain.json',explains],['report.json',report]])json(join(options.output,name),value);
  json(join(options.output,'sha256.json'),['trace.json','samples.json','explain.json','report.json'].map(path=>{const raw=readFileSync(join(options.output,path));return {path,bytes:raw.length,sha256:sha(raw)};}));
 }if(primary)throw primary;return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const options=argumentsFor(process.argv.slice(2),process.env);if(options===null)console.log(JSON.stringify({status:'inert-plan-only',plan:PLAN}));else{const report=await run(options);console.log(JSON.stringify({status:report.status,output:options.output}));}}catch(error){console.error(JSON.stringify({status:'failed',error:failure(error)}));process.exitCode=1;}}
