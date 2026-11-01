// Explicit new source binding for the existing operator-list fixture; historical profile remains untouched.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ASSEMBLY,observeIndexedAssembly} from '../indexed-schema-mongodb/assembly.mjs';
import {STATEFUL_SDK49_SOURCE_PROFILE,admitSdk49SourceOptions} from '../../../tests/unit/sdk49-indexed-source-admission.mjs';
import {OPERATOR_LIST_ASSEMBLY as historical} from './linux-cleanup-source-profile.mjs';
import {sha} from './contract.mjs';
import {diagnosticDirectory,retainAdmission,writeAssemblyDiagnostic} from './assembly-diagnostics.mjs';
export const OPERATOR_LIST_PROFILE=STATEFUL_SDK49_SOURCE_PROFILE;
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export const OPERATOR_LIST_ASSEMBLY=freeze({...historical,profile:OPERATOR_LIST_PROFILE,
 trees:{...historical.trees,nativeBuild:{...historical.trees.nativeBuild,sha256:sha(JSON.stringify(ASSEMBLY.trees.nativeBuild))}}});
export function admitOperatorListAssembly(profile){assert.equal(profile,OPERATOR_LIST_PROFILE);return admitSdk49SourceOptions({engineeringSourceProfile:profile});}
export function diagnoseOperatorListAssembly(directory){
 diagnosticDirectory(directory);const snapshot=observeIndexedAssembly();
 const paths={rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'};
 const trees=Object.fromEntries(Object.entries(snapshot.trees).map(([name,rows])=>[name,{path:paths[name],files:rows.length,sha256:sha(JSON.stringify(rows)),textLF:false}]));
 const observed={...snapshot,sourceFiles:snapshot.sources,trees};delete observed.sources;
 const provenance={platform:process.platform,arch:process.arch,environmentObservations:Object.fromEntries(
  ['GITHUB_SHA','GITHUB_WORKFLOW_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB','RUNNER_OS','RUNNER_ARCH'].map(name=>[name,(process.env[name]??'').slice(0,512)]))};
 return retainAdmission(()=>admitOperatorListAssembly(OPERATOR_LIST_PROFILE),admission=>writeAssemblyDiagnostic({
  root:fileURLToPath(new URL('../../../',import.meta.url)),directory,observed,inventories:snapshot.trees,expected:ASSEMBLY,admission,provenance}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 assert.equal(process.argv[2],'--diagnostics');assert.equal(process.argv.length,4);console.log(JSON.stringify(diagnoseOperatorListAssembly(process.argv[3]),null,2));
}
