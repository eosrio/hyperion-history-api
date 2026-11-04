import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepared,frames,schemaJson,capture,hash} from './portable-state-source-fixture.mjs';
import {randomUUID} from 'node:crypto';
const {ProtocolAbiCoordinator}=await import('../../build/indexer/protocol/abi-coordinator.js');
const {protocolAbiCaptureDigest}=await import('../../build/indexer/protocol/abi-observation-store.js');
const {HyperionMaster}=await import('../../build/indexer/modules/master.js');

for(const recovered of [false,true])test(`reader ${recovered?'recovers committed':'publishes fresh'} captured genesis before live block two`,async()=>{
    const p=await prepared({},0),dir=mkdtempSync(join(tmpdir(),'captured-reader-'));
    const cwd=process.cwd(),previous=process.env.CONFIG_JSON;
    const coordinator=new ProtocolAbiCoordinator({chainId:capture.chainId,profile:p.options.profile,ownerId:'reader-control',
        store:p.store,bindings:p.bindings,observations:p.observations,
        verifyNativeGenesis:p.options.provider.verifyNativeGenesis.bind(p.options.provider),capturedGenesisEnabled:true});
    await coordinator.start();
    const ship=p.options.provider.createShipSession(JSON.parse(schemaJson));
    try {
        mkdirSync(join(dir,'config'));writeFileSync(join(dir,'chain.json'),JSON.stringify({settings:{chain:'reader'},indexer:{}}));
        writeFileSync(join(dir,'config','connections.json'),'{}');
        const config={schema_path:join(dir,'schema'),schema_sha256:hash(schemaJson),frame_path:join(dir,'one'),frame_sha256:hash(frames[0]),
            block_two_path:join(dir,'two'),block_two_sha256:hash(frames[1])};
        writeFileSync(config.schema_path,schemaJson);writeFileSync(config.frame_path,frames[0]);writeFileSync(config.block_two_path,frames[1]);
        const one=ship.decodeResult(frames[0])[1],two=ship.decodeResult(frames[1])[1];
        process.chdir(dir);process.env.CONFIG_JSON=join(dir,'chain.json');
        const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
        let confirmed=false,finishCalled=false,brokerConfirmation,originalSelection;
        if(recovered){
            const grant={contextId:p.contextId,readerSessionId:'prior-capture',schemaSha256:config.schema_sha256,frameSha256:config.frame_sha256,
                genesisBlockId:one.this_block.block_id,blockTwoId:two.this_block.block_id,blockTwoPreviousId:two.prev_block.block_id};
            const old=(await coordinator.beginCapturedGenesis(grant)).generation;
            const source={chainId:capture.chainId,blockNum:1,blockId:one.this_block.block_id,previousBlockId:null};
            const sections={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:one.block,tracesHex:one.traces,deltasHex:one.deltas};
            const digest=protocolAbiCaptureDigest(source,sections);
            originalSelection=(await p.bindings.prepareSelection({schemaVersion:1,contextId:p.contextId,readerSessionId:'prior-capture',
                readerRole:'captured-genesis',assignmentId:null,source,frameSha256:hash(frames[0]),captureSha256:digest,
                head:{blockNum:one.head.block_num,blockId:one.head.block_id},irreversible:{blockNum:one.last_irreversible.block_num,blockId:one.last_irreversible.block_id}})).id;
            assert.equal((await coordinator.admit(originalSelection,old)).status,'accepted');
            const facts=p.options.provider.verifyNativeGenesis({schemaJson,block:Buffer.from(one.block,'hex'),traces:null,deltas:Buffer.from(one.deltas,'hex')},source);
            const observation=await p.observations.prepare({schemaVersion:1,protocol:p.options.profile,source:{...source,inputSha256:digest},
                capture:sections,observation:{status:'native-genesis',facts}});
            await p.bindings.prepareObservationLink({schemaVersion:1,selectionId:originalSelection,observationId:observation.id,observationDigest:observation.digest});
            await coordinator.drain();await coordinator.revokeSource('prior-capture',old);
        }
        const worker={},replies=[];
        const master=Object.assign(Object.create(HyperionMaster.prototype),{
            conf:{settings:{protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:capture.profileId},
                protocol_abi_coordination:{retained_genesis:config}}},chain:'wire',manager:{conn:{chains:{wire:{chain_id:capture.chainId}}}},
            protocolAbiCoordinator:coordinator,liveReader:{wref:worker},workerMap:[{wref:worker,worker_role:'continuous_reader'}],
            rpc:{v1:{chain:{get_info:async()=>({chain_id:capture.chainId,last_irreversible_block_num:2})}},
                call:async({path,params})=>{
                    assert.equal(path,'/v1/chain/get_block');
                    assert.ok(params.block_num_or_id===1||params.block_num_or_id===2);
                    return params.block_num_or_id===1
                        ?{block_num:1,id:one.this_block.block_id,previous:'0'.repeat(64)}
                        :{block_num:2,id:two.this_block.block_id,previous:two.prev_block.block_id};
                }},
            replyProtocolAbiCoordinator:(_worker,_id,data)=>replies.push(data),requestProtocolAbiDrain:()=>{},failProtocolAbiCoordinator:error=>{throw error;}
        });
        const request=async data=>{await master.handleProtocolAbiCoordinatorRequest(worker,{event:'protocol_abi_coordinator_request',mId:randomUUID(),data});
            const reply=replies.shift();if(!reply.ok)throw new Error(reply.error.message);return reply.result;};
        const reader=Object.assign(Object.create(Reader.prototype),{chainId:capture.chainId,protocolId:p.options.profile.id,
            protocol:p.options.provider,protocolComponents:p.options.profile.components,
            chain:'wire',isLiveReader:true,cch_ready:true,publications:new Map(),scheduleConfirmationDeadline:()=>{},
            cch:{sendToQueue:(_queue,_content,_options,callback)=>{brokerConfirmation=callback;return true;}},
            conf:{settings:{protocol_abi_coordination:{retained_genesis:config}}},
            sourceContext:{id:p.contextId,schemaJson,readerSessionId:'physical-session',generation:1},
            verifiedReaderSessionId:'physical-session',protocolSourceBindingStore:p.bindings,profiler:{start:()=>()=>{}},
            coordinatorRpc:{
                captureBegin:(contextId,readerSessionId)=>request({operation:'capture_begin',contextId,readerSessionId}),
                admit:(selectionId,readerSessionId,generation)=>request({operation:'admit',selectionId,readerSessionId,generation}),
                captureFinish:(readerSessionId,generation)=>{finishCalled=true;assert.equal(confirmed,true);return request({operation:'capture_finish',readerSessionId,generation});},
                open:(contextId,readerSessionId)=>request({operation:'open',contextId,readerSessionId})
            },
            stageOneDistQueue:{push:async item=>{
                reader.recursiveDistribute([item],reader.cch,()=>{});
                assert.equal(typeof brokerConfirmation,'function');assert.equal(finishCalled,false);
                const selectionId=Object.values(item.headers)[0],binding=await p.bindings.readSelection(selectionId),source=binding.selection.source;
                if(recovered)assert.equal(selectionId,originalSelection,'restart must republish the originally committed selection');
                const sections={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:one.block,tracesHex:one.traces,deltasHex:one.deltas};
                const digest=protocolAbiCaptureDigest(source,sections);
                const facts=p.options.provider.verifyNativeGenesis({schemaJson,block:Buffer.from(one.block,'hex'),traces:null,deltas:Buffer.from(one.deltas,'hex')},source);
                const observation=await p.observations.prepare({schemaVersion:1,protocol:p.options.profile,source:{...source,inputSha256:digest},
                    capture:sections,observation:{status:'native-genesis',facts}});
                await p.bindings.prepareObservationLink({schemaVersion:1,selectionId,observationId:observation.id,observationDigest:observation.digest});
                await coordinator.drain();confirmed=true;brokerConfirmation(null);
            }}
        });
        await reader.publishRetainedGenesis();assert.equal(finishCalled,true);
        assert.equal((await coordinator.inspect()).head.coverageStart,1);
        await reader.openCoordinatorSource();assert.equal(reader.coordinatorResumeFromBlock,2);
        const liveHeaders=await reader.bindProtocolSource(two,frames[1]);
        const liveSelection=(await p.bindings.readSelection(Object.values(liveHeaders)[0])).selection;
        assert.equal(liveSelection.readerRole,'live');assert.equal(liveSelection.source.blockNum,2);
        assert.equal(liveSelection.source.previousBlockId,one.this_block.block_id);
        assert.equal((await coordinator.inspect()).pending.length,1);
    } finally {ship.close?.();process.chdir(cwd);if(previous===undefined)delete process.env.CONFIG_JSON;else process.env.CONFIG_JSON=previous;
        rmSync(dir,{recursive:true,force:true});}
});

test('captured publication refuses a failed or replaced broker confirmation',async()=>{
    const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
    for(const kind of ['failed','replaced']) {
        let callback,confirmed=false,rejected=false,failure=false;
        const publisher={sendToQueue:(_queue,_body,_options,cb)=>{callback=cb;return true;}};
        const reader=Object.assign(Object.create(Reader.prototype),{chain:'wire',isLiveReader:true,cch_ready:true,cch:publisher,
            publications:new Map(),scheduleConfirmationDeadline:()=>{},failPublisherRecovery:()=>{failure=true;}});
        reader.recursiveDistribute([{num:1,content:Buffer.from([1]),confirmCaptured:()=>{confirmed=true;},
            failCaptured:()=>{rejected=true;}}],publisher,()=>{});
        if(kind==='replaced')reader.cch={};
        callback(kind==='failed'?new Error('negative acknowledgement'):null);
        assert.equal(confirmed,false);assert.equal(rejected,true);assert.equal(failure,true);
    }
});
