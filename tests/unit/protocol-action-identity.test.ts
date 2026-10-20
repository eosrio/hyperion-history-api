import {describe,expect,it} from 'bun:test';
import {EventEmitter} from 'node:events';
import {ElasticRoutes} from '../../src/indexer/helpers/elastic-routes.js';

describe('extension action bulk receipt identity',()=>{
    it('stores distinct original uint64 occurrences even when the legacy numeric fields are identical',async()=>{
        let operations:any[]=[];
        const routes=new ElasticRoutes({chain:'fixture',config:{scaling:{},settings:{
            protocol:{provider:'extension',package:'fixture',profileId:'fixture'},index_version:'v1',index_partition_size:1000}},
            ingestClients:[{bulk:async(request:any)=>{
                operations=request.operations;
                return {errors:false,items:[{index:{_id:'9007199254740995',status:201}},{index:{_id:'9007199254740996',status:201}}]};
            }}]} as any);
        const bodies=['9007199254740995','9007199254740996'].map(globalSequence=>({block_num:42,global_sequence:9007199254740996,
            protocol:{schemaVersion:1,input:{globalSequence}},act:{account:'alpha',name:'act',data:'07'}}));
        const deliveries=bodies.map((body,index)=>({content:Buffer.from(JSON.stringify(body)),fields:{deliveryTag:index+1},properties:{}} as any));
        const acked:any[]=[];
        const channel=Object.assign(new EventEmitter(),{ack:(message:any)=>acked.push(message),nack:()=>{throw new Error('Unexpected retry');}});
        const previous=(ElasticRoutes as any).reportMaxBlock;
        try{
            (ElasticRoutes as any).reportMaxBlock=()=>{};
            expect(await new Promise(resolve=>routes.routes.action(deliveries,channel as any,resolve))).toBe(2);
            expect(operations[0].index._id).toBe('9007199254740995');
            expect(operations[2].index._id).toBe('9007199254740996');
            expect(operations[1]).toEqual(bodies[0]);expect(operations[3]).toEqual(bodies[1]);
            expect(acked).toHaveLength(2);
        }finally{(ElasticRoutes as any).reportMaxBlock=previous;}
    });
});
