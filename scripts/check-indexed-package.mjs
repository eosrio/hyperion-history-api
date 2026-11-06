// Normal npm commands only, settled child exits. No timeout, signal, kill, service or controller operations.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {dirname,delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),native=join(root,'packages/backend-mongodb'),name='@eosrio/hyperion-backend-mongodb';
const npmCli=process.env.npm_execpath;assert(npmCli,'Run this package check through npm');
await mkdir(join(root,'out'),{recursive:true});const evidence=await mkdtemp(join(root,'out','indexed-packed-')),consumer=join(evidence,'consumer');await mkdir(consumer);
const commands=[],sha=bytes=>createHash('sha256').update(bytes).digest('hex'),env={...process.env,PATH:dirname(process.execPath)+delimiter+process.env.PATH};delete env.NODE_OPTIONS;delete env.NODE_PATH;
async function run(label,args,cwd){
 const startedAt=new Date().toISOString(),answer=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 child.once('error',reject);child.once('close',status=>resolve({status,stdout,stderr}));});
 await writeFile(join(evidence,label+'.stdout'),answer.stdout);await writeFile(join(evidence,label+'.stderr'),answer.stderr);
 commands.push({label,argv:[process.execPath,...args],cwd,startedAt,finishedAt:new Date().toISOString(),exitCode:answer.status,stdoutSha256:sha(answer.stdout),stderrSha256:sha(answer.stderr)});
 assert.equal(answer.status,0,label+'\n'+answer.stdout+'\n'+answer.stderr);return answer.stdout;
}
try{
 const raw=JSON.parse(await run('pack',[npmCli,'pack','--json','--pack-destination',evidence],native)),packed=(Array.isArray(raw)?raw:Object.values(raw))[0];assert.equal(packed.name,name);
 const paths=packed.files.map(x=>x.path);for(const file of ['dist/stateful-indexed-v1.js','dist/stateful-indexed-v1.d.ts','dist/stateful-indexed-model-v1.js','dist/stateful-indexed-materialization-v1.js','dist/stateful-indexed-cursor-v1.js'])assert(paths.includes(file));
 const tarball=join(evidence,packed.filename),sdk='git+https://github.com/eosrio/hyperion-sdk.git#dc20a03f2b60ba05a3369d677222a9cf0d65d299';
 await writeFile(join(consumer,'package.json'),JSON.stringify({name:'indexed-native-packed-control',private:true,type:'module',dependencies:{[name]:'file:'+tarball,'@eosrio/hyperion-sdk':sdk,mongodb:'7.2.0'},devDependencies:{typescript:'7.0.2','@types/node':'25.5.0'}},null,2)+'\n');
 await run('install',[npmCli,'install','--allow-git=all','--no-audit','--no-fund'],consumer);
 const installed=join(consumer,'node_modules',name),files={};for(const file of paths.sort()){
  const bytes=await readFile(join(installed,file));assert.equal(sha(bytes),sha(await readFile(join(native,file))),file);files[file]=sha(bytes);
 }
 await mkdir(join(installed,'tests'));for(const file of ['indexed-schema-fixture.mjs','indexed-schema-owner-port.mjs','indexed-schema-model.test.mjs','indexed-schema-effects.test.mjs','indexed-schema-cursor.test.mjs','indexed-schema-attachment.test.mjs','indexed-schema-owner.test.mjs'])await copyFile(join(native,'tests',file),join(installed,'tests',file));
 await writeFile(join(consumer,'consumer.mts'),`import {createMongoDbStatefulIndexedAdapterV1,type MongoDbStatefulIndexedAdapterV1} from '@eosrio/hyperion-backend-mongodb/stateful-owner-indexed-query-v1';
import type {IndexedQueryHostV1,IndexedRequestV1} from '@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1';
export const factory:typeof createMongoDbStatefulIndexedAdapterV1=createMongoDbStatefulIndexedAdapterV1;
export async function compose(host:IndexedQueryHostV1,q:IndexedRequestV1){return host.compose('schema',async read=>({data:await read.query(q)}));}
export type Native=MongoDbStatefulIndexedAdapterV1;
`);
 await writeFile(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:'ESNext',module:'NodeNext',types:['node']},files:['consumer.mts']},null,2)+'\n');
 await run('declarations',[join(consumer,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],consumer);
 await run('installed-finite',['--test',...['model','effects','cursor','attachment','owner'].map(x=>join(installed,'tests','indexed-schema-'+x+'.test.mjs'))],consumer);
 const receipt={node:process.version,evidence,installedFromTarball:true,tarball:{path:tarball,sha256:sha(await readFile(tarball)),integrity:packed.integrity},packedFiles:files,commands,
  scope:'Installed native model/planner/cursor/effect/attachment finite controls only. No native MongoDB/PostgreSQL, controller, physical HTTP listener or release qualification.'};
 await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({node:process.version,evidence,packedFiles:paths.length,installedFiniteControls:41,declarations:'passed'}));
}catch(error){await writeFile(join(evidence,'failed.json'),JSON.stringify({node:process.version,error:String(error.stack??error),commands},null,2)+'\n');throw error;}
