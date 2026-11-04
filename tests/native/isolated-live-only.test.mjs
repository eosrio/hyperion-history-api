import test from 'node:test';
import assert from 'node:assert/strict';
import {HyperionMaster} from '../../build/indexer/modules/master.js';

test('live-only source setup does not launch overlapping historical readers',async()=>{
    for(const liveOnly of [true,false]){
        const workers=[];
        const master=Object.assign(Object.create(HyperionMaster.prototype),{
            chain:'wire',conf:{indexer:{live_reader:true,live_only_mode:liveOnly},scaling:{ds_threads:1}},
            starting_block:2,head:100,max_readers:2,maxBatchSize:10,validatedShipServers:[],
            chain_data:{head_block_num:{toNumber:()=>100}},addWorker:entry=>{workers.push(entry);return entry;}
        });
        await master.setupReaders();
        assert.equal(workers.filter(worker=>worker.worker_role==='continuous_reader').length,1);
        assert.equal(workers.filter(worker=>worker.worker_role==='reader').length,liveOnly?0:2);
        assert.equal(workers.find(worker=>worker.worker_role==='continuous_reader').worker_last_processed_block,100);
    }
});
