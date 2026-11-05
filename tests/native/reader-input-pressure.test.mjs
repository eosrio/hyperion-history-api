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
 const f=fixture();await f.check();f.events.length=0;f.sizes.set('wire:blocks:1',10);await f.check();assert.deepEqual(f.events,[['reader','pause']]);
 f.sizes.set('wire:blocks:1',5);await f.check();assert.equal(f.events.length,1);f.sizes.set('wire:blocks:1',4);await f.check();assert.deepEqual(f.events,[['reader','pause'],['reader','resume']]);
});
test('live input pressure is separately bounded and does not pause bulk',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.sizes.set('wire:live_blocks',10);await f.check();assert.deepEqual(f.events,[['continuous_reader','pause']]);
 f.sizes.set('wire:live_blocks',5);await f.check();assert.equal(f.events.length,1);f.sizes.set('wire:live_blocks',4);await f.check();assert.deepEqual(f.events,[['continuous_reader','pause'],['continuous_reader','resume']]);
});
test('shared and unrecognized pressure pauses both, and each remains blocked by its own queue',async()=>{
 for(const queue of ['wire:ds_pool:1','wire:index_actions:1','wire:other']){
  const f=fixture();await f.check();f.events.length=0;f.sizes.set(queue,20);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
  f.sizes.set(queue,4);f.sizes.set('wire:blocks:1',7);await f.check();assert.deepEqual(f.events.at(-1),['continuous_reader','resume']);assert.equal(f.events.length,3);
  f.sizes.set('wire:blocks:1',4);await f.check();assert.deepEqual(f.events.at(-1),['reader','resume']);
 }
});
test('duplicate or malformed input queue classifications remain conservative',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.master.workerMap.push({worker_role:'other',queue:'wire:blocks:1'});f.sizes.set('wire:blocks:1',10);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});
test('ingestor autoscale remains independent of reader classification',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.sizes.set('wire:index_actions:1',101);await f.monitor.checkQueues({},100);assert.equal(f.launches.length,1);assert.equal(f.launches[0].worker_role,'ingestor');assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});

test('both input pressures recover independently and cannot clear shared pressure',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.sizes.set('wire:blocks:1',10);f.sizes.set('wire:live_blocks',10);await f.check();
 f.sizes.set('wire:blocks:1',0);f.sizes.set('wire:ds_pool:1',20);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
 f.sizes.set('wire:ds_pool:1',4);await f.check();assert.deepEqual(f.events.at(-1),['reader','resume']);assert.equal(f.events.length,3);
 f.sizes.set('wire:live_blocks',0);await f.check();assert.deepEqual(f.events.at(-1),['continuous_reader','resume']);
});
test('unknown deserializer queue remains shared pressure',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.master.workerMap.push({worker_role:'deserializer',worker_queue:'wire:blocks:invalid'});f.sizes.set('wire:blocks:invalid',10);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});
test('overlapping polls do not publish stale pause decisions and failed reads allow a later poll',async()=>{
 const f=fixture();await f.check();f.events.length=0;let entered,release;const active=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=f.master.manager.checkQueueSize;let first=true;
 f.master.manager.checkQueueSize=async q=>{if(first){first=false;entered();await gate;}return original(q);};
 f.sizes.set('wire:blocks:1',10);const pending=f.check();await active;await f.check();assert.equal(f.events.length,0);release();await pending;assert.deepEqual(f.events,[['reader','pause']]);
 f.master.manager.checkQueueSize=async()=>{throw Error('unavailable');};await f.check();assert.deepEqual(f.events.at(-1),['continuous_reader','pause']);assert.equal(f.events.length,2);
 f.master.manager.checkQueueSize=original;f.sizes.set('wire:blocks:1',0);await f.check();assert.deepEqual(f.events.slice(-2),[['reader','resume'],['continuous_reader','resume']]);
});

test('conflicting live-mode metadata is shared pressure',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.master.workerMap[0].live_mode='true';f.sizes.set('wire:blocks:1',10);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});

test('queue HTTP failures do not masquerade as an empty queue',async()=>{
 const {checkQueueSize}=await import('../../build/indexer/connections/amqp.js');const previous=globalThis.fetch;
 try {const config={protocol:'http',api:'localhost:15672',vhost:'/',user:'test',pass:'test'};globalThis.fetch=async()=>{throw Error('network unavailable');};await assert.rejects(checkQueueSize('wire:blocks:1',config),/network unavailable/);globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({messages:0})});await assert.rejects(checkQueueSize('wire:blocks:1',config),/HTTP 503/);}
 finally {globalThis.fetch=previous;}
});

test('malformed queue observation pauses both until a complete valid sample',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.sizes.set('wire:other',undefined);await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
 f.sizes.set('wire:other',0);await f.check();assert.deepEqual(f.events.slice(-2),[['reader','resume'],['continuous_reader','resume']]);
});

test('stalled queue observation times out, pauses both, then recovers on a valid poll', {timeout: 16000}, async()=>{
 const {checkQueueSize}=await import('../../build/indexer/connections/amqp.js');const previous=globalThis.fetch;const f=fixture();await f.check();f.events.length=0;
 const config={protocol:'http',api:'localhost:15672',vhost:'/',user:'test',pass:'test'};
 try {
  globalThis.fetch=async (_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  f.master.manager.checkQueueSize=async q=>checkQueueSize(q,config);await f.check();
  assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
  globalThis.fetch=async()=>({ok:true,json:async()=>({messages:0})});await f.check();
  assert.deepEqual(f.events.slice(-2),[['reader','resume'],['continuous_reader','resume']]);
  globalThis.fetch=async (_url,{signal})=>({ok:true,json:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  await f.check();assert.deepEqual(f.events.slice(-2),[['reader','pause'],['continuous_reader','pause']]);
  globalThis.fetch=async()=>({ok:true,json:async()=>({messages:0})});await f.check();assert.deepEqual(f.events.slice(-2),[['reader','resume'],['continuous_reader','resume']]);
 } finally {globalThis.fetch=previous;}
});

test('startup remains paused through unknown, saturated and hysteresis-band samples',async()=>{
 const f=fixture();assert.equal(f.monitor.isReaderPaused('reader'),true);assert.equal(f.monitor.isReaderPaused('continuous_reader'),true);
 f.sizes.set('wire:blocks:1',10);await f.check();assert.equal(f.monitor.isReaderPaused('reader'),true);assert.equal(f.monitor.isReaderPaused('continuous_reader'),false);
 f.sizes.set('wire:blocks:1',5);await f.check();assert.equal(f.monitor.isReaderPaused('reader'),true);
 f.sizes.set('wire:blocks:1',4);await f.check();assert.equal(f.monitor.isReaderPaused('reader'),false);
});
test('an active reader with an unobserved input queue fails closed for both roles',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.master.workerMap.push({worker_role:'reader'});f.master.workerMap=f.master.workerMap.filter(w=>w.worker_queue!=='wire:blocks:1');
 await f.check();assert.deepEqual(f.events,[['reader','pause'],['continuous_reader','pause']]);
});

test('a disappeared inactive input remains unknown for a later replacement',async()=>{
 const f=fixture();await f.check();f.events.length=0;f.master.workerMap=f.master.workerMap.filter(w=>w.worker_queue!=='wire:live_blocks');
 await f.check();assert.equal(f.monitor.isReaderPaused('continuous_reader'),true);assert.equal(f.monitor.isReaderPaused('reader'),false);
 f.master.workerMap.push({worker_role:'continuous_reader'});assert.equal(f.monitor.isReaderPaused('continuous_reader'),true);
});


test('first complete under-budget sample releases startup despite retained shared backlog in hysteresis band',async()=>{
 const f=fixture();f.sizes.set('wire:ds_pool:1',12);await f.check();
 assert.deepEqual(f.events,[['reader','resume'],['continuous_reader','resume']]);
 assert.equal(f.monitor.getPressureSnapshot().status,'current');
});
test('unknown samples fail closed without inventing pressure; actual limit retains hysteresis across failure',async()=>{
 const f=fixture(),original=f.master.manager.checkQueueSize;
 f.master.manager.checkQueueSize=async()=>{throw Error('unavailable');};await f.check();
 assert.equal(f.monitor.isReaderPaused('reader'),true);assert.equal(f.monitor.isReaderPaused('continuous_reader'),true);
 f.master.manager.checkQueueSize=original;f.sizes.set('wire:ds_pool:1',12);await f.check();
 assert.deepEqual(f.events,[['reader','resume'],['continuous_reader','resume']]);
 f.sizes.set('wire:ds_pool:1',20);await f.check();
 f.master.manager.checkQueueSize=async()=>undefined;await f.check();
 f.master.manager.checkQueueSize=original;f.sizes.set('wire:ds_pool:1',12);await f.check();
 assert.equal(f.monitor.isReaderPaused('reader'),true);assert.equal(f.monitor.isReaderPaused('continuous_reader'),true);
 f.sizes.set('wire:ds_pool:1',4);await f.check();
 assert.equal(f.monitor.isReaderPaused('reader'),false);assert.equal(f.monitor.isReaderPaused('continuous_reader'),false);
});
test('startup latches only roles whose own or shared queue reaches its limit',async()=>{
 for(const [queue,paused] of [['wire:blocks:1',{reader:true,continuous_reader:false}],
  ['wire:live_blocks',{reader:false,continuous_reader:true}],['wire:ds_pool:1',{reader:true,continuous_reader:true}]]){
  const f=fixture();f.sizes.set(queue,queue.includes('ds_pool')?20:10);await f.check();
  assert.deepEqual(f.monitor.getPressureSnapshot().queue_monitor_paused_roles,paused);
  f.sizes.set(queue,7);await f.check();assert.deepEqual(f.monitor.getPressureSnapshot().queue_monitor_paused_roles,paused);
  f.sizes.set(queue,4);await f.check();assert.deepEqual(f.monitor.getPressureSnapshot().queue_monitor_paused_roles,{reader:false,continuous_reader:false});
 }
});

test('valid over-limit observation survives a later failed queue read for each scope',async()=>{
 for(const [queue,limit,expected] of [['wire:blocks:1',10,{reader:true,continuous_reader:false}],
  ['wire:live_blocks',10,{reader:false,continuous_reader:true}],['wire:ds_pool:1',20,{reader:true,continuous_reader:true}]]){
  const f=fixture(),original=f.master.manager.checkQueueSize;f.sizes.set(queue,limit);
  f.master.manager.checkQueueSize=async q=>{if(q==='wire:other')throw Error('later read failed');return original(q);};
  await f.check();assert.deepEqual(f.monitor.getPressureSnapshot().queue_monitor_paused_roles,{reader:true,continuous_reader:true});
  f.master.manager.checkQueueSize=original;f.sizes.set(queue,7);await f.check();
  assert.deepEqual(f.monitor.getPressureSnapshot().queue_monitor_paused_roles,expected);
  f.sizes.set(queue,4);await f.check();assert.deepEqual(f.monitor.getPressureSnapshot().queue_monitor_paused_roles,{reader:false,continuous_reader:false});
 }
});
