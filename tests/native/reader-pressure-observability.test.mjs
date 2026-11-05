import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HyperionQueueMonitor} from '../../build/indexer/modules/queueMonitor.js';
test('pressure snapshots reflect decisions, hysteresis, failures and are detached', async () => {
 const sizes = new Map([['wire:blocks:1',0],['wire:live_blocks',0],['wire:ds_pool:1',0]]);
 const master = {chain:'wire', conf:{scaling:{block_queue_limit:10,max_queue_limit:20,resume_trigger:5,max_autoscale:0}},
  workerMap:[{worker_role:'reader'},{worker_role:'continuous_reader'},{worker_role:'deserializer',worker_queue:'wire:blocks:1'},
   {worker_role:'deserializer',worker_queue:'wire:live_blocks'},{worker_role:'ds_pool_worker',local_id:1}],
  manager:{async checkQueueSize(q){return sizes.get(q);}},sendToRole(){}};
 const monitor = new HyperionQueueMonitor(master), check = () => monitor.checkQueues({},100);
 assert.equal(monitor.getPressureSnapshot().status,'missing'); assert.equal(monitor.getPressureSnapshot().sample_age_ms,null);
 await check(); let s=monitor.getPressureSnapshot(); assert.equal(s.status,'current'); assert.ok(s.sampled_at);
 assert.deepEqual(s.queue_monitor_paused_roles,{reader:false,continuous_reader:false}); assert.ok(s.sample_age_ms >= 0);
 const now=Date.now; try { Date.now=()=>0; assert.equal(monitor.getPressureSnapshot().sample_age_ms,null); } finally { Date.now=now; }
 let release, entered; const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);
 const original=master.manager.checkQueueSize; let first=true; master.manager.checkQueueSize=async q=>{if(first){first=false;entered();await gate;}return original(q);};
 const pending=check(); await started; assert.equal(monitor.getPressureSnapshot().status,'stale'); release(); await pending; master.manager.checkQueueSize=original;
 sizes.set('wire:blocks:1',10); await check(); s=monitor.getPressureSnapshot();
 assert.deepEqual(s.queue_monitor_paused_roles,{reader:true,continuous_reader:false});
 assert.deepEqual(s.queues.find(q=>q.scope==='bulk'),{queue:'wire:blocks:1',scope:'bulk',size:10,limit:10,resume_trigger:5});
 s.queue_monitor_paused_roles.reader=false; s.queues[0].size=999; s.scopes.bulk=false;
 assert.equal(monitor.getPressureSnapshot().queue_monitor_paused_roles.reader,true); assert.notEqual(monitor.getPressureSnapshot().queues[0].size,999); assert.equal(monitor.getPressureSnapshot().scopes.bulk,true);
 sizes.set('wire:blocks:1',4); sizes.set('wire:ds_pool:1',20); await check();
 assert.deepEqual(monitor.getPressureSnapshot().queue_monitor_paused_roles,{reader:true,continuous_reader:true});
 sizes.set('wire:ds_pool:1',5); await check(); assert.equal(monitor.getPressureSnapshot().queue_monitor_paused_roles.reader,true);
 sizes.set('wire:ds_pool:1',4); await check(); assert.equal(monitor.getPressureSnapshot().queue_monitor_paused_roles.reader,false);
 master.manager.checkQueueSize=async()=>{throw Error('secret exception');}; await check(); s=monitor.getPressureSnapshot();
 assert.equal(s.status,'failed'); assert.equal(s.reason,'check_failed'); assert.deepEqual(s.queues,[]); assert.equal(JSON.stringify(s).includes('secret exception'),false); assert.equal(s.queue_monitor_paused_roles.reader,true);
 master.manager.checkQueueSize=async()=>undefined; await check(); assert.equal(monitor.getPressureSnapshot().reason,'invalid_metric');
 master.workerMap=master.workerMap.filter(w=>w.worker_queue!=='wire:blocks:1'); await check(); assert.equal(monitor.getPressureSnapshot().reason,'missing_input');
});

 test('emitted local scaling handler exposes the monitor snapshot without probing', async () => {
 const {readFile} = await import('node:fs/promises'); const vm = await import('node:vm');
 let source = await readFile(new URL('../../build/indexer/modules/controller.js', import.meta.url),'utf8');
 source = source.replace(/^import .*;\s*$/gm,'').replace('export class LocalHyperionController','class LocalHyperionController');
 const context = {IndexerPauseCoordinator:class {}, App:()=>{throw Error('unexpected server');}, hLog(){}, randomUUID(){return 'id';}};
 vm.runInNewContext(source+'\nthis.Controller=LocalHyperionController;',context);
 const routes={}; let calls=0; const snapshot={status:'missing',queue_monitor_paused_roles:{reader:true,continuous_reader:true}};
 const master={conf:{scaling:{}},workerMap:[],getReaderPressureSnapshot(){calls++;return snapshot;}};
 const controller=new context.Controller(master); controller.localController={get(path,handler){routes[path]=handler;}}; controller.setHttpHandlers();
 let body; routes['/scaling']({writeHeader(){},end(value){body=JSON.parse(value);}},{});
 assert.deepEqual(body.reader_pressure,snapshot); assert.equal(calls,1);
 });

 test('failed sample is published even if pause IPC throws', async () => {
 const master={chain:'wire',conf:{scaling:{block_queue_limit:10,max_queue_limit:20,resume_trigger:5,max_autoscale:0}},
  workerMap:[{worker_role:'reader'},{worker_role:'deserializer',worker_queue:'wire:blocks:1'}],
  manager:{async checkQueueSize(){return 0;}},sendToRole(){}};
 const monitor=new HyperionQueueMonitor(master); await monitor.checkQueues({},100);
 assert.equal(monitor.isReaderPaused('reader'),false);
 master.manager.checkQueueSize=async()=>{throw Error('metric failure');};
 master.sendToRole=()=>{throw Error('disconnected IPC');};
 await assert.rejects(monitor.checkQueues({},100),/disconnected IPC/);
 const snapshot=monitor.getPressureSnapshot(); assert.equal(snapshot.status,'failed');
 assert.equal(snapshot.reason,'check_failed'); assert.deepEqual(snapshot.queues,[]);
 assert.equal(snapshot.checking,false); assert.equal(snapshot.queue_monitor_paused_roles.reader,false);
 });
