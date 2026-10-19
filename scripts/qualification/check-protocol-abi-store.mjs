import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Client} from '@elastic/elasticsearch';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';

// Own the exact server and namespace; this runner never accepts a borrowed cluster URL.
const image='docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
const run=randomUUID().replaceAll('-','').slice(0,12),name=`hyp-abi-observation-${run}`;
const clusterName=`hyperion-abi-observation-${run}`,network=`${name}-net`;
const label='io.eosrio.qualifier=protocol-abi-observation',runLabel=`io.eosrio.run=${run}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024}).trim();
const inspect=target=>JSON.parse(docker(['inspect',target]))[0];
const checkOwner=value=>{
    const labels=value.Config?.Labels??value.Labels;
    assert.equal(labels?.['io.eosrio.qualifier'],'protocol-abi-observation');assert.equal(labels?.['io.eosrio.run'],run);
};
const output=process.argv[2];if(process.argv.length>3)throw new Error('Usage: node check-protocol-abi-store.mjs [output.json]');
let containerId,networkCreated=false,client;
const report={schemaVersion:1,status:'running',createdAt:new Date().toISOString(),run,image,checks:[],cleanup:{container:false,network:false},qualification:false};
try {
    docker(['network','create','--label',label,'--label',runLabel,network]);networkCreated=true;
    containerId=docker(['run','-d','--name',name,'--network',network,'--label',label,'--label',runLabel,
        '--cpus','2','--memory','2g','-p','127.0.0.1::9200',
        '--tmpfs','/usr/share/elasticsearch/data:rw,uid=1000,gid=0,size=268435456',
        '-e','discovery.type=single-node','-e',`cluster.name=${clusterName}`,
        '-e','xpack.security.enabled=false','-e','xpack.security.autoconfiguration.enabled=false',
        '-e','xpack.ml.enabled=false','-e','ingest.geoip.downloader.enabled=false','-e','ES_JAVA_OPTS=-Xms512m -Xmx512m',image]);
    const owned=inspect(containerId);checkOwner(owned);assert.equal(owned.Id,containerId);assert.equal(owned.Config.Image,image);
    const ports=owned.NetworkSettings.Ports['9200/tcp'];assert.equal(ports.length,1);assert.equal(ports[0].HostIp,'127.0.0.1');
    const port=Number(ports[0].HostPort);assert(Number.isInteger(port)&&port>1024&&port!==9200);
    const url=`http://127.0.0.1:${port}`;
    client=new Client({node:url,requestTimeout:5000,maxRetries:0});
    let info;const deadline=Date.now()+90000;
    while(Date.now()<deadline){try{info=await client.info();break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}
    assert.equal(info?.version?.number,'9.5.5');assert.equal(info.cluster_name,clusterName);assert.match(info.cluster_uuid,/^[A-Za-z0-9_-]{16,64}$/);
    report.server={version:info.version.number,clusterName,clusterUuid:info.cluster_uuid};
    const chain=`hyp-abiobs-${run}`,store=new ProtocolAbiObservationStore(client,chain,0,{chunkBytes:256,maximumBytes:32768,maximumChunks:128});
    const record=block=>{const input={schemaVersion:1,protocol:{id:'synthetic-wire-observer',profileId:'serialization-only',components:[
        {id:'fixture-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]},
        source:{chainId:'1'.repeat(64),blockNum:block,blockId:block.toString(16).padStart(64,'0'),previousBlockId:(block-1).toString(16).padStart(64,'0'),inputSha256:'4'.repeat(64)},
        capture:{kind:'unattested-ship-result-sections-v1',schemaJson:'{}',blockHex:'00',tracesHex:'00',deltasHex:'00'},
        observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[],deployments:[{account:'alice',abiHex:''},{account:'bob',abiHex:'ff'}],finalStates:[]}}};
        const {inputSha256,...position}=input.source;input.source.inputSha256=protocolAbiCaptureDigest(position,input.capture);return input;};
    const first=record(100);const prepared=await store.prepare(first);assert.deepEqual(await store.read(prepared.id),first);
    const initialSettings=(await client.indices.getSettings({index:store.index,flat_settings:true,include_defaults:true}))[store.index];
    report.retentionSettings=Object.fromEntries(['index.translog.durability','index.mapping.source.mode','index.default_pipeline',
        'index.final_pipeline','index.number_of_replicas','index.number_of_shards'].map(key=>[key,initialSettings.settings?.[key]??initialSettings.defaults?.[key]]));
    assert.deepEqual(await new ProtocolAbiObservationStore(client,chain,0,{chunkBytes:256,maximumBytes:32768,maximumChunks:128}).prepare(first),prepared);
    report.checks.push('real create/getsettings/mapping/copy receipts','existing-index detection and identical CAS redelivery');

    // Only this owned projection index is changed; automatic refresh stays disabled for the visibility case.
    await client.indices.putSettings({index:store.index,settings:{refresh_interval:'-1'}});
    const second=record(101);const unrefreshed=await store.prepare(second);
    const hidden=await client.search({index:store.index,query:{ids:{values:[unrefreshed.id]}},size:1});
    assert.equal(hidden.timed_out,false);assert.equal(hidden._shards.failed,0);assert.equal(hidden.hits.hits.length,0);
    assert.deepEqual(await store.read(unrefreshed.id),second);report.checks.push('realtime manifest/chunk GET before search visibility');
    const conflict=structuredClone(second);conflict.observation={status:'incomplete',error:{code:'conflict',message:'Changed derived observations'}};
    await assert.rejects(store.prepare(conflict),/Immutable.*conflict/);assert.deepEqual(await store.read(unrefreshed.id),second);
    report.checks.push('immutable derived-facts conflict within one capture');

    const partial=record(102);let injected=true;
    const faultClient=new Proxy(client,{get(target,key){
        if(key==='create')return async request=>{if(injected&&request.document.chunk_index===1)throw new Error('injected chunk failure');return target.create(request);};
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const partialStore=new ProtocolAbiObservationStore(faultClient,chain,0,{chunkBytes:256,maximumBytes:32768,maximumChunks:128});
    await assert.rejects(partialStore.prepare(partial),/injected chunk failure/);injected=false;
    const repaired=await partialStore.prepare(partial);assert.deepEqual(await store.read(repaired.id),partial);
    report.checks.push('partial chunk failure and restart-style identical repair');

    await client.indices.putSettings({index:store.index,settings:{'translog.durability':'async'}});
    try{await assert.rejects(store.prepare(record(103)),/durability/);}finally{
        await client.indices.putSettings({index:store.index,settings:{'translog.durability':'request'}});
    }
    report.checks.push('unsafe dedicated-index durability refusal');
    const filteredStore=new ProtocolAbiObservationStore(client,`${chain}-filtered`,0);
    const mappings=await client.indices.getMapping({index:store.index});
    await client.indices.create({index:filteredStore.index,settings:{number_of_shards:1,number_of_replicas:0,
        'translog.durability':'request',auto_expand_replicas:'false'},
        mappings:{...mappings[store.index].mappings,_source:{excludes:['payload']}}});
    await assert.rejects(filteredStore.prepare(record(104)),/incompatible/);
    assert.equal((await client.count({index:filteredStore.index})).count,0);
    report.checks.push('real mapping source-filter retention refusal before writes');
    const pipeline=`${chain}-prune`;
    await client.ingest.putPipeline({id:pipeline,processors:[{remove:{field:'payload',ignore_missing:true}}]});
    for(const setting of ['default_pipeline','final_pipeline']) {
        await client.indices.putSettings({index:store.index,settings:{[setting]:pipeline}});
        try {await assert.rejects(store.prepare(record(105)),/retention/);} finally {
            await client.indices.putSettings({index:store.index,settings:{[setting]:'_none'}});
        }
    }
    report.checks.push('real default/final ingest pipeline retention refusal');
    report.status='passed';
} catch(error){report.status='failed';report.error=String(error.stack??error);}
finally {
    try {await client?.close();} catch(error){report.clientCloseError=String(error.stack??error);report.status='failed';}
    try {
        // Name is generated by this process; verify every identity/label before removal.
        const inventory=docker(['ps','-aq','--filter',`name=^/${name}$`]).split('\n').filter(Boolean);
        const values=inventory.length?JSON.parse(docker(['inspect',name])):[];
        if(values.length){assert.equal(values.length,1);const owned=values[0];checkOwner(owned);
            if(containerId)assert.equal(owned.Id,containerId);assert.equal(owned.Config.Image,image);
            docker(['rm','-f','-v',owned.Id]);}
        report.cleanup.container=true;
        if(networkCreated){const owned=JSON.parse(docker(['network','inspect',network]))[0];checkOwner(owned);
            assert.equal(Object.keys(owned.Containers??{}).length,0);docker(['network','rm',network]);}
        report.cleanup.network=true;
    } catch(error){report.cleanup.error=String(error.stack??error);report.status='failed';}
    report.completedAt=new Date().toISOString();
    const text=JSON.stringify(report,null,2)+'\n';if(output)writeFileSync(output,text);process.stdout.write(text);
    if(report.status!=='passed')process.exitCode=1;
}
