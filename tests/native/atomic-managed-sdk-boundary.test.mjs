// Pure SDK/declaration controls. No database, worker, HTTP host or timer is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const atomicRoot = realpathSync(process.env.HYPERION_ATOMIC_ROOT);
const atomicTree = 'db9a1c22fab23d118567588fdc3132e278f133c3';
assert.equal(execFileSync('git', ['-C', atomicRoot, 'rev-parse', 'HEAD^{tree}'], {encoding:'utf8', windowsHide:true}).trim(), atomicTree);
const mixedRoot=realpathSync(process.env.HYPERION_MIXED_ROOT);
assert.equal(execFileSync('git',['-C',mixedRoot,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),'c1b98a52a872b6c070ada32243c8286607e86883');
const {createAtomicStatefulPlugin} = await import(pathToFileURL(join(atomicRoot, 'dist/stateful/plugin.js')));
const {limits} = await import(pathToFileURL(join(atomicRoot, 'tests/fixtures/config-component.mjs')));
const root = {
    logical: await import('@eosrio/hyperion-sdk/projection-stateful'),
    owner: await import('@eosrio/hyperion-sdk/projection-stateful-owner-v2'),
    indexed: await import('@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1')
};
const sdkAt=async sdkRoot=>Object.fromEntries(await Promise.all([
    ['logical','projection-stateful'], ['owner','projection-stateful-owner-v2'], ['indexed','projection-stateful-indexed-query-v1']
].map(async ([key, subpath]) => [key, await import(pathToFileURL(join(sdkRoot,'dist',subpath+'.js')))])));
const nativeRoot=realpathSync(new URL('../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/',import.meta.url));
const native=await sdkAt(nativeRoot),mixed=await sdkAt(realpathSync(join(mixedRoot,'node_modules/@eosrio/hyperion-sdk')));
assert.notEqual(import.meta.resolve('@eosrio/hyperion-sdk/projection-stateful-indexed-query-v1'),pathToFileURL(join(nativeRoot,'dist/projection-stateful-indexed-query-v1.js')).href);
const hex = n => n.toString(16).padStart(64,'0');
const bounds = {...limits(),recordKinds:22,readKeys:64,readAttempts:128,mutations:256};
const plugin = createAtomicStatefulPlugin({limits:bounds,ownedSchemaCounts:true,engineeringOwnedSchemaMongoComparison:true,
    engineeringRoyaltyTemplateQuery:true,engineeringRoyaltyTemplateMongoComparison:true});
const registration = plugin.getStatefulProjectionsV2({binding:{},sourceCapabilities:['original-action-authorization-v1']});
const template = registration.projections.find(p=>p.definition.id==='atomicassets:royalty-template-rules');
assert(template);
const requirement = template.requiredIndexedQueries.find(q=>q.model.id==='atomicmarket-royalty-templates');
assert(requirement);
async function capture(sdk, selected=template) {
    const projection = await sdk.logical.captureStatefulDeclaration({...selected.definition,
        binding:{chainId:hex(1),backendId:'managed-atomic-boundary',generation:'fresh',mappingRevision:hex(2),hookArtifact:hex(3),hookRevision:hex(4),codecRevision:hex(5),normalizerRevision:hex(6)},
        selectors:selected.definition.selectors.map(s=>({...s,abiDeployment:'fixture',abiSha256:hex(7)}))},bounds);
    const offer = supported => ({family:sdk.owner.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:bounds});
    return sdk.owner.negotiateStatefulOwnerV2(projection,offer(sdk.owner.STATEFUL_OWNER_HOST_CAPABILITIES_V2),offer(sdk.owner.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
}

test('actual merged Atomic77 royalty membership is refused by the mixed host SDK before native work', async()=>{
    const lock = JSON.parse(readFileSync(join(mixedRoot,'package-lock.json')));
    assert(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved.endsWith('#dc20a03f2b60ba05a3369d677222a9cf0d65d299'));
    const owner = await capture(mixed);
    await assert.rejects(mixed.indexed.captureIndexedDeclarationV1(owner,requirement.modelRevision,requirement.model), /invalid field operators/);
    for(const selected of registration.projections) for(const q of selected.requiredIndexedQueries??[]) {
        if(q===requirement) continue;
        const declaration=await mixed.indexed.captureIndexedDeclarationV1(await capture(mixed,selected),q.modelRevision,q.model);
        assert.equal(declaration.model.id,q.model.id);
    }
});

test('receiving CBFB SDK captures the exact unchanged model while foreign brands remain refused', async()=>{
    const lock=JSON.parse(readFileSync(new URL('../../packages/backend-mongodb/package-lock.json',import.meta.url)));
    assert(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved.endsWith('#cbfb26694b90b52266d1e0b9b5dbf6f8389e736b'));
    const source=await capture(mixed),receiver=await capture(native);
    assert.equal(receiver.digest,source.digest);
    await assert.rejects(native.indexed.captureIndexedDeclarationV1(source,requirement.modelRevision,requirement.model), {code:'stateful.invalid-contract',message:'Recapture the owner declaration before use'});
    const declaration=await native.indexed.captureIndexedDeclarationV1(receiver,requirement.modelRevision,requirement.model);
    assert.deepEqual(declaration.model,requirement.model);
    assert(declaration.model.fields.some(field=>field.type==='int64'&&field.operators.includes('in')));
});

test('shipping host captures the unchanged royalty model through its own negotiated SDK authority',async()=>{
    const lock=JSON.parse(readFileSync(new URL('../../package-lock.json',import.meta.url)));
    assert(lock.packages['node_modules/@eosrio/hyperion-sdk'].resolved.endsWith('#cbfb26694b90b52266d1e0b9b5dbf6f8389e736b'));
    const declaration=await root.indexed.captureIndexedDeclarationV1(await capture(root),requirement.modelRevision,requirement.model);
    assert.deepEqual(declaration.model,requirement.model);
});

test('actual managed AA/AM source builders pass the shipping SDK source capture with original fixture payloads and registry stamps',async()=>{
 const {managedSourceInputs,managedRoyaltyTemplateInputs}=await import('../../scripts/qualification/atomic-managed/driver.mjs'),{captureStatefulSourceV2}=await import('@eosrio/hyperion-sdk/projection-stateful-source-v2'),{initial}=await import(pathToFileURL(join(atomicRoot,'tests/fixtures/asset-domain-cases.mjs')));
 const aa=await capture(root,registration.projections.find(p=>p.definition.id==='atomicassets')),am=await capture(root,template),ids=['-2','0','1','2','10','9223372036854775807'];
 for(const [declaration,inputs]of [[aa,managedSourceInputs(aa,initial(),1)],[am,managedRoyaltyTemplateInputs(am,ids,2)]]){
  const source={previous:{blockNum:0,blockId:hex(0)},block:{blockNum:1,blockId:hex(1),previousBlockId:hex(0),timeMs:'1'},inputs};
  const captured=await captureStatefulSourceV2(declaration,source);assert.equal(captured.declarationDigest,declaration.digest);assert.equal(Object.getPrototypeOf(captured.source.inputs[0]),null);assert.deepEqual(JSON.parse(JSON.stringify(captured.source.inputs)),inputs);assert.match(captured.digest,/^[a-f0-9]{64}$/);
  const changed=structuredClone(source);changed.inputs[0].abiSha256=hex(99);await assert.rejects(captureStatefulSourceV2(declaration,changed));
 }
});


test('actual managed royalty initializer uses the frozen source-input clock while AA keeps its chronology',async()=>{
 const driver=readFileSync(new URL('../../scripts/qualification/atomic-managed/driver.mjs',import.meta.url),'utf8'),original=readFileSync(join(atomicRoot,'scripts/qualification/royalty-template-mongodb/driver.mjs'),'utf8'),clock=/block:\{\.\.\.block,timeMs:('[0-9]+')\}/.exec(original);assert(clock,'Frozen original source frame must explicitly declare its clock');const originalTime=new Function('return '+clock[1])();assert.equal(originalTime,'1');
 const {managedSourceInputs,managedRoyaltyTemplateInputs}=await import('../../scripts/qualification/atomic-managed/driver.mjs'),{captureStatefulSourceV2}=await import('@eosrio/hyperion-sdk/projection-stateful-source-v2'),{initial}=await import(pathToFileURL(join(atomicRoot,'tests/fixtures/asset-domain-cases.mjs'))),oracle=await import(pathToFileURL(join(atomicRoot,'scripts/qualification/royalty-template-mongodb/oracle.mjs')));
 const frozen=oracle.originalSnapshot(),ids=frozen.physicalRows.map(row=>row.template_id),expected=new Map(frozen.results.find(row=>row.name==='none').http.body.data.map(row=>[row.template_id,row]));
 const start=driver.indexOf('    const apply=async('),end=driver.indexOf('\n    const phase=',start);assert(start>0&&end>start);const applySource=driver.slice(start,end),initializeAt=driver.indexOf('initialize:ids=>apply(am,'),observeAt=driver.indexOf(',observe:async(query,name)=>{',initializeAt);assert(initializeAt>0&&observeAt>initializeAt);const initializeSource=driver.slice(initializeAt+'initialize:'.length,observeAt);
 async function probe(declaration,royalty,serial){
  const previous={declarationDigest:declaration.digest,backendId:declaration.projection.definition.binding.backendId,generation:declaration.projection.definition.binding.generation,revision:hex(8),checkpoint:{blockNum:0,blockId:hex(0)}},stop=new Error('pure source capture boundary'),state={entry:{declaration,adapter:{async recovery(){return{view:previous};},async admitRaw(){}},reduce:template.reduce},identity:{id:'clock-control',generation:'one'},lease:{}};let captured,frames=0;
  const owner={...root.owner,async executeStatefulOwnerBlockV2(actual,_adapter,_lease,_target,source){assert.equal(actual,declaration);captured=await captureStatefulSourceV2(actual,source);frames++;throw stop;}},unreachable=()=>{throw new Error('Pure clock probe must stop before effects/custody/publication');};
  const apply=new Function('owner','guard','copy','hex','custody','publishSource','persist','assert','serial',applySource+';return apply;')(owner,()=>{},structuredClone,hex,()=>({}),unreachable,unreachable,assert,serial);
  const initialize=new Function('apply','am','managedRoyaltyTemplateInputs','return ('+initializeSource+');')(apply,state,managedRoyaltyTemplateInputs);
  await assert.rejects(royalty?initialize(ids):apply(state,id=>managedSourceInputs(declaration,initial(),id)),error=>error===stop);assert.equal(frames,1);return captured.source;
 }
 const am=await capture(root,template),aa=await capture(root,registration.projections.find(row=>row.definition.id==='atomicassets'));
 for(const serial of [112,999]){
  const source=await probe(am,true,serial);assert.equal(source.block.timeMs,originalTime,'Actual AM initialize callback must supply the original input clock independently of AA serial');assert.equal(source.block.blockNum,1);
  const rows=[];await template.reduce({source,async get(){return{status:'covered-absent'};},put(kind,key,value){assert.equal(kind,'market-royalty-template');rows.push(value);},delete(){throw new Error('Initialization does not delete');}});assert.equal(rows.length,ids.length);
  for(const row of rows){const prior=expected.get(row.template_id);assert(prior);for(const field of ['created_at_time','updated_at_time','created_at_block','updated_at_block'])assert.equal(row[field],prior[field],row.template_id+': '+field);}
  assert.equal((await probe(aa,false,serial)).block.timeMs,String(1700000000000+(serial+1)*1000),'AA source chronology remains unchanged');
 }
});
