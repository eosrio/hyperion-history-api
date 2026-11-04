import test from 'node:test';
import assert from 'node:assert/strict';
import {observe,validateInput,classifyReference} from '../../scripts/qualification/wire-genesis-preview-preflight.mjs';
import {resolve} from 'node:path';
const id='1'.repeat(64),sel='h45srcsel1:'+'2'.repeat(64),sha='3'.repeat(64);
const config={settings:{chain:'wire',protocol:{provider:'extension',package:'example',profileId:'example'},protocol_abi_coordination:{
    source_namespace:'candidate',retained_genesis:{schema_path:resolve('schema'),schema_sha256:sha,frame_path:resolve('one'),frame_sha256:sha,
        block_two_path:resolve('two'),block_two_sha256:sha},historical_certificates:{interface_version:1,max_commits_per_drain:1,
            max_commit_bytes_per_drain:1024,max_ms_per_drain:1}}},indexer:{live_reader:true}};
test('preview preflight refuses malformed source configuration and references',()=>{
    assert.equal(validateInput(config,id).namespace,'wire-psrc-candidate');
    assert.throws(()=>validateInput({...config,indexer:{live_reader:false}},id));
    assert.throws(()=>validateInput(config,'bad'));
    assert.equal(classifyReference({selectionId:'bad'}),null);
});
test('read-only observation reports index and alias collisions and separates proof outcomes',async()=>{
    const requests=[],metadata={selectionId:sel,source:{chainId:id,blockNum:4,blockId:'4'.repeat(64)}};
    const transport=async(url,options)=>{requests.push({path:url.pathname,method:options.method});
        const value=url.pathname==='/_cat/indices'?[{index:'wire-action-v1-1'},{index:'wire-psrc-candidate-protocol-abi-frontier-v1'}]:
            url.pathname==='/_alias'?{'wire-action-v1-1':{aliases:{'wire-psrc-candidate-alias':{}}},
                'existing-stream':{aliases:{'wire-psrc-candidate-stream-alias':{}}}}:
            url.pathname==='/_data_stream'?{data_streams:[{name:'wire-psrc-candidate-stream',indices:[{index_name:'.ds-wire-psrc-candidate-stream-000001'}]}]}:
                {timed_out:false,_shards:{failed:0},hits:{total:{value:2,relation:'eq'},hits:[{_source:{protocol:metadata}},{_source:{}}]}};
        return new Response(JSON.stringify(value));};
    const result=await observe({config,chainId:id,endpoint:'http://127.0.0.1:9200',transport,
        protocolLoader:async()=>({id:'x',provider:{profileId:'y'},components:[]}),clientFactory:()=>({close:async()=>{}}),
        readerFactory:namespace=>({open:async()=>{if(namespace!=='wire')throw new Error('not re-established');}})});
    assert.deepEqual(requests.map(x=>x.method),['GET','GET','GET','POST']);
    assert.equal(result.activationAuthority,false);assert.equal(result.historyTotal,2);assert.equal(result.sampled.length,2);
    assert.deepEqual(result.sampled[0],{selectionId:sel,blockNum:4,legacyNamespaceProofUnderCandidateProfile:'verified',newNamespaceProofUnderCandidateProfile:'unavailable'});
    assert.equal(result.sampled[1].classification,'missing_or_malformed');
    assert.deepEqual(result.namespaceCollisions,['wire-psrc-candidate-alias','wire-psrc-candidate-protocol-abi-frontier-v1',
        'wire-psrc-candidate-stream','wire-psrc-candidate-stream-alias']);
    await assert.rejects(observe({config,chainId:id,endpoint:'http://user:secret@127.0.0.1:9200',transport}),/without credentials/);
});
test('absence of discoverable history remains unknown and does not become empty or ready',async()=>{
    const methods=[];
    const result=await observe({config,chainId:id,endpoint:'http://127.0.0.1:9200',
        transport:async(url,options)=>{methods.push(options.method);return new Response(JSON.stringify(url.pathname==='/_alias'?{}:
            url.pathname==='/_data_stream'?{data_streams:[]}:[]));},
        protocolLoader:async()=>({id:'x',provider:{profileId:'y'},components:[]}),clientFactory:()=>({close:async()=>{}}),
        readerFactory:()=>({open:async()=>{throw new Error('unexpected');}})});
    assert.deepEqual(methods,['GET','GET','GET']);assert.equal(result.historyTotal,null);
    assert.equal(result.activationAuthority,false);assert.deepEqual(result.sampled,[]);
});
test('data-stream inventory authorization failures refuse the entire observation',async()=>{
    const transport=async url=>url.pathname==='/_data_stream'?new Response('{}',{status:403}):
        new Response(JSON.stringify(url.pathname==='/_alias'?{}:[]));
    await assert.rejects(observe({config,chainId:id,endpoint:'http://127.0.0.1:9200',transport}),/HTTP 403/);
});
