import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

registerHooks({resolve(specifier,context,next){if(specifier.includes('node-abieos'))throw new Error('Wire imported the legacy addon');return next(specifier,context);}});
const previous=process.cwd(),directory=mkdtempSync(join(tmpdir(),'hyperion-abi-frontier-'));
const workers=[],masters=[],events=[],originalSend=process.send,originalExit=process.exit;
const until=async predicate=>{const end=Date.now()+6000;while(!(await predicate())){assert(Date.now()<end,'Fixture wait expired');await new Promise(resolve=>setTimeout(resolve,5));}};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
let currentMaster,activeReaderSender,activeDsSender,dropHints=false,dropCheckpoints=false;
const sourceSenders=new Map();
process.send=(message,callback)=>{
    events.push(message);
    const sender=message.event==='protocol_abi_source_revoked'?sourceSenders.get(message.data.readerSessionId)
        :message.event==='protocol_abi_prepared'?activeDsSender:activeReaderSender;
    if(sender&&currentMaster&&message.event.startsWith('protocol_abi_')&&!(dropHints&&message.event==='protocol_abi_prepared'))currentMaster.handleMessage(sender,message);
    if(sender&&currentMaster&&message.event==='live_checkpoint'&&!dropCheckpoints)currentMaster.handleMessage(sender,message);
    callback?.(null);return true;
};
try {
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/wire-host/receipts.json',import.meta.url)));
    const profileId=process.env.HYPERION_WIRE_PROFILE??fixture.profileId;
    const chain='abi-frontier-fixture',chainId='1'.repeat(64),schemaJson=JSON.stringify(fixture.handshake);
    const config={settings:{chain,parser:'3.2',protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId},
        protocol_abi_coordination:{max_pending_blocks:2,recovery_window_blocks:8},eosio_alias:'sysio',system_contract:'sysio',
        index_version:'v1',index_partition_size:10000,ds_profiling:false,es_replicas:0},
        indexer:{live_reader:true,fetch_block:true,fetch_traces:true,fetch_deltas:true,process_deltas:true,disable_indexing:false},
        features:{index_all_deltas:true,index_deltas:true,index_deltas_deletions:true,streaming:{deltas:false,traces:false},tables:{},failed_trx:false},
        scaling:{ds_queues:1,ds_pool_size:1,routing_mode:'round_robin',indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},
        prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{root_only:false,actions:[],deltas:[]},api:{tx_cache_mode:'batch'}};
    mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    const connections={amqp:{protocol:'http'},elasticsearch:{host:'127.0.0.1:1',user:'',pass:''},
        chains:{[chain]:{chain_id:chainId,http:'http://127.0.0.1:1',ship:'ws://127.0.0.1:1'}},redis:{host:'127.0.0.1',port:1}};
    writeFileSync(join(directory,'config/connections.json'),JSON.stringify(connections));
    process.chdir(directory);process.env.CONFIG_JSON=join(directory,'chain.json');
    const {HyperionWorker}=await import('../../build/indexer/workers/hyperionWorker.js');
    HyperionWorker.prototype.connectAMQP=async function(){};HyperionWorker.prototype.onConnect=function(){};
    const {HyperionMaster}=await import('../../build/indexer/modules/master.js');
    const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
    const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
    const {ProtocolAbiCoordinatorRpc}=await import('../../build/indexer/protocol/abi-coordinator-rpc.js');
    const {ProtocolSourceBindingStore,protocolSourceSelectionHeader:header}=await import('../../build/indexer/protocol/source-bindings.js');
    const {ProtocolAbiObservationStore}=await import('../../build/indexer/protocol/abi-observation-store.js');
    const {ProtocolAbiFrontierStore}=await import('../../build/indexer/protocol/abi-frontier-store.js');
    const wire=await import('@eosrio/hyperion-wire-plugin');
    const codec=wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(profileId));
    // The retained engineering template is decoded under its original pin; all
    // test frames are then encoded under the selected profile, never relabeled captures.
    const originalCodec=wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(fixture.profileId));
    const template=originalCodec.decode('result',Buffer.from(fixture.frameHex,'hex'));
    const memory=frontierMemoryClient(),sources=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain);
    const frontier=new ProtocolAbiFrontierStore(memory.client,chain);
    const blockId=number=>number.toString(16).padStart(64,'0');
    const frame=(number,changes={})=>{
        const traces=originalCodec.decode('transaction_trace[]',Buffer.from(template[1].traces,'hex'));
        for(const [index,trace] of traces[0][1].action_traces.entries())trace[1].receipt[1].global_sequence=String(number*2+index+1);
        return Buffer.from(codec.encode('result',[template[0],{...structuredClone(template[1]),last_irreversible:{block_num:102,block_id:blockId(102)},this_block:{block_num:number,block_id:blockId(number)},
            prev_block:{block_num:number-1,block_id:blockId(number-1)},traces:Buffer.from(codec.encode('transaction_trace[]',traces)).toString('hex'),...changes}]));
    };
    const status=(irreversible=102)=>Buffer.from(codec.encode('result',['get_status_result_v0',{head:template[1].head,last_irreversible:{block_num:irreversible,block_id:blockId(irreversible)},
        trace_begin_block:2,trace_end_block:10000,chain_state_begin_block:2,chain_state_end_block:10000,chain_id:chainId}]));
    const master=async(conf=config)=>{
        const result=Object.assign(Object.create(HyperionMaster.prototype),{conf,chain:conf.settings.chain,manager:{conn:connections},esClient:memory.client,
            workerMap:[],indexerMonitor:{},shutdownStarted:false,protocolAbiDrainInFlight:false,protocolAbiFailed:false});
        result.initHandlerMap();await result.initializeProtocolAbiCoordinator();masters.push(result);return result;
    };
    currentMaster=await master();
    const firstOwner=(await frontier.readControl()).value.ownerId;
    const noAuthority=await master({...config,indexer:{...config.indexer,live_reader:false}});
    assert.equal(noAuthority.protocolAbiCoordinator,undefined);assert.equal((await frontier.readControl()).value.ownerId,firstOwner);
    const publications=[];let workerId=0,deliveryTag=0;
    const reader=async(start,role='continuous_reader',boundSources=sources)=>{
        process.env.worker_role=role;process.env.worker_last_processed_block=String(start);process.env.worker_last_processed_block_id=blockId(start-1);
        const result=new Reader();workers.push(result);await result.protocolReady;
        result.protocolSourceBindingStore=boundSources;result.receivedFirstBlock=true;
        const replies=[],commands=[],sockets=[];
        const wref=Object.assign(new EventEmitter(),{id:++workerId,isConnected:()=>true,send(message,callback){replies.push(message);result.onIpcMessage(message);callback?.(null);}});
        const definition={worker_id:wref.id,worker_role:role,wref,worker_last_processed_block:start};
        currentMaster.workerMap.push(definition);if(role==='continuous_reader')currentMaster.liveReader=definition;
        result.coordinatorRpc=new ProtocolAbiCoordinatorRpc((message,callback)=>{sourceSenders.set(message.data.readerSessionId,wref);currentMaster.handleMessage(wref,message);callback(null);});
        result.ship={connected:true,nextUrl(){},close(){},connect(message,disconnect,error,open){sockets.push({message,disconnect,error,open});},
            send(bytes){commands.push(codec.decode('request',bytes));}};
        const publisher={sendToQueue(queue,content,options,confirm){
            const publication={queue,content,properties:options,owner:wref,confirm(){const before=activeReaderSender;activeReaderSender=wref;try{confirm(null);}finally{activeReaderSender=before;}}};
            publications.push(publication);if(!result.holdPublisherConfirms)publication.confirm();return true;
        }};
        result.cch=publisher;result.cch_ready=true;
        const drain=()=>until(()=>result.blockReadingQueue.idle());
        const connect=()=>{result.startWS();sockets.at(-1).open();return sockets.at(-1);};
        const connection=connect();await drain();connection.message(Buffer.from(schemaJson));await drain();
        return {worker:result,wref,definition,replies,commands,sockets,drain,connect,connection};
    };
    const ds=async()=>{
        process.env.worker_role='deserializer';const result=new MainDS();workers.push(result);await result.protocolReady;await until(()=>result.mLoader.parser);
        result.protocolSourceBindingStore=sources;result.protocolAbiObservationStore=observations;result.preIndexingQueue={push:async()=>{}};result.ch_ready=true;
        const wref=Object.assign(new EventEmitter(),{id:++workerId,isConnected:()=>true,send(message,callback){result.onIpcMessage(message);callback?.(null);}});
        currentMaster.workerMap.push({worker_id:wref.id,worker_role:'deserializer',wref});const acks=[];let received;
        result.ch={prefetch(){},consume(queue,callback){received=callback;},on(){},ack(message){acks.push(message.fields.deliveryTag);},nack(){throw new Error('Unexpected fixture NACK');},sendToQueue(){return true;}};
        process.env.worker_queue=chain+':live_blocks';result.initConsumer();delete process.env.worker_queue;
        return {worker:result,wref,acks,async consume(publication){activeDsSender=wref;received({...publication,fields:{deliveryTag:++deliveryTag}});await until(()=>result.consumerQueue.idle());activeDsSender=undefined;}};
    };
    const a=await ds(),b=await ds();
    dropCheckpoints=true;
    const live=await reader(100);
    const openEntered=gate(),openRelease=gate();
    memory.faults.beforeWrite=async request=>{if(request.index===frontier.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64')).source){openEntered.release();await openRelease.promise;}};
    live.connection.message(status());await openEntered.promise;
    assert.deepEqual(live.commands.map(value=>value[0]),['get_status_request_v0']);assert.equal(publications.length,0);
    openRelease.release();await live.drain();delete memory.faults.beforeWrite;
    assert.equal(live.commands.at(-1)[0],'get_blocks_request_v0');assert.equal(live.commands.at(-1)[1].start_block_num,100);
    assert.deepEqual(live.commands.at(-1)[1].have_positions,[]);
    const admissionEntered=gate(),admissionRelease=gate();
    memory.faults.beforeWrite=async request=>{if(request.index===frontier.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64')).pending?.length){admissionEntered.release();await admissionRelease.promise;}};
    live.connection.message(frame(100));await admissionEntered.promise;assert.equal(publications.length,0,'Rabbit publication preceded durable source admission');
    admissionRelease.release();await live.drain();delete memory.faults.beforeWrite;
    live.connection.message(frame(101));await live.drain();assert.equal(publications.length,2);
    const admitted=await currentMaster.protocolAbiCoordinator.inspect();assert.deepEqual(admitted.pending,publications.map(value=>value.properties.headers[header]));
    // Capacity holds one frame at the reader; reverse worker completion cannot select source order.
    live.worker.holdPublisherConfirms=true;
    live.connection.message(frame(102));await until(()=>live.replies.some(reply=>reply.data?.result?.status==='backpressure'));
    assert.equal(publications.length,2);await b.consume(publications[1]);
    await until(()=>!currentMaster.protocolAbiDrainInFlight);assert.equal((await currentMaster.protocolAbiCoordinator.inspect()).head,null);
    dropHints=true;await a.consume(publications[0]);dropHints=false;
    await until(async()=>((await frontier.readControl()).value.head?.blockNum??0)>=101);
    await until(()=>publications.length===3);
    assert.equal(currentMaster.liveReader.worker_last_processed_block,100,'Coordinator progress fabricated a broker checkpoint');
    // A source publication checkpoint may be ahead of the canonical cursor.
    dropCheckpoints=false;publications[2].confirm();await live.drain();live.worker.holdPublisherConfirms=false;
    assert.equal(currentMaster.liveReader.worker_last_processed_block,103);
    clearInterval(currentMaster.protocolAbiDrainTimer);
    const oldMaster=currentMaster;currentMaster=await master();
    const resumed=await reader(103);resumed.connection.message(status());await resumed.drain();
    assert.equal(resumed.commands.at(-1)[1].start_block_num,102);assert.equal(currentMaster.liveReader.worker_last_processed_block,103);
    // Old source hints are retained but cannot become the new branch's input.
    currentMaster.workerMap.push(...oldMaster.workerMap.filter(value=>value.worker_role==='deserializer'));
    await a.consume(publications[2]);await until(()=>!currentMaster.protocolAbiDrainInFlight);
    assert.equal((await frontier.readControl()).value.head.blockNum,101);
    resumed.connection.message(frame(102));await resumed.drain();await a.consume(publications.at(-1));
    await until(async()=>(await frontier.readControl()).value.head?.blockNum===102);
    assert.equal(currentMaster.liveReader.worker_last_processed_block,103);
    // Fork admission returns a new generation before its replacement block is published.
    resumed.connection.message(frame(103));await resumed.drain();await a.consume(publications.at(-1));
    await until(async()=>(await frontier.readControl()).value.head?.blockNum===103);
    const beforeFork=resumed.worker.coordinatorSource.generation;
    const replacementId='f'.repeat(64);resumed.connection.message(frame(103,{this_block:{block_num:103,block_id:replacementId}}));await resumed.drain();
    assert.notEqual(resumed.worker.coordinatorSource.generation,beforeFork);
    assert.equal((await frontier.readControl()).value.head.blockNum,102);
    await b.consume(publications.at(-1));await until(async()=>(await frontier.readControl()).value.head?.blockId===replacementId);
    // Explicit incomplete contract observations advance topology with UNKNOWN ABI knowledge.
    const hook=a.worker.protocol.observeBlockAbi;a.worker.protocol.observeBlockAbi=()=>{throw new Error('Unsupported contract observation');};
    resumed.connection.message(frame(104,{prev_block:{block_num:103,block_id:replacementId}}));await resumed.drain();await a.consume(publications.at(-1));a.worker.protocol.observeBlockAbi=hook;
    await until(async()=>(await frontier.readControl()).value.head?.blockNum===104);
    const incomplete=(await frontier.readControl()).value;assert.equal(incomplete.phase,'incomplete');assert.equal(incomplete.head.coverageStart,null);
    resumed.connection.message(frame(105));await resumed.drain();await a.consume(publications.at(-1));await until(async()=>(await frontier.readControl()).value.head?.blockNum===105);
    // Revoke the real source while openSource is still waiting for its durable receipt.
    // Reader cancellation is synchronous; the engine's CAS fence is the durable boundary.
    const reopening=resumed.connect();await resumed.drain();reopening.message(Buffer.from(schemaJson));await resumed.drain();
    const openSession=resumed.worker.sourceContext.readerSessionId,revokedOpenEntered=gate(),revokedOpenRelease=gate();
    memory.faults.beforeWrite=async request=>{
        if(request.index===frontier.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64')).source?.readerSessionId===openSession){
            revokedOpenEntered.release();await revokedOpenRelease.promise;
        }
    };
    const commandsBeforeRevoke=resumed.commands.length;reopening.message(status());await revokedOpenEntered.promise;
    const realSetTimeout=globalThis.setTimeout;let reconnect;
    globalThis.setTimeout=(callback,delay,...args)=>{
        if(delay===5000){reconnect=()=>callback(...args);return {unref(){return this;}};}
        return realSetTimeout(callback,delay,...args);
    };
    try{reopening.disconnect();}finally{globalThis.setTimeout=realSetTimeout;}
    assert.equal(resumed.worker.coordinatorSource,undefined);assert.equal(currentMaster.protocolAbiSource,undefined);
    assert.equal(typeof reconnect,'function');reconnect();const currentSocket=resumed.sockets.at(-1);currentSocket.open();
    revokedOpenRelease.release();await resumed.drain();delete memory.faults.beforeWrite;
    assert.equal(resumed.commands.length,commandsBeforeRevoke,'Revoked awaited open sent a range command to the replacement socket');
    await until(async()=>(await frontier.readControl()).value.source===null);
    assert.equal(currentMaster.shutdownStarted,false,'Normal physical revocation became a master infrastructure failure');
    currentSocket.message(Buffer.from(schemaJson));await resumed.drain();currentSocket.message(status());await resumed.drain();
    assert.equal(resumed.commands.at(-1)[1].start_block_num,106,'Coordinator-ahead resume reused the older Rabbit checkpoint');
    assert.deepEqual(resumed.commands.at(-1)[1].have_positions,[]);assert.equal(currentMaster.liveReader.worker_last_processed_block,103);
    resumed.worker.holdPublisherConfirms=true;const beforeFresh=publications.length;
    currentSocket.message(frame(106,{last_irreversible:{block_num:106,block_id:blockId(106)}}));await until(()=>publications.length===beforeFresh+1);
    assert.equal(currentMaster.liveReader.worker_last_processed_block,103,'Opening a source fabricated a broker checkpoint');
    publications.at(-1).confirm();await resumed.drain();resumed.worker.holdPublisherConfirms=false;
    assert.equal(currentMaster.liveReader.worker_last_processed_block,107,'Fresh confirmed irreversible publication did not establish the new local epoch');
    await a.consume(publications.at(-1));await until(async()=>(await frontier.readControl()).value.head?.blockNum===106);
    const pendingAdmission=gate(),releaseAdmission=gate(),beforeRevokedPublication=publications.length;
    memory.faults.beforeWrite=async request=>{
        if(request.index===frontier.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64')).pending?.length){
            pendingAdmission.release();await releaseAdmission.promise;
        }
    };
    const revokedFrame=frame(107);currentSocket.message(revokedFrame);await pendingAdmission.promise;
    let reconnectAdmission;
    globalThis.setTimeout=(callback,delay,...args)=>{
        if(delay===5000){reconnectAdmission=()=>callback(...args);return {unref(){return this;}};}
        return realSetTimeout(callback,delay,...args);
    };
    const beforeRevokedCommands=resumed.commands.length;
    try{currentSocket.disconnect();}finally{globalThis.setTimeout=realSetTimeout;}
    assert.equal(resumed.worker.coordinatorSource,undefined);assert.equal(currentMaster.protocolAbiSource,undefined);
    reconnectAdmission();const afterAdmission=resumed.sockets.at(-1);afterAdmission.open();
    releaseAdmission.release();await resumed.drain();delete memory.faults.beforeWrite;
    assert.equal(publications.length,beforeRevokedPublication);assert.equal(resumed.commands.length,beforeRevokedCommands);
    await until(async()=>(await frontier.readControl()).value.source===null);
    const capsuleEvent=events.filter(event=>event.event==='ds_error'&&event.data?.code==='protocol_reader_stale_ingress').at(-1);
    assert.equal((await sources.readQuarantine(capsuleEvent.data.capsuleId)).frameHex,revokedFrame.toString('hex'));
    afterAdmission.message(Buffer.from(schemaJson));await resumed.drain();afterAdmission.message(status());await resumed.drain();
    assert.equal(resumed.commands.at(-1)[1].start_block_num,107);
    afterAdmission.message(frame(107));await resumed.drain();await b.consume(publications.at(-1));
    await until(async()=>(await frontier.readControl()).value.head?.blockNum===107);
    // A current reader's identity, not a claimed role field, controls admission.
    const forged=Object.assign(new EventEmitter(),{isConnected:()=>true,send(message){this.reply=message;}});
    const beforeUnauthorized=(await frontier.readControl()).value.revision;
    await currentMaster.handleProtocolAbiCoordinatorRequest(forged,{event:'protocol_abi_coordinator_request',mId:'1'.repeat(36),worker_role:'continuous_reader',
        data:{operation:'open',contextId:resumed.worker.sourceContext.id,readerSessionId:'forged'}});
    assert.equal(forged.reply.data.error.code,'unauthorized');assert.equal((await frontier.readControl()).value.revision,beforeUnauthorized);
    // An exited/replaced worker loses authorization even while its old object remains available.
    globalThis.setTimeout=(callback,delay,...args)=>delay===5000?{unref(){return this;}}:realSetTimeout(callback,delay,...args);
    try{currentMaster.handleWorkerDisconnect(resumed.wref);}finally{globalThis.setTimeout=realSetTimeout;}
    await until(async()=>(await frontier.readControl()).value.source===null);
    const afterDisconnect=(await frontier.readControl()).value.revision;
    await currentMaster.handleProtocolAbiCoordinatorRequest(resumed.wref,{event:'protocol_abi_coordinator_request',mId:'2'.repeat(36),
        data:{operation:'open',contextId:resumed.worker.sourceContext.id,readerSessionId:'old-worker'}});
    assert.equal(resumed.replies.at(-1).data.error.code,'unauthorized');assert.equal((await frontier.readControl()).value.revision,afterDisconnect);
    // Bulk readers still retain inputs and PREPARE but never acquire source authority.
    const bulk=await reader(106,'reader');bulk.connection.message(status());await bulk.drain();bulk.worker.local_block_num=105;
    const beforeBulk=(await frontier.readControl()).value.revision;
    bulk.connection.message(frame(106));await bulk.drain();await a.consume(publications.at(-1));await until(()=>!currentMaster.protocolAbiDrainInFlight);
    assert.equal((await frontier.readControl()).value.revision,beforeBulk);assert.equal(bulk.worker.coordinatorSource,undefined);
    // Cold-start Rabbit confirmations can advance before any ABI observation commits.
    // Reconnect and a new master owner must replay the first admitted source block.
    const originalMaster=currentMaster,coldChain=chain+'-cold',coldConfig={...config,settings:{...config.settings,chain:coldChain}};
    const coldSources=new ProtocolSourceBindingStore(memory.client,coldChain),coldFrontier=new ProtocolAbiFrontierStore(memory.client,coldChain);
    connections.chains[coldChain]=connections.chains[chain];
    writeFileSync(join(directory,'chain.json'),JSON.stringify(coldConfig));
    writeFileSync(join(directory,'config/connections.json'),JSON.stringify(connections));
    currentMaster=await master(coldConfig);
    const cold=await reader(900,'continuous_reader',coldSources);
    cold.connection.message(status(901));await cold.drain();
    for(const number of [900,901]){cold.connection.message(frame(number,{last_irreversible:{block_num:901,block_id:blockId(901)}}));await cold.drain();}
    assert.equal(currentMaster.liveReader.worker_last_processed_block,902);
    const coldAdmitted=await coldFrontier.readControl();assert.equal(coldAdmitted.value.head,null);assert.equal(coldAdmitted.value.pending.length,2);
    let coldReconnect;
    globalThis.setTimeout=(callback,delay,...args)=>delay===5000?((coldReconnect=()=>callback(...args)),{unref(){return this;}}):realSetTimeout(callback,delay,...args);
    try{cold.connection.disconnect();}finally{globalThis.setTimeout=realSetTimeout;}
    await until(async()=>(await coldFrontier.readControl()).value.source===null);
    coldReconnect();const coldSocket=cold.sockets.at(-1);coldSocket.open();await cold.drain();
    coldSocket.message(Buffer.from(schemaJson));await cold.drain();coldSocket.message(status(901));await cold.drain();
    assert.equal(cold.commands.at(-1)[1].start_block_num,900,'Cold reconnect skipped initial admitted but uncommitted source blocks');
    assert.equal(currentMaster.liveReader.worker_last_processed_block,902,'Cold replay fabricated a Rabbit checkpoint');
    assert.equal((await coldFrontier.readControl()).value.head,null);
    clearInterval(currentMaster.protocolAbiDrainTimer);currentMaster=await master(coldConfig);
    const coldReplacement=await reader(902,'continuous_reader',coldSources);
    coldReplacement.connection.message(status(901));await coldReplacement.drain();
    assert.equal(coldReplacement.commands.at(-1)[1].start_block_num,900,'New owner lost the cold replay boundary after pending was cleared');
    assert.equal(currentMaster.liveReader.worker_last_processed_block,902);assert.equal((await coldFrontier.readControl()).value.head,null);
    clearInterval(currentMaster.protocolAbiDrainTimer);currentMaster=originalMaster;
    writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    // Periodic infrastructure failures require supervised shutdown, rather than log-only success.
    let exited;process.exit=code=>{exited=code;};
    memory.faults.beforeRead=request=>{if(request.index===frontier.controlIndex)throw new Error('Frontier transport unavailable');};
    currentMaster.requestProtocolAbiDrain();await until(()=>exited!==undefined);delete memory.faults.beforeRead;process.exit=originalExit;
    assert.equal(exited,1);assert.equal(currentMaster.shutdownStarted,true);
    console.log(JSON.stringify({passed:true,profileId,actualReaderMasterWorker:true,sourceOrder:true,backpressure:true,lostHintRecovery:true,
        resume:true,coldStartReplay:true,revokeRace:true,admitRevokeRace:true,currentWorkerAuth:true,forkGeneration:true,incompleteContinuation:true,bulkAuthority:false,decodingActivation:false,syntheticConsensus:false}));
} finally {
    for(const master of masters)if(master.protocolAbiDrainTimer)clearInterval(master.protocolAbiDrainTimer);
    for(const worker of workers){if(worker.forkHandlingTimeout)clearTimeout(worker.forkHandlingTimeout);worker.coordinatorRpc?.cancel();worker.shipSession?.close?.();worker.profiler?.stopReporting();}
    process.send=originalSend;process.exit=originalExit;process.chdir(previous);rmSync(directory,{recursive:true,force:true});
}
