import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

registerHooks({resolve(specifier,context,next){if(specifier.includes('node-abieos'))throw new Error('Wire imported the native Antelope addon');return next(specifier,context);}});
const previous=process.cwd(),directory=mkdtempSync(join(tmpdir(),'hyperion-abi-consumers-'));
const workers=[],events=[],originalSend=process.send,originalExit=process.exit;
const until=async predicate=>{const end=Date.now()+8000;while(!(await predicate())){assert(Date.now()<end,'Fixture wait expired');await new Promise(resolve=>setTimeout(resolve,5));}};
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
let coordinator,reader,draining=Promise.resolve();
process.send=(message,callback)=>{
    events.push(message);
    if(message.event==='protocol_abi_prepared')draining=coordinator.drain();
    if(message.event==='protocol_abi_source_revoked')void coordinator.revokeSource(message.data.readerSessionId);
    callback?.(null);return true;
};
try {
    const fixture=JSON.parse(readFileSync(new URL('./fixtures/wire-host/receipts.json',import.meta.url)));
    const profileId=process.env.HYPERION_WIRE_PROFILE??fixture.profileId,chain='abi-consumer-fixture',chainId='1'.repeat(64);
    const config={settings:{chain,parser:'3.2',protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId},
        eosio_alias:'sysio',system_contract:'sysio',index_version:'v1',index_partition_size:10000,es_replicas:0,ds_profiling:false},
        indexer:{fetch_block:true,fetch_traces:true,fetch_deltas:true,process_deltas:true,disable_indexing:false,live_reader:true},
        features:{index_all_deltas:true,index_deltas:true,index_deltas_deletions:true,contract_state:{contracts:{'hyp.replay':{records:{}}}},
            streaming:{deltas:false,traces:false},tables:{},failed_trx:false},scaling:{ds_pool_size:1,routing_mode:'round_robin',
            indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},prefetch:{read:1,block:1,index:1},plugins:{},
        whitelists:{root_only:false,actions:[],deltas:[]},api:{tx_cache_mode:'batch'}};
    mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    writeFileSync(join(directory,'config/connections.json'),JSON.stringify({amqp:{protocol:'http'},
        elasticsearch:{host:'127.0.0.1:1',user:'',pass:''},chains:{[chain]:{chain_id:chainId,http:'http://127.0.0.1:1',ship:'ws://127.0.0.1:1'}},
        redis:{host:'127.0.0.1',port:1}}));
    process.chdir(directory);process.env.CONFIG_JSON=join(directory,'chain.json');process.env.worker_last_processed_block='1';
    const {HyperionWorker}=await import('../../build/indexer/workers/hyperionWorker.js');
    HyperionWorker.prototype.connectAMQP=async function(){};HyperionWorker.prototype.onConnect=function(){};
    const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
    const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
    const {default:Pool}=await import('../../build/indexer/workers/ds-pool.js');
    const {ProtocolAbiCoordinator}=await import('../../build/indexer/protocol/abi-coordinator.js');
    const {ProtocolAbiCoordinatorRpc}=await import('../../build/indexer/protocol/abi-coordinator-rpc.js');
    const {ProtocolSourceBindingStore,protocolSourceSelectionHeader:header}=await import('../../build/indexer/protocol/source-bindings.js');
    const {ProtocolAbiObservationStore}=await import('../../build/indexer/protocol/abi-observation-store.js');
    const {ProtocolAbiFrontierStore}=await import('../../build/indexer/protocol/abi-frontier-store.js');
    const {ProtocolAbiProofReader}=await import('../../build/indexer/protocol/abi-proof.js');
    const wire=await import('@eosrio/hyperion-wire-plugin');
    const codec=wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(profileId));
    const originalCodec=wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(fixture.profileId));
    const template=originalCodec.decode('result',Buffer.from(fixture.frameHex,'hex'));
    const originalTrace=originalCodec.decode('transaction_trace[]',Buffer.from(template[1].traces,'hex'))[0][1];
    const memory=frontierMemoryClient(),sources=new ProtocolSourceBindingStore(memory.client,chain),observations=new ProtocolAbiObservationStore(memory.client,chain);
    const store=new ProtocolAbiFrontierStore(memory.client,chain),blockId=number=>number.toString(16).padStart(64,'0');
    process.env.worker_role='continuous_reader';reader=new Reader();workers.push(reader);await reader.protocolReady;
    reader.client=memory.client;reader.protocolSourceBindingStore=sources;reader.receivedFirstBlock=true;
    const profile={id:reader.protocolId,profileId,components:reader.protocolComponents??[]};
    coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'consumer-fixture-master',bindings:sources,observations,store});await coordinator.start();
    reader.coordinatorRpc=new ProtocolAbiCoordinatorRpc((request,callback)=>{
        const input=request.data;
        void (input.operation==='open'?coordinator.openSource(input.contextId,input.readerSessionId):coordinator.admit(input.selectionId,input.generation))
            .then(result=>reader.onIpcMessage({event:'protocol_abi_coordinator_reply',mId:request.mId,data:{ok:true,result}}))
            .catch(error=>reader.onIpcMessage({event:'protocol_abi_coordinator_reply',mId:request.mId,data:{ok:false,error:{code:'fixture',message:error.message}}}));
        callback(null);
    });
    const publications=[],poolMessages=[],indexOutput=[],actions=[],acks=[];
    reader.ship={connected:true,send(){},close(){}};reader.stageOneDistQueue={push:async value=>publications.push(value)};
    await reader.onMessage(Buffer.from(JSON.stringify(fixture.handshake)));
    await reader.onMessage(Buffer.from(codec.encode('result',['get_status_result_v0',{head:template[1].head,
        last_irreversible:{block_num:0,block_id:blockId(0)},trace_begin_block:1,trace_end_block:1000,chain_state_begin_block:1,chain_state_end_block:1000,chain_id:chainId}])));
    process.env.worker_role='deserializer';const main=new MainDS();workers.push(main);await main.protocolReady;await until(()=>main.mLoader.parser);
    main.client=memory.client;main.protocolSourceBindingStore=sources;main.protocolAbiObservationStore=observations;main.ch_ready=true;
    main.preIndexingQueue={push:async value=>indexOutput.push(value)};
    main.ch={ack(){},nack(){throw new Error('Unexpected MainDS NACK');},sendToQueue(queue,content,options){poolMessages.push({content,properties:options,queue});return true;}};
    const createPool=async()=>{
        process.env.worker_role='ds_pool_worker';const result=new Pool();result.ioRedisClient.disconnect();result.ioRedisClient=null;workers.push(result);
        await result.protocolReady;result.client=memory.client;result.mLoader=main.mLoader;result.ch_ready=true;
        result.ch={ack(message){acks.push(message);},nackAll(){throw new Error('Extension reused nackAll');},sendToQueue(queue,content){actions.push(JSON.parse(content));return true;}};
        result.preIndexingQueue={push:async()=>{throw new Error('Unexpected deferred action publication');}};return result;
    };
    let pool=await createPool();
    const abi=field=>({version:'sysio::abi/1.3',types:[],structs:[{name:'record',base:'',fields:[{name:field,type:'uint32'}]}],
        actions:[{name:'record',type:'record',ricardian_contract:''}],tables:[{name:'records',index_type:'i64',key_names:[],key_types:[],type:'record',table_id:0,secondary_indexes:[]}],
        ricardian_clauses:[],error_messages:[],abi_extensions:[],variants:[]});
    const abiA=Buffer.from(reader.protocol.contractCodec.encodeAbi(abi('old'))).toString('hex'),abiB=Buffer.from(reader.protocol.contractCodec.encodeAbi(abi('new'))).toString('hex');
    const encode=(type,value)=>Buffer.from(codec.encode(type,value)).toString('hex');
    const account=(bytes,present=true)=>({present,data:encode('account',['account_v0',{name:'hyp.replay',creation_date:'2025-01-01T00:00:00.000',abi:bytes}])});
    const occurrence=(ordinal,globalSequence,{account='hyp.replay',name='record',receiver=account,creator=0,raw='07000000',abiSequence=0}={})=>{
        const result=structuredClone(originalTrace.action_traces[0][1]);
        Object.assign(result,{action_ordinal:ordinal,creator_action_ordinal:creator,receiver,act:{account,name,authorization:[{actor:'alice',permission:'active'}],data:raw},except:null,error_code:null});
        result.receipt[1]={...result.receipt[1],receiver,global_sequence:globalSequence,abi_sequence:abiSequence,act_digest:'d'.repeat(64)};
        return ['action_trace_v1',result];
    };
    const frame=(number,actionTraces=[],accountRows=[],extraDeltas=[])=>{
        const trace={...structuredClone(originalTrace),id:'a'.repeat(63)+number.toString(16),status:0,scheduled:false,action_traces:actionTraces,except:null,error_code:null,failed_dtrx_trace:null};
        return Buffer.from(codec.encode('result',[template[0],{...structuredClone(template[1]),this_block:{block_num:number,block_id:blockId(number)},
            prev_block:{block_num:number-1,block_id:blockId(number-1)},last_irreversible:{block_num:0,block_id:blockId(0)},
            traces:encode('transaction_trace[]',actionTraces.length?[['transaction_trace_v0',trace]]:[]),
            deltas:encode('table_delta[]',[['table_delta_v0',{name:'account',rows:accountRows}],...extraDeltas])}]));
    };
    const prepare=async bytes=>{
        reader.local_block_num=Number(reader.decodeShipResult(bytes)[1].this_block.block_num)-1;
        await reader.onMessage(bytes);const publication=publications.at(-1),message={content:publication.content,properties:{headers:publication.headers}};
        main.captureProtocolSourceDelivery(message,main.ch);const routedBefore=poolMessages.length;
        await main.mLoader.parser.parseMessage(main,[message]);await draining;
        return {message,selectionId:publication.headers[header],pool:poolMessages.slice(routedBefore)};
    };
    const consumePool=async messages=>{for(const message of messages)pool.captureProtocolActionDelivery(message,pool.ch);await pool.processMessages(messages);};
    await prepare(frame(1,[],[account(abiA)]));
    const setabi=Buffer.concat([codec.encode('name','hyp.replay'),codec.encode('bytes',abiB)]).toString('hex');
    const changed=await prepare(frame(2,[occurrence(1,'9007199254740993'),occurrence(2,'9007199254740994',{account:'sysio',name:'setabi',raw:setabi}),
        occurrence(3,'9007199254740996',{creator:1,abiSequence:1}),occurrence(4,'9007199254740995',{creator:1,receiver:'bob',abiSequence:1})],[account(abiB)]));
    assert.equal(changed.pool.length,1);assert.equal(changed.pool[0].properties.headers[header],changed.selectionId);
    await consumePool(changed.pool);
    const root=actions.find(action=>action.action_ordinal===1),inline=actions.find(action=>action.action_ordinal===3),native=actions.find(action=>action.action_ordinal===2);
    assert.deepEqual(root.act.data,{old:7});assert.deepEqual(inline.act.data,{new:7});assert.equal(root.receipts.length,2);assert.equal(inline.receipts.length,1);
    assert.equal(root.protocol.input.globalSequence,'9007199254740993');assert.equal(root.protocol.input.inputActionOrdinal,1);
    assert.equal(inline.protocol.input.inputActionOrdinal,3);assert.equal(root.protocol.input.rawHex,'07000000');
    assert.equal(native.ds_error,true);assert.equal(native.protocol.status,'incomplete');assert.equal(typeof native.act.data,'string');
    // Historical final KV uses the certified target root despite an unrefreshed/missing ABI index.
    indexOutput.length=0;
    const kv={present:1,data:encode('contract_row_kv',['contract_row_kv_v0',{code:'hyp.replay',payer:'alice',table_id:0,key:'01',value:'07000000'}])};
    const later=await prepare(frame(3,[occurrence(1,'9007199254740997',{abiSequence:1})],[],[['table_delta_v0',{name:'contract_row_kv',rows:[kv]}]]));
    await consumePool(later.pool);assert.deepEqual(actions.at(-1).act.data,{new:7});
    const row=indexOutput.filter(value=>value.queue.includes('index_deltas')).map(value=>JSON.parse(value.content));
    assert.equal(row.length,1);assert.deepEqual(row[0].data,{new:7});
    for(const [number,bytes,sequence] of [[4,'','9007199254740998'],[5,'ff','9007199254741000'],[6,abiB,'9007199254741002']]) {
        const publication=Buffer.concat([codec.encode('name','hyp.replay'),codec.encode('bytes',bytes)]).toString('hex');
        const changed=await prepare(frame(number,[occurrence(1,sequence,{account:'sysio',name:'setabi',raw:publication}),
            occurrence(2,String(BigInt(sequence)+1n),{abiSequence:number-2})],[account(bytes)]));
        await consumePool(changed.pool);
        if(number<6){assert.equal(actions.at(-1).ds_error,true);assert.equal(actions.at(-1).protocol.status,'incomplete');assert.equal(actions.at(-1).act.data,'07000000');}
        else assert.deepEqual(actions.at(-1).act.data,{new:7},'Clear/rejected ABI barrier stopped unrelated later valid decoding');
    }
    // Tampered occurrence and a subsequent genuine action remain independent.
    const tampered=structuredClone(later.pool[0]);const tamperedTrace=JSON.parse(Buffer.from(tampered.content).toString());tamperedTrace.action_traces[0][1].act.data='08000000';
    tampered.content=Buffer.from(JSON.stringify(tamperedTrace));await consumePool([tampered]);
    assert.equal(actions.at(-1).protocol.status,'incomplete');assert.equal(actions.at(-1).act.data,'08000000');
    await consumePool(later.pool.map(message=>({...message,content:Buffer.from(message.content)})));assert.deepEqual(actions.at(-1).act.data,{new:7});
    // Proof state IO fails without acknowledging; contract codec failure alone stays raw.
    const beforeFailure=acks.length;
    const readState=pool.protocolProofReader.action.bind(pool.protocolProofReader);
    pool.protocolProofReader.action=async()=>{throw new Error('Injected immutable-state transport failure');};
    await assert.rejects(consumePool(later.pool.map(message=>({...message}))),/transport failure/);assert.equal(acks.length,beforeFailure);
    pool.protocolProofReader.action=readState;
    // Original broker ownership survives a held proof await and channel replacement.
    const entered=gate(),release=gate(),oldChannel=pool.ch,ownerAcks=acks.length;
    pool.protocolProofReader.action=async(...args)=>{entered.release();await release.promise;return readState(...args);};
    const pending=consumePool(later.pool.map(message=>({...message})));await entered.promise;
    pool.ch={...oldChannel,ack(){throw new Error('Old tag reached replacement channel');}};release.release();
    await assert.rejects(pending,/original broker channel/);assert.equal(acks.length,ownerAcks);pool.ch=oldChannel;pool.protocolProofReader.action=readState;
    // Actual consume registration captures both receipts before the second waits
    // behind the first cargo item. A channel replacement requires a new worker.
    let receive,exitCode,cargoReads=0;const cargoEntered=gate(),cargoRelease=gate(),cargoOwner=pool.ch;
    Object.assign(cargoOwner,{prefetch(){},consume(_queue,callback){receive=callback;}});pool.local_queue=chain+':ds_pool:fixture';await pool.initConsumer();
    pool.protocolProofReader.action=async(...args)=>{cargoReads++;cargoEntered.release();await cargoRelease.promise;return readState(...args);};
    const cargoFirst={...later.pool[0],fields:{deliveryTag:10}},cargoSecond={...later.pool[0],fields:{deliveryTag:11}},beforeCargoAck=acks.length;
    process.exit=code=>{exitCode=code;};
    receive(cargoFirst);await cargoEntered.promise;receive(cargoSecond);
    const failedPool=pool;pool.ch={...cargoOwner,ack(){throw new Error('Queued old receipt acknowledged replacement channel');}};cargoRelease.release();
    await until(()=>exitCode!==undefined);process.exit=originalExit;
    assert.equal(exitCode,1);assert.equal(cargoReads,1);assert.equal(acks.length,beforeCargoAck);assert.equal(failedPool.consumerQueue.length(),0);
    pool=await createPool();await consumePool(later.pool.map(message=>({...message,fields:{deliveryTag:12}})));
    assert.deepEqual(actions.at(-1).act.data,{new:7},'Fresh replacement failed to consume redelivery with its own receipt');
    // A fork between selection and final publication restores raw input and drops hook-derived fields.
    const revalidate=pool.protocolProofReader.revalidate.bind(pool.protocolProofReader);let checks=0;
    pool.protocolProofReader.revalidate=async view=>{
        if(++checks===3)await coordinator.revokeSource(reader.sourceContext.readerSessionId);
        return revalidate(view);
    };
    pool.common.attachActionExtras=(_worker,action)=>{action['@record']={derived:'must disappear'};};
    const prior=actions.length;await consumePool(later.pool.map(message=>({...message})));assert.equal(actions.length,prior+1);
    assert.equal(actions.at(-1).protocol.status,'incomplete');assert.equal(actions.at(-1).act.data,'07000000');assert.equal(actions.at(-1)['@record'],undefined);
    assert(events.some(message=>message.event==='ds_error'&&message.data?.type==='protocol_action_incomplete'));
    const mapping=await import('../../build/indexer/definitions/index-templates.js');assert.deepEqual(mapping.action.mappings.properties.protocol,{enabled:false});
    console.log(JSON.stringify({passed:true,profileId,syntheticConsensus:false,proofBoundActions:true,certifiedOrigins:true,
        finalRootKv:true,losslessAnchors:true,rawIsolation:true,oldChannelFenced:true,stalePublicationFenced:true}));
} finally {
    for(const worker of workers){worker.coordinatorRpc?.cancel();worker.shipSession?.close?.();worker.profiler?.stopReporting();if(worker.monitoringLoop)clearInterval(worker.monitoringLoop);if(worker.forkHandlingTimeout)clearTimeout(worker.forkHandlingTimeout);}
    process.send=originalSend;process.exit=originalExit;process.chdir(previous);rmSync(directory,{recursive:true,force:true});
}
