import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepared,schemaJson,frames} from './portable-state-source-fixture.mjs';
const configuration=JSON.parse(readFileSync(process.argv[2],'utf8')),p=await prepared(),directory=mkdtempSync(join(tmpdir(),'h45-disk-worker-'));
const config={settings:{chain:p.options.chain,parser:'3.2',protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:p.options.profile.profileId},
    index_version:'v1',index_partition_size:10000,es_replicas:0,protocol_abi_history:configuration},
    indexer:{fetch_block:true,fetch_traces:true,fetch_deltas:true,process_deltas:true,disable_indexing:false},
    features:{index_all_deltas:true,index_deltas:true,index_deltas_deletions:true,streaming:{deltas:false,traces:false},tables:{},failed_trx:false},
    scaling:{ds_pool_size:1,indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{actions:[],deltas:[]}};
mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
writeFileSync(join(directory,'config/connections.json'),JSON.stringify({}));process.env.CONFIG_JSON=join(directory,'chain.json');process.chdir(directory);
const {default:Reader}=await import('../../build/indexer/workers/state-reader.js');
const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
const {DiskAbiHistoryCatalog}=await import('../../build/indexer/protocol/disk-abi-history.js');
const {ProofConsumerScope}=await import('../../build/indexer/protocol/proof-consumer-scope.js');
const catalog=DiskAbiHistoryCatalog.fromConfiguration(configuration,p.options.chainId,p.options.profile);
const own=(target,values)=>{for(const[key,value]of Object.entries(values))Object.defineProperty(target,key,{value,writable:true,configurable:true});return target;};
const session=p.options.provider.createShipSession(JSON.parse(schemaJson));
try{
    const result=session.decodeResult(frames[1])[1],context=await p.bindings.readContext(p.contextId);
    const reader=own(Object.create(Reader.prototype),{chainId:p.options.chainId,protocolId:p.options.profile.id,protocol:p.options.provider,
        protocolComponents:p.options.profile.components,diskAbiHistoryConfiguration:configuration,
        sourceContext:{...context,id:p.contextId,readerSessionId:'fixture-source',generation:1},verifiedReaderSessionId:'fixture-source',
        protocolSourceBindingStore:p.bindings,isLiveReader:true,profiler:{start:()=>()=>{}},assertCurrentIngress(){},
        admitCoordinatorSelection(){throw new Error('Covered source reached live coordinator');}});
    const headers=await reader.bindProtocolSource(result,frames[1]),selected=headers['hyperion-source-selection-v1'];
    const worker=own(Object.create(MainDS.prototype),{chainId:p.options.chainId,chain:p.options.chain,client:p.options.client,protocol:p.options.provider,
        protocolId:p.options.profile.id,protocolComponents:p.options.profile.components,conf:config,diskAbiHistoryConfiguration:configuration,
        protocolAbiObservationStore:p.observations,protocolSourceBindingStore:p.bindings,activeSourceSelectionId:selected,activeProtocolShipSchemaJson:schemaJson,
        activeSourceRole:'bulk',usesProtocolSourceBindings:true,usesExtensionProtocol:true,assertWorkerAttemptActive(){},profiler:{start:()=>()=>{}},
        decodeShipValue:(type,raw)=>{const bytes=typeof raw==='string'?Buffer.from(raw,'hex'):raw;
            return type==='transaction_trace[]'?session.decodeTraces(bytes):type==='table_delta[]'?session.decodeDeltas(bytes):session.decodeRow(type,bytes);}});
    await new ProofConsumerScope('disk-abi-history-worker').run(()=>worker.prepareProtocolAbiObservations(result));
    assert.equal(worker.activeProtocolAbiProofView.source.blockId,p.positions[1].blockId);
    assert.equal((await p.bindings.readPublishedSource(p.options.chainId,p.positions[1].blockId)).selectionId,selected);
    console.log(JSON.stringify({passed:true,actualReaderMethod:true,actualMainDSMethod:true,liveAdmissionBypassed:true,rawPublicationDurable:true}));
}finally{session.close?.();await catalog.close();}
