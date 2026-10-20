import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {assertProtocolProofRequestActive, withProtocolProofRequest} from '../../src/api/helpers/protocol-proof-request.js';

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
