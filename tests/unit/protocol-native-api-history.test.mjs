import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerHooks} from 'node:module';
import {nativeApiWireSource, STATEFUL_EXPLORER_API_SOURCE_PROFILE} from './protocol-native-api-source.mjs';
registerHooks({resolve(specifier, context, next) {
    if (specifier.includes('node-abieos')) throw new Error('Native API imported the legacy addon');
    if (specifier === 'uWebSockets.js') return {url: 'data:text/javascript,export const App=()=>{};', shortCircuit: true};
    return next(specifier, context);
}});
const {ProtocolActionConsumer} = await import('../../build/api/helpers/protocol-abi.js');
const history = {interfaceVersion:1,maxCommitsPerDrain:16,maxCommitBytesPerDrain:8388608,maxMillisecondsPerDrain:1000};
const configHistory = {interface_version:1,max_commits_per_drain:16,max_commit_bytes_per_drain:8388608,max_ms_per_drain:1000};
const result = rows => ({took:1,timed_out:false,_shards:{total:1,successful:1,failed:0,skipped:0},hits:{total:{value:rows.length,relation:'eq'},hits:rows.map(row=>({_source:structuredClone(row)}))}});
async function host(source, row, enabled) {
    const app=Fastify({logger:false}), cache=new Map();
    const settings={protocol:{provider:'extension',package:'@eosrio/hyperion-wire-plugin',profileId:source.provider.profileId},es_replicas:0,index_partition_size:10000,index_version:'v1'};
    if(enabled) settings.protocol_abi_coordination={historical_certificates:configHistory};
    app.decorate('manager',{chain:source.chain,conn:{chains:{[source.chain]:{chain_id:source.chainId}}},readIndexset:()=>source.chain+'-action-*',config:{settings,api:{enable_caching:false,cache_life:60,query_timeout:'10s',limits:{get_actions:100,get_trx_actions:100},stream_scroll_batch:100}}});
    app.decorate('elastic',{...source.client,async search(query){
        if(query.index===source.chain+'-block-*') {const block=source.retained.get(row.block_num);return result([{block_num:row.block_num,block_id:row.block_id,prev_id:block.source.previousBlockId,'@timestamp':row['@timestamp'],producer:row.producer}]);}
        assert.equal(query.index,source.chain+'-action-*');return result([row]);
    }});
    app.decorate('redis',{get:async key=>cache.get(key)??null,set:async()=> 'OK',hgetall:async()=>({}),ttl:async()=>60});
    app.decorate('antelope',{chain:{get_info:async()=>({last_irreversible_block_num:{valueOf:()=>999,toNumber:()=>999}})},getAbi:async()=>{throw new Error('head ABI prohibited');}});
    app.decorate('allowedActionQueryParamSet',new Set());app.decorate('protocolActionConsumer',new ProtocolActionConsumer(app,source.selected));
    for(const [path,prefix] of [['v2-history/get_actions','/v2/history'],['v2-history/get_transaction','/v2/history'],['v1-trace/get_block','/v1/trace_api']]) {
        const {default:register}=await import('../../build/api/routes/'+path+'/index.js');await app.register(register,{prefix});
    }
    await app.ready();return app;
}
test('explicit historical source permits API actions, transaction, and trace beyond the unchanged 256 window', {timeout:180000},async()=>{
    const source=await nativeApiWireSource({engineeringSourceProfile:STATEFUL_EXPLORER_API_SOURCE_PROFILE},history);
    let off,on,wrongSource,wrongEpoch;
    try {
        await source.appendUntil(2);const row=await source.action(2);await source.appendUntil(259);
        for(let i=0;i<50;i++){await source.coordinator.drain();if((await source.coordinator.inspect()).historical)break;}
        off=await host(source,row,false);on=await host(source,row,true);
        const requests=[{method:'GET',url:'/v2/history/get_actions?hydrate=false'},{method:'GET',url:'/v2/history/get_transaction?id='+row.trx_id+'&hydrate=false'},{method:'POST',url:'/v1/trace_api/get_block',payload:{block_num:2}}];
        for(const request of requests){const red=await off.inject(request);assert.equal(red.statusCode,503,red.body);assert.equal(red.json().code,'ancestry_unavailable');const green=await on.inject(request);assert.equal(green.statusCode,200,green.body);}
        const forked=structuredClone(row);forked.protocol.source.blockId='f'.repeat(64);
        wrongSource=await host(source,forked,true);
        const forkResponse=await wrongSource.inject(requests[0]);assert.equal(forkResponse.statusCode,503,forkResponse.body);
        const wrong=structuredClone(row);wrong.protocol.selectionId='h45srcsel1:'+'f'.repeat(64);
        wrongEpoch=await host(source,wrong,true);
        const epochResponse=await wrongEpoch.inject(requests[0]);assert.equal(epochResponse.statusCode,503,epochResponse.body);
        const retained=source.retained.get(2), reader=on.protocolActionConsumer.reader;
        const abort=new AbortController();abort.abort();
        await assert.rejects(reader.open(retained.source,retained.selectionId,{signal:abort.signal}), error=>error.statusCode===503);
        await assert.rejects(reader.open({...retained.source,blockId:'f'.repeat(64)},retained.selectionId),error=>error.statusCode===503);
        await source.coordinator.revokeSource('native-api-original-reader');
        for(const request of requests){const denied=await on.inject(request);assert.equal(denied.statusCode,503,denied.body);}
        const {ProtocolAbiCoordinator}=await import('../../build/indexer/protocol/abi-coordinator.js');
        const replacement=new ProtocolAbiCoordinator({chainId:source.chainId,profile:source.profile,ownerId:'replacement-api-history-owner',
            bindings:source.bindings,observations:source.observations,store:source.frontier,historicalCertificates:history,
            verifyNativeGenesis:source.provider.verifyNativeGenesis.bind(source.provider),nativeActionInterfaceVersion:1});
        await replacement.start();
        const staleOwner=await on.inject(requests[0]);assert.equal(staleOwner.statusCode,503,staleOwner.body);
    } finally {await off?.close();await on?.close();await wrongSource?.close();await wrongEpoch?.close();await source.dispose();}
});
