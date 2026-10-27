import {createHash} from 'node:crypto';
import * as sdk from '@eosrio/hyperion-sdk/projection-stateful';
import {createMongoDbStatefulAdapter} from '../dist/stateful.js';
import {databaseFixture, hex, genesis} from './fixture.mjs';
export {sdk, databaseFixture, hex, genesis};
export const hash = value => createHash('sha256').update(value).digest('hex');
export const limits = () => ({value:{depth:32,nodes:10000,fields:64,arrayElements:512,stringBytes:65536,recordBytes:262144,integerFields:8,pathSegments:16},
    envelope:{depth:48,nodes:100000,fields:64,arrayElements:2048,stringBytes:2097152,recordBytes:4194304,integerFields:8,pathSegments:16},
    selectors:8,recordKinds:8,inputOccurrences:512,inputBytes:1048576,keyBytes:1024,readKeys:32,readAttempts:128,mutations:512,candidateBytes:4194304,responseRecords:32,responseBytes:4194304});
export const definition = () => ({family:sdk.STATEFUL_FAMILY,interfaceVersion:1,id:'driver-boundary-stateful',
    binding:{chainId:hex(10),backendId:'stateful-fixture',generation:'synthetic-genesis',mappingRevision:hex(11),hookArtifact:hex(12),hookRevision:hex(13),codecRevision:hex(14),normalizerRevision:hex(15)},
    selectors:[{id:'changes',kind:'action',contract:'fixture',name:'changes',abiDeployment:'synthetic-1',abiSha256:hex(16)}],
    records:[{kind:'asset',integers:[{path:['id'],type:'uint64',vector:false},{path:['vector'],type:'uint64',vector:true}]},{kind:'collection',integers:[]}]});
export const host = bounds => ({family:sdk.STATEFUL_FAMILY,interfaceVersion:1,supported:sdk.STATEFUL_HOST_CAPABILITIES,limits:bounds});
export async function configured(fixture=databaseFixture(), changes={}) {
    const draft=changes.declaration??await sdk.captureStatefulDeclaration(definition(),limits());
    const options={client:fixture.client,databaseName:'stateful_fixture',backendId:'stateful-fixture',collectionPrefix:'boundary',declaration:draft,
        receiptRetention:4,rollbackRetentionBlocks:8,rollbackRetentionBytes:4194304,rollbackMaxBlockBytes:1048576,operationTimeoutMS:1000,transactionTimeoutMS:2000,...changes};
    const adapter=await createMongoDbStatefulAdapter(options);
    const declaration=await sdk.negotiateStatefulProjection(draft.definition,draft.limits,host(draft.limits),adapter.capabilities);
    return {fixture,options,adapter,declaration,custody:new Custody()};
}
export class Custody {
    entries=new Map();retains=0;
    async load(d,s){return this.entries.get(d+s)??null;}
    async retain(c){const id=c.declarationDigest+c.source.digest,prior=this.entries.get(id);if(prior&&prior.digest!==c.digest)throw new Error('custody conflict');this.entries.set(id,structuredClone(c));this.retains++;}
}
export async function setup(fixture,changes){const state=await configured(fixture,changes);await state.adapter.initialize(state.declaration);return state;}
export function source(state,n,id=n,previous={blockNum:n-1,blockId:hex(n-1)}){
    return {previous,block:{blockNum:n,blockId:hex(id),previousBlockId:previous.blockId,timeMs:String(1000+n)},inputs:[]};
}
export const guard=()=>{};
export const run=(s,input,hook)=>sdk.executeStatefulBlock(s.declaration,input,s.adapter,s.custody,hook,guard);
export const view=s=>s.adapter.open(s.declaration);
export const read=async(s,v,kind='asset',key='one')=>(await sdk.readStatefulRecords(s.declaration,s.adapter,v,[{kind,key}],guard))[0];
export const physical = s => {
    const values=[...s.fixture.storage.entries()];
    return {metadata:[...values.find(([n])=>n.endsWith('_metadata'))[1].values()][0],rows:[...values.find(([n])=>n.includes('_r_'))[1].values()],images:[...values.find(([n])=>n.includes('_u_'))[1].values()]};
};
