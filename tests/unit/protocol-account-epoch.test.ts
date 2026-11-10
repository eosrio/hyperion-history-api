import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('the actual deserializer records an account row as an ABI deployment only when its proof shows a new epoch',()=>{
    const result=spawnSync(process.env.HYPERION_TEST_NODE??'node',[fileURLToPath(new URL('./protocol-account-epoch-worker.mjs',import.meta.url))],
        {encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
    expect(result.status,result.stderr+result.stdout).toBe(0);expect(result.stdout).toContain('"passed":true');
},30000);
