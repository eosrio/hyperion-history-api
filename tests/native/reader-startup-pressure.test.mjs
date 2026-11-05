import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
const previousDirectory=process.cwd(),directory=mkdtempSync(join(tmpdir(),'hapi-reader-startup-'));
mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify({settings:{chain:'wire'},indexer:{},prefetch:{read:8}}));writeFileSync(join(directory,'config/connections.json'),'{}');
process.chdir(directory);process.env.CONFIG_JSON=join(directory,'chain.json');
const {HyperionQueueMonitor}=await import('../../build/indexer/modules/queueMonitor.js');
const {HyperionMaster}=await import('../../build/indexer/modules/master.js');
const parent = `export class HyperionWorker { constructor(){this.conf=globalThis.__readerConfig;process.on('message',msg=>this.onIpcMessage(msg));} } export const protocolSourceCapture=()=>{};`;
const hook=registerHooks({resolve(specifier,context,next){if(specifier==='./hyperionWorker.js' && context.parentURL?.endsWith('/workers/state-reader.js'))return {url:'data:text/javascript,'+encodeURIComponent(parent),shortCircuit:true};return next(specifier,context);}});
const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
test('replacement reader starts gated, synchronizes current role pressure and keeps manual pause',async()=>{
 const saved={send:process.send,role:process.env.worker_role,sync:process.env.reader_pressure_sync,block:process.env.worker_last_processed_block};
 const sent=[];process.send=(msg,cb)=>{sent.push(msg);cb?.(null);return true;};process.env.worker_role='continuous_reader';process.env.reader_pressure_sync='true';process.env.worker_last_processed_block='42';
 globalThis.__readerConfig={settings:{reader_recovery_window_blocks:256},indexer:{fetch_block:true,fetch_traces:true,fetch_deltas:true},scaling:{},prefetch:{read:8}};
 let reader,bulk;
 try {
  reader=new Reader();assert.deepEqual(sent,[{event:'reader_pressure_ready'}]);const requests=[];reader.ship={connected:true};reader.send=(value)=>requests.push(value);
  reader.requestBlocks(42);reader.returnShipCredits(1,reader.shipCreditOwner());process.emit('message',{event:'pause'});assert.deepEqual(requests,[]);
  const worker={send(msg,cb){process.emit('message',msg);cb?.(null);}},stale={send(){throw Error('retired worker must not receive a state');}};
  let size=20;const master=Object.assign(Object.create(HyperionMaster.prototype),{chain:'wire',conf:{scaling:{block_queue_limit:10,max_queue_limit:20,resume_trigger:5,max_autoscale:0}},
    workerMap:[{worker_role:'continuous_reader',wref:worker},{worker_role:'deserializer',worker_queue:'wire:live_blocks'},{worker_role:'ds_pool_worker',local_id:1}],manager:{async checkQueueSize(){return size;}},sendToRole(role,msg){if(role==='continuous_reader')worker.send(msg);}});
  master.queueMonitor=new HyperionQueueMonitor(master);master.syncReaderPressure(stale);master.syncReaderPressure(worker);
  assert.deepEqual(requests,[],'unknown startup pressure must stay closed before any sample');await master.queueMonitor.checkQueues({},100);
  master.syncReaderPressure(worker);reader.requestBlocks(42);assert.deepEqual(requests,[]);
  size=0;await master.queueMonitor.checkQueues({},100);assert.deepEqual(requests,[],'automatic resume must not clear manual pause');
  process.emit('message',{event:'resume'});assert.equal(requests.filter(x=>x[0].startsWith('get_blocks_request_')).length,1);assert.deepEqual(requests.filter(x=>x[0]==='get_blocks_ack_request_v0'),[['get_blocks_ack_request_v0',{num_messages:1}]]);
  process.env.worker_role='reader';bulk=new Reader();const bulkRequests=[];bulk.ship={connected:true};bulk.send=value=>bulkRequests.push(value);
  bulk.requestBlocks(0);bulk.requestBlockRange(5,9);bulk.returnShipCredits(1,bulk.shipCreditOwner());assert.deepEqual(bulkRequests,[]);
  const bulkWorker={send(msg,cb){bulk.onIpcMessage(msg);cb?.(null);}};size=20;master.workerMap=[{worker_role:'reader',wref:bulkWorker},{worker_role:'deserializer',worker_queue:'wire:blocks:1'},{worker_role:'ds_pool_worker',local_id:1}];
  master.sendToRole=(role,msg)=>{if(role==='reader')bulkWorker.send(msg);};master.queueMonitor=new HyperionQueueMonitor(master);master.syncReaderPressure(bulkWorker);assert.deepEqual(bulkRequests,[]);await master.queueMonitor.checkQueues({},100);master.syncReaderPressure(bulkWorker);
  assert.deepEqual(bulkRequests,[]);size=0;await master.queueMonitor.checkQueues({},100);
  assert.equal(bulkRequests.filter(x=>x[0].startsWith('get_blocks_request_')).length,1);assert.equal(bulkRequests.find(x=>x[0].startsWith('get_blocks_request_'))[1].start_block_num,5);assert.equal(bulkRequests.filter(x=>x[0]==='get_blocks_ack_request_v0').length,1);

 } finally {
  reader?.blockReadingQueue.kill();reader?.stageOneDistQueue.kill();bulk?.blockReadingQueue.kill();bulk?.stageOneDistQueue.kill();hook.deregister();process.send=saved.send;
  for(const [key,value] of [['worker_role',saved.role],['reader_pressure_sync',saved.sync],['worker_last_processed_block',saved.block]])value===undefined?delete process.env[key]:process.env[key]=value;
  delete globalThis.__readerConfig;process.chdir(previousDirectory);assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});
 }
});
