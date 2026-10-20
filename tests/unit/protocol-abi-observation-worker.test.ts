import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('production MainDS prepares unfiltered Wire facts before ACK, preserving no-op and incomplete distinctions',async()=>{
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node',fileURLToPath(new URL('./protocol-abi-observation-worker.mjs',import.meta.url))],
        {stdout:'pipe',stderr:'pipe',timeout:30000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr,stdout:stdout.slice(-2500)}).toMatchObject({code:0,stderr:''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed:true,prepared:11,sourceAckAfterDurability:true,cargoRestart:true,canonicalActivation:false,syntheticConsensus:false});
},35000);
