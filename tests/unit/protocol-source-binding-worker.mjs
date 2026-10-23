import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observationMemoryClient} from './protocol-observation-memory.mjs';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

registerHooks({resolve(specifier,context,next){if(specifier.includes('node-abieos'))throw new Error('Wire imported the legacy addon');return next(specifier,context);}});
const previous=process.cwd(),directory=mkdtempSync(join(tmpdir(),'hyperion-source-binding-'));
const workers=[],events=[],send=process.send;
process.send=event=>{events.push(event);return true;};
const until=async predicate=>{const end=Date.now()+4000;while(!predicate()){assert(Date.now()<end,'Fixture wait expired');await new Promise(resolve=>setTimeout(resolve,5));}};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
try {
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/wire-host/receipts.json',import.meta.url)));
    const chain='source-binding-fixture',chainId='1'.repeat(64),schemaJson=JSON.stringify(fixture.handshake);
    const config={settings:{chain,parser:'3.2',protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:fixture.profileId},
        eosio_alias:'sysio',system_contract:'sysio',index_version:'v1',index_partition_size:10000,ds_profiling:false,es_replicas:0},
        indexer:{fetch_block:true,fetch_traces:true,fetch_deltas:true,process_deltas:true,disable_indexing:false},
        features:{index_all_deltas:true,index_deltas:true,index_deltas_deletions:true,streaming:{deltas:false,traces:false},tables:{},failed_trx:false},
        scaling:{ds_pool_size:1,routing_mode:'round_robin',indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},
        prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{root_only:false,actions:[],deltas:[]},api:{tx_cache_mode:'batch'}};
    mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    writeFileSync(join(directory,'config/connections.json'),JSON.stringify({amqp:{protocol:'http'},elasticsearch:{host:'127.0.0.1:1',user:'',pass:''},
        chains:{[chain]:{chain_id:chainId,http:'http://127.0.0.1:1',ship:'ws://127.0.0.1:1'}},redis:{host:'127.0.0.1',port:1}}));
    process.chdir(directory);process.env.CONFIG_JSON=join(directory,'chain.json');process.env.worker_role='reader';
    const {HyperionWorker}=await import('../../build/indexer/workers/hyperionWorker.js');
    HyperionWorker.prototype.connectAMQP=async function(){};HyperionWorker.prototype.onConnect=function(){};
    const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
    const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
    const {ProtocolSourceBindingStore,protocolSourceSelectionHeader:header}=await import('../../build/indexer/protocol/source-bindings.js');
    const {ProtocolAbiObservationStore}=await import('../../build/indexer/protocol/abi-observation-store.js');
    const wire=await import('@eosrio/hyperion-wire-plugin');
    const codec=wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(fixture.profileId));
    const template=codec.decode('result',Buffer.from(fixture.frameHex,'hex'));
    const statusFrame=(id=chainId)=>{
        const value={head:template[1].head,last_irreversible:template[1].last_irreversible,
            trace_begin_block:2,trace_end_block:10000,chain_state_begin_block:2,chain_state_end_block:10000};
        if(id!==null)value.chain_id=id;
        return Buffer.from(codec.encode('result',['get_status_result_v0',value]));
    };
    const sourceMemory=observationMemoryClient(),observationMemory=observationMemoryClient();
    const sources=new ProtocolSourceBindingStore(sourceMemory.client,chain),observations=new ProtocolAbiObservationStore(observationMemory.client,chain);
    const stages=new Map(),activeStages=new Set();let timer=0;
    const instrument=worker=>{worker.profiler.start=stage=>{const id=++timer;activeStages.add(id);stages.set(stage,(stages.get(stage)??0)+1);return()=>{assert(activeStages.delete(id),`Timer stopped twice: ${stage}`);};};};
    const publications=[],requests=[];
    const createReader=async()=>{
        const reader=new Reader();workers.push(reader);await reader.protocolReady;instrument(reader);
        reader.protocolSourceBindingStore=sources;reader.confirmRange=undefined;reader.receivedFirstBlock=true;
        reader.ship={connected:true,send:bytes=>requests.push(Buffer.from(bytes)),close(){}};
        const publisher={sendToQueue(queue,content,options,confirm){publications.push({content,properties:options});confirm(null);return true;}};
        reader.cch=publisher;reader.cch_ready=true;
        reader.stageOneDistQueue={push:async payload=>new Promise(resolve=>reader.recursiveDistribute([payload],publisher,resolve))};
        return reader;
    };
    const reader=await createReader();await reader.onMessage(Buffer.from(schemaJson));await reader.onMessage(statusFrame());
    const main=new MainDS();workers.push(main);await main.protocolReady;instrument(main);
    main.client=frontierMemoryClient().client;
    main.protocolSourceBindingStore=sources;main.protocolAbiObservationStore=observations;
    await main.initializeProtocolShip(schemaJson);await until(()=>main.mLoader.parser);
    let ack=0;const indexed=[];main.ch_ready=true;main.preIndexingQueue={push:async value=>indexed.push(value)};
    main.ch={ack(){ack++;},nack(){throw new Error('Unexpected NACK');},sendToQueue(){return true;}};
    const frame=(number,changes={})=>Buffer.from(codec.encode('result',[template[0],{...structuredClone(template[1]),
        this_block:{block_num:number,block_id:number.toString(16).padStart(64,'0')},
        prev_block:{block_num:number-1,block_id:(number-1).toString(16).padStart(64,'0')},...changes}]));
    const publish=async content=>{reader.local_block_num=Number(reader.decodeShipResult(content)[1].this_block.block_num)-1;
        const before=publications.length;await reader.onMessage(content);assert.equal(publications.length,before+1);return publications.at(-1);};
    const consume=delivery=>{(controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(delivery,main.ch);return main.mLoader.parser.parseMessage(main,[delivery]);};
    const selectedId=delivery=>delivery.properties.headers[header];
    const first=await publish(frame(100));
    const retained=await sources.readSelection(selectedId(first));
    assert.equal(retained.context.schemaJson,schemaJson);assert.equal(retained.selection.readerRole,'bulk');
    assert(Object.isFrozen(retained.context));

    // A different schema may arrive over IPC while durable PREPARE is awaited.
    // Only the independently owned delivery session may decode the remaining block.
    const changed=structuredClone(fixture.handshake);
    changed.structs.find(item=>item.name==='block_header').fields.find(item=>item.name==='timestamp').name='new_timestamp';
    const changedJson=JSON.stringify(changed);
    const preparedGate=gate(),resumePrepared=gate(),prepare=observations.prepare.bind(observations);
    observations.prepare=async record=>{preparedGate.release();await resumePrepared.promise;return prepare(record);};
    const inFlight=consume(first);await preparedGate.promise;
    main.onIpcMessage({event:'initialize_abi',data:changedJson});await until(()=>main.protocolShipAbiJson===changedJson);
    assert.equal(main.shipSession.decodeBlock(Buffer.from(template[1].block,'hex')).timestamp,undefined);
    resumePrepared.release();await inFlight;observations.prepare=prepare;
    assert.equal(ack,1);assert(indexed.some(value=>value.queue.includes('index_blocks')));
    const firstLink=await sources.readObservationLink(selectedId(first));
    assert.equal((await observations.read(firstLink.observationId)).capture.schemaJson,schemaJson);
    assert.equal(observationMemory.documents.get(firstLink.observationId).document.digest,firstLink.observationDigest);

    // Old Rabbit deliveries keep their exact reader context after reconnection.
    await reader.processFirstABI(Buffer.from(JSON.stringify(fixture.handshake,null,2)));
    await reader.onMessage(statusFrame());
    await consume(first);assert.equal(ack,2);
    const capsules=async()=>Promise.all([...sourceMemory.documents.entries()]
        .filter(([id,entry])=>id.startsWith('h45srcq1:')&&entry.document.kind==='manifest').map(([id])=>sources.readQuarantine(id)));
    const refuse=async delivery=>{
        const before=ack,completed=events.filter(event=>event.event==='consumed_block').length,indexedBefore=indexed.length;
        await consume(delivery);assert.equal(ack,before+1);
        assert.equal(indexed.length,indexedBefore);assert.equal(events.filter(event=>event.event==='consumed_block').length,completed);
        assert((await capsules()).some(capsule=>capsule.frameHex===delivery.content.toString('hex')));
    };
    await refuse({content:frame(101),properties:{}});
    await refuse({content:frame(101),properties:{headers:{[header]:Buffer.from('invalid')}}});
    await refuse({content:frame(101),properties:{headers:{[header]:'h45srcsel1:'+'0'.repeat(64)}}});
    await refuse({...first,content:Buffer.concat([first.content,Buffer.from([0])])});
    const binding=retained.selection;
    const withSelection=async change=>{const selected=await sources.prepareSelection({...binding,...change});return {content:first.content,properties:{headers:{[header]:selected.id}}};};
    await refuse(await withSelection({captureSha256:'0'.repeat(64)}));
    await refuse(await withSelection({source:{...binding.source,blockId:'f'.repeat(64)}}));
    for(const field of ['chain','profile','build']){
        const context=structuredClone(retained.context);
        if(field==='chain')context.chainId='2'.repeat(64);
        if(field==='profile')context.protocol.profileId='foreign-engineering-v1';
        if(field==='build')context.protocol.components[0].sha256='3'.repeat(64);
        const stored=await sources.prepareContext(context);
        await refuse(await withSelection({contextId:stored.id,source:{...binding.source,chainId:context.chainId}}));
    }
    // Pure inner codec errors retain the exact frame and cannot poison later work.
    for(const [offset,section] of ['block','traces','deltas'].entries()) {
        await refuse(await publish(frame(130+offset,{[section]:'ff'})));
        const lastError=events.filter(event=>event.event==='ds_error').at(-1);
        assert.equal(lastError.data.code,'protocol_source_codec_incomplete');
        const beforeValid=ack;await consume(await publish(frame(140+offset)));assert.equal(ack,beforeValid+1);
    }
    let backendAck=ack;
    const backendFailure=await publish(frame(145));
    observationMemory.faults.beforeWrite=()=>{throw new Error('Injected backend unavailable');};
    await assert.rejects(consume(backendFailure),/Injected backend unavailable/);assert.equal(ack,backendAck);
    delete observationMemory.faults.beforeWrite;
    await consume(backendFailure);assert.equal(ack,backendAck+1);
    const admittedProvider=main.protocol;assert(Object.isFrozen(admittedProvider));
    // The mutable fault belongs to this worker fixture, never the selected provider object.
    main.protocol={...admittedProvider,observeBlockAbi(){throw new Error('x'.repeat(4095)+'😀');}};
    let unicodeDelivery,unicodeAck;
    try{unicodeDelivery=await publish(frame(146));unicodeAck=ack;await consume(unicodeDelivery);}
    finally{main.protocol=admittedProvider;}
    assert.equal(ack,unicodeAck+1);
    const unicodeLink=await sources.readObservationLink(selectedId(unicodeDelivery)),unicodeRecord=await observations.read(unicodeLink.observationId);
    assert.equal(unicodeRecord.observation.status,'incomplete');assert.equal(unicodeRecord.capture.tracesHex,template[1].traces);
    assert(unicodeRecord.observation.error.message.length<=4096);assert(unicodeRecord.observation.error.message.isWellFormed());
    // A corrupt/incomplete retained context never borrows initialize_abi.
    const manifest=sourceMemory.documents.get(binding.contextId),chunkId=manifest.document.chunk_ids[0],chunk=sourceMemory.documents.get(chunkId);
    sourceMemory.documents.delete(chunkId);await refuse(first);sourceMemory.documents.set(chunkId,chunk);
    // Infrastructure and unsafe storage failures remain redeliverable, without an ACK/capsule fallback.
    let before=ack;sourceMemory.faults.read=()=>{throw new Error('Source store transport failure');};
    await assert.rejects(consume(first),/transport failure/);assert.equal(ack,before);delete sourceMemory.faults.read;
    sourceMemory.faults.beforeWrite=()=>{throw new Error('Quarantine unavailable');};
    await assert.rejects(consume({content:frame(102),properties:{}}),/Quarantine unavailable/);assert.equal(ack,before);delete sourceMemory.faults.beforeWrite;
    // The selection-to-observation link is part of the source ACK durability boundary.
    const linked=await publish(frame(103));
    sourceMemory.faults.beforeWrite=request=>{if(request.id.startsWith('h45srcobs1:'))throw new Error('Observation link unavailable');};
    await assert.rejects(consume(linked),/link unavailable/);assert.equal(ack,before);delete sourceMemory.faults.beforeWrite;
    await consume(linked);assert.equal(ack,before+1);assert.equal((await sources.readObservationLink(selectedId(linked))).selectionId,selectedId(linked));

    // A successful old-channel delivery cannot settle a tag on a replacement channel.
    const ownerChannel=main.ch;let foreignSettlements=0;
    const replacementChannel={...ownerChannel,ack(){foreignSettlements++;},nack(){foreignSettlements++;}};
    const ackGate=gate(),resumeAck=gate();
    observations.prepare=async record=>{ackGate.release();await resumeAck.promise;return prepare(record);};
    const oldTag=await publish(frame(108)),oldProcessing=consume(oldTag);await ackGate.promise;
    before=ack;main.ch=replacementChannel;resumeAck.release();await oldProcessing;
    assert.equal(ack,before);assert.equal(foreignSettlements,0);
    observations.prepare=prepare;main.ch=ownerChannel;await consume(oldTag);assert.equal(ack,before+1);
    const quarantineGate=gate(),resumeQuarantine=gate(),quarantine=sources.quarantine.bind(sources);
    sources.quarantine=async record=>{quarantineGate.release();await resumeQuarantine.promise;return quarantine(record);};
    const oldInvalid=consume({content:frame(109),properties:{}});await quarantineGate.promise;
    before=ack;main.ch=replacementChannel;resumeQuarantine.release();await oldInvalid;
    assert.equal(ack,before);assert.equal(foreignSettlements,0);sources.quarantine=quarantine;main.ch=ownerChannel;
    // Downstream failures propagate to supervised cargo without NACKing a replacement channel.
    const processBlock=main.processBlock;
    main.processBlock=async()=>{main.ch=replacementChannel;throw new Error('History processing failure');};
    await assert.rejects(consume(oldTag),/History processing failure/);assert.equal(foreignSettlements,0);
    main.processBlock=processBlock;main.ch=ownerChannel;

    // Receipt ownership is captured by the production consume callback before cargo waits.
    const queued=new MainDS();workers.push(queued);await queued.protocolReady;await until(()=>queued.mLoader.parser);
    queued.client=frontierMemoryClient().client;
    queued.protocolSourceBindingStore=sources;queued.protocolAbiObservationStore=observations;queued.preIndexingQueue={push:async()=>{}};
    queued.ch_ready=true;const receipts=[],oldAcks=[],newAcks=[];
    const channel=settled=>({prefetch(){},consume(queue,callback){receipts.push(callback);},on(){},
        ack(message){settled.push(message.fields.deliveryTag);},nack(){throw new Error('Unexpected queued NACK');},sendToQueue(){return true;}});
    const oldConsumer=channel(oldAcks),newConsumer=channel(newAcks);
    queued.ch=oldConsumer;process.env.worker_queue='source-binding-fixture:blocks';queued.initConsumer();delete process.env.worker_queue;
    const queuedFirst={...await publish(frame(111)),fields:{deliveryTag:1}},queuedSecond={...await publish(frame(112)),fields:{deliveryTag:2}};
    const cargoEntered=gate(),resumeCargo=gate();
    observations.prepare=async record=>{if(record.source.blockNum===111){cargoEntered.release();await resumeCargo.promise;}return prepare(record);};
    receipts[0](queuedFirst);receipts[0](queuedSecond);await cargoEntered.promise;queued.ch=newConsumer;resumeCargo.release();
    await until(()=>queued.consumerQueue.idle());observations.prepare=prepare;
    assert.deepEqual(oldAcks,[]);assert.deepEqual(newAcks,[],'Queued old tag was rebound when processing began on a replacement channel');
    process.env.worker_queue='source-binding-fixture:blocks';queued.initConsumer();delete process.env.worker_queue;
    receipts[1]({...queuedFirst,fields:{deliveryTag:101}});receipts[1]({...queuedSecond,fields:{deliveryTag:102}});
    await until(()=>queued.consumerQueue.idle());assert.deepEqual(newAcks,[101,102]);assert.deepEqual(oldAcks,[]);

    // Exercise actual startWS callbacks and constructor-created ingress cargo.
    const ingress=await createReader(),sockets=[],commands=[];
    ingress.ship={connected:true,close(){},nextUrl(){},connect(message,disconnect,error,open){sockets.push({message,disconnect,error,open});},
        send(bytes){commands.push({socket:sockets.length,request:codec.decode('request',bytes)});}};
    const drain=()=>until(()=>ingress.blockReadingQueue.idle());
    const open=()=>{ingress.startWS();sockets.at(-1).open();return sockets.at(-1);};
    const old=open();await drain();
    const entered=gate(),release=gate(),prepareContext=sources.prepareContext.bind(sources);
    sources.prepareContext=async value=>{entered.release();await release.promise;return prepareContext(value);};
    old.message(Buffer.from(schemaJson));await entered.promise;
    const setTimeout=globalThis.setTimeout;let reconnect;
    globalThis.setTimeout=(callback,delay,...args)=>{
        if(delay===5000){reconnect=()=>callback(...args);return {unref(){return this;}};}
        return setTimeout(callback,delay,...args);
    };
    ingress.local_block_num=100;ingress.local_last_block=200;
    try{old.disconnect();}finally{globalThis.setTimeout=setTimeout;}
    assert.equal(ingress.recovery,true);assert.equal(typeof reconnect,'function');reconnect();
    const next=sockets.at(-1);next.open();old.message(frame(104));release.release();await drain();sources.prepareContext=prepareContext;
    assert.equal(commands.length,0,'Old pending handshake sent commands to the replacement socket');
    next.message(Buffer.from(schemaJson));await drain();assert(commands.every(command=>command.socket===2));
    assert.deepEqual(commands.map(command=>command.request[0]),['get_status_request_v0'],'Handshake granted block-flow credit');
    const beforeUnverified=publications.length;
    next.message(statusFrame('2'.repeat(64)));next.message(frame(120));next.message(statusFrame(null));await drain();
    assert.equal(publications.length,beforeUnverified);
    assert.deepEqual(commands.map(command=>command.request[0]),['get_status_request_v0'],'Unverified source received block request or credit');
    next.message(statusFrame());await drain();
    assert.deepEqual(commands.map(command=>command.request[0]),['get_status_request_v0','get_blocks_request_v0'],'Status response granted block-flow credit');
    old.open();assert.equal(ingress.physicalIngressGeneration,2,'Late open restored an obsolete socket');
    const beforeQueued=commands.length,publishedBefore=publications.length;
    ingress.blockReadingQueue.pause();next.message(frame(105));const third=open();ingress.blockReadingQueue.resume();await drain();
    assert.equal(commands.length,beforeQueued);assert.equal(publications.length,publishedBefore);
    third.message(Buffer.from(schemaJson));await drain();third.message(statusFrame());await drain();
    const selectionEntered=gate(),selectionRelease=gate(),prepareSelection=sources.prepareSelection.bind(sources);
    sources.prepareSelection=async value=>{selectionEntered.release();await selectionRelease.promise;return prepareSelection(value);};
    ingress.local_block_num=105;third.message(frame(106));await selectionEntered.promise;
    const beforePending=commands.length,fourth=open();selectionRelease.release();await drain();sources.prepareSelection=prepareSelection;
    assert.equal(publications.length,publishedBefore);assert.equal(commands.length,beforePending,'Old pending frame credited the new socket');
    fourth.message(Buffer.from(schemaJson));await drain();fourth.message(statusFrame());await drain();ingress.local_block_num=106;
    let confirmPublication;
    ingress.cch.sendToQueue=(queue,content,options,confirm)=>{publications.push({content,properties:options});confirmPublication=confirm;return true;};
    const beforeConfirm=commands.length;
    fourth.message(frame(107));await until(()=>!!confirmPublication);await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(commands.length,beforeConfirm,'Source received block credit before Rabbit confirmation');
    confirmPublication(null);await drain();assert.equal(publications.length,publishedBefore+1);
    assert.deepEqual(commands.at(-1),{socket:4,request:['get_blocks_ack_request_v0',{num_messages:1}]});
    await consume(publications.at(-1));
    const unavailable=Buffer.from(codec.encode('result',[template[0],{...structuredClone(template[1]),this_block:null,prev_block:null,block:null,traces:null,deltas:null}]));
    const beforeUnavailable=publications.length;fourth.message(unavailable);await drain();
    assert.equal(publications.length,beforeUnavailable);
    assert.deepEqual(commands.at(-1),{socket:4,request:['get_blocks_ack_request_v0',{num_messages:1}]},'Unavailable block response did not return its one source credit');
    const unrouted=frame(110);fourth.message(unrouted);await drain();assert.equal(publications.length,beforeUnavailable);
    const retainedCapsules=await capsules();
    for(const bytes of [unavailable,unrouted])assert(retainedCapsules.some(capsule=>capsule.frameHex===bytes.toString('hex')&&capsule.reason.code==='protocol_reader_unrouted_block'));
    for(const bytes of [statusFrame('2'.repeat(64)),statusFrame(null),frame(120)])assert(retainedCapsules.some(capsule=>capsule.frameHex===bytes.toString('hex')&&capsule.reason.code==='protocol_reader_chain_unverified'));
    const stale=await capsules();
    for(const bytes of [Buffer.from(schemaJson),frame(104),frame(105),frame(106)])assert(stale.some(capsule=>capsule.frameHex===bytes.toString('hex')&&capsule.reason.code==='protocol_reader_stale_ingress'));
    for(const stage of ['protocol_source_prepare_context','protocol_source_prepare_selection','protocol_source_resolve','protocol_source_verify'])assert(stages.get(stage)>0);
    assert.equal(activeStages.size,0,'A source profiling timer escaped an error/finally path');
    console.log(JSON.stringify({passed:true,readerToRabbit:true,perDeliverySession:true,durableQuarantine:true,linkBeforeAck:true,
        reconnectIngress:true,legacyAddonImported:false,canonicalActivation:false}));
} finally {
    for(const worker of workers){worker.shipSession?.close?.();worker.profiler?.stopReporting();}
    process.send=send;process.chdir(previous);rmSync(directory,{recursive:true,force:true});
}
