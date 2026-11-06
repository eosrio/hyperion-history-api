/** Phase-1 controlled-transport feedback loop. No services, native proof, source grant or real Mongo durability. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {databaseFixture} from '../../packages/backend-mongodb/tests/fixture.mjs';
import {PortableStateController} from '../../build/indexer/projection/controller.js';
import {DeclarativeProjectionRuntime} from '../../build/indexer/projection/runtime.js';
import {resolvePortableStateConfiguration,portableStateBinding} from '../../build/indexer/projection/config.js';
import {auditPortablePhysicalMongo} from '../../scripts/qualification/portable-state-worker-mongo.ts';
import {assertNativeQualificationRuntime} from '../../scripts/qualification/native-node-runtime.mjs';
assertNativeQualificationRuntime();
const started=performance.now(),mode=process.argv[2]??'red';assert.ok(['red','characterize'].includes(mode));
const input=JSON.parse(readFileSync(new URL('../fixtures/portable-state-worker/mongo-1244.json',import.meta.url)));
const {definition,binding,backend,source,failedBlock,checkpoint,change}=input;
const configuration=resolvePortableStateConfiguration({backend,projections:[definition]},binding.chainId);
assert.deepEqual(JSON.parse(JSON.stringify(portableStateBinding(configuration,definition,binding.chainId))),binding);
const fixture=databaseFixture(),adapter=fixture.adapter({backendId:backend.id,databaseName:backend.database});
const runtime=await DeclarativeProjectionRuntime.create({adapter,definition,binding,genesis:{blockNum:0,blockId:'0'.repeat(64)},maximumPendingFrames:1});
for(let n=1;n<=checkpoint.blockNum;n++)await adapter.apply({binding,
 previous:{blockNum:n-1,blockId:n===1?'0'.repeat(64):source[n-2].blockId},
 block:{...source[n-1],previousBlockId:n===1?'0'.repeat(64):source[n-2].blockId},mutations:[]});
const frame={chainId:binding.chainId,block:failedBlock,changes:[change]};
await assert.rejects(runtime.process(frame),/Required source field is missing/);
const before=await adapter.recovery(binding);assert.deepEqual(before.checkpoint,checkpoint);
assert.match(before.pending.reason,/Required source field is missing/);

// The audit reads the actual adapter-produced Map records, never hand-authored pending metadata.
// Only Mongo transport/session/server-identity methods are controlled; this is not physical-server evidence.
const replicaSet='h45rs_'+'1'.repeat(32);
const cursor=items=>{let maximum=Infinity;const c={sort(order){items=[...items].sort((a,b)=>String(a._id??a.name).localeCompare(String(b._id??b.name)));return c;},
 limit(n){maximum=n;return c;},async close(){},async *[Symbol.asyncIterator](){for(const item of items.slice(0,maximum))yield structuredClone(item);}};return c;};
const map=(name,session)=>[...(session?.storage??fixture.storage).get(name)?.values()??[]];
const auditDb={
 admin(){return{async command(command){return command.hello?{setName:replicaSet,isWritablePrimary:true,
  me:'controlled-memory-only',primary:'controlled-memory-only',topologyVersion:{processId:'not-a-live-server'},maxWireVersion:25}:{version:'8.0.34',gitVersion:'controlled-memory-only'};}};},
 listCollections(){return cursor([...fixture.storage.keys()].map(name=>({name,type:'collection',options:{collation:{locale:'simple'}}})));},
 collection(name){return{find(_query,options){return cursor(map(name,options.session));},async countDocuments(_query,options){return map(name,options.session).length;}};}
};
const auditClient={options:{directConnection:true,replicaSet,hosts:[{host:'127.0.0.1',port:35000}]},
 startSession(){return{storage:null,startTransaction(){this.storage=structuredClone(fixture.storage);},async abortTransaction(){},async endSession(){}};},
 db(){return auditDb;}};
const audit=()=>auditPortablePhysicalMongo({client:auditClient,database:backend.database,backendId:backend.id,chainId:binding.chainId,
 replicaSet,version:'8.0.34',through:input.actualBarrier,source,expectations:[{definition,binding,rows:[],checkpoint,failedBlock}]});
const baseline=await audit();assert.equal(baseline.readOnly,true);
let notifyAdmission,releaseBoundary,revalidationCalls=0;
const admitted=new Promise(resolve=>{notifyAdmission=resolve;}),release=new Promise(resolve=>{releaseBoundary=resolve;});
const progress=[];
const controller=await PortableStateController.create({chainId:binding.chainId,configuration,adapter,
 source:{async frame(number,actualDefinition,admit){assert.equal(number,failedBlock.blockNum);assert.equal(actualDefinition.id,definition.id);
  await admit(failedBlock);notifyAdmission();await release;throw new Error('Probe released before returning any source proof');},
  async revalidate(){revalidationCalls++;assert.fail('This feedback loop must never manufacture a proof/revalidation success');}},
 onProgress(value){progress.push(value);}});
const draining=controller.drain();await admitted;
const held=await adapter.recovery(binding);assert.deepEqual(held.checkpoint,checkpoint);
let auditError;
try{await audit();}catch(error){auditError=error;}
finally{releaseBoundary();await draining;await controller.stop();}
if(auditError){
 assert.ok(auditError instanceof assert.AssertionError,'The feedback loop must fail at the exact physical audit predicate');
 assert.match(auditError.message,/Required source field is missing/);
 assert.match(auditError.message,/Canonical projection source admitted; durable application is pending/);
 assert.match(held.pending.reason,/^Canonical projection source admitted; durable application is pending$/);
}
if(mode==='characterize')assert.ok(auditError,'Characterization control requires the current recorded failure pattern');
await assert.rejects(runtime.process(frame),/Required source field is missing/);
const settled=await adapter.recovery(binding),after=await audit();assert.equal(after.readOnly,true);
assert.deepEqual(settled.checkpoint,checkpoint);assert.equal(revalidationCalls,0);
console.log(JSON.stringify({node:process.versions.node,mode,barrier:input.actualBarrier,checkpoint:checkpoint.blockNum,
 initialReason:before.pending.reason,heldReason:held.pending.reason,settledReason:settled.pending.reason,
 baselineAudit:'passed',heldAudit:auditError?'failed':'passed',settledAudit:'passed',auditError:auditError?{name:auditError.name,message:auditError.message,stack:auditError.stack}:null,
 sourceProofsReturned:0,revalidationCalls,controllerProgress:progress.map(p=>({status:p.status,reason:p.reason})),
 elapsedMs:performance.now()-started,controlledMongoTransport:true,actualMongo:false,sourceAuthority:false,fullWorkerQualification:false}));
if(mode==='red'&&auditError)throw auditError;
