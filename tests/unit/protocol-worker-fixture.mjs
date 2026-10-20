import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {observationMemoryClient} from './protocol-observation-memory.mjs';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// A real selected extension must work when importing the legacy addon is impossible.
registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) throw new Error('Wire imported the Antelope addon');
    return next(specifier, context);
}});
const previous = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'hyperion-wire-worker-'));
const workers = [];
const originalSend = process.send;
const events = [];
process.send = event => { events.push(event); return true; };
try {
    const {loadChainProtocol} = await import('../../build/indexer/protocol/selection.js');
    const wire = await import('@eosrio/hyperion-wire-plugin');
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/wire-host/receipts.json', import.meta.url)));
    assert.equal(createHash('sha256').update(readFileSync(new URL('./fixtures/wire-host/receipts.json', import.meta.url))).digest('hex'),
        '6938adcee9bee9b687bb6db1677eec168e2d68766ea708bcf9614fde9e7d6c32');
    assert.equal(fixture.fixtureKind, 'synthetic-serialization-only');
    assert.equal(fixture.consensusValidation, false);
    const packageRoot = join(dirname(fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin'))), '..');
    const vectorFile = JSON.parse(readFileSync(join(packageRoot, 'fixtures/codec/ship-vectors.json')));
    const captured = vectorFile.vectors.find(entry => entry.id === 'captured-ship-block-result');
    const profileId = fixture.profileId;
    const protocol = {provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId};
    const chainId = vectorFile.producer.chainId;
    const chain = 'wire-host-fixture';
    const config = {
        settings:{chain,parser:'3.2',protocol,eosio_alias:'sysio',system_contract:'sysio',index_version:'v1',index_partition_size:10000,
            ds_profiling:false,allow_custom_abi:false,max_ws_payload_mb:16},
        indexer:{fetch_block:true,fetch_traces:true,fetch_deltas:true,process_deltas:true,abi_scan_mode:false,disable_indexing:false},
        features:{index_all_deltas:true,index_deltas:true,index_deltas_deletions:true,index_transfer_memo:true,
            contract_state:{enabled:true,contracts:{'hyp.replay':{People:{}}}},streaming:{deltas:false,traces:false},tables:{},failed_trx:false},
        scaling:{ds_pool_size:1,routing_mode:'round_robin',indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},
        prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{root_only:false,actions:[],deltas:[]},api:{tx_cache_mode:'batch'},
    };
    mkdirSync(join(directory,'config'));
    writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    writeFileSync(join(directory,'config/connections.json'),JSON.stringify({
        amqp:{protocol:'http'},elasticsearch:{host:'127.0.0.1:1',user:'',pass:''},
        chains:{[chain]:{chain_id:chainId,http:'http://127.0.0.1:1',ship:'ws://127.0.0.1:1'}},redis:{host:'127.0.0.1',port:1},
    }));
    process.chdir(directory); process.env.CONFIG_JSON = join(directory,'chain.json'); process.env.worker_role = 'reader';
    const {HyperionWorker} = await import('../../build/indexer/workers/hyperionWorker.js');
    // Transport boundary only: constructors, selection, codecs and processing methods are production code.
    HyperionWorker.prototype.connectAMQP = async function() {};
    HyperionWorker.prototype.onConnect = function() {};
    const {default: Reader} = await import('../../build/indexer/workers/state-reader.js');
    const {default: Deserializer} = await import('../../build/indexer/workers/deserializer.js');
    const {default: Pool} = await import('../../build/indexer/workers/ds-pool.js');
    const {MongoRoutes} = await import('../../build/indexer/helpers/mongo-routes.js');
    const {ElasticRoutes} = await import('../../build/indexer/helpers/elastic-routes.js');
    const {ProtocolAbiObservationStore} = await import('../../build/indexer/protocol/abi-observation-store.js');
    const {ProtocolSourceBindingStore} = await import('../../build/indexer/protocol/source-bindings.js');
    const sourceStore = new ProtocolSourceBindingStore(observationMemoryClient().client,chain);
    const reader = new Reader(); workers.push(reader);
    await reader.protocolReady;
    reader.protocolSourceBindingStore = sourceStore;
    const requests = []; const distributed = [];
    reader.ship = {connected:true,send:bytes=>requests.push(Buffer.from(bytes)),close(){}};
    reader.stageOneDistQueue = {push:async payload=>distributed.push(payload)};
    reader.local_block_num = vectorFile.producer.blockNum - 1; reader.receivedFirstBlock = true;
    await reader.onMessage(Buffer.from(JSON.stringify(fixture.handshake)));
    const handshakeCodec = wire.createWireValueCodec(fixture.handshake,wire.resolveCodecProfile(profileId));
    const capturedResult = handshakeCodec.decode('result',Buffer.from(captured.hex,'hex'))[1];
    const statusFrame = Buffer.from(handshakeCodec.encode('result',['get_status_result_v0',{head:capturedResult.head,
        last_irreversible:capturedResult.last_irreversible,trace_begin_block:2,trace_end_block:10000,
        chain_state_begin_block:2,chain_state_end_block:10000,chain_id:chainId}]));
    await reader.onMessage(statusFrame);
    reader.local_block_num = vectorFile.producer.blockNum - 1;
    await reader.processIncomingBlocks([Buffer.from(captured.hex,'hex')]);
    assert.equal(distributed.length,1);
    assert.equal(distributed[0].content.toString('hex'),captured.hex);
    assert.deepEqual(handshakeCodec.decode('request',requests[0]),['get_status_request_v0',{}]);
    assert.equal(handshakeCodec.decode('request',requests[1])[0],'get_blocks_request_v0');
    assert.deepEqual(handshakeCodec.decode('request',requests[2]),['get_blocks_ack_request_v0',{num_messages:1}]);
    reader.shipRev='v1';
    await reader.processFirstABI(Buffer.from(JSON.stringify(fixture.handshake)));
    await reader.onMessage(statusFrame);
    reader.requestBlockRange(6350,6351);
    const requestV1=handshakeCodec.decode('request',requests.at(-1));
    assert.equal(requestV1[0],'get_blocks_request_v1');
    assert.equal(Number(requestV1[1].fetch_finality_data),0);
    assert(!Object.hasOwn(requestV1[1],'fetch_block_header'));

    const main = new Deserializer(); workers.push(main);
    main.client = frontierMemoryClient().client;
    await main.protocolReady;
    main.protocolSourceBindingStore = sourceStore;
    main.protocolAbiObservationStore = new ProtocolAbiObservationStore(observationMemoryClient().client,chain);
    const originalConfig=main.conf;
    const originalProvider=main.protocol;
    const originalFilters=Object.fromEntries(Object.entries(main.filters).map(([key,value])=>[key,[...value]]));
    const rejectedConfig=structuredClone(config);
    rejectedConfig.settings.protocol={provider:'antelope'};
    rejectedConfig.settings.eosio_alias='wrongalias';rejectedConfig.settings.process_prefix='wrongprefix';
    rejectedConfig.whitelists.actions=['wrong::action'];
    writeFileSync(join(directory,'chain.json'),JSON.stringify(rejectedConfig));
    main.onIpcMessage({event:'reload_config'});
    assert.equal(main.conf,originalConfig);assert.equal(main.configModule.config,originalConfig);
    assert.equal(main.protocol,originalProvider);assert.equal(main.configModule.EOSIO_ALIAS,'sysio');
    assert.equal(main.configModule.proc_prefix,'hyp');
    assert.deepEqual(Object.fromEntries(Object.entries(main.filters).map(([key,value])=>[key,[...value]])),originalFilters);
    assert(events.some(event=>event.event==='config_reloaded' && event.status==='error' && /controlled worker restart/.test(event.message)));
    writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
    await main.initializeProtocolShip(JSON.stringify(fixture.handshake)); main.shipABI = JSON.stringify(fixture.handshake);
    const output = []; const poolMessages = [];
    main.preIndexingQueue = {push:async value=>output.push(value)};
    main.ch_ready = true;
    main.ch = {ack:()=>{},nack:()=>{},sendToQueue:(queue,content,options)=>{poolMessages.push({queue,content,properties:options});return true;}};
    const until = async predicate => { const limit = Date.now()+3000; while(!predicate()) {assert(Date.now()<limit);await new Promise(resolve=>setTimeout(resolve,5));} };
    await until(()=>main.mLoader.parser && main.mLoader.chainMappings.has('*::transfer'));
    const delivery = payload => ({content:payload.content,properties:{headers:payload.headers}});
    const consume=async message=>{main.captureProtocolSourceDelivery(message,main.ch);return main.mLoader.parser.parseMessage(main,[message]);};
    await consume(delivery(distributed[0]));
    assert(output.some(value=>value.queue.includes('index_abis')),'captured binary account ABI did not reach the ABI output');
    const capturedBlock = output.find(value=>value.queue.includes('index_blocks'));
    assert.equal(JSON.parse(capturedBlock.content)['@timestamp'],fixture.expected.block.timestamp);
    output.length = 0; poolMessages.length = 0;
    // Captured and transformed block6350 are independent engineering fixtures,
    // not two competing byte representations in one authoritative journal.
    main.protocolAbiObservationStore = new ProtocolAbiObservationStore(observationMemoryClient().client,chain);
    reader.local_block_num = 6349;
    await reader.onMessage(Buffer.from(fixture.frameHex,'hex'));
    const fixtureDelivery = delivery(distributed.at(-1));
    await consume(fixtureDelivery);
    const blockDocument = JSON.parse(output.find(value=>value.queue.includes('index_blocks')).content);
    assert.equal(blockDocument.cpu_usage,479);
    assert.equal(blockDocument.trx_count,1);
    assert(!Object.hasOwn(blockDocument,'net_usage'),'Wire block invented receipt net usage');
    assert(!Object.hasOwn(blockDocument,'schedule_version'),'Wire block invented a legacy producer schedule');
    assert.deepEqual(blockDocument.protocol.receipts,[{cpu_usage_us:[23,456]}]);
    assert.equal(poolMessages.length,1);
    const tokenAbi = JSON.parse(readFileSync(join(packageRoot,'fixtures/codec/artifacts/7dede884/sysio.token.abi')));
    const selected = await loadChainProtocol(protocol);
    const tokenReference = {account:'sysio.token',block:10,block_id:'a'.repeat(64),protocol_profile:profileId,
        actions:['transfer'],abi_hex:Buffer.from(selected.provider.contractCodec.encodeAbi(tokenAbi)).toString('hex')};
    const complete = references => ({timed_out:false,_shards:{total:1,successful:1,failed:0,skipped:0},hits:{hits:references.map(_source=>({_source}))}});
    const search = async query => {
        const at = query.query.bool.must.find(entry=>entry.range?.block).range.block.lte;
        return complete(at>=10?[tokenReference]:[]);
    };
    const actions = [];
    const pool = Object.assign(Object.create(Pool.prototype),{...selected,protocol:selected.provider,protocolId:selected.id,protocolComponents:selected.components,abieos:selected.decoder,
        chain,chainId,conf:config,profiler:{start:()=>()=>{}},poolAbiCache:new Map(),poolTypeCache:new Map(),loadedActionAbis:new Map(),
        failedAbiMap:new Map(),customAbiMap:new Map(),contracts:new Map(),contractUsage:{},totalHits:0,actionDsCounter:0,act_emit_idx:1,
        client:{...frontierMemoryClient().client,search},protocolDeliveryOwners:new WeakMap(),
        mLoader:main.mLoader,ch_ready:true,ch:{ack(){},sendToQueue:(queue,content)=>{actions.push(JSON.parse(content));return true;}},
        preIndexingQueue:{push:async()=>{}},allowStreaming:false,ioRedisClient:null});
    pool.common = {deserializeActionAtBlockNative:pool.deserializeActionAtBlockNative,attachActionExtras:pool.attachActionExtras};
    for(const message of poolMessages)pool.captureProtocolActionDelivery(message,pool.ch);
    await pool.processMessages(poolMessages);
    assert.equal(actions.length,2);
    for(const action of actions) {
        assert.equal(action.ds_error,true);
        assert.equal(action.act.account,'sysio.token');
        assert.equal(typeof action.act.data,'string','unqualified automatic action decoding was allowed');
        assert.deepEqual(selected.provider.contractCodec.decodeValue(tokenAbi,'transfer',Buffer.from(action.act.data,'hex')),
            {from:'alice',to:'bob',quantity:'12.3400 SYS',memo:'fixture'});
    }
    assert.equal(actions[0].cpu_usage_us,479);
    assert.equal(actions[0].net_usage_words,9);
    main.conf.whitelists.root_only=true;main.conf.whitelists.actions=['sysio.token::transfer'];
    main.filters.action_whitelist=new Set(['sysio.token::transfer']);
    output.length=0;poolMessages.length=0;
    await consume(fixtureDelivery);
    assert.equal(poolMessages.length,1,'root-only filtering dropped a matching direct Wire transaction');
    assert(output.some(value=>value.queue.includes('index_abis')));
    main.filters.action_whitelist=new Set(['other::nomatch']);
    output.length=0;poolMessages.length=0;
    await consume(fixtureDelivery);
    assert.equal(poolMessages.length,0);
    assert(!output.some(value=>value.queue.includes('index_abis')),'root-only filtering processed a nonmatching transaction');
    main.conf.whitelists.root_only=false;main.conf.whitelists.actions=[];main.filters.action_whitelist=new Set();

    const rowAbi = revision => ({version:'sysio::abi/1.3',types:[],structs:[{name:'person',base:'',fields:[
        {name:'id',type:'uint64'},...(revision===2?[{name:'revision',type:'uint8'}]:[]),{name:'memo',type:'string'}]}],
        actions:[],tables:[{name:'People',index_type:'',key_names:[],key_types:[],type:'person',table_id:0,
            secondary_indexes:[{name:'byMemo',key_type:'string',table_id:7}]}],ricardian_clauses:[],error_messages:[],abi_extensions:[],variants:[]});
    const make = (type,value)=>Buffer.from(handshakeCodec.encode(type,value)).toString('hex');
    const rawKey = 'ab'.repeat(1024);
    const accountRow = revision => ({present:1,data:make('account',['account_v0',{name:'hyp.replay',creation_date:'2025-01-01T00:00:00.000',
        abi:Buffer.from(selected.provider.contractCodec.encodeAbi(rowAbi(revision))).toString('hex')}])});
    const primary = (present,revision,key=rawKey)=>({present,data:make('contract_row_kv',['contract_row_kv_v0',{code:'hyp.replay',payer:'alice',table_id:0,
        key,value:present?Buffer.from(selected.provider.contractCodec.encodeValue(rowAbi(revision),'person',{id:'7',...(revision===2?{revision:2}:{}),memo:'complete'})).toString('hex'):''}])});
    const secondary = present=>({present,data:make('contract_index_kv',['contract_index_kv_v0',{code:'hyp.replay',payer:'alice',table_id:7,sec_key:'de'.repeat(600),pri_key:rawKey}])});
    const deltas = (revision,remove=false)=>[
        ['table_delta_v0',{name:'account',rows:[accountRow(revision)]}],
        ['table_delta_v0',{name:'contract_row_kv',rows:[primary(remove?0:1,revision)]}],
        ['table_delta_v0',{name:'contract_index_kv',rows:[secondary(remove?0:1)]}],
    ];
    output.length = 0;
    for(const [block,revision,remove] of [[100,1,false],[101,2,false],[102,2,true]]) {
        await main.processDeltas(deltas(revision,remove),block,'2026-10-19T21:08:19.500',block.toString(16).padStart(64,'0'));
    }
    const histories = output.filter(value=>value.queue.includes('index_deltas')).map(value=>JSON.parse(value.content));
    const dynamics = output.filter(value=>value.queue.includes('index_dynamic'));
    assert.equal(histories.length,6); assert.equal(dynamics.length,6);
    assert.equal(histories[0].protocol.record.keyHex,rawKey);
    assert.equal(histories[1].protocol.record.secondaryKeyHex,'de'.repeat(600));
    assert.equal(histories[1].protocol.record.primaryKeyHex,rawKey);
    assert.equal(histories[2].data.revision,2);
    assert.notEqual(histories[0].protocol.source.abiDeployment,histories[2].protocol.source.abiDeployment);
    assert.equal(histories[4].present,0); assert.equal(histories[5].present,0);
    assert.equal(histories[0].primary_key,histories[4].primary_key);
    const mongoOps = [];
    const mongo = new MongoRoutes({prepareMongoClient(){},chain,conn:{mongodb:{database_prefix:'fixture'}},
        mongodbClient:{db:()=>({collection:name=>({bulkWrite:async(operations,options)=>{mongoOps.push({name,operations,options});return {};}})})}});
    await mongo.routes['dynamic-table'](dynamics.map(value=>({...value,properties:{headers:value.headers}})));
    assert.equal(mongoOps.length,1);
    assert.equal(mongoOps[0].operations.length,6);
    assert.deepEqual(mongoOps[0].operations[0].updateOne.filter,mongoOps[0].operations[4].deleteOne.filter);
    assert.deepEqual(mongoOps[0].operations[1].updateOne.filter,mongoOps[0].operations[5].deleteOne.filter);
    assert.notDeepEqual(mongoOps[0].operations[0].updateOne.filter,mongoOps[0].operations[1].updateOne.filter);
    assert.equal(mongoOps[0].operations[0].updateOne.update.$set['@protocol'].record.keyHex,rawKey);
    const bulks = []; let acknowledged = 0;
    const elastic = new ElasticRoutes({chain,config,ingestClients:[{bulk:async request=>{
        bulks.push(request); return {errors:false,items:request.operations.filter((_,index)=>index%2===0)
            .map(operation=>({index:{_id:operation.index._id,status:201}}))};
    }}]});
    const broker=Object.assign(new EventEmitter(),{ack:()=>acknowledged++,nack:()=>{throw new Error('unexpected nack');}});
    await new Promise(resolve=>elastic.routes.delta(histories.map((body,index)=>({content:Buffer.from(JSON.stringify(body)),fields:{deliveryTag:index+1}})),
        broker,resolve));
    assert.equal(acknowledged,6);
    assert.equal(bulks[0].operations[1].protocol.record.keyHex,rawKey);
    assert(bulks[0].operations.every((value,index)=>index%2 || Buffer.byteLength(value.index._id)<=512));
    assert.equal(new Set(bulks[0].operations.filter((_,index)=>index%2===0).map(value=>value.index._id)).size,6);
    // A failed/rejected ABI load cannot leave a previously valid decoder context behind.
    selected.decoder.loadAbi('rejected',rowAbi(1));
    assert.throws(()=>selected.decoder.loadAbi('rejected','{'));
    assert.throws(()=>selected.decoder.binToJson('rejected','person',new Uint8Array()),/No selected ABI/);
    selected.decoder.loadAbi('rejected',rowAbi(1));
    assert.throws(()=>selected.decoder.loadAbiHex('rejected','ff'));
    assert.throws(()=>selected.decoder.binToJson('rejected','person',new Uint8Array()),/No selected ABI/);
    const rowReference = {account:'hyp.replay',block:100,block_id:'a'.repeat(64),protocol_profile:profileId,
        abi_hex:Buffer.from(selected.provider.contractCodec.encodeAbi(rowAbi(1))).toString('hex')};
    const invalidSelections = [
        {...complete([rowReference]),timed_out:true},
        {...complete([rowReference]),_shards:{total:2,successful:1,failed:1,skipped:0}},
        complete([rowReference,{...rowReference,block_id:'b'.repeat(64)}]),
        complete([{...rowReference,protocol_profile:'wire-sysio-6508c9e8-engineering-v1'}, {...rowReference,block:10}]),
    ];
    for(const response of invalidSelections) {
        main.protocolAbiSelections.clear();main.protocolAbiAtBlock.clear();main.client={search:async()=>response};
        await assert.rejects(main.selectProtocolAbi('hyp.replay',300,'c'.repeat(64)));
        assert.equal(main.protocolAbiSelections.size,0,'unavailable selection poisoned the successful deployment cache');
    }
    main.client={search:async()=>{throw new Error('An ES-latest result cannot prove ABI coverage');}};
    await assert.rejects(main.selectProtocolAbi('hyp.replay',300,'c'.repeat(64)),/Canonical ABI coverage/);
    for(const response of [
        {...complete([tokenReference]),timed_out:true},
        {...complete([tokenReference]),_shards:{total:2,successful:1,failed:1}},
        complete([tokenReference,{...tokenReference,block_id:'d'.repeat(64)}]),
    ]) {
        pool.poolAbiCache.clear();pool.client={search:async()=>response};
        await assert.rejects(pool.fetchAbiHexAtBlockElastic('sysio.token',300,false,0));
        assert.equal(pool.poolAbiCache.size,0);
    }
    pool.poolAbiCache.clear();
    pool.client={search:async()=>complete([{...tokenReference,block:20,protocol_profile:'wire-sysio-6508c9e8-engineering-v1'},tokenReference])};
    assert.deepEqual(await pool.verifyLocalType('sysio.token','transfer',300,'action'),[false,'']);
    const unknown = make('table_delta[]',[['table_delta_v0',{name:'future_required_stream',rows:[]}] ]);
    assert.throws(()=>main.decodeShipValue('table_delta[]',unknown),/Unsupported|unsupported|Unknown|unknown/);
    assert.throws(()=>main.decodeShipValue('signed_block',Buffer.from(fixture.blockHex.slice(0,-2),'hex')));
    const priorCount = events.length;
    const staleAbi={...rowAbi(1),structs:[{name:'person',base:'',fields:[{name:'old_id',type:'uint64'},{name:'memo',type:'string'}]}]};
    let unsafeSearches=0;
    main.client = {search:async()=>{unsafeSearches++;return complete([{...rowReference,
        abi_hex:Buffer.from(selected.provider.contractCodec.encodeAbi(staleAbi)).toString('hex')}]);}};
    output.length = 0;
    await main.processDeltas([['table_delta_v0',{name:'contract_row_kv',rows:[primary(1,1)]}]],200,
        '2026-10-19T21:08:19.500','b'.repeat(64));
    assert(events.slice(priorCount).some(event=>event.event==='ds_error' && event.data.rawHex));
    assert.equal(output.filter(value=>value.queue.includes('index_deltas')).length,0);
    assert.equal(unsafeSearches,0,'historical KV lookup trusted a possibly stale ABI index');
    const badContract = {present:1,data:make('contract_row_kv',['contract_row_kv_v0',{code:'bad.replay',payer:'alice',table_id:0,key:'ff',value:''}])};
    await main.processDeltas([
        ['table_delta_v0',{name:'account',rows:[accountRow(1)]}],
        ['table_delta_v0',{name:'contract_row_kv',rows:[badContract,primary(1,1,'cd')]}],
    ],201,'2026-10-19T21:08:19.500','c'.repeat(64));
    assert.equal(output.filter(value=>value.queue.includes('index_deltas')).length,1,'a failed contract stopped an unrelated valid row');
    for(const [block,abiHex] of [[202,''],[203,'ff']]) {
        output.length=0;
        const barrier={present:1,data:make('account',['account_v0',{name:'hyp.replay',creation_date:'2025-01-01T00:00:00.000',abi:abiHex}])};
        await main.processDeltas([
            ['table_delta_v0',{name:'account',rows:[barrier]}],
            ['table_delta_v0',{name:'contract_row_kv',rows:[primary(1,1)]}],
        ],block,'2026-10-19T21:08:19.500','d'.repeat(64));
        const indexed=JSON.parse(output.find(value=>value.queue.includes('index_abis')).content);
        assert.equal(indexed.abi_available,false);assert.equal(indexed.abi_hex,abiHex);
        assert(indexed.abi_error);assert.equal(output.filter(value=>value.queue.includes('index_deltas')).length,0);
        main.protocolAbiAtBlock.clear();main.protocolAbiSelections.clear();
        main.client={search:async()=>complete([indexed,rowReference])};
        await assert.rejects(main.selectProtocolAbi('hyp.replay',block+1,'e'.repeat(64)));
    }
    console.log(JSON.stringify({passed:true,capturedFrame:true,syntheticConsensus:false,readerRequests:requests.length,actions:actions.length,
        histories:histories.length,stateOperations:mongoOps[0].operations.length,legacyAddonImported:false}));
} finally {
    for(const worker of workers) {worker.shipSession?.close?.();worker.profiler?.stopReporting();}
    process.send = originalSend;
    process.chdir(previous); rmSync(directory,{recursive:true,force:true});
}
