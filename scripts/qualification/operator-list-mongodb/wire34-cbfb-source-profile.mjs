// Explicit Wire34/CBFB operator-list source admission. Frozen Wire69 bindings remain unchanged.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DESCRIPTOR,observeWire34CbfbAssembly} from '../indexed-schema-mongodb/wire34-cbfb-assembly.mjs';
import {STATEFUL_WIRE34_CBFB_SOURCE_PROFILE,WIRE34_CBFB_MANIFEST,admitWire34CbfbSourceOptions} from '../../../tests/unit/wire34-cbfb-source-admission.mjs';
import {CBFB_SDK,freeze} from '../wire34-cbfb/contract.mjs';
import {OPERATOR_LIST_ASSEMBLY as historical} from './linux-cleanup-source-profile.mjs';
import {sha} from './wire34-cbfb-contract.mjs';
import {diagnosticDirectory,retainAdmission,writeAssemblyDiagnostic} from './assembly-diagnostics.mjs';
const ASSEMBLY=DESCRIPTOR.observation;
export const OPERATOR_LIST_PROFILE=STATEFUL_WIRE34_CBFB_SOURCE_PROFILE;
const paths={rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'};
export const OPERATOR_LIST_ASSEMBLY=freeze({schemaVersion:1,profile:OPERATOR_LIST_PROFILE,qualificationOnly:true,
 consumerBase:WIRE34_CBFB_MANIFEST.consumerBase,
 checkoutIdentity:'Actual CI checkout and full tracked-path census are recorded separately; consumerBase is not the workflow checkout',
 pins:ASSEMBLY.pins,sourceFiles:WIRE34_CBFB_MANIFEST.sources.files,
 ciIdentitySourcePaths:['tests/unit/wire34-cbfb-source-admission.mjs','tests/fixtures/engineering-profiles/wire34-cbfb-linux.json'],
 trees:Object.fromEntries(Object.entries(ASSEMBLY.trees).map(([name,rows])=>[name,{path:paths[name],files:rows.length,sha256:sha(JSON.stringify(rows)),textLF:false}])),
 sdkPackages:Object.fromEntries(['root','native'].map(scope=>[scope,{revision:CBFB_SDK,sha256:WIRE34_CBFB_MANIFEST.sdkPackageSha256}])),
 dependencies:WIRE34_CBFB_MANIFEST.dependencies,
 wire:{...WIRE34_CBFB_MANIFEST.wire,sdkRevision:'58d68c5cea81490bbb1c9a7736d633d465bab3ef',sdkPackageSha256:WIRE34_CBFB_MANIFEST.wireSdkPackageSha256,sdkFiles:WIRE34_CBFB_MANIFEST.wireSdkFiles},
 fixture:historical.fixture,platform:historical.platform,runtimeEvidence:historical.runtimeEvidence,engineeringCandidate:historical.engineeringCandidate,
 runtimeQualification:'Wire34 exact Linux24.22.1/26.4.0 admission; retained runtimeEvidence establishes no current workload acceptance'});
export function admitOperatorListAssembly(profile){assert.equal(profile,OPERATOR_LIST_PROFILE);return admitWire34CbfbSourceOptions({engineeringSourceProfile:profile});}
export function diagnoseOperatorListAssembly(directory){
 diagnosticDirectory(directory);const snapshot=observeWire34CbfbAssembly();
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
