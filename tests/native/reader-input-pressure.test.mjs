import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HyperionQueueMonitor} from '../../build/indexer/modules/queueMonitor.js';
function fixture(){
 const sizes=new Map([['wire:blocks:1',0],['wire:live_blocks',0],['wire:ds_pool:1',0],['wire:index_actions:1',0],['wire:other',0]]),events=[],launches=[];
 const master={chain:'wire',conf:{scaling:{block_queue_limit:10,max_queue_limit:20,resume_trigger:5,max_autoscale:2}},
  workerMap:[{worker_role:'deserializer',worker_queue:'wire:blocks:1'},{worker_role:'deserializer',worker_queue:'wire:live_blocks'},
   {worker_role:'ds_pool_worker',local_id:1},{worker_role:'ingestor',queue:'wire:index_actions:1',type:'action'},{worker_role:'other',queue:'wire:other'}],
  manager:{async checkQueueSize(q){assert.ok(sizes.has(q),q);return sizes.get(q);}},sendToRole(role,msg){events.push([role,msg.event]);},
  addWorker(worker){launches.push(worker);},launchWorkers(){}};
 return {monitor:new HyperionQueueMonitor(master),master,sizes,events,launches,async check(){await this.monitor.checkQueues({},100);}};
}
test('historical input pressure pauses only bulk and preserves independent hysteresis',async()=>{
 const f=fixture();f.sizes.set('wire:blocks:1',10);await f.check();assert.deepEqual(f.events,[['reader','pause']]);
 f.sizes.set('wire:blocks:1',5);await f.check();assert.equal(f.events.length,1);f.sizes.set('wire:blocks:1',4);await f.check();assert.deepEqual(f.events,[['reader','pause'],['reader','resume']]);
});
test('live input pressure is separately bounded and does not pause bulk',async()=>{
 const f=fixture();f.sizes.set('wire:live_blocks',10);await f.check();assert.deepEqual(f.events,[['continuous_reader','pause']]);
 f.sizes.set('wire:live_blocks',5);await f.check();assert.equal(f.events.length,1);f.sizes.set('wire:live_blocks',4);await f.check();assert.deepEqual(f.events,[['continuous_reader','pause'],['continuous_reader','resume']]);
});
test('shared and unrecognized pressure pauses both, and each remains blocked by its own queue',async()=>{
 for(const queue of ['wire:ds_pool:1','wire:index_actions:1','wire:other']){
  const f=fixture();f.sizes.set(queue,20);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
  f.sizes.set(queue,4);f.sizes.set('wire:blocks:1',7);await f.check();assert.deepEqual(f.events.at(-1),['continuous_reader','resume']);assert.equal(f.events.length,3);
  f.sizes.set('wire:blocks:1',4);await f.check();assert.deepEqual(f.events.at(-1),['reader','resume']);
 }
});
test('duplicate or malformed input queue classifications remain conservative',async()=>{
 const f=fixture();f.master.workerMap.push({worker_role:'other',queue:'wire:blocks:1'});f.sizes.set('wire:blocks:1',10);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});
test('ingestor autoscale remains independent of reader classification',async()=>{
 const f=fixture();f.sizes.set('wire:index_actions:1',101);await f.monitor.checkQueues({},100);assert.equal(f.launches.length,1);assert.equal(f.launches[0].worker_role,'ingestor');assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});

test('both input pressures recover independently and cannot clear shared pressure',async()=>{
 const f=fixture();f.sizes.set('wire:blocks:1',10);f.sizes.set('wire:live_blocks',10);await f.check();
 f.sizes.set('wire:blocks:1',0);f.sizes.set('wire:ds_pool:1',20);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
 f.sizes.set('wire:ds_pool:1',4);await f.check();assert.deepEqual(f.events.at(-1),['reader','resume']);assert.equal(f.events.length,3);
 f.sizes.set('wire:live_blocks',0);await f.check();assert.deepEqual(f.events.at(-1),['continuous_reader','resume']);
});
test('unknown deserializer queue remains shared pressure',async()=>{
 const f=fixture();f.master.workerMap.push({worker_role:'deserializer',worker_queue:'wire:blocks:invalid'});f.sizes.set('wire:blocks:invalid',10);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});
test('overlapping polls do not publish stale pause decisions and failed reads allow a later poll',async()=>{
 const f=fixture();let entered,release;const active=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=f.master.manager.checkQueueSize;let first=true;
 f.master.manager.checkQueueSize=async q=>{if(first){first=false;entered();await gate;}return original(q);};
 f.sizes.set('wire:blocks:1',10);const pending=f.check();await active;await f.check();assert.equal(f.events.length,0);release();await pending;assert.deepEqual(f.events,[['reader','pause']]);
 f.master.manager.checkQueueSize=async()=>{throw Error('unavailable');};await f.check();assert.deepEqual(f.events.at(-1),['continuous_reader','pause']);assert.equal(f.events.length,2);
 f.master.manager.checkQueueSize=original;f.sizes.set('wire:blocks:1',0);await f.check();assert.deepEqual(f.events.slice(-2),[['reader','resume'],['continuous_reader','resume']]);
});

test('conflicting live-mode metadata is shared pressure',async()=>{
 const f=fixture();f.master.workerMap[0].live_mode='true';f.sizes.set('wire:blocks:1',10);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});

test('queue HTTP failures do not masquerade as an empty queue',async()=>{
 const {checkQueueSize}=await import('../../build/indexer/connections/amqp.js');const previous=globalThis.fetch;
 try {const config={protocol:'http',api:'localhost:15672',vhost:'/',user:'test',pass:'test'};globalThis.fetch=async()=>{throw Error('network unavailable');};await assert.rejects(checkQueueSize('wire:blocks:1',config),/network unavailable/);globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({messages:0})});await assert.rejects(checkQueueSize('wire:blocks:1',config),/HTTP 503/);}
 finally {globalThis.fetch=previous;}
});

test('malformed queue observation pauses both until a complete valid sample',async()=>{
 const f=fixture();f.sizes.set('wire:other',undefined);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
 f.sizes.set('wire:other',0);await f.check();assert.deepEqual(f.events.slice(-2),[['reader','resume'],['continuous_reader','resume']]);
});
