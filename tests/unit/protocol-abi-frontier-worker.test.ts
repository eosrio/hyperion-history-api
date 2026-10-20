import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';

for(const profileId of ['wire-sysio-6508c9e8-engineering-v1','wire-sysio-7dede884-engineering-v1'])test(`canonical ABI host coordinates actual runtime paths for ${profileId} without enabling decoding`,async()=>{
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node',fileURLToPath(new URL('./protocol-abi-frontier-worker.mjs',import.meta.url))],
        {stdout:'pipe',stderr:'pipe',timeout:30000,env:{...process.env,HYPERION_WIRE_PROFILE:profileId}});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr,stdout:stdout.slice(-4000)}).toMatchObject({code:0,stderr:''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed:true,profileId,actualReaderMasterWorker:true,sourceOrder:true,
        backpressure:true,lostHintRecovery:true,resume:true,coldStartReplay:true,revokeRace:true,admitRevokeRace:true,currentWorkerAuth:true,forkGeneration:true,incompleteContinuation:true,
        bulkAuthority:false,decodingActivation:false,syntheticConsensus:false});
},35000);
