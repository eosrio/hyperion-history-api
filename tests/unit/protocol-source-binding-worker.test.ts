import {expect,test} from 'bun:test';
import {fileURLToPath} from 'node:url';

test('production reader source bindings isolate reconnects, quarantine incomplete input and durably link before ACK',async()=>{
    const child=Bun.spawn([process.env.HYPERION_NATIVE_NODE??'node',fileURLToPath(new URL('./protocol-source-binding-worker.mjs',import.meta.url))],
        {stdout:'pipe',stderr:'pipe',timeout:30000});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr,stdout:stdout.slice(-3500)}).toMatchObject({code:0,stderr:''});
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({passed:true,readerToRabbit:true,perDeliverySession:true,
        durableQuarantine:true,linkBeforeAck:true,reconnectIngress:true,legacyAddonImported:false,canonicalActivation:false});
},35000);
