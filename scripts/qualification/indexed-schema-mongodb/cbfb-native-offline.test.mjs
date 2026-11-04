// Pure cbfb fixture controls: never import or run the native process lifecycle.
import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import * as ts from 'typescript/unstable/ast';
import {PLAN as historical} from './native-contract.mjs';
import {PLAN} from './cbfb-native-contract.mjs';
import {DESCRIPTOR} from './cbfb-assembly.mjs';
import {NATIVE_PROFILE,observeNativeInputs,assertNativeInputs,assertNativeRuntime} from './cbfb-native-assembly.mjs';
import {observeSourceClosure,assertSourceClosure} from './native-source-closure.mjs';
test('cbfb fixture preserves historical resources, limits and all existing cases',()=>{
 assert.deepEqual(PLAN.fixture,historical.fixture);assert.deepEqual(PLAN.limits,historical.limits);assert.equal(PLAN.operationMS,historical.operationMS);assert.equal(PLAN.transactionMS,historical.transactionMS);
 assert.deepEqual(PLAN.cases.filter(x=>x!=='bounded-int64-membership'),historical.cases);assert(PLAN.cases.includes('bounded-int64-membership'));
 assert.equal(PLAN.sdk,'cbfb26694b90b52266d1e0b9b5dbf6f8389e736b');assert.equal(PLAN.acceptance.nativeMongoDB,'pending-until-run');
});
test('cbfb native profile captures exact installed dependencies and retains historical descriptor',()=>{
 const actual=observeNativeInputs(),receipt=assertNativeInputs(actual);assert.equal(receipt.profile,PLAN.profile);
 for(const mutate of [x=>x.sourceFiles[0].sha256='0'.repeat(64),x=>x.dependencies['native:bson'].files.pop(),x=>x.baseAssemblySha256='f'.repeat(64)]){const copy=structuredClone(actual);mutate(copy);assert.throws(()=>assertNativeInputs(copy));}
 for(const runtime of NATIVE_PROFILE.runtimes){assertNativeRuntime({node:runtime.node,platform:'linux',arch:'x64',executableSha256:runtime.executableSha256});assert.throws(()=>assertNativeRuntime({node:runtime.node,platform:'linux',arch:'x64',executableSha256:'0'.repeat(64)}));}
});
test('cbfb native source closure is exact and bounded',()=>{
 const boundaries=new Set(DESCRIPTOR.observation.sources.map(x=>x.path));for(const [key,prefix] of Object.entries({rootBuild:'build',nativeBuild:'packages/backend-mongodb/dist',rootSDK:'node_modules/@eosrio/hyperion-sdk/dist',nativeSDK:'packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist'}))for(const row of DESCRIPTOR.observation.trees[key])boundaries.add(prefix+'/'+row.path);
 const closure=observeSourceClosure({root:fileURLToPath(new URL('../../../',import.meta.url)),ts,boundaries,...NATIVE_PROFILE.sourceClosure.inputs});assertSourceClosure(closure,NATIVE_PROFILE);
 const altered=structuredClone(closure);altered.edges.pop();assert.throws(()=>assertSourceClosure(altered,NATIVE_PROFILE),/closure changed/);
});
import * as logical from '@eosrio/hyperion-sdk/projection-stateful';
import * as owner from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import * as indexed from '../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-indexed-query-v1.js';
import * as nativeOwner from '../../../packages/backend-mongodb/node_modules/@eosrio/hyperion-sdk/dist/projection-stateful-owner-v2.js';
import {receiveMongoIndexedModelV1,planMongoIndexedQueryV1} from '../../../packages/backend-mongodb/dist/stateful-indexed-model-v1.js';
import {projectionDefinition,projectionLimits,schemaModel,page} from './cbfb-native-contract.mjs';
test('real mixed root/native SDK captures bounded signed-int64 set as BSON Long',async()=>{
 const projection=await logical.captureStatefulDeclaration(projectionDefinition(logical,'mixed-sdk-control'),projectionLimits());
 const capability=supported=>({family:owner.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:projection.limits});
 const declared=await owner.negotiateStatefulOwnerV2(projection,capability(owner.STATEFUL_OWNER_HOST_CAPABILITIES_V2),capability(owner.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const received=await nativeOwner.receiveStatefulOwnerDeclarationV2(declared),nativeCapability=supported=>({family:nativeOwner.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported,limits:received.projection.limits});
 const native=await nativeOwner.negotiateStatefulOwnerV2(received.projection,nativeCapability(nativeOwner.STATEFUL_OWNER_HOST_CAPABILITIES_V2),nativeCapability(nativeOwner.STATEFUL_OWNER_ADAPTER_CAPABILITIES_V2));
 const declaration=await indexed.captureIndexedDeclarationV1(native,'owned-native-fixture-v1',schemaModel()),model=await receiveMongoIndexedModelV1(native,declaration,PLAN.limits);
 const where=[{field:'contract',op:'eq',value:'atomicassets'},{field:'created',op:'in',values:['9007199254740995','9007199254740993','9007199254740993']}];
 const planned=planMongoIndexedQueryV1(model,page({where,limit:8}),'fixture_rows'),set=planned.pipeline[0].$match.$and.find(row=>row['v.created'])['v.created'].$in;
 assert.deepEqual(set.map(v=>v.toString()),where[1].values);assert(set.every(v=>v._bsontype==='Long'));assert.equal(planned.allowDiskUse,false);
});
