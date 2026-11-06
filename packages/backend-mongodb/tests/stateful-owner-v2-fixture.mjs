import * as v1 from '@eosrio/hyperion-sdk/projection-stateful';
import * as sdk from '@eosrio/hyperion-sdk/projection-stateful-owner-v2';
import {createMongoDbStatefulOwnerAdapterV2} from '../dist/stateful-owner-v2.js';
import {databaseFixture, definition, limits, hex, Custody} from './stateful-fixture.mjs';
export {v1, sdk, hex, Custody, createMongoDbStatefulOwnerAdapterV2};
export const guard=()=>{};
export const ownerIdentity=(generation='one')=>({id:'actual-worker-control',generation});
export function ownerFixture(){
    const fixture=databaseFixture(),originalDb=fixture.client.db.bind(fixture.client);
    // Model transactional collection creation explicitly. The original v1 fixture stays byte-exact.
    fixture.client.db=(...args)=>{const db=originalDb(...args);return {...db,async createCollection(name,options){
        if(!options?.session)return db.createCollection(name,options);
        fixture.native.push({command:'createCollection',name,options});
        if(options.session.storage.has(name))throw new Error('transactional namespace exists');
        options.session.storage.set(name,new Map());
    }};};
    return fixture;
}
export async function configured(fixture=ownerFixture(),changes={}){
    const {projection:provided,...nativeChanges}=changes;
    const projection=provided??await v1.captureStatefulDeclaration(definition(),limits()),draft=await sdk.captureStatefulOwnerDeclarationV2(projection,2);
    const options={client:fixture.client,databaseName:'stateful_fixture',backendId:'stateful-fixture',collectionPrefix:'boundary',declaration:draft,
        receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:1000,transactionTimeoutMS:2000,...nativeChanges};
    const adapter=await createMongoDbStatefulOwnerAdapterV2(options),declaration=await sdk.negotiateStatefulOwnerV2(projection,
        {family:sdk.STATEFUL_OWNER_FAMILY_V2,interfaceVersion:2,sourceInputVersions:[2],supported:sdk.STATEFUL_OWNER_HOST_CAPABILITIES_V2,limits:projection.limits},adapter.capabilities);
    return {fixture,adapter,declaration,options,custody:new Custody()};
}
export async function setup(fixture,changes){const state=await configured(fixture,changes);state.identity=ownerIdentity();
    state.lease=await state.adapter.acquireOwner({expected:null,nextOwner:state.identity},guard);return state;}
export const physical=s=>[...s.fixture.storage.entries()].find(([name])=>name.endsWith('_stateful_v2_metadata'))[1].values().next().value;
export async function raw(s,n,id=n){const recovery=await s.adapter.recovery();return sdk.captureStatefulRawTargetV2(s.declaration,{
    schemaVersion:2,chainId:s.declaration.projection.definition.binding.chainId,declarationDigest:s.declaration.digest,owner:s.identity,previous:recovery.view,
    block:{blockNum:n,blockId:hex(id),previousBlockId:recovery.view.checkpoint.blockId},
    rawSource:{commitId:'synthetic-commit:'+hex(n),selectionId:'synthetic-selection:'+hex(n),observationId:'synthetic-observation:'+hex(n),observationDigest:hex(n+100)}});}
export const source=target=>({previous:target.target.previous.checkpoint,block:{...target.target.block,timeMs:'1001'},inputs:[]});
export async function admit(s,n,id=n){const target=await raw(s,n,id);await s.adapter.admitRaw(s.lease,target);return target;}
export const execute=(s,target,hook)=>sdk.executeStatefulOwnerBlockV2(s.declaration,s.adapter,s.lease,target.digest,source(target),s.custody,hook,guard);
export async function takeover(s,generation='two',authority=guard){const recovery=await s.adapter.recovery(),identity=ownerIdentity(generation);
    const request={expected:{version:recovery.version,view:recovery.view,owner:recovery.owner},nextOwner:identity};
    const lease=await s.adapter.acquireOwner(request,authority);return {...s,lease,identity};}
export async function retire(s,target){const candidate=[...s.custody.entries.values()].find(c=>c.source.source.block.blockId===target.target.block.blockId);
    await s.adapter.retireRaw(s.lease,target.digest,candidate.source.digest,candidate.digest);return candidate;}
