// Exact independent cbfb/native source and emission admission. No host/DB operations.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {observeIndexedAssembly} from './assembly.mjs';
export const PROFILE='indexed-schema-sdk-cbfb-native-cf514-engineering-v1';
export const DESCRIPTOR=JSON.parse(readFileSync(new URL('./cbfb-assembly.json',import.meta.url),'utf8'));
const root=fileURLToPath(new URL('../../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
export function observeCbfbAssembly(){
 const observed=observeIndexedAssembly();observed.profile=PROFILE;
 for(const path of ['packages/backend-mongodb/src/stateful-indexed-royalty-engineering-v1.ts','packages/backend-mongodb/ROYALTY-ENGINEERING.json','scripts/qualification/indexed-schema-mongodb/cbfb-assembly.mjs','scripts/qualification/indexed-schema-mongodb/cbfb-assembly.test.mjs','.github/workflows/indexed-schema-finite.yml','packages/backend-mongodb/tests/indexed-int64-membership.test.mjs','packages/backend-mongodb/tests/indexed-schema-attachment.test.mjs','packages/backend-mongodb/tests/indexed-schema-owner.test.mjs']){
  const file=join(root,path),stat=lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=4*1024*1024);const bytes=readFileSync(file);observed.sources.push({path,bytes:bytes.length,sha256:sha(bytes)});
 }
 observed.sources.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return observed;
}
export function assertCbfbAssembly(observed){
 assert.equal(DESCRIPTOR.schemaVersion,1);assert.equal(DESCRIPTOR.qualificationOnly,true);assert.equal(DESCRIPTOR.profile,PROFILE);
 assert.equal(DESCRIPTOR.provenance.testedHapi,'49dfe804590ab5b9cb17df05ebc85eb8e6976b14');assert.equal(DESCRIPTOR.provenance.integratedPhysicalAcceptance,'pending');
 assert.deepEqual(observed,DESCRIPTOR.observation,'Exact cbfb source and emission profile differs');
 return {profile:PROFILE,scope:'exact-engineering-source-and-emissions-only',integratedNativeMongo:'pending',AtomicSQL:'pending',managedHTTP:'pending',productionOffers:'empty',observationSha256:sha(JSON.stringify(observed))};
}
export function admitCbfbAssembly(){assert.equal(process.versions.bun,undefined);assert([24,26].includes(Number(process.versions.node.split('.')[0])));const observation=observeCbfbAssembly();return {...assertCbfbAssembly(observation),runtime:{node:process.version,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))}};}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--profile',PROFILE]);console.log(JSON.stringify(admitCbfbAssembly(),null,2));}
