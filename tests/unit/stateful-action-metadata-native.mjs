import assert from 'node:assert/strict';
import {findPackageJSON} from 'node:module';
import {realpathSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {statefulHostFixture} from './stateful-host-fixture.mjs';
import {captureStatefulSourceV2, STATEFUL_ACTION_AUTHORIZATION_CAPABILITY_V1 as capability} from '@eosrio/hyperion-sdk/projection-stateful-source-v2';
import {deriveProtocolActionOccurrences} from '../../build/indexer/history/action-source-inventory.js';

assert.equal(process.versions.bun,undefined);assert.match(process.version,/^v(?:24|26)\./);
const seen=[],f=await statefulHostFixture({requiredSourceCapabilities:[capability],hooks:{source(port){seen.push(structuredClone(port.source));}}});
try{
  assert.equal(f.registry.entries.get(f.declaration.projection.definition.id).sourceMetadata.actionMetadataVersion,1);
  assert.deepEqual(seen.map(source=>source.actionMetadataVersion),[1,1,1]);
  const input=seen[2].inputs.find(input=>input.kind==='action');assert(input);assert.equal(Object.hasOwn(input.data,'authorization'),false);
  const packet=await f.p.source.originalBlock(3,async()=>{}),session=f.p.options.provider.createShipSession(JSON.parse(packet.context.schemaJson));
  let original;
  try{original=deriveProtocolActionOccurrences(session.decodeTraces(Buffer.from(packet.observation.capture.tracesHex,'hex')))
    .find(row=>row.input.account==='target'&&row.input.name==='update');}finally{session.close?.();}
  assert(original);assert.deepEqual(input.authorization,original.authorization);
  for(const table of seen[2].inputs.filter(input=>input.kind==='table'))assert.equal(Object.hasOwn(table,'authorization'),false);
  const legacy=await f.p.source.statefulBlock(3,f.declaration,async()=>{});
  assert.equal(Object.hasOwn(legacy.source.source,'actionMetadataVersion'),false);
  assert.equal(Object.hasOwn(legacy.source.source.inputs[0],'authorization'),false);
  const marked=await f.p.source.statefulBlock(3,f.declaration,async()=>{},{actionMetadataVersion:1});
  assert.notEqual(marked.source.digest,legacy.source.digest);assert.notEqual(marked.source.source.inputs[0].sourceEvidence,legacy.source.source.inputs[0].sourceEvidence);
  assert.equal((await captureStatefulSourceV2(f.declaration,seen[2])).digest,marked.source.digest);
  // The actual native adapter applied this marked candidate using its own receiving SDK recapture.
  const recovery=await f.native.adapter.recovery();assert.equal(recovery.view.checkpoint.blockNum,3);assert.equal(recovery.raw,null);
  const response=await f.app.inject('/state');assert.equal(response.statusCode,200,response.body);
  let refusedAdmissions=0;
  for(const metadata of [{actionMetadataVersion:2},{actionMetadataVersion:1,ready:true},[],null])
    await assert.rejects(f.p.source.statefulBlock(3,f.declaration,async()=>{refusedAdmissions++;},metadata));
  assert.equal(refusedAdmissions,0);
  const backendSdkPackage=findPackageJSON('@eosrio/hyperion-sdk',new URL('../../packages/backend-mongodb/package.json',import.meta.url));assert(backendSdkPackage);
  const backendSdkManifest=JSON.parse(readFileSync(backendSdkPackage,'utf8'));
  const backendSdkSource=new URL(backendSdkManifest.exports['./projection-stateful-source-v2'].import,pathToFileURL(backendSdkPackage));
  console.log(JSON.stringify({actualValidatedOriginalAuthorization:true,markedSourcesApplied:seen.length,legacyVariantPreserved:true,
    tableMetadataAbsent:true,originalSourceEvidenceBound:true,actualHostRegistry:true,nativeCandidateRecaptured:true,
    rootSdk:realpathSync(fileURLToPath(import.meta.resolve('@eosrio/hyperion-sdk/projection-stateful-source-v2'))),
    backendSdk:fileURLToPath(backendSdkSource),services:false,physical:false}));
}finally{await f.close();}
