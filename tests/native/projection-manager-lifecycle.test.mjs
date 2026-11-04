// Pure lifecycle-port controls. Never import/run the cluster fixtures, a worker, or a controller.
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
