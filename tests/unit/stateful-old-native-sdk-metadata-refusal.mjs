/** Explicit old native receiving-realm compatibility negative; no install, alias or adapter/service authority. */
import assert from 'node:assert/strict';import {findPackageJSON} from 'node:module';import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const [newSdkRoot,oldBackendRoot]=process.argv.slice(2);assert(newSdkRoot&&oldBackendRoot);
const fromNew=path=>import(pathToFileURL(join(newSdkRoot,path)).href);
const oldPackage=findPackageJSON('@eosrio/hyperion-sdk',pathToFileURL(join(oldBackendRoot,'package.json')));assert(oldPackage);
const oldManifest=JSON.parse(readFileSync(oldPackage,'utf8'));
const oldExport=subpath=>new URL(oldManifest.exports[subpath].import,pathToFileURL(oldPackage));
const newV1=await fromNew('dist/projection-stateful.js'),newOwner=await fromNew('dist/projection-stateful-owner-v2.js'),newSource=await fromNew('dist/projection-stateful-source-v2.js');
const oldV1=await import(oldExport('./projection-stateful').href);
const oldOwner=await import(oldExport('./projection-stateful-owner-v2').href);
const oldSource=await import(oldExport('./projection-stateful-source-v2').href);
const f=await fromNew('tests/fixtures/stateful-reference.mjs');
assert.notEqual(oldV1.captureStatefulDeclaration,newV1.captureStatefulDeclaration,'Actual independently installed modules');
const newDeclaration=await newOwner.captureStatefulOwnerDeclarationV2(await newV1.captureStatefulDeclaration(f.definition(),f.limits()),2);
const oldDeclaration=await oldOwner.captureStatefulOwnerDeclarationV2(await oldV1.captureStatefulDeclaration(f.definition(),f.limits()),2);
assert.equal(oldDeclaration.digest,newDeclaration.digest);
const input=f.source(newDeclaration.projection,1,f.hex(1),{blockNum:0,blockId:f.hex(0)},[['setdata',{value:'legacy'}]]);
const baseline=await oldSource.captureStatefulSourceV2(oldDeclaration,input);
assert.equal(baseline.digest,(await newSource.captureStatefulSourceV2(newDeclaration,input)).digest);
const marked={...input,actionMetadataVersion:1,inputs:input.inputs.map(row=>({...row,authorization:[{actor:'fixture',permission:'active'}]}))};
assert.equal((await newSource.captureStatefulSourceV2(newDeclaration,marked)).source.inputs[0].authorization[0].actor,'fixture');
await assert.rejects(oldSource.captureStatefulSourceV2(oldDeclaration,marked),/Unexpected source fields/);
console.log(JSON.stringify({independentSdkRealms:true,oldNativeSdkPath:oldExport('./projection-stateful-source-v2').href,
  oldLegacyDigestMatches:true,oldReceivingVariantRefused:true,newVariantAccepted:true,adapterNotExecuted:true,services:false,physical:false}));
