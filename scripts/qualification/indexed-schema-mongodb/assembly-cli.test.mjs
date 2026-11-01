// Actual CLI observation: ordinary settled child exits only. No DB, controller, deadline or signal operations.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSEMBLY,PROFILE,indexedSdkDirectory,inventory,observeIndexedAssembly} from './assembly.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),cli=fileURLToPath(new URL('./assembly.mjs',import.meta.url));
function run(args){return new Promise((resolve,reject)=>{
 const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
 const child=spawn(process.execPath,[cli,...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
 child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
});}
test('actual CLI admits the installed import-only SDK49 root/native source and whole emissions',async()=>{
 const result=await run(['--profile',PROFILE]);assert.equal(result.signal,null);assert.equal(result.code,0,result.stderr);
 assert.equal(result.stderr,'');const receipt=JSON.parse(result.stdout);assert.equal(receipt.profile,PROFILE);
 assert.deepEqual(receipt.observation,{profile:PROFILE,pins:ASSEMBLY.pins,sources:ASSEMBLY.sources,trees:ASSEMBLY.trees});
 assert.equal(receipt.runtime.node,process.version);assert.equal(receipt.runtime.executable,process.execPath);
 assert.equal(receipt.nativeMongoDB,'pending');assert.equal(receipt.AtomicSQL,'pending');assert.equal(receipt.managedHTTP,'pending');
});
test('root and native observations name separate installations and never fall back to an ancestor SDK',()=>{
 const parent=join(root,'out');mkdirSync(parent,{recursive:true});const workspace=mkdtempSync(join(parent,'indexed-assembly-scope-')),
  native=join(workspace,'packages','backend-mongodb');mkdirSync(native,{recursive:true});
 for(const directory of [workspace,native])writeFileSync(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
 const install=(base,value)=>{const sdk=join(base,'node_modules','@eosrio','hyperion-sdk');mkdirSync(join(sdk,'dist'),{recursive:true});
  writeFileSync(join(sdk,'package.json'),JSON.stringify({name:'@eosrio/hyperion-sdk',type:'module',exports:{'.':{import:'./dist/index.js'}}}));
  writeFileSync(join(sdk,'dist','index.js'),`throw new Error('Observation must not execute ${value}');\n`);return sdk;};
 const rootSdk=install(workspace,'root');assert.equal(indexedSdkDirectory(workspace),rootSdk);
 assert.throws(()=>indexedSdkDirectory(native),/selected root\/native npm installation/);
 const nativeSdk=install(native,'native');assert.equal(indexedSdkDirectory(native),nativeSdk);assert.notEqual(rootSdk,nativeSdk);
 assert.notDeepEqual(inventory(join(rootSdk,'dist')),inventory(join(nativeSdk,'dist')));
 for(const base of [root,join(root,'packages/backend-mongodb')]){
  const directory=indexedSdkDirectory(base),metadata=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
  assert.equal(metadata.exports['.'].require,undefined);assert.equal(directory,join(base,'node_modules','@eosrio','hyperion-sdk'));
 }
 const actual=observeIndexedAssembly();assert.deepEqual(actual.trees.rootSDK,inventory(join(indexedSdkDirectory(root),'dist')));
 assert.deepEqual(actual.trees.nativeSDK,inventory(join(indexedSdkDirectory(join(root,'packages/backend-mongodb')),'dist')));
});
test('actual CLI still refuses omitted and historical assembly profiles',async()=>{
 for(const args of [[],['--profile','stateful-owner-v2-root741-native429-wire69-native45-linux-gitlf-engineering']]){
  const result=await run(args);assert.equal(result.signal,null);assert.equal(result.code,1);assert.equal(result.stdout,'');
  assert.match(result.stderr,/AssertionError/);
 }
});
