import {test,expect} from 'bun:test';
import {errors} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {observationMemoryClient} from './protocol-observation-memory.mjs';

test('an unknown create receipt fails the first prepare; identical redelivery obtains a new complete CAS receipt',async()=>{
    const memory=observationMemoryClient(1),store=new ImmutableProtocolBundleStore(memory.client as any,'fixture',1,'protocol-test','protocol-test-v1');
    let timeout=true;
    memory.faults.receipt=(receipt:any,request:any)=>{
        if(timeout&&request.document.kind==='chunk'){timeout=false;throw new errors.TimeoutError('controlled timeout after committed create');}
        return receipt;
    };
    await expect(store.prepare('bundle-1',{value:'original'})).rejects.toBeInstanceOf(errors.TimeoutError);
    expect([...memory.documents.values()].some((row:any)=>row.document.kind==='manifest')).toBe(false);
    expect([...memory.documents.values()].some((row:any)=>row.document.kind==='chunk')).toBe(true);
    const prepared=await store.prepare('bundle-1',{value:'original'});
    expect(prepared.id).toBe('bundle-1');
    expect(memory.calls.some((call:any)=>call.method==='index'&&Number.isSafeInteger(call.request.if_seq_no)
        &&call.request.wait_for_active_shards==='all')).toBe(true);
    await expect(store.prepare('bundle-1',{value:'different'})).rejects.toThrow('conflict');
});
