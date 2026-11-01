// Normal packed native-adapter consumers; no database/network connection is created.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temporary=await mkdtemp(join(tmpdir(),'stateful-mongodb-consumer-'));
const npm=process.env.npm_execpath;assert.ok(npm,'Run through npm run test:package');
const run=(args,cwd)=>execFileSync(process.execPath,[npm,...args],{cwd,stdio:['ignore','pipe','inherit']});
try{
    run(['pack','--ignore-scripts','--pack-destination',temporary],root);
    const sdkRoot=join(root,'node_modules/@eosrio/hyperion-sdk');
    run(['pack','--ignore-scripts','--pack-destination',temporary],sdkRoot);
    const tarballs=(await readdir(temporary)).filter(n=>n.endsWith('.tgz'));assert.equal(tarballs.length,2);
    const consumer=join(temporary,'consumer');await mkdir(consumer);
    await writeFile(join(consumer,'package.json'),JSON.stringify({name:'stateful-native-consumer',private:true,type:'module'}));
    run(['install','--ignore-scripts','--no-audit','--no-fund',...tarballs.map(n=>join(temporary,n)),'@types/node@25.5.0'],consumer);
    for(const name of ['fixture.mjs','stateful-fixture.mjs','stateful.test.mjs','stateful-owner-v2-fixture.mjs','stateful-owner-v2.test.mjs',
        'stateful-complete-kind-fixture.mjs','stateful-complete-kind.test.mjs','stateful-complete-kind-driver.test.mjs']){
        let text=await readFile(join(root,'tests',name),'utf8');
        text=text.replaceAll('../dist/index.js','@eosrio/hyperion-backend-mongodb').replaceAll('../dist/stateful.js','@eosrio/hyperion-backend-mongodb/stateful');
        text=text.replaceAll('../dist/stateful-owner-v2.js','@eosrio/hyperion-backend-mongodb/stateful-owner-v2');
        text=text.replaceAll('../dist/stateful-complete-kind-v1.js','@eosrio/hyperion-backend-mongodb/stateful-owner-complete-kind-v1');
        await writeFile(join(consumer,name),text);
    }
    await writeFile(join(consumer,'consumer.mts'),await readFile(join(root,'tests/consumers/stateful.mts'),'utf8'));
    await writeFile(join(consumer,'owner-v2.mts'),await readFile(join(root,'tests/consumers/stateful-owner-v2.mts'),'utf8'));
    await writeFile(join(consumer,'complete-kind.mts'),await readFile(join(root,'tests/consumers/stateful-complete-kind.mts'),'utf8'));
    execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--strict','--skipLibCheck','--target','ES2022','--module','NodeNext','consumer.mts','owner-v2.mts','complete-kind.mts'],{cwd:consumer,stdio:'inherit'});
    execFileSync(process.execPath,[join(consumer,'consumer.mjs')],{cwd:consumer,stdio:'inherit'});
    execFileSync(process.execPath,['--test',join(consumer,'stateful.test.mjs'),join(consumer,'stateful-owner-v2.test.mjs'),
        join(consumer,'stateful-complete-kind.test.mjs'),join(consumer,'stateful-complete-kind-driver.test.mjs')],{cwd:consumer,stdio:'inherit'});
    console.log('Packed ESM/TypeScript and native-driver controls passed; physical MongoDB qualification remains pending.');
}finally{await rm(temporary,{recursive:true,force:true});}
