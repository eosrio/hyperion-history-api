// Separate all-CBFB root/native engineering source admission. Mixed/SDK49 profiles remain frozen.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {observeCbfbAssembly} from './cbfb-assembly.mjs';
export const PROFILE='indexed-schema-all-cbfb-root-native-wire69-engineering-v1';
export const DESCRIPTOR=JSON.parse(readFileSync(new URL('./all-cbfb-assembly.json',import.meta.url),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function observeAllCbfbAssembly(){
 const observation=observeCbfbAssembly();observation.profile=PROFILE;
 for(const path of ['scripts/qualification/indexed-schema-mongodb/all-cbfb-assembly.mjs','scripts/qualification/indexed-schema-mongodb/all-cbfb-assembly.test.mjs']){
  const bytes=readFileSync(new URL('../../../'+path,import.meta.url));observation.sources.push({path,bytes:bytes.length,sha256:sha(bytes)});
 }observation.sources.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return observation;
}
export function assertAllCbfbAssembly(observation){
 assert.equal(observation.profile,PROFILE);for(const key of ['rootSDK','nativeSDK'])assert.equal(observation.pins[key],'git+https://github.com/eosrio/hyperion-sdk.git#cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');
 assert.equal(DESCRIPTOR.profile,PROFILE);assert.equal(DESCRIPTOR.qualificationOnly,true);assert.deepEqual(observation,DESCRIPTOR.observation,'Exact all-CBFB source/emission assembly differs');
 return{profile:PROFILE,scope:'exact-all-cbfb-engineering-source-and-emissions-only',integratedNativeMongo:'pending',AtomicSQL:'pending',managedHTTP:'pending',productionOffers:'empty',observationSha256:sha(JSON.stringify(observation))};
}
export function admitAllCbfbAssembly(){assert.equal(process.versions.bun,undefined);assert([24,26].includes(Number(process.versions.node.split('.')[0])));const observation=observeAllCbfbAssembly();return{...assertAllCbfbAssembly(observation),runtime:{node:process.version,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))}};}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--profile',PROFILE]);console.log(JSON.stringify(admitAllCbfbAssembly(),null,2));}
