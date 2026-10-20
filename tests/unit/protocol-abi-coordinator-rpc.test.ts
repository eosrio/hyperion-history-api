import {expect,test} from 'bun:test';
import {ProtocolAbiCoordinatorRpc,isProtocolAbiCoordinatorRequest} from '../../src/indexer/protocol/abi-coordinator-rpc.js';

const context='h45srcctx1:'+'1'.repeat(64),selection='h45srcsel1:'+'2'.repeat(64);
test('coordinator RPC holds one waiter and correlates replies without accepting a stale result',async()=>{
    const sent:any[]=[];const client=new ProtocolAbiCoordinatorRpc(message=>{sent.push(message);},1000);
    const opened=client.open(context,'reader-one');
    await expect(client.open(context,'reader-two')).rejects.toThrow('pending');
    client.onMessage({event:'protocol_abi_coordinator_reply',mId:'old',data:{ok:true,result:{generation:'old',resumeFromBlock:1}}});
    expect(isProtocolAbiCoordinatorRequest(sent[0])).toBe(true);
    client.onMessage({event:'protocol_abi_coordinator_reply',mId:sent[0].mId,data:{ok:true,result:{generation:'one',resumeFromBlock:42}}});
    expect(await opened).toEqual({generation:'one',resumeFromBlock:42});
    const admitted=client.admit(selection,'reader-one','one');
    client.onMessage({event:'protocol_abi_coordinator_reply',mId:sent[1].mId,data:{ok:true,result:{status:'accepted',generation:'fork-two'}}});
    expect(await admitted).toEqual({status:'accepted',generation:'fork-two'});
});
test('coordinator RPC cancellation rejects its waiter and cannot resolve a later request with the old reply',async()=>{
    const sent:any[]=[];const client=new ProtocolAbiCoordinatorRpc(message=>{sent.push(message);},1000);
    const first=client.open(context,'reader-one');client.cancel();await expect(first).rejects.toThrow('socket changed');
    const second=client.open(context,'reader-two');
    client.onMessage({event:'protocol_abi_coordinator_reply',mId:sent[0].mId,data:{ok:true,result:{generation:'old',resumeFromBlock:3}}});
    client.onMessage({event:'protocol_abi_coordinator_reply',mId:sent[1].mId,data:{ok:true,result:{generation:'current',resumeFromBlock:null}}});
    expect(await second).toEqual({generation:'current',resumeFromBlock:null});
});
test('coordinator RPC reports IPC failures, malformed replies and bounded timeouts without leaking capacity',async()=>{
    const failed=new ProtocolAbiCoordinatorRpc((_message,callback)=>callback(new Error('IPC closed')));
    await expect(failed.open(context,'reader')).rejects.toThrow('IPC closed');
    const sent:any[]=[];const client=new ProtocolAbiCoordinatorRpc(message=>{sent.push(message);},10);
    const malformed=client.open(context,'reader');
    client.onMessage({event:'protocol_abi_coordinator_reply',mId:sent[0].mId,data:{ok:true,result:{generation:'g',resumeFromBlock:-1}}});
    await expect(malformed).rejects.toThrow('Malformed');
    await expect(client.open(context,'reader')).rejects.toThrow('timed out');
    expect(isProtocolAbiCoordinatorRequest({...sent[0],data:{operation:'open',contextId:context,readerSessionId:'r',proof:true}})).toBe(false);
});
