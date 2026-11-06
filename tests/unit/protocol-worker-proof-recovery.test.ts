import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';
test('emitted worker pure-read recovery keeps source, lifetime, output and API fences',async()=>{
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node',fileURLToPath(new URL('./protocol-worker-proof-recovery.mjs',import.meta.url))],
        {stdout:'pipe',stderr:'pipe',timeout:30000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr,stdout:stdout.slice(-15000)}).toMatchObject({code:0,stderr:''});
},35000);
