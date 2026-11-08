import {describe,expect,it} from 'bun:test';
import {waitForHistoricalSource} from '../../src/indexer/protocol/historical-source-wait.js';
import {ProtocolAbiProofUnavailableError} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolNativeActionUnavailableError} from '../../src/indexer/protocol/native-authorization.js';

const missing=()=>new ProtocolAbiProofUnavailableError('historical_source_unavailable','Historical address is not in the activated root');
function clock(){
    let time=0;const sleeps:number[]=[];
    return {sleeps,now:()=>time,sleep:async(ms:number)=>{sleeps.push(ms);time+=ms;}};
}

describe('waiting for the historical ABI root',()=>{
    it('retries an uncovered block until the root covers it, notifying once',async()=>{
        const c=clock();let calls=0,notified=0;
        const value=await waitForHistoricalSource(async()=>{if(++calls<5)throw missing();return 'view';},
            {now:c.now,sleep:c.sleep,onWait:()=>notified++});
        expect(value).toBe('view');expect(calls).toBe(5);expect(notified).toBe(1);
        expect(c.sleeps).toEqual([250,500,1000,2000]);
    });
    it('caps the backoff and rethrows the last error once the bound is spent',async()=>{
        const c=clock();let calls=0,last:unknown;
        const thrown=await waitForHistoricalSource(async()=>{calls++;throw (last=missing());},
            {now:c.now,sleep:c.sleep,maxWaitMs:20000}).catch(error=>error);
        expect(thrown).toBe(last);
        expect(Math.max(...c.sleeps)).toBe(5000);expect(c.sleeps.reduce((a,b)=>a+b,0)).toBe(20000);expect(calls).toBe(c.sleeps.length+1);
    });
    it('retries the native reader error with the same code',async()=>{
        const c=clock();let calls=0;
        expect(await waitForHistoricalSource(async()=>{
            if(++calls===1)throw new ProtocolNativeActionUnavailableError('historical_source_unavailable','not covered');return 1;},
            {now:c.now,sleep:c.sleep})).toBe(1);
        expect(calls).toBe(2);
    });
    it('never retries other proof results, and a zero bound makes a single attempt',async()=>{
        for(const code of ['authority_changed','source_not_canonical','ancestry_unavailable','proof_timeout']){
            const c=clock();let calls=0;const error=new ProtocolAbiProofUnavailableError(code,'x');
            await expect(waitForHistoricalSource(async()=>{calls++;throw error;},{now:c.now,sleep:c.sleep})).rejects.toBe(error);
            expect(calls).toBe(1);expect(c.sleeps).toEqual([]);
        }
        const plain=new Error('boom');let calls=0;
        await expect(waitForHistoricalSource(async()=>{calls++;throw plain;})).rejects.toBe(plain);expect(calls).toBe(1);
        const c=clock();calls=0;const once=missing();
        await expect(waitForHistoricalSource(async()=>{calls++;throw once;},{now:c.now,sleep:c.sleep,maxWaitMs:0})).rejects.toBe(once);
        expect(calls).toBe(1);expect(c.sleeps).toEqual([]);
    });
    it('rejects an invalid bound before opening',async()=>{
        let calls=0;
        await expect(waitForHistoricalSource(async()=>{calls++;},{maxWaitMs:-1})).rejects.toThrow('Invalid historical source wait bound');
        expect(calls).toBe(0);
    });
});
