import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8')),directory=mkdtempSync(join(tmpdir(),'h45-historical-main-'));
const history={interface_version:1,max_commits_per_drain:4,max_commit_bytes_per_drain:1048576,max_ms_per_drain:1000,allow_pending_work:true};
const config={settings:{chain:input.chain,parser:'3.2',index_version:'v1',index_partition_size:10000,es_replicas:0,
    protocol_abi_history:input.configuration,protocol_abi_coordination:{historical_certificates:history}},indexer:{},
    features:{streaming:{deltas:false,traces:false},tables:{}},scaling:{ds_pool_size:1,indexing_queues:1,ad_idx_queues:1,dyn_idx_queues:1},
    prefetch:{read:1,block:1,index:1},plugins:{},whitelists:{actions:[],deltas:[]}};
mkdirSync(join(directory,'config'));writeFileSync(join(directory,'chain.json'),JSON.stringify(config));
writeFileSync(join(directory,'config/connections.json'),'{}');process.env.CONFIG_JSON=join(directory,'chain.json');process.chdir(directory);
const {default:MainDS}=await import('../../build/indexer/workers/deserializer.js');
const {ProofConsumerScope}=await import('../../build/indexer/protocol/proof-consumer-scope.js');
const {DiskAbiHistoryCatalog}=await import('../../build/indexer/protocol/disk-abi-history.js');
const memory=frontierMemoryClient();for(const name of ['documents','mappings','settings','sequences'])for(const[key,value]of input[name])memory[name].set(key,value);
function worker(configuration){const value=Object.create(MainDS.prototype);for(const[key,item]of Object.entries({conf:configuration,chain:input.chain,
    chainId:input.chainId,client:memory.client,protocolId:input.profile.id,protocolComponents:input.profile.components,protocol:{profileId:input.profile.profileId},
    diskAbiHistoryConfiguration:input.configuration}))Object.defineProperty(value,key,{value:item,writable:true});return value;}
try{
    const accepted=worker(config);await new ProofConsumerScope('historical-main-ds').run(async()=>{
        const reader=accepted.getProtocolAbiProofReader(),view=await reader.open(input.source,input.selectionId);
        assert.equal((await reader.action(view,input.action)).state.abiHex,'bb');});
    const legacy=worker({...config,settings:{...config.settings,protocol_abi_coordination:undefined}});
    await assert.rejects(new ProofConsumerScope('historical-main-ds-disabled').run(()=>legacy.getProtocolAbiProofReader().open(input.source,input.selectionId)),
        error=>error.code==='ancestry_unavailable');
    assert.equal(memory.calls.some(call=>['create','createIndex','index'].includes(call.method)),false);
    console.log(JSON.stringify({passed:true,actualMainDSReader:true,default256Retained:true,historicalOpenBeyond256:true,readOnly:true,node:process.version}));
}finally{await DiskAbiHistoryCatalog.fromConfiguration(input.configuration,input.chainId,input.profile).close();}
