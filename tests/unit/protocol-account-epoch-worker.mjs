import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// The actual MainDS account handler, driven with a stub proof reader: which account rows become ABI deployments.
const directory=mkdtempSync(join(tmpdir(),'h45-account-epoch-')),chain='account-epoch';
const config={settings:{chain,parser:'3.2',index_version:'v1',index_partition_size:10000,es_replicas:0},indexer:{},
    features:{streaming:{deltas:false,traces:false},tables:{}},scaling:{ds_pool_size:1,indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},
    prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{actions:[],deltas:[]}};
mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
writeFileSync(join(directory,'config/connections.json'),'{}');process.env.CONFIG_JSON=join(directory,'chain.json');process.chdir(directory);
const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
const {ProtocolAbiProofUnavailableError}=await import('../../build/indexer/protocol/abi-proof.js');

const block=n=>n.toString(16).padStart(64,'0'),abiHex='0e7379736f2e61626900000000',blockNum=100,blockId=block(100);
const sent=[];process.send=message=>{sent.push(message);return true;};
function worker(options={}) {
    const view=Object.hasOwn(options,'view')?options.view:{source:{blockNum,blockId}},inspect=options.inspect;
    const value=Object.create(MainDS.prototype),published=[],inspected=[];
    const fields={chain,conf:config,protocol:{profileId:'epoch-profile',contractCodec:{decodeAbi:()=>({actions:[{name:'setcode'}],tables:[{name:'global'}]})}},
        abieos:{deleteContract(){}},protocolAbiAtBlock:new Map(),protocolAbiSelections:new Map([['kept',{}]]),verifyTypeCache:new Map([['kept',[true,'t']]]),
        autoBlacklist:new Map(),activeProtocolAbiProofView:view,
        getProtocolAbiProofReader:()=>({inspectFinalState:async(...args)=>{inspected.push(args);return inspect(...args);}}),
        enqueueDerivedPublication:async payload=>{published.push(JSON.parse(payload.content.toString()));}};
    for(const [key,item] of Object.entries(fields))Object.defineProperty(value,key,{value:item,writable:true});
    return {value,published,inspected};
}
const state=(sourceBlock,hex=abiHex,present=true)=>({account:'sysio',present,abiHex:hex,source:{blockNum:sourceBlock,blockId:block(sourceBlock)}});
const touch=async(f,{present=1,hex=abiHex,at=blockNum,id=blockId}={})=>{
    sent.length=0;
    await f.value.processProtocolAccount({name:'sysio',abi:hex},at,'2026-01-01T00:00:00.000',{present,ordinal:3},id);
    return {recorded:f.published.length===1,broadcast:sent.filter(message=>message.event==='save_abi').length};
};

// An ordinary touch under an older retained epoch with identical bytes: no document, no broadcast, caches intact.
let f=worker({inspect:()=>state(40)});
assert.deepEqual(await touch(f),{recorded:false,broadcast:0});
assert.equal(f.inspected.length,1);assert.equal(f.inspected[0][1],'sysio');
assert.equal(f.value.protocolAbiSelections.size,1);assert.equal(f.value.verifyTypeCache.size,1);assert.equal(f.value.protocolAbiAtBlock.size,0);

// A deployment at this block, including identical bytes republished by setabi, is recorded.
f=worker({inspect:()=>state(blockNum)});assert.deepEqual(await touch(f),{recorded:true,broadcast:1});
assert.equal(f.published[0].block,blockNum);assert.equal(f.published[0].abi_available,true);
assert.equal(f.value.protocolAbiSelections.size,0);

// Different bytes, an absent state, or a removed account all keep the previous behaviour.
for(const inspect of [()=>state(40,'00'),()=>null,()=>state(40,abiHex,false),()=>({...state(40),account:'other'})]) {
    f=worker({inspect});assert.deepEqual(await touch(f),{recorded:true,broadcast:1});
}
f=worker({inspect:()=>state(40)});assert.deepEqual(await touch(f,{present:0}),{recorded:true,broadcast:1});
f=worker({inspect:()=>state(40)});assert.deepEqual(await touch(f,{hex:''}),{recorded:true,broadcast:1});

// An account that never had an ABI is touched like any other: its empty epoch is kept, so only its first row is recorded.
f=worker({inspect:()=>state(40,'')});assert.deepEqual(await touch(f,{hex:''}),{recorded:false,broadcast:0});
assert.equal(f.value.protocolAbiAtBlock.size,0);
f=worker({inspect:()=>state(blockNum,'')});assert.deepEqual(await touch(f,{hex:''}),{recorded:true,broadcast:1});
assert.equal(f.published[0].abi_available,false);
// A row with bytes under an empty epoch is a deployment and is recorded.
f=worker({inspect:()=>state(40,'')});assert.deepEqual(await touch(f),{recorded:true,broadcast:1});
// A removed account under a retained removed epoch is a touch too; a removed row with other bytes is recorded.
f=worker({inspect:()=>state(40,abiHex,false)});assert.deepEqual(await touch(f,{present:0}),{recorded:false,broadcast:0});
f=worker({inspect:()=>state(40,'',false)});assert.deepEqual(await touch(f,{present:0}),{recorded:true,broadcast:1});

// Only a proof view of exactly this block can retain an epoch.
for(const view of [undefined,{source:{blockNum:blockNum-1,blockId:block(blockNum-1)}},{source:{blockNum,blockId:block(7)}}]) {
    f=worker({view,inspect:()=>state(40)});assert.deepEqual(await touch(f),{recorded:true,broadcast:1});
    assert.equal(f.inspected.length,0);
}

// An unavailable proof records the row; a storage failure escapes so the block is redelivered.
f=worker({inspect:()=>{throw new ProtocolAbiProofUnavailableError('ancestry_unavailable','not retained');}});
assert.deepEqual(await touch(f),{recorded:true,broadcast:1});
const failure=new Error('store down');f=worker({inspect:()=>{throw failure;}});
await assert.rejects(touch(f),error=>error.message==='Canonical ABI proof storage failed'&&error.cause===failure);
assert.equal(f.published.length,0);

// The actual worker reader builders: proof stores take the bounded read view, so a second read within the bound skips metadata.
const {default:DSPool}=await import('../../build/indexer/workers/ds-pool.js');
const {ProtocolAbiFrontierStore}=await import('../../build/indexer/protocol/abi-frontier-store.js');
const memory=frontierMemoryClient(),writer=new ProtocolAbiFrontierStore(memory.client,chain);
await writer.compareAndSet(null,{schemaVersion:1});const committed=await writer.prepareCommit({height:1});
const profile={id:'epoch-fixture',profileId:'epoch-profile',components:[{id:'node',runtime:'node',version:'0.0.0',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const built=Class=>{const value=Object.create(Class.prototype);
    for(const [key,item] of Object.entries({conf:config,chain,chainId:'1'.repeat(64),client:memory.client,protocolId:profile.id,
        protocolComponents:profile.components,protocol:{profileId:profile.profileId}}))Object.defineProperty(value,key,{value:item,writable:true});return value;};
const metadataReads=mark=>memory.calls.slice(mark).filter(call=>call.method==='getIndex').length;
const readers={'ds-pool':built(DSPool).getStandaloneProtocolProofReader(),deserializer:built(MainDS).getProtocolAbiProofReader()};
for(const [name,reader] of Object.entries(readers)) {
    const store=reader.options.store;await store.readControl();await store.readCommit(committed.id);
    const mark=memory.calls.length;await store.readControl();
    assert.equal(metadataReads(mark),0,name+' control read relies on its bounded check');
    assert.ok(memory.calls.length>mark,name+' still reads control itself');
    await assert.rejects(store.compareAndSet(null,{schemaVersion:1}),/Read-only/);
}
const strict=new ProtocolAbiFrontierStore(memory.client,chain,0,{readOnly:true});await strict.readControl();
let mark=memory.calls.length;await strict.readControl();assert.equal(metadataReads(mark),1,'a default store checks every read');
// The writer itself never relies on an earlier check.
mark=memory.calls.length;await writer.prepareCommit({height:2});assert.ok(metadataReads(mark)>=1);

console.log(JSON.stringify({passed:true,node:process.version}));
