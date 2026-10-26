/** Original native hold at397; controlled canonical/storage reads, stop at the independent proof guard. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join,dirname,basename,resolve} from 'node:path';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
import {auditPortableWorkerSource,portableWorkerSourceFrame,portableSourceHash} from '../../scripts/qualification/portable-state-worker-source.ts';
import {auditPortableNativeOracle,createPortableNativeQualification,portableNativeProfile} from '../../scripts/qualification/portable-state-worker-native.ts';
import {createPortableHistoryDiagnostics} from '../../scripts/qualification/portable-state-history-diagnostics.ts';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolNativeObservationStore} from '../../build/indexer/protocol/native-observation-store.js';
import {ProtocolNativeActionReader} from '../../build/indexer/protocol/native-authorization.js';
import {snapshotProtocolNativeDecisions,protocolNativeInputInventory} from '../../build/indexer/protocol/native-observation-facts.js';
import {protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';
import {deriveProtocolActionOccurrences} from '../../build/indexer/history/action-source-inventory.js';
import {ActionSourceAdmissionStore} from '../../build/indexer/history/action-source-admission.js';
import {ActionHistorySourceJournal,ActionHistorySourceJournalReadError} from '../../build/indexer/history/action-source-journal.js';
import {actionHistoryImmutableJson,fingerprintActionHistoryEffect} from '../../build/indexer/history/action-history-manifest.js';

assertNativeQualificationRuntime();
const bootstrapStarted=performance.now();
const requested=process.argv[2]??'characterize',modes=['visible','delayed','missing','wrong','orphan','timeout','partial','source-incomplete'];
assert.ok([...modes,'characterize','witness'].includes(requested));let mode=requested;
const root=fileURLToPath(new URL('../../',import.meta.url)),temporary=mkdtempSync(join(tmpdir(),'hyperion-native-history-'));
const directory=join(temporary,'source');
try {
 const made=spawnSync(process.platform==='win32'?'python':'python3',[join(root,'tests/fixtures/portable-state-worker/prepare.py'),directory],{encoding:'utf8',timeout:20000});
 assert.equal(made.status,0,made.stderr);
const plan=JSON.parse(readFileSync(join(directory,'plan.json'),'utf8'));
const source=await auditPortableWorkerSource(plan.source,portableNativeProfile),oracle=await auditPortableNativeOracle(source);
const selected=await loadChainProtocol({provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:portableNativeProfile});
const provider=selected.provider,expected=oracle.rows.find(value=>value.blockNum===397);
const raw=portableWorkerSourceFrame(source,397),session=provider.createShipSession(JSON.parse(source.schemaJson));
const [,frame]=session.decodeResult(raw),traces=session.decodeTraces(Buffer.from(frame.traces,'hex'));
const occurrences=deriveProtocolActionOccurrences(traces),inputs=occurrences.map(value=>value.input);
const occurrence=occurrences.find(value=>value.input.transactionId===expected.transactionId&&value.input.actionOrdinal===expected.actionOrdinal);
assert.ok(occurrence);
const position={chainId:source.chainId,blockNum:397,blockId:source.records[396].blockId,previousBlockId:source.records[396].previousBlockId};
const capture={kind:'unattested-ship-result-sections-v1',schemaJson:source.schemaJson,blockHex:frame.block,tracesHex:frame.traces,deltasHex:frame.deltas};
const captureSha=protocolAbiCaptureDigest(position,capture);
const observed=snapshotProtocolNativeDecisions(provider.nativeActions.observe({schemaJson:source.schemaJson,block:Buffer.from(frame.block,'hex'),traces:Buffer.from(frame.traces,'hex')},position),inputs);
session.close?.();
const chain='hyp-p191-334334334334',profile={id:selected.id,profileId:source.profileId,components:selected.components};
const event={kind:'native_boundary',event:'native_prepare_readback',blockNum:397,pid:process.pid,sequence:1192,
 selectionId:'h45srcsel1:'+'a'.repeat(64),linkId:'controlled-link',observationId:'controlled-native',observationDigest:'controlled-digest'};
const events=Array.from({length:397},(_,index)=>[
 {kind:'native_boundary',event:'native_prepare_readback',blockNum:index+1},
 {kind:'native_boundary',event:'source_ack_sent',blockNum:index+1},
]).flat().filter(value=>value.blockNum!==397);
events.push({...event,event:'native_prepare_begin',sequence:1191},event,{...event,event:'source_ack_sent',sequence:1193});
const retained={linkId:event.linkId,link:{observationId:event.observationId,observationDigest:event.observationDigest},
 selection:{frameSha256:portableSourceHash(raw),captureSha256:captureSha},abiObservation:{capture},
 record:{source:position,protocol:profile,captureRef:{inputSha256:captureSha},inventory:protocolNativeInputInventory(inputs),observation:{status:'observed',facts:observed}}};
const data=await provider.nativeActions.decodeValue(expected.nativeKind,Buffer.from(expected.rawHex,'hex'));assert.deepEqual(data,expected.expectedValue);
const physical={block_num:397,block_id:position.blockId,trx_id:expected.transactionId,action_ordinal:expected.actionOrdinal,global_sequence:expected.globalSequence,
 act:{account:'sysio',name:'onblock',data},receipts:[occurrence.receipt],protocol:{schemaVersion:2,kind:'native',input:occurrence.input,
 source:position,native:{nativeKind:expected.nativeKind,profile}}};
const target={name:chain+'-action-v1-000001',uuid:'controlled-original-target'};
const current={id:'controlled-admission',planId:'controlled-plan',incomplete:null,target,
 source:{frameHex:raw.toString('hex'),schemaJson:source.schemaJson,captureSha256:captureSha,previousBlockId:position.previousBlockId,
  inventoryInput:{profileId:source.profileId,source:{chainId:position.chainId,blockNum:397,blockId:position.blockId,
   producer:source.records[396].producer,timestamp:source.records[396].timestamp},sourceSelectionId:event.selectionId,traces},producer:{profileId:source.profileId}}};
const admissionPlan={source:{...position,captureSha256:captureSha},producer:current.source.producer,target};
const witnessDocument={...structuredClone(physical),protocol:{...structuredClone(physical.protocol),selectionId:event.selectionId}};
const manifest={planId:current.planId,fragments:[{transactionId:expected.transactionId,effects:[fingerprintActionHistoryEffect(witnessDocument)]}]};
const witnessBulk=join(temporary,'bulk');mkdirSync(witnessBulk);const receipts=[];
let requestNumber=0;
const seedWitness=kind=>{
 receipts.splice(0);const number=++requestNumber,prefix=String(number).padStart(5,'0'),document=structuredClone(witnessDocument);
 const index=kind==='wrong-target'?chain+'-action-v1-000002':target.name;
 if(kind==='wrong-canonical')document.opaque='changed after the original seal';
 if(kind==='wrong-native')document.trx_id='f'.repeat(64);
 if(kind==='wrong-selection')document.protocol.selectionId='foreign-selection';
 const bytes=Buffer.from(JSON.stringify({create:{_index:index,_id:'637'}})+'\n'+actionHistoryImmutableJson(document)+'\n');
 const response={errors:kind==='failed-item',items:[{create:{_index:index,_id:kind==='wrong-item'?'638':'637',status:kind==='failed-item'?429:201,
  _shards:{total:2,successful:kind==='incomplete-copies'?1:2,failed:0}}}]};
 const reply=Buffer.from(JSON.stringify(response)),held=['held','capture-held','capture-failed','delayed-completion','delayed-invalid','expired','no-budget'].includes(kind);
 writeFileSync(join(witnessBulk,prefix+'-request.ndjson'),bytes,{flag:'wx'});
 if(!held)writeFileSync(join(witnessBulk,prefix+'-response.json'),reply,{flag:'wx'});
 receipts.push({number,path:'/'+chain+'-action-v1/_bulk',captureComplete:!held,status:kind==='failed-http'?503:200,
  operations:[{operation:'create',index,id:'637'}],request:{file:prefix+'-request.ndjson',bytes:bytes.length,sha256:kind==='capture-hash'?'0'.repeat(64):portableSourceHash(bytes)},
  responseBody:{file:prefix+'-response.json',bytes:reply.length,sha256:kind==='response-hash'?'0'.repeat(64):portableSourceHash(reply)},response});
 if(kind==='item-bytes')response.items[0].create.status=202;
};
if(requested==='witness')events.push({kind:'native_boundary',event:'action_admitted',blockNum:397,admissionId:current.id});
const witnessModes=['ready','delayed-completion','held','failed-http','failed-item','incomplete-copies','wrong-target','wrong-item',
 'wrong-canonical','wrong-native','wrong-selection','capture-held','capture-failed','capture-hash','expired','no-budget',
 'seal-pending','incomplete-seal','query-wrong','witness-timeout','witness-partial','witness-source-incomplete','refresh-partial','delayed-invalid',
 'ready-expired','late-witness','slow-refresh','response-hash','item-bytes'];
if(process.argv[3]){assert.ok(witnessModes.includes(process.argv[3]));witnessModes.splice(0,witnessModes.length,process.argv[3]);}
const proofBoundary=new Error('controlled independent proof boundary reached');
const diagnosticDirectory=join(temporary,'history-diagnostics');mkdirSync(diagnosticDirectory);
const errors=[],historyDiagnostics=createPortableHistoryDiagnostics(diagnosticDirectory,errors),results=[];
let reads=0,proofCalls=0,visible=false,observedSearch,refreshCalls=0,phaseBudget,historyWaitCalls=0,sealReleased=false;
const deadlineBoundary=new Error('controlled original phase deadline exhausted'),captureFailure=new Error('controlled bulk capture failure');
const client={async search(request){
 assert.equal(request.query.term.block_num,397);reads++;
 assert.equal(request.index,chain+'-action-*');assert.equal(request.size,1024);assert.equal(request.track_total_hits,true);
 const has=visible||mode==='wrong',body=structuredClone(physical);
 if(mode==='wrong'||mode==='query-wrong')body.trx_id='f'.repeat(64);
 if(mode==='orphan')body.block_id='f'.repeat(64);
 const partial=['partial','witness-partial'].includes(mode);
 const response={timed_out:['timeout','witness-timeout'].includes(mode),_shards:{total:2,successful:partial?1:2,failed:partial?1:0},
  hits:{total:{value:has?1:0,relation:'eq'},hits:has?[{_index:chain+'-action-v1-000001',_id:'637',_source:body}]:[]}};
 observedSearch={controlled:true,request:structuredClone(request),response:structuredClone(response),observedMonotonicNs:process.hrtime.bigint().toString()};
 if(mode==='delayed')queueMicrotask(()=>{visible=true;});return response;
}};
const originals={control:ProtocolAbiFrontierStore.prototype.readControl,commit:ProtocolAbiFrontierStore.prototype.readCommit,
 native:ProtocolNativeObservationStore.prototype.readSelection,open:ProtocolNativeActionReader.prototype.open,
 admission:ActionSourceAdmissionStore.prototype.resolve,plan:ActionHistorySourceJournal.prototype.readPlan,manifest:ActionHistorySourceJournal.prototype.readManifest};
if(requested==='witness'){
 ActionSourceAdmissionStore.prototype.resolve=async id=>{assert.equal(id,current.id);return structuredClone(current);};
 ActionHistorySourceJournal.prototype.readPlan=async id=>{assert.equal(id,current.planId);return {plan:structuredClone(admissionPlan)};};
 ActionHistorySourceJournal.prototype.readManifest=async id=>{assert.equal(id,current.planId);
  if(mode==='late-witness')await new Promise(resolve=>setTimeout(resolve,Math.max(1,phaseBudget.deadline-performance.now()+5)));
  if(mode==='seal-pending'&&!sealReleased)throw new ActionHistorySourceJournalReadError('missing','seal','controlled-seal','not yet sealed');
  if(mode==='incomplete-seal')throw new ActionHistorySourceJournalReadError('incomplete','manifest','controlled-manifest','broken referenced manifest');
  return {id:'controlled-manifest',manifest:structuredClone(manifest)};};
}
ProtocolAbiFrontierStore.prototype.readControl=async()=>({value:{head:{blockNum:397,commitId:'controlled-commit'},profile,phase:'following'}});
ProtocolAbiFrontierStore.prototype.readCommit=async()=>({nativeActionInterfaceVersion:1,source:{blockId:position.blockId}});
ProtocolNativeObservationStore.prototype.readSelection=async id=>{assert.equal(id,event.selectionId);const copy=structuredClone(retained);
 if(['source-incomplete','witness-source-incomplete'].includes(mode)){copy.record.inventory=null;copy.record.observation={status:'incomplete',error:{code:'controlled_source_incomplete'}};}return copy;};
ProtocolNativeActionReader.prototype.open=async()=>{proofCalls++;throw proofBoundary;};
try{
 const qualification=await createPortableNativeQualification({source,oracle,client,chain,apiPort:43210,events:async()=>events,historyDiagnostics,
  wait:async(name,work,budget)=>{
   if(requested!=='witness')return work();
   if(name.startsWith('native PREPARE')){await work();return mode==='no-budget'?undefined:phaseBudget;}
   historyWaitCalls++;assert.equal(budget,phaseBudget,'completion must inherit the exact original phase budget');
   assert.ok(performance.now()<budget.deadline,'expired budget must never start another wait');
   if(mode==='capture-failed')throw captureFailure;
   if(mode==='delayed-completion')seedWitness('ready');if(mode==='delayed-invalid')seedWitness('failed-item');
   if(mode==='seal-pending')sealReleased=true;
   try{await work();}catch(error){if(error.message==='exact original native history write is not completely captured')throw deadlineBoundary;throw error;}
   return budget;
  },http:async()=>assert.fail('proof guard must precede HTTP'),unrelated:async()=>assert.fail('not a complete source/proof fixture'),
  rawHistory:async()=>assert.fail('not a full service fixture'),bulk:{directory:witnessBulk,receipts},
  ...(requested==='witness'?{refreshActions:async(_through,budget)=>{refreshCalls++;assert.equal(budget,phaseBudget);
   if(mode==='slow-refresh')await new Promise(resolve=>setTimeout(resolve,Math.max(1,phaseBudget.deadline-performance.now()+5)));
   visible=true;return {_shards:{total:2,successful:mode==='refresh-partial'?1:2,failed:mode==='refresh-partial'?1:0}};}}:{})});
 const bootstrapElapsedMs=performance.now()-bootstrapStarted;
 for(const next of requested==='characterize'?[...modes,'delayed']:requested==='witness'?witnessModes: [requested]){
  mode=next;reads=0;proofCalls=0;observedSearch=undefined;visible=['visible','orphan','timeout','partial'].includes(mode);
  if(requested==='witness'){refreshCalls=0;historyWaitCalls=0;sealReleased=false;phaseBudget=Object.freeze({deadline:performance.now()+(['expired','ready-expired'].includes(mode)?-1:1000)});seedWitness(mode);}
  const started=performance.now();let error;try{await qualification.hold(397);}catch(value){error=value;}
  const reached=error===proofBoundary;
  const result={mode,node:process.version,reads,proofCalls,refreshCalls,historyWaitCalls,reachedIndependentProofGuard:reached,visibleAfterRead:visible,error:error?.message.slice(0,512),
   originalHoldInvoked:true,originalSourceRows:source.records.length,controlledCanonicalAndStorage:true,proofSuccessFabricated:false,fullWorkerQualification:false,
   originalHoldElapsedMs:performance.now()-started,bootstrapElapsedMs,errorName:error?.name,errorCode:error?.code};
  results.push(result);
  if(reads){
   const retained=historyDiagnostics.evidence.records.at(-1),bytes=readFileSync(join(diagnosticDirectory,retained.file));
   assert.equal(portableSourceHash(bytes),retained.sha256);const captured=JSON.parse(bytes);
   assert.deepEqual(captured.context.request,observedSearch.request);assert.deepEqual(captured.response,observedSearch.response);
   assert.equal(captured.context.expected.transactionId,expected.transactionId);assert.equal(captured.context.expected.globalSequence,'637');
   assert.equal(captured.context.phase.name,'native-oracle-hold');assert.equal(captured.context.phase.selection.selectionId,event.selectionId);
   assert.deepEqual(captured.context.source,position);assert.equal(captured.context.frameSha256,portableSourceHash(raw));
   result.historyCapture={sha256:retained.sha256,bytes:retained.bytes,body:captured};
  }
  if(requested!=='characterize')console.log(JSON.stringify(result));
  if(requested==='characterize'){
   assert.equal(reached,mode==='visible','characterization must retain the original failing decision');
   if(['delayed','missing','wrong'].includes(mode)){assert.match(error.message,/assert.ok\(row\)/);assert.equal(reads,1);}
   if(mode==='orphan'){assert.equal(reads,1);assert.equal(proofCalls,0);assert.equal(error.actual,'f'.repeat(64));assert.equal(error.expected,expected.blockId);}
   if(mode==='timeout'){assert.equal(reads,1);assert.equal(proofCalls,0);assert.equal(error.actual,true);assert.equal(error.expected,false);}
   if(mode==='partial'){assert.equal(reads,1);assert.equal(proofCalls,0);assert.equal(error.actual,1);assert.equal(error.expected,0);}
   if(mode==='source-incomplete'){assert.equal(reads,0);assert.equal(proofCalls,0);}
  }else if(requested==='witness'){
   const passes=['ready','delayed-completion','seal-pending'].includes(mode),queried=passes||['query-wrong','witness-timeout','witness-partial'].includes(mode);
   assert.equal(reached,passes,'only exact ready witnesses may reach the independent proof boundary');assert.equal(reads,queried?1:0);
   assert.equal(refreshCalls,queried||['refresh-partial','slow-refresh'].includes(mode)?1:0);assert.equal(proofCalls,passes?1:0);
   if(['expired','ready-expired','no-budget','failed-http','failed-item','wrong-item','incomplete-copies','wrong-canonical','wrong-native','wrong-selection','capture-hash','response-hash','item-bytes','incomplete-seal','late-witness','slow-refresh'].includes(mode))assert.equal(historyWaitCalls,0);
   if(mode==='capture-failed')assert.equal(error,captureFailure);if(['held','wrong-target','capture-held'].includes(mode))assert.equal(error,deadlineBoundary);
  }else assert.equal(reached,mode==='visible'||mode==='delayed','original native hold rejected before independently guarded source proof');
 }
 assert.deepEqual(errors,[]);assert.equal(historyDiagnostics.evidence.failedCaptures,0);
 if(requested==='characterize')console.log(JSON.stringify({status:'characterized',node:process.version,results,
  diagnosticRecords:historyDiagnostics.evidence.records.length,retainedFrames:source.records.length,proofSuccessFabricated:false,fullWorkerQualification:false}));
 if(requested==='witness')console.log(JSON.stringify({status:'witness-controls-passed',node:process.version,results,
  diagnosticRecords:historyDiagnostics.evidence.records.length,retainedFrames:source.records.length,oracleHashes:oracle.hashes,
  sourceFramePinsSha256:portableSourceHash(Buffer.from(JSON.stringify(source.records.map(value=>[value.blockNum,value.frameSha256])))),
  inheritedDeadline:true,proofSuccessFabricated:false,fullWorkerQualification:false}));
}finally{
 ProtocolAbiFrontierStore.prototype.readControl=originals.control;ProtocolAbiFrontierStore.prototype.readCommit=originals.commit;
 ProtocolNativeObservationStore.prototype.readSelection=originals.native;ProtocolNativeActionReader.prototype.open=originals.open;
 ActionSourceAdmissionStore.prototype.resolve=originals.admission;ActionHistorySourceJournal.prototype.readPlan=originals.plan;
 ActionHistorySourceJournal.prototype.readManifest=originals.manifest;
}
} finally {
 assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert(basename(temporary).startsWith('hyperion-native-history-'));
 rmSync(temporary,{recursive:true,force:true});
}
