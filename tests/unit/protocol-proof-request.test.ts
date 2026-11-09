import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import {assertProtocolProofRequestActive, createProtocolStreamScope, streamProofRecoveryMs, withProtocolProofRequest}
    from '../../src/api/helpers/protocol-proof-request.js';
import {ProtocolAbiProofUnavailableError, protocolHistoricalAdvanceError} from '../../src/indexer/protocol/abi-proof.js';
import {currentProofReadRecovery} from '../../src/indexer/protocol/proof-consumer-scope.js';

function fixture() {
    const socket=Object.assign(new EventEmitter(),{destroyed:false});
    const raw=Object.assign(new EventEmitter(),{aborted:false,socket});
    return {raw};
}

for(const event of ['aborted','close'] as const) {
    test(`HTTP proof work stops promptly on ${event} and removes its listeners`,async()=>{
        const scope=fixture();let release!:()=>void,signal:AbortSignal|undefined;
        const held=new Promise<void>(resolve=>{release=resolve;});
        const pending=withProtocolProofRequest(scope,async options=>{signal=options.signal;await held;return 'late';})
            .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
        if(event==='aborted'){scope.raw.aborted=true;scope.raw.emit('aborted');}
        else{scope.raw.socket.destroyed=true;scope.raw.socket.emit('close');}
        const result=await Promise.race([pending,new Promise<{error?:unknown;value?:unknown}>(resolve=>setImmediate(()=>resolve({value:'still pending'})))]);
        try {
            expect(result.error).toMatchObject({statusCode:503,code:'proof_cancelled'});
            expect(signal?.aborted).toBe(true);
            expect(scope.raw.listenerCount('aborted')).toBe(0);
            expect(scope.raw.socket.listenerCount('close')).toBe(0);
        } finally {release();await pending;}
    });
}

test('successful HTTP proof work releases listeners and preserves the result',async()=>{
    const scope=fixture();
    expect(await withProtocolProofRequest(scope,async()=>{
        expect(scope.raw.listenerCount('aborted')).toBe(1);
        expect(scope.raw.socket.listenerCount('close')).toBe(1);
        return 0;
    })).toBe(0);
    expect(scope.raw.listenerCount('aborted')).toBe(0);expect(scope.raw.socket.listenerCount('close')).toBe(0);
});

test('already disconnected HTTP requests never start additional proof work',async()=>{
    for(const event of ['aborted','close']) {
        const scope=fixture();if(event==='aborted')scope.raw.aborted=true;else scope.raw.socket.destroyed=true;
        let calls=0;
        await expect(withProtocolProofRequest(scope,async()=>{calls++;})).rejects.toMatchObject({statusCode:503,code:'proof_cancelled'});
        expect(calls).toBe(0);expect(()=>assertProtocolProofRequestActive(scope)).toThrow();
    }
});

test('stream proof scopes keep their independently managed lifetime',async()=>{
    const scope={};assertProtocolProofRequestActive(scope);
    expect(await withProtocolProofRequest(scope,async options=>{expect(options.signal).toBeUndefined();return 'stream';})).toBe('stream');
});

const streamSocket=()=>Object.assign(new EventEmitter(),{connected:true});
test('a stream proof read repeats under bounded recovery when the historical root advances',async()=>{
    const socket=streamSocket(),{scope,dispose}=createProtocolStreamScope([socket]);
    const recoveries:number[]=[];let calls=0;
    try {
        expect(await withProtocolProofRequest(scope,async options=>{
            calls++;const recovery=currentProofReadRecovery();
            expect(recovery?.signal).toBe(options.signal);recoveries.push(recovery!.remainingMs());
            if(calls<3)throw protocolHistoricalAdvanceError('Activated historical address root changed');
            return 'proven';
        })).toBe('proven');
        expect(calls).toBe(3);
        // One shared deadline across the repeated reads, within the stream bound.
        expect(recoveries.every(ms=>ms>0&&ms<=streamProofRecoveryMs)).toBe(true);
        expect(recoveries[2]).toBeLessThan(recoveries[0]);
    } finally {dispose();}
});

test('a stream proof read never repeats any other proof failure',async()=>{
    const socket=streamSocket(),{scope,dispose}=createProtocolStreamScope([socket]);
    try {
        for(const error of [new ProtocolAbiProofUnavailableError('authority_changed','Activated historical address root changed'),
            new ProtocolAbiProofUnavailableError('source_not_canonical','x'),new Error('boom')]) {
            let calls=0;
            const thrown=await withProtocolProofRequest(scope,async()=>{calls++;throw error;}).catch(caught=>caught);
            expect(thrown).toBe(error);expect(calls).toBe(1);
        }
    } finally {dispose();}
});

test('a stream disconnect ends the recovery wait at once',async()=>{
    const socket=streamSocket(),{scope,dispose}=createProtocolStreamScope([socket]);let calls=0;
    try {
        const pending=withProtocolProofRequest(scope,async()=>{calls++;
            if(calls===1)setImmediate(()=>socket.emit('disconnect'));
            throw protocolHistoricalAdvanceError('Canonical ABI head advanced during historical root selection');
        }).catch(caught=>caught);
        const started=performance.now(),thrown=await pending;
        expect(thrown).toMatchObject({code:'proof_cancelled'});
        expect(calls).toBeLessThanOrEqual(2);expect(performance.now()-started).toBeLessThan(1000);
    } finally {dispose();}
});

test('HTTP proof reads keep their own policy and do not repeat a historical advance here',async()=>{
    const scope=fixture();let calls=0;
    const error=protocolHistoricalAdvanceError('Activated historical address root changed');
    expect(await withProtocolProofRequest(scope,async()=>{calls++;expect(currentProofReadRecovery()).toBeUndefined();throw error;}).catch(caught=>caught)).toBe(error);
    expect(calls).toBe(1);
});
