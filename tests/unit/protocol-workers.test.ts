import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('selected Wire package traverses production reader, parser, action pool and row/index output methods',async()=>{
    const fixture = fileURLToPath(new URL('./protocol-worker-fixture.mjs',import.meta.url));
    const child = Bun.spawn([process.env.HYPERION_NATIVE_NODE ?? 'node',fixture],{stdout:'pipe',stderr:'pipe',timeout:30000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr,stdout:stdout.slice(-1500)}).toMatchObject({code:0,stderr:''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed:true,capturedFrame:true,syntheticConsensus:false,
        readerRequests:4,actions:2,histories:6,stateOperations:6,legacyAddonImported:false});
},35000);
