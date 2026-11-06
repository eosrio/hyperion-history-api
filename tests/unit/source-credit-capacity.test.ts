import {expect, test} from 'bun:test';
import {resolveSourceCreditCapacity, SourceCreditCapacityCoordinator, SourceCreditCapacityRpc,
    isSourceCreditCapacityRequest, type SourceCreditCapacityUpdate} from '../../src/indexer/helpers/source-credit-capacity.js';

const session = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const options = {maximumBytes: 16, frameBytes: 4, window: 2};
const update = (sequence: number, wantedTotal: number, settledTotal = 0, sessionId = session): SourceCreditCapacityUpdate => ({sessionId,sequence,wantedTotal,settledTotal});
const config = () => ({settings: {max_ws_payload_mb: 1, protocol: {provider: 'extension'},
    source_credit_capacity: {interface_version: 1 as const, qualification_only: true as const, maximum_ingress_bytes: 8 * 1024 * 1024}},
    indexer: {live_reader: true,live_only_mode: true},prefetch:{read:8}});

test('source reservations have no derived budget/default and reject unsupported lifecycle or unsafe bounds',()=>{
    const conf=config();expect(resolveSourceCreditCapacity(conf)).toEqual({maximumBytes:8388608,frameBytes:1048576,window:8});
    expect(resolveSourceCreditCapacity({...conf,settings:{}})).toBeUndefined();
    for(const mutate of [(c:any)=>delete c.settings.source_credit_capacity.maximum_ingress_bytes,
        (c:any)=>c.settings.source_credit_capacity.maximum_ingress_bytes=1,(c:any)=>c.settings.source_credit_capacity.maximum_ingress_bytes=Number.MAX_SAFE_INTEGER+1,
        (c:any)=>c.settings.source_credit_capacity.qualification_only=false,(c:any)=>c.settings.source_credit_capacity.extra=true,
        (c:any)=>c.settings.max_ws_payload_mb=0,(c:any)=>c.settings.max_ws_payload_mb=NaN,(c:any)=>c.prefetch.read=0,
        (c:any)=>c.indexer.live_only_mode=false,(c:any)=>c.indexer.live_reader=false,(c:any)=>c.settings.protocol.provider='antelope']){
        const value=config();mutate(value);expect(()=>resolveSourceCreditCapacity(value)).toThrow('Source-credit capacity');
    }
});

test('master reserves one shared byte pool across physical readers and duplicate sequences cannot allocate twice',()=>{
    const ledger=new SourceCreditCapacityCoordinator(options),a={},b={},c={};
    expect(ledger.matches({...options})).toBe(true);expect(ledger.matches({...options,maximumBytes:32})).toBe(false);
    const first=ledger.update(a,update(1,2));expect(first.grantedTotal).toBe(2);
    ledger.update(b,update(1,2,0,other));expect(ledger.snapshot().reservedBytes).toBe(16);
    expect(ledger.update(c,update(1,2)).grantedTotal).toBe(0);
    expect(ledger.update(a,update(1,2))).toEqual(first);expect(ledger.snapshot().reservedBytes).toBe(16);
    expect(()=>ledger.update(a,update(1,3))).toThrow('duplicate');
    ledger.update(a,update(2,2,1));expect(ledger.snapshot().reservedBytes).toBe(12);
    expect(ledger.update(c,update(2,2)).grantedTotal).toBe(1);expect(ledger.snapshot().reservedBytes).toBe(16);
    expect(()=>ledger.update(a,update(3,3,3))).toThrow('cumulative');
    expect(()=>ledger.update(a,update(3,2,1,other))).toThrow('session');
    expect(()=>ledger.update(a,update(1,2))).toThrow('sequence');
});

test('uncertain retiring owner remains charged until actual exit and cannot resurrect after exit',()=>{
    const ledger=new SourceCreditCapacityCoordinator({maximumBytes:8,frameBytes:4,window:2}),old={},replacement={};
    ledger.update(old,update(1,2));expect(ledger.update(replacement,update(1,2,0,other)).grantedTotal).toBe(0);
    // No timer, disconnect or fork method exists that can manufacture settlement.
    expect(ledger.snapshot().reservedBytes).toBe(8);ledger.exited(old);ledger.exited(old);
    expect(ledger.update(replacement,update(2,2,0,other)).grantedTotal).toBe(2);
    expect(()=>ledger.update(old,update(2,2))).toThrow('exited');
    expect(ledger.snapshot().reservedBytes).toBe(8);
});

test('RPC requires exact same-session cumulative replies, one waiter and an unchanged master epoch',async()=>{
    const sent:any[]=[],ledger=new SourceCreditCapacityCoordinator(options),reader={};
    const rpc=new SourceCreditCapacityRpc(message=>{sent.push(message);},1000);
    const first=rpc.update(0,2);expect(isSourceCreditCapacityRequest(sent[0])).toBe(true);
    await expect(rpc.update(0,2)).rejects.toThrow('pending');
    rpc.onMessage({event:'source_credit_capacity_reply',mId:'old',data:{ok:true,result:{}}});
    const grant=ledger.update(reader,sent[0].data);
    const reply={event:'source_credit_capacity_reply',mId:sent[0].mId,data:{ok:true,result:grant}};
    rpc.onMessage(reply);rpc.onMessage(reply);expect(await first).toEqual(grant);
    const second=rpc.update(1,3),changed=ledger.update(reader,sent[1].data);
    rpc.onMessage({event:'source_credit_capacity_reply',mId:sent[1].mId,data:{ok:true,result:{...changed,epoch:other}}});
    await expect(second).rejects.toThrow('replaced');expect(ledger.snapshot().reservedBytes).toBe(8);
    await expect(rpc.update(1,3)).rejects.toThrow('closed');
    expect(isSourceCreditCapacityRequest({...sent[0],data:{...sent[0].data,authority:true}})).toBe(false);
});

test('cancellation, malformed replies, IPC failure and timeout cannot release master reservations',async()=>{
    const sent:any[]=[],ledger=new SourceCreditCapacityCoordinator(options),owner={};
    const rpc=new SourceCreditCapacityRpc(message=>{sent.push(message);ledger.update(owner,message.data);},1000);
    const pending=rpc.update(0,2);rpc.cancel();await expect(pending).rejects.toThrow('cancelled');
    rpc.onMessage({event:'source_credit_capacity_reply',mId:sent[0].mId,data:{ok:true,result:{}}});
    expect(ledger.snapshot().reservedBytes).toBe(8);
    const timed=new SourceCreditCapacityRpc(()=>{},5);await expect(timed.update(0,2)).rejects.toThrow('timed out');
    const failed=new SourceCreditCapacityRpc((_m,callback)=>callback(new Error('IPC closed')));
    await expect(failed.update(0,2)).rejects.toThrow('IPC closed');
    const malformed=new SourceCreditCapacityRpc(message=>{sent.push(message);},1000),bad=malformed.update(0,2);
    malformed.onMessage({event:'source_credit_capacity_reply',mId:sent.at(-1).mId,data:{ok:true,result:{...sent.at(-1).data,epoch:session,grantedTotal:3}}});
    await expect(bad).rejects.toThrow('Malformed');expect(ledger.snapshot().reservedBytes).toBe(8);
});
