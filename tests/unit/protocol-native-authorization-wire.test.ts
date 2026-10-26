import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('original Wire native actions use coordinator-issued canonical occurrences within the default recovery window',async()=>{
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node',fileURLToPath(new URL('./protocol-native-authorization-wire.mjs',import.meta.url))],
        {stdout:'pipe',stderr:'pipe',timeout:90000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr,stdout:stdout.slice(-4000)}).toMatchObject({code:0,stderr:''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toMatchObject({passed:true,originalBlocks:397,archiveMembers:1488,
        defaultAncestry:256,agedProofsUnavailable:[33,122],genesisZeroToOne:true,nativeActivation:false,fullWorkerQualification:false});
},95000);
