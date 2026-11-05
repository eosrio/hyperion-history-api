import test from 'node:test';
import assert from 'node:assert/strict';
import {frontierMemoryClient} from '../unit/protocol-frontier-memory.mjs';
const {ProtocolAbiCoordinator}=await import('../../build/indexer/protocol/abi-coordinator.js');
const {ProtocolAbiFrontierStore}=await import('../../build/indexer/protocol/abi-frontier-store.js');
const {ProtocolSourceBindingStore}=await import('../../build/indexer/protocol/source-bindings.js');
const {ProtocolAbiObservationStore}=await import('../../build/indexer/protocol/abi-observation-store.js');
const chainId='1'.repeat(64),profile={id:'@eosrio/hyperion-wire-plugin',profileId:'seed-test',components:[{id:'wire-node',runtime:'node',version:'1.0.0',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
test('fresh qualified coordinator durably returns the genesis request boundary without a fabricated head',async()=>{
 const memory=frontierMemoryClient(),chain='wire-qualification-fixture',bindings=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain),store=new ProtocolAbiFrontierStore(memory.client,chain);
 const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson:'{}'})).id;
 const coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'owner',bindings,observations,store,qualificationGenesisStart:true,verifyNativeGenesis:()=>false});
 await coordinator.start();const state=await coordinator.inspect();assert.equal(state.head,null);assert.equal(state.replayFromBlock,1);
 const source=await coordinator.openSource(contextId,'live-reader');assert.equal(source.resumeFromBlock,1);
});

test('qualification seed preserves an existing control and restart resumes its persisted request boundary',async()=>{
 const memory=frontierMemoryClient(),chain='wire-qualification-restart',bindings=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain),store=new ProtocolAbiFrontierStore(memory.client,chain);
 const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson:'{}'})).id;
 const make=(owner,seed)=>new ProtocolAbiCoordinator({chainId,profile,ownerId:owner,bindings,observations,store,...(seed?{qualificationGenesisStart:true,verifyNativeGenesis:()=>false}:{})});
 const first=make('first',true);await first.start();
 const restarted=make('restart',true);await restarted.start();assert.equal((await restarted.openSource(contextId,'restart-session')).resumeFromBlock,1);assert.equal((await restarted.inspect()).head,null);
});
test('existing control from a different protocol profile is never adopted',async()=>{
 const memory=frontierMemoryClient(),chain='wire-qualification-profile',bindings=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain),store=new ProtocolAbiFrontierStore(memory.client,chain);
 const first=new ProtocolAbiCoordinator({chainId,profile,ownerId:'first',bindings,observations,store});await first.start();
 const other={...profile,profileId:'different-profile'};
 const changed=new ProtocolAbiCoordinator({chainId,profile:other,ownerId:'other',bindings,observations,store,qualificationGenesisStart:true,verifyNativeGenesis:()=>false});
 await assert.rejects(()=>changed.start(),/different ABI profile/);assert.equal((await first.inspect()).ownerId,'first');
});
test('unknown initial CAS receipt never grants a source or seed',async()=>{
 const memory=frontierMemoryClient(),chain='wire-qualification-receipt',bindings=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain),store=new ProtocolAbiFrontierStore(memory.client,chain);
 const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson:'{}'})).id;
 memory.faults.receipt=(receipt,request)=>request.id==='control'?{...receipt,_shards:{total:1,successful:0,failed:1}}:receipt;
 const coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'owner',bindings,observations,store,qualificationGenesisStart:true,verifyNativeGenesis:()=>false});
 await assert.rejects(()=>coordinator.start(),/Incomplete ABI frontier durable control receipt/);
 await assert.rejects(()=>coordinator.openSource(contextId,'live-reader'));
});
test('unsupported native genesis verifier cannot select the seed',()=>{
 const memory=frontierMemoryClient(),chain='wire-qualification-unsupported',bindings=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain),store=new ProtocolAbiFrontierStore(memory.client,chain);
 assert.throws(()=>new ProtocolAbiCoordinator({chainId,profile,ownerId:'owner',bindings,observations,store,qualificationGenesisStart:true}),/native genesis verification/);
});

