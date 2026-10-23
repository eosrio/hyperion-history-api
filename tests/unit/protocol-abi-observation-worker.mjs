import {controlledAttemptLifecycle} from './worker-attempt-fixture.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observationMemoryClient} from './protocol-observation-memory.mjs';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

registerHooks({resolve(specifier,context,next){if(specifier.includes('node-abieos'))throw new Error('Wire imported the legacy addon');return next(specifier,context);}});
const previous=process.cwd(),directory=mkdtempSync(join(tmpdir(),'hyperion-abi-observation-'));
let main;const workers=[];const originalSend=process.send;const originalExit=process.exit;
const events=[];process.send=event=>{events.push(event);return true;};
try {
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/wire-host/receipts.json',import.meta.url)));
    const chain='abi-observation-fixture',chainId='1'.repeat(64);
    const config={settings:{chain,parser:'3.2',protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:fixture.profileId},
        eosio_alias:'sysio',system_contract:'sysio',index_version:'v1',index_partition_size:10000,ds_profiling:false,es_replicas:0},
        indexer:{fetch_block:true,fetch_traces:true,fetch_deltas:true,process_deltas:true,disable_indexing:false,max_inline:1},
        features:{index_all_deltas:true,index_deltas:true,index_deltas_deletions:true,streaming:{deltas:false,traces:false},tables:{},failed_trx:false},
        scaling:{ds_pool_size:1,routing_mode:'round_robin',indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},
        prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{root_only:false,actions:[],deltas:[]},api:{tx_cache_mode:'batch'}};
    mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    writeFileSync(join(directory,'config/connections.json'),JSON.stringify({amqp:{protocol:'http'},elasticsearch:{host:'127.0.0.1:1',user:'',pass:''},
        chains:{[chain]:{chain_id:chainId,http:'http://127.0.0.1:1',ship:'ws://127.0.0.1:1'}},redis:{host:'127.0.0.1',port:1}}));
    process.chdir(directory);process.env.CONFIG_JSON=join(directory,'chain.json');process.env.worker_role='deserializer';
    const {HyperionWorker}=await import('../../build/indexer/workers/hyperionWorker.js');
    HyperionWorker.prototype.connectAMQP=async function(){};HyperionWorker.prototype.onConnect=function(){};
    const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
    const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
    const {ProtocolSourceBindingStore,protocolSourceSelectionHeader}=await import('../../build/indexer/protocol/source-bindings.js');
    const {ProtocolAbiObservationStore,protocolAbiCaptureDigest}=await import('../../build/indexer/protocol/abi-observation-store.js');
    const wire=await import('@eosrio/hyperion-wire-plugin');
    main=new MainDS();workers.push(main);await main.protocolReady;await main.initializeProtocolShip(JSON.stringify(fixture.handshake));
    main.client=frontierMemoryClient().client;
    const limit=Date.now()+3000;while(!main.mLoader.parser){assert(Date.now()<limit);await new Promise(resolve=>setTimeout(resolve,5));}
    const memory=observationMemoryClient();const store=new ProtocolAbiObservationStore(memory.client,chain);
    main.protocolAbiObservationStore=store;
    const sourceMemory=observationMemoryClient(),sourceStore=new ProtocolSourceBindingStore(sourceMemory.client,chain);
    main.protocolSourceBindingStore=sourceStore;
    const reader=new Reader();workers.push(reader);await reader.protocolReady;
    reader.protocolSourceBindingStore=sourceStore;reader.confirmRange=undefined;reader.receivedFirstBlock=true;
    reader.ship={connected:true,send(){},close(){}};
    const publications=[];
    const publisher={sendToQueue(queue,content,options,confirm){publications.push({content,properties:options});confirm(null);return true;}};
    reader.cch=publisher;reader.cch_ready=true;
    reader.stageOneDistQueue={push:async payload=>new Promise(resolve=>reader.recursiveDistribute([payload],publisher,resolve))};
    await reader.processFirstABI(Buffer.from(JSON.stringify(fixture.handshake)));
    const publish=async content=>{
        reader.local_block_num=Number(reader.decodeShipResult(content)[1].this_block.block_num)-1;
        const before=publications.length;
        await reader.onMessage(content);assert.equal(publications.length,before+1);
        return publications.at(-1);
    };
    const consume=async(content,worker=main)=>{
        const delivery=await publish(content);(controlledAttemptLifecycle(worker, 'deserializer'), worker).captureProtocolSourceDelivery(delivery,worker.ch);
        return worker.mLoader.parser.parseMessage(worker,[delivery]);
    };
    let ack=0;const output=[],routed=[];
    main.preIndexingQueue={push:async value=>output.push(value)};main.ch_ready=true;
    main.ch={ack(){ack++;},nack(){throw new Error('Unexpected process failure');},sendToQueue(queue,content,options){routed.push({queue,content,options});return true;}};
    const originalHook=main.protocol.observeBlockAbi;
    assert.equal(typeof originalHook,'function','Positive host fixture requires the coordinated real Wire observer package');
    const observed=[];
    main.protocol={...main.protocol,observeBlockAbi(input,source){
        observed.push({input:structuredClone(input),source:structuredClone(source)});
        return originalHook.call(main.protocol,input,source);
    }};
    const codec=wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(fixture.profileId));
    const template=main.decodeShipResult(Buffer.from(fixture.frameHex,'hex'));
    await reader.onMessage(Buffer.from(codec.encode('result',['get_status_result_v0',{head:template[1].head,last_irreversible:template[1].last_irreversible,
        trace_begin_block:2,trace_end_block:10000,chain_state_begin_block:2,chain_state_end_block:10000,chain_id:chainId}])));
    const make=(type,value)=>Buffer.from(codec.encode(type,value)).toString('hex');
    const account=(name,abi)=>({present:1,data:make('account',['account_v0',{name,creation_date:'2025-01-01T00:00:00.000',abi}])});
    const frame=(number,changes={})=>Buffer.from(codec.encode('result',[template[0],{...structuredClone(template[1]),
        this_block:{block_num:number,block_id:number.toString(16).padStart(64,'0')},
        prev_block:{block_num:number-1,block_id:(number-1).toString(16).padStart(64,'0')},...changes}]));
    const journalRecords=async()=>{
        const ids=[...memory.documents.entries()].filter(([,entry])=>entry.document.kind==='manifest').map(([id])=>id);
        return await Promise.all(ids.map(id=>store.read(id)));
    };

    // A matching history filter still cannot truncate or mutate the observation input.
    main.conf.whitelists.root_only=false;main.filters.action_whitelist=new Set();
    const first=frame(100);
    const firstDelivery=await publish(first);
    (controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(firstDelivery,main.ch);
    await main.mLoader.parser.parseMessage(main,[firstDelivery]);
    assert.equal(ack,1);assert.equal(observed[0].input.traces[0][1].action_traces.length,2);
    let records=await journalRecords();assert.equal(records[0].observation.status,'observed');
    assert.equal(records[0].observation.facts.actionInputs.length,2);
    const {inputSha256,...position}=records[0].source;
    assert.equal(inputSha256,protocolAbiCaptureDigest(position,records[0].capture));
    assert.equal(records[0].capture.schemaJson,JSON.stringify(fixture.handshake));
    assert.equal(records[0].capture.tracesHex,template[1].traces);
    assert.equal(JSON.parse(routed.at(-1).content).action_traces.length,1,'max_inline fixture did not exercise production truncation');
    for(const action of records[0].observation.facts.actionInputs)assert.equal(typeof action.globalSequence,'string');
    const drift=frame(100,{head:{block_num:9000,block_id:'9'.repeat(64)},last_irreversible:{block_num:99,block_id:'8'.repeat(64)}});
    const driftDelivery=await publish(drift);
    (controlledAttemptLifecycle(main, 'deserializer'), main).captureProtocolSourceDelivery(driftDelivery,main.ch);
    await main.mLoader.parser.parseMessage(main,[driftDelivery]);
    assert.equal(ack,2);assert.equal((await journalRecords()).length,1,'Mutable head/LIB metadata changed the capture identity');
    const firstLink=await sourceStore.readObservationLink(firstDelivery.properties.headers[protocolSourceSelectionHeader]);
    const driftLink=await sourceStore.readObservationLink(driftDelivery.properties.headers[protocolSourceSelectionHeader]);
    assert.notEqual(firstLink.selectionId,driftLink.selectionId);assert.equal(firstLink.observationId,driftLink.observationId);
    assert.equal(firstLink.observationDigest,driftLink.observationDigest);

    // Nonmatching root-only and transaction filters still observe complete account ABI barriers.
    main.conf.whitelists.root_only=true;main.conf.whitelists.actions=['other::nomatch'];main.filters.action_whitelist=new Set(['other::nomatch']);
    output.length=0;routed.length=0;
    const barriers=make('table_delta[]',[['table_delta_v0',{name:'account',rows:[account('hyp.replay',''),account('bad.replay','ff')]}]]);
    await consume(frame(101,{deltas:barriers}));
    assert.equal(ack,3);assert.equal(routed.length,0);assert(!output.some(value=>value.queue.includes('index_abis')));
    records=await journalRecords();const barrier=records.find(record=>record.source.blockNum===101);
    assert.equal(barrier.observation.status,'observed');
    assert.deepEqual(barrier.observation.facts.finalStates.map(entry=>entry.abiHex),['','ff']);
    assert.equal(observed.at(-1).input.traces[0][1].action_traces.length,2);

    // A full explicit zero-observation block is different from missing source data.
    await consume(frame(102,{traces:make('transaction_trace[]',[]),deltas:make('table_delta[]',[])}));
    records=await journalRecords();const noOp=records.find(record=>record.source.blockNum===102);
    assert.deepEqual(noOp.observation,{status:'observed',facts:{schemaVersion:1,actionInputs:[],deployments:[],finalStates:[]}});
    await consume(frame(103,{traces:null}));
    records=await journalRecords();assert.equal(records.find(record=>record.source.blockNum===103).observation.status,'incomplete');

    // Storage failure escapes before source ACK, then identical redelivery recovers.
    const before=ack;let failing=true;
    memory.faults.beforeWrite=()=>{if(failing)throw new Error('Observation sink unavailable');};
    const retry=frame(104);
    await assert.rejects(consume(retry),/sink unavailable/);assert.equal(ack,before);
    failing=false;await consume(retry);assert.equal(ack,before+1);
    await consume(retry);assert.equal(ack,before+2);
    const observer=main.protocol.observeBlockAbi;
    main.protocol.observeBlockAbi=()=>{throw new Error('Different derived facts for the same capture');};
    await assert.rejects(consume(retry),/Immutable.*conflict/);assert.equal(ack,before+2);
    main.protocol.observeBlockAbi=observer;
    const refill=frame(104,{traces:null});
    await consume(refill);assert.equal(ack,before+3);
    const fork=frame(104,{this_block:{block_num:104,block_id:'f'.repeat(64)}});
    await consume(fork);assert.equal(ack,before+4);
    records=await journalRecords();assert.equal(records.filter(record=>record.source.blockNum===104).length,3);

    // Absent/unsupported observations are durable explicit incompleteness, never empty success.
    main.protocol.observeBlockAbi=()=>{throw new Error('Unsupported observation source');};
    await consume(frame(105));
    records=await journalRecords();assert.match(records.find(record=>record.source.blockNum===105).observation.error.message,/Unsupported/);
    let getters=0;
    main.protocol.observeBlockAbi=()=>Object.defineProperty({schemaVersion:1,deployments:[],finalStates:[]},'actionInputs',
        {enumerable:true,get(){getters++;return [];}});
    await consume(frame(106));assert.equal(getters,0);
    records=await journalRecords();const malformed=records.find(record=>record.source.blockNum===106);
    assert.equal(malformed.observation.status,'incomplete');assert.equal(malformed.capture.tracesHex,template[1].traces);
    main.protocol.observeBlockAbi=()=>({schemaVersion:1,actionInputs:[null],deployments:[],finalStates:[]});
    await consume(frame(108));
    records=await journalRecords();assert.equal(records.find(record=>record.source.blockNum===108).observation.status,'incomplete');
    main.protocol.observeBlockAbi=observer;
    const huge=main.decodeShipValue('transaction_trace[]',template[1].traces);
    for(const [index,entry] of huge[0][1].action_traces.entries())entry[1].receipt[1].global_sequence=String(9007199254740993n+BigInt(index));
    await consume(frame(107,{traces:make('transaction_trace[]',huge)}));
    records=await journalRecords();assert.deepEqual(records.find(record=>record.source.blockNum===107).observation.facts.actionInputs
        .map(entry=>entry.globalSequence),['9007199254740993','9007199254740994']);

    // Exercise the actual constructor-created cargo, including a queued delivery
    // behind the failed batch. A supervised replacement receives fresh broker tags.
    const cargoMemory=observationMemoryClient();let failManifest=true;
    cargoMemory.faults.beforeWrite=request=>{if(failManifest&&request.document.kind==='manifest')throw new Error('Transient durable sink failure');};
    const settlements=[];
    const createWorker=async label=>{
        const worker=new MainDS();workers.push(worker);await worker.protocolReady;await worker.initializeProtocolShip(JSON.stringify(fixture.handshake));
        worker.client=frontierMemoryClient().client;
        const deadline=Date.now()+3000;while(!worker.mLoader.parser){assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
        worker.protocolAbiObservationStore=new ProtocolAbiObservationStore(cargoMemory.client,chain);
        worker.protocolSourceBindingStore=sourceStore;
        worker.preIndexingQueue={push:async()=>{}};worker.ch_ready=true;
        worker.ch={ack(message){assert(worker.ch_ready,`${label} acknowledged a stale channel`);settlements.push(`${label}:${message.fields.deliveryTag}`);},
            nackAll(){throw new Error('nackAll would make queued delivery tags stale');},sendToQueue(){return true;}};
        return worker;
    };
    const failedWorker=await createWorker('old');let requestedExit;
    process.exit=code=>{requestedExit=code;};
    const delivery=async(number,tag)=>({...await publish(frame(number)),fields:{deliveryTag:tag}});
    const retry200=await delivery(200,1),retry201=await delivery(201,2);
    (controlledAttemptLifecycle(failedWorker, 'deserializer'), failedWorker).captureProtocolSourceDelivery(retry200,failedWorker.ch);(controlledAttemptLifecycle(failedWorker, 'deserializer'), failedWorker).captureProtocolSourceDelivery(retry201,failedWorker.ch);
    void failedWorker.consumerQueue.push(retry200).catch(()=>{});
    void failedWorker.consumerQueue.push(retry201).catch(()=>{});
    const restartDeadline=Date.now()+3000;while(requestedExit===undefined){assert(Date.now()<restartDeadline);await new Promise(resolve=>setTimeout(resolve,5));}
    process.exit=originalExit;
    assert.equal(requestedExit,1);assert.equal(settlements.length,0);assert.equal(failedWorker.consumerQueue.length(),0);
    assert.equal(failedWorker.ch_ready,false);failManifest=false;
    const replacement=await createWorker('replacement');
    const replacement200={...retry200,fields:{deliveryTag:101}},replacement201={...retry201,fields:{deliveryTag:102}};
    (controlledAttemptLifecycle(replacement, 'deserializer'), replacement).captureProtocolSourceDelivery(replacement200,replacement.ch);(controlledAttemptLifecycle(replacement, 'deserializer'), replacement).captureProtocolSourceDelivery(replacement201,replacement.ch);
    await Promise.all([replacement.consumerQueue.push(replacement200),replacement.consumerQueue.push(replacement201)]);
    assert.deepEqual(settlements,['replacement:101','replacement:102']);assert.equal(new Set(settlements).size,settlements.length);
    assert.equal(failedWorker.consumerQueue.length(),0,'Old cargo retained already-requeued source work');
    console.log(JSON.stringify({passed:true,prepared:records.length,sourceAckAfterDurability:true,cargoRestart:true,
        canonicalActivation:false,syntheticConsensus:false}));
} finally {
    for(const worker of workers){worker.shipSession?.close?.();worker.profiler?.stopReporting();}
    process.send=originalSend;process.exit=originalExit;
    process.chdir(previous);rmSync(directory,{recursive:true,force:true});
}
