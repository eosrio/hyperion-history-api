import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepared,frames,schemaJson,capture,hash} from './portable-state-source-fixture.mjs';
const {ProtocolAbiCoordinator}=await import('../../build/indexer/protocol/abi-coordinator.js');
const {HyperionMaster}=await import('../../build/indexer/modules/master.js');

test('master grants only the current continuous reader after exact native and RPC preflight',async()=>{
    const p=await prepared({},0),dir=mkdtempSync(join(tmpdir(),'captured-master-'));
    const coordinator=new ProtocolAbiCoordinator({chainId:capture.chainId,profile:p.options.profile,ownerId:'master-control',
        store:p.store,bindings:p.bindings,observations:p.observations,
        verifyNativeGenesis:p.options.provider.verifyNativeGenesis.bind(p.options.provider),capturedGenesisEnabled:true});
    await coordinator.start();const ship=p.options.provider.createShipSession(JSON.parse(schemaJson));
    try {
        const one=ship.decodeResult(frames[0])[1],two=ship.decodeResult(frames[1])[1];
        const config={schema_path:join(dir,'schema'),schema_sha256:hash(schemaJson),frame_path:join(dir,'one'),frame_sha256:hash(frames[0]),
            block_two_path:join(dir,'two'),block_two_sha256:hash(frames[1])};
        writeFileSync(config.schema_path,schemaJson);writeFileSync(config.frame_path,frames[0]);writeFileSync(config.block_two_path,frames[1]);
        const worker={},other={},replies=[];
        const master=Object.assign(Object.create(HyperionMaster.prototype),{
            conf:{settings:{protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:capture.profileId},
                protocol_abi_coordination:{retained_genesis:config}}},chain:'wire',
            manager:{conn:{chains:{wire:{chain_id:capture.chainId}}}},protocolAbiCoordinator:coordinator,
            liveReader:{wref:worker},workerMap:[{wref:worker,worker_role:'continuous_reader'}],
            rpc:{v1:{chain:{get_info:async()=>({chain_id:capture.chainId,last_irreversible_block_num:2}),
                get_block:async n=>n===1?{id:one.this_block.block_id,previous:'0'.repeat(64)}:{id:two.this_block.block_id,previous:two.prev_block.block_id}}}},
            replyProtocolAbiCoordinator:(_worker,_id,data)=>replies.push(data),requestProtocolAbiDrain:()=>{},
            failProtocolAbiCoordinator:error=>{throw error;}
        });
        const message={event:'protocol_abi_coordinator_request',mId:randomUUID(),data:{operation:'capture_begin',contextId:p.contextId,readerSessionId:'capture'}};
        await master.handleProtocolAbiCoordinatorRequest(other,message);
        assert.equal(replies.pop().error.code,'unauthorized');assert.equal((await coordinator.inspect()).source,null);
        const inspect=coordinator.inspect.bind(coordinator);let release,entered;
        const waiting=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
        coordinator.inspect=async()=>{entered();await held;return inspect();};
        const racing=master.handleProtocolAbiCoordinatorRequest(worker,message);await waiting;
        master.liveReader={wref:other};master.workerMap=[{wref:other,worker_role:'continuous_reader'}];release();await racing;
        assert.equal(replies.pop().error.code,'stale');assert.equal(master.protocolAbiSource,undefined);
        coordinator.inspect=inspect;assert.equal((await coordinator.inspect()).source,null);
        master.liveReader={wref:worker};master.workerMap=[{wref:worker,worker_role:'continuous_reader'}];
        await master.handleProtocolAbiCoordinatorRequest(worker,message);
        const response=replies.pop();assert.equal(response.ok,true);assert.equal(typeof response.result.generation,'string');
        assert.equal((await coordinator.inspect()).capturedGenesis.frameSha256,config.frame_sha256);
    } finally {ship.close?.();rmSync(dir,{recursive:true,force:true});}
});
