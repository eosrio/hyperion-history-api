// Pure lifecycle-port controls. Never construct a controller or run a worker/cluster fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createProjectionManagerFixture} from '../unit/projection-manager-fixture.mjs';

const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8'),source=read('build/indexer/workers/projection.js'),
 start=source.indexOf('            await this.controller?.stop();'),at=source.indexOf('        catch (error) {',start),
 end=source.indexOf('\n        }\n    }\n    handleProjectionFailure',at);
assert(start>0&&at>start&&end>at);
const success=source.slice(start,at).replace(/\n        }\s*$/,''),failure=source.slice(at+'        catch (error) {'.length,end);

for(const [path,mode] of [['projection-startup-fencing.mjs','success'],['projection-controller-startup.mjs','success'],['worker-attempt-quiescence-worker.mjs','failure']])
test('actual '+path+' manager setup supports emitted '+mode+' cleanup without optional-client allocation',async()=>{
 const fixture=read('tests/unit/'+path),line=fixture.split('\n').find(line=>line.trim().startsWith('manager:'));
 assert(line,'Actual worker manager expression required');
 const expression=line.trim().slice('manager:'.length).split(', stopped:')[0].trim().replace(/,$/,''),events=[],original=new Error('original initialization failure'),
  client={async close(){events.push('mongo-close');}},manager=runInNewContext('('+expression+')',{client,mongo:client,connects:0,createProjectionManagerFixture});
 const cleanup=runInNewContext(mode==='success'?'(async function(initialized){try{'+success+'}catch(error){'+failure+'}})':'(async function(error){'+failure+'})',
  {process:{exit:code=>events.push(['exit',code])}});
 const worker={manager,statefulControllers:new Map(),probes:new Set(),profiler:{stopReporting(){events.push('profiler-stop');}},
  handleProjectionFailure(error){assert.equal(error,original);events.push('original-failure');events.push(['exit',1]);}};
 await cleanup.call(worker,mode==='success'?{client}:original);
 assert.deepEqual(events,mode==='success'?['mongo-close','profiler-stop',['exit',0]]:['original-failure',['exit',1]]);
 await assert.rejects(manager.statefulCompleteKindMongoClient(5),/configuration is unavailable/);
});

test('the optional fixture port rejects unexpected allocation and uses the real idempotent pool close',async()=>{
 const manager=createProjectionManagerFixture({});
 await assert.rejects(manager.statefulCompleteKindMongoClient(5),/must not allocate an optional/);
 await manager.closeStatefulCompleteKindMongoClient();await manager.closeStatefulCompleteKindMongoClient();
 await assert.rejects(manager.statefulCompleteKindMongoClient(5),/configuration is unavailable/);
});

test('emitted cleanup retains a real original Mongo close failure after closing the optional port',async()=>{
 const primary=new Error('original Mongo close failure'),events=[],client={async close(){throw primary;}},manager=createProjectionManagerFixture(client);
 const cleanup=runInNewContext('(async function(initialized){try{'+success+'}catch(error){'+failure+'}})',{process:{exit:code=>events.push(['exit',code])}});
 await cleanup.call({manager,statefulControllers:new Map(),probes:new Set(),profiler:{stopReporting(){}},handleProjectionFailure(error){assert.equal(error,primary);events.push('primary');events.push(['exit',1]);}},{client});
 assert.deepEqual(events,['primary',['exit',1]]);await assert.rejects(manager.statefulCompleteKindMongoClient(5),/configuration is unavailable/);
});

test('actual startup controller supports all emitted IPC invalidation events and stop before drain completion',async()=>{
 const fixture=read('tests/unit/projection-startup-fencing.mjs'),line=fixture.split('\n').find(line=>line.includes("send({event: 'fixture_initialized'})")&&line.includes('return '));
 assert(line,'Actual startup controller expression required');const expression=line.trim().slice('return '.length).replace(/;$/,'');
 const methodStart=source.indexOf('    onIpcMessage(message) {'),methodEnd=source.indexOf('    async run() {',methodStart);assert(methodStart>0&&methodEnd>methodStart);
 const onIpc=new Function('return ({'+source.slice(methodStart,methodEnd)+'});')().onIpcMessage;
 const ports=await import('../unit/projection-manager-fixture.mjs');
 for(const event of ['stop','worker_attempt_fence','worker_attempt_fence_active','reload_config','reload_contract_config']){
  const events=[],controller=runInNewContext('('+expression+')',{...ports,send:value=>events.push(value),finish:{promise:Promise.resolve()}});
  const retryEpoch={};controller.mappingRetries=new Map([['pending',{}]]);controller.retryEpoch=retryEpoch;
  const worker={controller,stopped:false,statefulControllers:new Map(),probes:new Set()};
  onIpc.call(worker,{event});assert.equal(worker.stopped,event==='stop');assert.equal(controller.mappingRetries.size,0);assert.notEqual(controller.retryEpoch,retryEpoch);
  await controller.drain();assert.equal(events.length,1);assert.equal(events[0].event,'fixture_initialized');await controller.stop();
 }
});

test('actual fatal-lineage and held-protocol fixtures reach emitted primary failure handling through a real optional-pool closer',async()=>{
 const lineage=read('tests/unit/worker-failure-lineage.mjs'),start=lineage.indexOf('    const worker = Object.assign(Object.create(Projection.prototype)'),end=lineage.indexOf('    worker.installControlledAttemptLifecycle',start);assert(start>0&&end>start);
 const expression=lineage.slice(start+'    const worker = '.length,end).trim().replace(/;$/,''),primary=new Error('primary initialization failure'),events=[];
 const worker=runInNewContext(expression,{Object,Projection:{prototype:{}},scenario:'projection',sentinel:primary,Promise:{reject:()=>undefined},createProjectionManagerFixture});
 const cleanup=runInNewContext('(async function(error){'+failure+'})',{});worker.handleProjectionFailure=error=>{assert.equal(error,primary);events.push('primary');};
 await cleanup.call(worker,primary);assert.deepEqual(events,['primary']);
 const supervisor=read('tests/unit/worker-attempt-supervisor.test.ts'),line=supervisor.split('\n').find(line=>line.trim().startsWith('manager:'));
 assert(line);const manager=runInNewContext('('+line.trim().slice('manager:'.length).replace(/\}\);$/,'')+')',{connections:0,createProjectionManagerFixture});
 await cleanup.call({manager,handleProjectionFailure:error=>{assert.equal(error,primary);events.push('held-primary');}},primary);assert.deepEqual(events,['primary','held-primary']);
 await assert.rejects(manager.statefulCompleteKindMongoClient(5),/configuration is unavailable/);
});
