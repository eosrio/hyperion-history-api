import {describe,expect,it} from 'bun:test';
import {ensureProtocolActionMapping} from '../../src/indexer/protocol/action-proof-mapping.js';

describe('retained action source evidence initialization',()=>{
    it('initializes only missing opaque mappings and preserves compatible partitions on retry',async()=>{
        const mappings:any={'fixture-action-v1-000001':{mappings:{properties:{act:{type:'object'}}}},
            'fixture-action-v1-000002':{mappings:{properties:{protocol:{type:'object',enabled:false}}}}};
        const writes:any[]=[];
        const client:any={indices:{
            getMapping:async({index}:any)=>index.endsWith('*')?structuredClone(mappings):{[index]:structuredClone(mappings[index])},
            putMapping:async(request:any)=>{writes.push(request);mappings[request.index].mappings.properties.protocol=request.properties.protocol;return {acknowledged:true};}
        }};
        expect(await ensureProtocolActionMapping(client,'fixture')).toEqual({inspected:2,updated:1});
        expect(writes).toEqual([{index:'fixture-action-v1-000001',properties:{protocol:{type:'object',enabled:false}}}]);
        expect(await ensureProtocolActionMapping(client,'fixture')).toEqual({inspected:2,updated:0});
        expect(writes).toHaveLength(1);
    });
    it('refuses incompatible reserved fields and unexpected index ownership before changing them',async()=>{
        let writes=0;
        const client:any={indices:{getMapping:async()=>({'fixture-action-v1-1':{mappings:{properties:{protocol:{type:'keyword'}}}}}),
            putMapping:async()=>{writes++;return {acknowledged:true};}}};
        await expect(ensureProtocolActionMapping(client,'fixture')).rejects.toThrow('incompatible');expect(writes).toBe(0);
        client.indices.getMapping=async()=>({'another-action-1':{mappings:{properties:{}}}});
        await expect(ensureProtocolActionMapping(client,'fixture')).rejects.toThrow('Unowned');expect(writes).toBe(0);
    });
    it('requires acknowledged mapping effects and exact readback',async()=>{
        let readback=false;
        const client:any={indices:{getMapping:async()=>({'fixture-action-1':{mappings:{properties:{}}}}),
            putMapping:async()=>({acknowledged:readback})}};
        await expect(ensureProtocolActionMapping(client,'fixture')).rejects.toThrow('not acknowledged');
        readback=true;await expect(ensureProtocolActionMapping(client,'fixture')).rejects.toThrow('readback mismatch');
    });
});
