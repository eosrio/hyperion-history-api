#!/usr/bin/env node
/** Read-only engineering observation. No result of this program grants activation authority. */
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@elastic/elasticsearch';
import {protocolSourceNamespace} from '../../build/indexer/protocol/source-namespace.js';
import {ProtocolAbiFrontierStore} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiProofReader} from '../../build/indexer/protocol/abi-proof.js';
import {loadChainProtocol} from '../../build/indexer/protocol/selection.js';
import {loadRetainedGenesisInput} from '../../build/indexer/protocol/retained-genesis-input.js';

const hex=/^[0-9a-f]{64}$/;
const selection=/^h45srcsel1:[0-9a-f]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceSuffixes=['protocol-abi-frontier-v1','protocol-abi-frontier-records-v1','protocol-source-bindings-v1',
    'protocol-abi-observations-v1','protocol-native-actions-v1'];
export function validateInput(config,chainId) {
    const chain=config?.settings?.chain,opts=config?.settings?.protocol_abi_coordination,cap=opts?.retained_genesis;
    if(typeof chain!=='string'||!opts?.source_namespace||!hex.test(chainId)||config?.settings?.protocol?.provider!=='extension'
        ||config?.indexer?.live_reader!==true||!cap||!opts.historical_certificates)throw new Error('Explicit preview source configuration is incomplete');
    for(const name of ['schema','frame','block_two'])if(!isAbsolute(cap[name+'_path']??'')||!hex.test(cap[name+'_sha256']??''))
        throw new Error('Captured input path or pin is invalid');
    const history=opts.historical_certificates;
    if(history.interface_version!==1||!Number.isSafeInteger(history.max_commits_per_drain)||history.max_commits_per_drain<1||history.max_commits_per_drain>256
        ||!Number.isSafeInteger(history.max_commit_bytes_per_drain)||history.max_commit_bytes_per_drain<1024||history.max_commit_bytes_per_drain>128*1024*1024
        ||!Number.isSafeInteger(history.max_ms_per_drain)||history.max_ms_per_drain<1||history.max_ms_per_drain>30000)
        throw new Error('Historical certificate budget is invalid');
    const namespace=protocolSourceNamespace(chain,opts.source_namespace);
    return {chain,chainId,namespace,expectedNames:sourceSuffixes.map(suffix=>namespace+'-'+suffix)};
}
export function classifyReference(metadata) {
    if(!metadata||typeof metadata!=='object'||!selection.test(metadata.selectionId??'')||!metadata.source
        ||!hex.test(metadata.source.chainId??'')||!Number.isSafeInteger(metadata.source.blockNum)||metadata.source.blockNum<1
        ||!hex.test(metadata.source.blockId??''))return null;
    return {selectionId:metadata.selectionId,source:metadata.source};
}
async function boundedJson(response) {
    if(!response.ok)throw new Error(`Elasticsearch read returned HTTP ${response.status}`);
    const reader=response.body?.getReader();if(!reader)throw new Error('Elasticsearch response has no stream');
    const chunks=[];let size=0;
    for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>4*1024*1024){await reader.cancel();throw new Error('Elasticsearch response exceeds bound');}chunks.push(item.value);}
    return JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString('utf8'));
}
export async function observe({config,chainId,endpoint,apiKey,basicAuth,transport=fetch,clientFactory=options=>new Client(options),
    protocolLoader=loadChainProtocol,readerFactory}) {
    const input=validateInput(config,chainId),url=new URL(endpoint);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
        throw new Error('Elasticsearch endpoint must be an origin without credentials');
    const auth=apiKey?{apiKey}:basicAuth?{username:basicAuth.username,password:basicAuth.password}:undefined;
    const headers=apiKey?{authorization:`ApiKey ${apiKey}`}:basicAuth?{authorization:'Basic '+Buffer.from(basicAuth.username+':'+basicAuth.password).toString('base64')}:{};
    const read=async(path,body)=>boundedJson(await transport(new URL(path,url),{
        method:body?'POST':'GET',headers:body?{...headers,'content-type':'application/json'}:headers,
        ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10000)}));
    const indices=await read('/_cat/indices?format=json&h=index&expand_wildcards=all');
    const aliases=await read('/_cat/aliases?format=json&h=alias,index&expand_wildcards=all');
    if(!Array.isArray(indices)||!Array.isArray(aliases)||indices.length>5000||aliases.length>5000)throw new Error('Index or alias inventory is invalid or exceeds bound');
    const names=indices.map(row=>row.index),aliasNames=aliases.map(row=>row.alias);
    if(names.some(name=>typeof name!=='string')||aliasNames.some(name=>typeof name!=='string')||aliases.some(row=>typeof row.index!=='string'))
        throw new Error('Index or alias inventory is malformed');
    const collisions=[...new Set([...names,...aliasNames].filter(name=>name===input.namespace||name.startsWith(input.namespace+'-')))].sort();
    const actionIndices=names.filter(name=>name.startsWith(input.chain+'-action-')).sort();
    const actionAliases=[...new Set(aliasNames.filter(name=>name.startsWith(input.chain+'-action-')))].sort();
    const actionTargets=[...new Set([...actionIndices,...actionAliases])];
    if(actionTargets.length>128)throw new Error('History index inventory exceeds bound');
    let total=null,hits=[];
    if(actionTargets.length){const result=await read('/'+actionTargets.map(encodeURIComponent).join(',')+'/_search',
        {size:20,sort:['_doc'],track_total_hits:true,_source:['protocol'],query:{match_all:{}}});
        if(result?.timed_out!==false||result?._shards?.failed!==0||!Array.isArray(result?.hits?.hits)||result.hits.hits.length>20||!Number.isSafeInteger(result.hits.total?.value)
            ||result.hits.total.relation!=='eq')throw new Error('History sample response is incomplete');
        total=result.hits.total.value;hits=result.hits.hits;}
    const selected=await protocolLoader(config.settings.protocol,{sourceEvidence:true});
    const profile={id:selected.id,profileId:selected.provider.profileId,components:selected.components??[]};
    const client=clientFactory({node:url.origin,...(auth?{auth}:{}),requestTimeout:10000,maxRetries:0});
    const make=readerFactory??(namespace=>new ProtocolAbiProofReader({chainId,profile,historicalCertificates:true,
        store:new ProtocolAbiFrontierStore(client,namespace,0,{readOnly:true})}));
    const old=make(input.chain),fresh=make(input.namespace),sample=[],deadline=performance.now()+30000;
    try {for(const hit of hits){const ref=classifyReference(hit?._source?.protocol);
        if(!ref||ref.source.chainId!==chainId){sample.push({classification:'missing_or_malformed'});continue;}
        const check=async reader=>{const remaining=Math.floor(deadline-performance.now());if(remaining<1)return 'not_checked_deadline';
            try{await reader.open(ref.source,ref.selectionId,{signal:AbortSignal.timeout(Math.min(remaining,5000))});return 'verified';}
            catch{return 'unavailable';}};
        const legacy=await check(old),candidate=collisions.length?await check(fresh):'namespace_absent';
        sample.push({selectionId:ref.selectionId,blockNum:ref.source.blockNum,legacyProof:legacy,newNamespaceProof:candidate});
    }} finally {await client.close();}
    return {schemaVersion:1,observedAt:new Date().toISOString(),chain:input.chain,chainId,sourceNamespace:input.namespace,
        expectedSourceIndices:input.expectedNames,indexNames:names.sort(),aliases:aliases.map(row=>({alias:row.alias,index:row.index})),namespaceCollisions:collisions,
        historyActionIndices:actionIndices,historyActionAliases:actionAliases,historyTotal:total,
        sampleLimit:20,proofBudgetMs:30000,sampled:sample,
        scope:'bounded_sample_only_non_snapshot',publisherConfirmationIsConsumerAck:false,activationAuthority:false};
}
async function main(){
    const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--config'||args[2]!=='--connections')
        throw new Error('Usage: --config <absolute JSON> --connections <absolute JSON>');
    const readInput=path=>{if(!isAbsolute(path)||statSync(path).size>1024*1024)throw new Error('Configuration path or size invalid');return readFileSync(path);};
    const bytes=readInput(args[1]),connectionBytes=readInput(args[3]);
    const config=JSON.parse(bytes.toString('utf8')),connections=JSON.parse(connectionBytes.toString('utf8'));
    const chainId=connections?.chains?.[config?.settings?.chain]?.chain_id,es=connections?.elasticsearch;
    validateInput(config,chainId);
    loadRetainedGenesisInput(config.settings.protocol_abi_coordination.retained_genesis);
    if(!es||typeof es.host!=='string'||!es.host.length||typeof (es.protocol??'http')!=='string')throw new Error('Configured Elasticsearch endpoint is invalid');
    const endpoint=(es.protocol||'http')+'://'+es.host;
    const basicAuth=typeof es.user==='string'&&es.user.length?{username:es.user,password:typeof es.pass==='string'?es.pass:''}:undefined;
    const result=await observe({config,chainId,endpoint,basicAuth,apiKey:process.env.HYPERION_PREFLIGHT_ES_API_KEY});
    console.log(JSON.stringify({...result,configSha256:digest(bytes),connectionsSha256:digest(connectionBytes),sourceFilesMatchPins:true,
        rpcAndNativeGenesisPreflight:'not_run'},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error=>{console.error(JSON.stringify({status:'REFUSED',reason:String(error?.message??error).slice(0,1024),activationAuthority:false}));process.exitCode=1;});
