// Separate all-CBFB root/native engineering source admission. Mixed/SDK49 profiles remain frozen.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {observeCbfbAssembly} from './cbfb-assembly.mjs';
import {observeWire34CbfbSourceOptions,STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,WIRE34_CBFB_MANIFEST} from '../../../tests/unit/wire34-cbfb-source-admission.mjs';
export const PROFILE='indexed-schema-all-cbfb-root-native-wire34-engineering-v1';
export const DESCRIPTOR=JSON.parse(readFileSync(new URL('./wire34-cbfb-assembly.json',import.meta.url),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertWire34SourceCensus(value,environment){
 assert.equal(environment.GITHUB_ACTIONS,'true');assert.equal(value.schemaVersion,1);assert.equal(value.qualificationOnly,true);assert.equal(value.trackedAndClean,true);
 assert.equal(value.source,environment.GITHUB_SHA);assert.match(value.source,/^[a-f0-9]{40}$/);assert.match(value.tree,/^[a-f0-9]{40}$/);
 assert.equal(value.files,WIRE34_CBFB_MANIFEST.sources.trackedPaths.length);assert.equal(value.hashedFiles,WIRE34_CBFB_MANIFEST.sources.files.length);assert.equal(value.passivePaths,WIRE34_CBFB_MANIFEST.sources.nonExecutionTrackedPaths.length);
 for(const [key,name]of [['runId','GITHUB_RUN_ID'],['runAttempt','GITHUB_RUN_ATTEMPT'],['job','GITHUB_JOB']]){assert.equal(typeof environment[name],'string');assert(environment[name].length>0);assert.equal(value[key],environment[name]);}
 assert.equal(value.workloadAcceptance,'pending');return value;
}
export function readWire34SourceCensus(){
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const value=JSON.parse(execFileSync(process.execPath,['scripts/qualification/wire34-cbfb/source-check.mjs'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));
 return assertWire34SourceCensus(value,process.env);
}
export function observeWire34CbfbAssembly(){
 const observation=observeCbfbAssembly();observation.profile=PROFILE;
 for(const path of ['scripts/qualification/indexed-schema-mongodb/wire34-cbfb-assembly.mjs','scripts/qualification/indexed-schema-mongodb/wire34-cbfb-assembly.test.mjs','packages/backend-mongodb/src/stateful-indexed-linear-history-engineering-v1.ts','packages/backend-mongodb/LINEAR-HISTORY-ENGINEERING.json']){
  const bytes=readFileSync(new URL('../../../'+path,import.meta.url));observation.sources.push({path,bytes:bytes.length,sha256:sha(bytes)});
 }observation.sources.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return observation;
}
export function assertWire34CbfbAssembly(observation){
 assert.equal(observation.profile,PROFILE);for(const key of ['rootSDK','nativeSDK'])assert.equal(observation.pins[key],'git+https://github.com/eosrio/hyperion-sdk.git#cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');
 assert.equal(DESCRIPTOR.profile,PROFILE);assert.equal(DESCRIPTOR.qualificationOnly,true);assert.deepEqual(observation,DESCRIPTOR.observation,'Exact all-CBFB source/emission assembly differs');
 return{profile:PROFILE,scope:'exact-all-cbfb-engineering-source-and-emissions-only',integratedNativeMongo:'pending',AtomicSQL:'pending',managedHTTP:'pending',productionOffers:'empty',observationSha256:sha(JSON.stringify(observation))};
}
export function admitWire34CbfbAssembly(){assert.equal(process.versions.bun,undefined);assert([24,26].includes(Number(process.versions.node.split('.')[0])));const wireSource=observeWire34CbfbSourceOptions({engineeringSourceProfile:STATEFUL_WIRE34_CBFB_SOURCE_PROFILE});assert.equal(wireSource.wireRevision,'1e7547ff52740ecaa88d7867d3ec887a2febaa58');const observation=observeWire34CbfbAssembly();return{...assertWire34CbfbAssembly(observation),wireSource:{profile:wireSource.profile,sourceFiles:wireSource.sourceFiles,wireRevision:wireSource.wireRevision,wireTree:wireSource.wireTree,sourceAcceptance:wireSource.runtimeAcceptance},runtime:{node:process.version,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))}};}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.deepEqual(process.argv.slice(2),['--profile',PROFILE]);const sourceCensus=readWire34SourceCensus();console.log(JSON.stringify({...admitWire34CbfbAssembly(),sourceCensus},null,2));}
