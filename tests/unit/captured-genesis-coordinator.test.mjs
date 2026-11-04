import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepared,frames,schemaJson,capture,hash} from './portable-state-source-fixture.mjs';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.ts';
import {protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.ts';

test('owner-bound captured genesis commits before an exact, fenced live handoff', async()=>{
    const p=await prepared({},0);
    const coordinator=new ProtocolAbiCoordinator({chainId:capture.chainId,profile:p.options.profile,ownerId:'bootstrap-owner',
        store:p.store,bindings:p.bindings,observations:p.observations,
        verifyNativeGenesis:p.options.provider.verifyNativeGenesis.bind(p.options.provider),capturedGenesisEnabled:true});
    await coordinator.start();
    const ship=p.options.provider.createShipSession(JSON.parse(schemaJson));
    try {
        const one=ship.decodeResult(frames[0])[1], two=ship.decodeResult(frames[1])[1];
        const source={chainId:capture.chainId,blockNum:1,blockId:one.this_block.block_id,previousBlockId:null};
        const grant={contextId:p.contextId,readerSessionId:'capture-session',schemaSha256:hash(schemaJson),frameSha256:hash(frames[0]),
            genesisBlockId:source.blockId,blockTwoId:two.this_block.block_id,blockTwoPreviousId:two.prev_block.block_id};
        const disabled=new ProtocolAbiCoordinator({chainId:capture.chainId,profile:p.options.profile,ownerId:'unused',
            store:p.store,bindings:p.bindings,observations:p.observations});
        await assert.rejects(disabled.beginCapturedGenesis(grant),/disabled/);
        const {generation}=await coordinator.beginCapturedGenesis(grant);
        await assert.rejects(coordinator.finishCapturedGenesis('capture-session',generation),/not durably committed/);
        await assert.rejects(coordinator.openSource(p.contextId,'live-session'),/handoff is not complete/);
        const sections={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:one.block,tracesHex:one.traces,deltasHex:one.deltas};
        const captureSha256=protocolAbiCaptureDigest(source,sections);
        const selected=await p.bindings.prepareSelection({schemaVersion:1,contextId:p.contextId,readerSessionId:'capture-session',
            readerRole:'captured-genesis',assignmentId:null,source,frameSha256:grant.frameSha256,captureSha256,
            head:{blockNum:one.head.block_num,blockId:one.head.block_id},irreversible:{blockNum:one.last_irreversible.block_num,blockId:one.last_irreversible.block_id}});
        assert.equal((await coordinator.admit(selected.id,'old-generation')).status,'stale');
        assert.equal((await coordinator.admit(selected.id,generation)).status,'accepted');
        const observation={status:'native-genesis',facts:p.options.provider.verifyNativeGenesis({schemaJson,block:Buffer.from(one.block,'hex'),
            traces:null,deltas:Buffer.from(one.deltas,'hex')},source)};
        const receipt=await p.observations.prepare({schemaVersion:1,protocol:p.options.profile,source:{...source,inputSha256:captureSha256},capture:sections,observation});
        await p.bindings.prepareObservationLink({schemaVersion:1,selectionId:selected.id,observationId:receipt.id,observationDigest:receipt.digest});
        await coordinator.drain();
        assert.equal((await coordinator.inspect()).head.coverageStart,1);
        const finish=coordinator.finishCapturedGenesis('capture-session',generation);
        await assert.rejects(coordinator.openSource(p.contextId,'racing-live'),/handoff is not complete/);
        await finish;
        assert.equal((await coordinator.inspect()).head.blockNum,1,'racing open must not replace the durable genesis head');
        await assert.rejects(coordinator.beginCapturedGenesis(grant));
        const live=await coordinator.openSource(p.contextId,'live-session');
        assert.equal(live.resumeFromBlock,2);
        assert.equal((await coordinator.admit(selected.id,generation)).status,'stale');
        const twoSource={chainId:capture.chainId,blockNum:2,blockId:grant.blockTwoId,previousBlockId:grant.genesisBlockId};
        const twoSections={kind:'unattested-ship-result-sections-v1',schemaJson,blockHex:two.block,tracesHex:two.traces,deltasHex:two.deltas};
        const twoDigest=protocolAbiCaptureDigest(twoSource,twoSections);
        const selectionTwo=async(blockId,previousBlockId)=>p.bindings.prepareSelection({schemaVersion:1,contextId:p.contextId,
            readerSessionId:'live-session',readerRole:'live',assignmentId:null,
            source:{chainId:capture.chainId,blockNum:2,blockId,previousBlockId},frameSha256:hash(frames[1]),captureSha256:twoDigest,
            head:{blockNum:two.head.block_num,blockId:two.head.block_id},irreversible:{blockNum:two.last_irreversible.block_num,blockId:two.last_irreversible.block_id}});
        assert.equal((await coordinator.admit((await selectionTwo('f'.repeat(64),grant.genesisBlockId)).id,live.generation)).status,'stale');
        assert.equal((await coordinator.admit((await selectionTwo(grant.blockTwoId,'f'.repeat(64))).id,live.generation)).status,'stale');
        const second=await selectionTwo(grant.blockTwoId,grant.genesisBlockId);
        assert.equal((await coordinator.admit(second.id,live.generation)).status,'accepted');
        assert.equal((await coordinator.inspect()).capturedGenesis.phase,'handoff', 'admission is not a durable block-two commit');
        let ordinal=0;const rows=[];
        for(const [,delta] of ship.decodeDeltas(Buffer.from(two.deltas,'hex')))for(const row of delta.rows){
            if(delta.name==='account'){const raw=Buffer.from(row.data,'hex');rows.push({ordinal,present:row.present===1,raw,value:ship.decodeRow('account',raw)});}ordinal++;
        }
        const facts=p.options.provider.observeBlockAbi({traces:ship.decodeTraces(Buffer.from(two.traces,'hex')),accountRows:rows},twoSource);
        const secondObservation=await p.observations.prepare({schemaVersion:1,protocol:p.options.profile,source:{...twoSource,inputSha256:twoDigest},
            capture:twoSections,observation:{status:'observed',facts}});
        await p.bindings.prepareObservationLink({schemaVersion:1,selectionId:second.id,observationId:secondObservation.id,observationDigest:secondObservation.digest});
        await coordinator.drain();const completed=await coordinator.inspect();
        assert.equal(completed.head.blockNum,2);assert.equal(completed.head.coverageStart,1);assert.equal(completed.capturedGenesis.phase,'complete');
    } finally {ship.close?.();}
});

test('interrupted captured source requires an identical owner grant and a fresh session',async()=>{
    const p=await prepared({},0), opts={chainId:capture.chainId,profile:p.options.profile,ownerId:'owner-before',
        store:p.store,bindings:p.bindings,observations:p.observations,
        verifyNativeGenesis:p.options.provider.verifyNativeGenesis.bind(p.options.provider),capturedGenesisEnabled:true};
    const old=new ProtocolAbiCoordinator(opts);await old.start();
    const ship=p.options.provider.createShipSession(JSON.parse(schemaJson));
    try {
        const one=ship.decodeResult(frames[0])[1],two=ship.decodeResult(frames[1])[1];
        const grant={contextId:p.contextId,readerSessionId:'capture-before',schemaSha256:hash(schemaJson),frameSha256:hash(frames[0]),
            genesisBlockId:one.this_block.block_id,blockTwoId:two.this_block.block_id,blockTwoPreviousId:two.prev_block.block_id};
        await old.beginCapturedGenesis(grant);
        const current=new ProtocolAbiCoordinator({...opts,ownerId:'owner-after'});await current.start();
        await assert.rejects(current.openSource(p.contextId,'live'),/handoff is not complete/);
        await assert.rejects(current.resumeCapturedGenesis({...grant,readerSessionId:'capture-after',frameSha256:'f'.repeat(64)}),/differs/);
        await assert.rejects(current.resumeCapturedGenesis(grant),/differs/);
        assert.ok((await current.resumeCapturedGenesis({...grant,readerSessionId:'capture-after'})).generation);
        await assert.rejects(old.inspect());
    } finally {ship.close?.();}
});
