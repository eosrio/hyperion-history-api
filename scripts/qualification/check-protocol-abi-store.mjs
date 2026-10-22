import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {Client} from '@elastic/elasticsearch';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest} from '../../build/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore} from '../../build/indexer/protocol/source-bindings.js';
import {ProtocolAbiFrontierStore,ProtocolAbiFrontierConflictError} from '../../build/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiCoordinator} from '../../build/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiProofReader,ProtocolAbiProofUnavailableError} from '../../build/indexer/protocol/abi-proof.js';
import {ensureProtocolActionMapping} from '../../build/indexer/protocol/action-proof-mapping.js';
import {createHash} from 'node:crypto';
import {checkProtocolNativeJournal} from './check-protocol-native-journal.mjs';

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
// Some client connection/timeout handles are unreferenced during startup. Keep
// this owned lifecycle alive until its bounded operations and cleanup complete.
const lifecycle=setInterval(()=>{},1000);
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
    while(Date.now()<deadline){
        try{info=await client.info({}, {signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))});break;}
        catch{await new Promise(resolve=>setTimeout(resolve,250));}
    }
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
    const sourceChain=`${chain}-sources`,sourceIndex=`${sourceChain}-protocol-source-bindings-v1`;
    const sources=new ProtocolSourceBindingStore(client,sourceChain,0);
    const context={schemaVersion:1,chainId:'1'.repeat(64),
        protocol:{id:'synthetic-wire-source',profileId:'serialization-only',components:[
            {id:'fixture-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)},
            {id:'fixture-rust',runtime:'rust',version:'0.0.0-dev.1',sourceRevision:'c'.repeat(40),sha256:'d'.repeat(64)}]},
        schemaJson:'{"version":"source-fixture-a"}'};
    const contextId=(await sources.prepareContext(context)).id;
    assert.equal((await sources.prepareContext(context)).id,contextId);
    const changedContext={...context,schemaJson:'{"version":"source-fixture-b"}'};
    const changedContextId=(await sources.prepareContext(changedContext)).id;
    assert.notEqual(changedContextId,contextId);
    const selection={schemaVersion:1,contextId,readerSessionId:'disposable-reader-session',readerRole:'bulk',assignmentId:'disposable-range',
        source:{chainId:context.chainId,blockNum:100,blockId:'2'.repeat(64),previousBlockId:'3'.repeat(64)},
        frameSha256:'4'.repeat(64),captureSha256:'5'.repeat(64),
        head:{blockNum:200,blockId:'6'.repeat(64)},irreversible:{blockNum:99,blockId:'7'.repeat(64)}};
    await client.indices.putSettings({index:sourceIndex,settings:{refresh_interval:'-1'}});
    const selectionId=(await sources.prepareSelection(selection)).id;
    const hiddenSelection=await client.search({index:sourceIndex,query:{ids:{values:[selectionId]}},size:1});
    assert.equal(hiddenSelection.timed_out,false);assert.equal(hiddenSelection._shards.failed,0);assert.equal(hiddenSelection.hits.hits.length,0);
    assert.deepEqual(await sources.readSelection(selectionId),{selection,context});
    const reopenedSources=new ProtocolSourceBindingStore(client,sourceChain,0);
    assert.deepEqual(await reopenedSources.readSelection(selectionId),{selection,context});
    assert.equal((await reopenedSources.prepareSelection(selection)).id,selectionId);
    report.checks.push('source contexts and selections survive fresh adapters and search refresh lag');
    const nextSelection={...selection,contextId:changedContextId};
    const nextSelectionId=(await sources.prepareSelection(nextSelection)).id;
    assert.notEqual(nextSelectionId,selectionId);
    assert.deepEqual(await sources.readSelection(selectionId),{selection,context});
    assert.equal((await sources.readSelection(nextSelectionId)).context.schemaJson,changedContext.schemaJson);
    assert.notEqual((await sources.prepareSelection({...selection,frameSha256:'8'.repeat(64)})).id,selectionId);
    report.checks.push('queued source selections keep exact old schemas and distinguish changed frame bytes');

    const link={schemaVersion:1,selectionId,observationId:prepared.id,observationDigest:prepared.digest};
    await sources.prepareObservationLink(link);
    assert.deepEqual(await reopenedSources.readObservationLink(selectionId),link);
    await sources.prepareObservationLink(link);
    await assert.rejects(sources.prepareObservationLink({...link,observationDigest:'9'.repeat(64)}),/conflict/i);
    report.checks.push('immutable selection to PREPARE linkage and conflicting result refusal');
    const capsule={schemaVersion:1,chainId:context.chainId,protocol:context.protocol,frameHex:'0001ff',
        reason:{code:'source_binding_unavailable',message:'Synthetic unbound delivery'},claimedSelectionId:null};
    const capsuleId=(await sources.quarantine(capsule)).id;
    assert.deepEqual(await reopenedSources.readQuarantine(capsuleId),capsule);
    assert.equal((await sources.quarantine(capsule)).id,capsuleId);
    report.checks.push('incomplete raw capsules are byte-retained and idempotently readable');

    await client.indices.putSettings({index:sourceIndex,settings:{'translog.durability':'async'}});
    try {await assert.rejects(sources.prepareSelection({...selection,readerSessionId:'unsafe-settings'}),/durability/);} finally {
        await client.indices.putSettings({index:sourceIndex,settings:{'translog.durability':'request'}});
    }
    for(const setting of ['default_pipeline','final_pipeline']) {
        await client.indices.putSettings({index:sourceIndex,settings:{[setting]:pipeline}});
        try {await assert.rejects(sources.quarantine({...capsule,frameHex:'00'}),/retention/);} finally {
            await client.indices.putSettings({index:sourceIndex,settings:{[setting]:'_none'}});
        }
    }
    report.checks.push('source-binding unsafe durability and ingest-pipeline refusal');
    const filteredSources=new ProtocolSourceBindingStore(client,`${sourceChain}-filtered`,0);
    const sourceMapping=(await client.indices.getMapping({index:sourceIndex}))[sourceIndex].mappings;
    const filteredSourceIndex=`${sourceChain}-filtered-protocol-source-bindings-v1`;
    await client.indices.create({index:filteredSourceIndex,settings:{number_of_shards:1,number_of_replicas:0,
        'translog.durability':'request',auto_expand_replicas:'false'},mappings:{...sourceMapping,_source:{excludes:['payload']}}});
    await assert.rejects(filteredSources.prepareContext(context),/incompatible/);
    assert.equal((await client.count({index:filteredSourceIndex})).count,0);
    report.checks.push('source-binding source-pruning mappings refused before writes');

    let incompleteHeadReceipt=false;
    const frontierClient=new Proxy(client,{get(target,key){
        if(key==='index')return async request=>{
            const receipt=await target.index(request);
            if(incompleteHeadReceipt&&request.id==='control'
                &&JSON.parse(Buffer.from(request.document.payload,'base64').toString('utf8')).head?.blockNum===4){
                incompleteHeadReceipt=false;return {...receipt,_shards:{...receipt._shards,successful:0}};
            }
            return receipt;
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const frontierChain=`${chain}-frontier`,frontierStore=new ProtocolAbiFrontierStore(frontierClient,frontierChain);
    const frontierSources=new ProtocolSourceBindingStore(client,frontierChain),frontierObservations=new ProtocolAbiObservationStore(client,frontierChain);
    const frontierContext={...context,schemaJson:'{"version":"eosio::abi/1.1"}'};
    const frontierContextId=(await frontierSources.prepareContext(frontierContext)).id;
    const coordinatorOptions={chainId:context.chainId,profile:context.protocol,ownerId:'disposable-master-a',
        bindings:frontierSources,observations:frontierObservations,store:frontierStore,maxPendingBlocks:2,recoveryWindowBlocks:2};
    const coordinator=new ProtocolAbiCoordinator(coordinatorOptions);await coordinator.start();
    let generation=(await coordinator.openSource(frontierContextId,'frontier-session-a')).generation;
    await client.indices.putSettings({index:frontierStore.controlIndex,settings:{refresh_interval:'-1'}});
    await frontierStore.prepareCommit({fixture:'unactivated-record-index-initialization'});
    await client.indices.putSettings({index:frontierStore.recordsIndex,settings:{refresh_interval:'-1'}});
    const positionId=number=>number.toString(16).padStart(64,'0');
    const selectedBlock=async(number,identity=number,parent=number-1,session='frontier-session-a')=>{
        const source={chainId:context.chainId,blockNum:number,blockId:positionId(identity),previousBlockId:number===1?null:positionId(parent)};
        const capture={kind:'unattested-ship-result-sections-v1',schemaJson:frontierContext.schemaJson,blockHex:'00',tracesHex:'00',deltasHex:'00'};
        const captureSha256=protocolAbiCaptureDigest(source,capture);
        const facts={schemaVersion:1,actionInputs:[],deployments:[],finalStates:[]};
        if(number===1)facts.finalStates.push({account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0});
        else facts.actionInputs.push({transactionId:'a'.repeat(64),actionOrdinal:1,inputActionOrdinal:1,receiver:'alpha',account:'alpha',name:'act',
            rawHex:'07',globalSequence:identity===20?'1':String(9007199254740991n+BigInt(number)),receiptAbiSequence:'0'});
        const input={schemaVersion:1,protocol:context.protocol,source:{...source,inputSha256:captureSha256},capture,observation:{status:'observed',facts}};
        const selected=(await frontierSources.prepareSelection({schemaVersion:1,contextId:frontierContextId,readerSessionId:session,
            readerRole:'live',assignmentId:null,source,captureSha256,frameSha256:createHash('sha256').update('synthetic-frame-'+identity).digest('hex'),
            head:{blockNum:number,blockId:source.blockId},irreversible:{blockNum:0,blockId:positionId(0)}})).id;
        return {selected,input};
    };
    const prepareBlock=async(value)=>{
        const prepared=await frontierObservations.prepare(value.input);
        await frontierSources.prepareObservationLink({schemaVersion:1,selectionId:value.selected,observationId:prepared.id,observationDigest:prepared.digest});
    };
    const frontierFirst=await selectedBlock(1),frontierSecond=await selectedBlock(2);
    await coordinator.admit(frontierFirst.selected,generation);await coordinator.admit(frontierSecond.selected,generation);
    await prepareBlock(frontierSecond);assert.deepEqual(await coordinator.drain(),{committed:0,pending:2});
    await client.indices.putSettings({index:frontierObservations.index,settings:{refresh_interval:'-1'}});
    await prepareBlock(frontierFirst);assert.deepEqual(await coordinator.drain(),{committed:2,pending:0});
    const canonicalView=await coordinator.inspect();assert.equal(canonicalView.head.blockNum,2);assert.equal(canonicalView.head.coverageStart,1);
    const canonicalCommit=await frontierStore.readCommit(canonicalView.head.commitId);
    assert.equal((await frontierStore.readAccountState(canonicalCommit.bindings[0].stateId)).abiHex,'aa');
    const currentControl=await client.get({index:frontierStore.controlIndex,id:'control',realtime:true});
    const hiddenControl=await client.search({index:frontierStore.controlIndex,
        query:{bool:{filter:[{ids:{values:['control']}},{term:{digest:currentControl._source.digest}}]}},size:1});
    assert.equal(hiddenControl.timed_out,false);assert.equal(hiddenControl._shards.failed,0);assert.equal(hiddenControl.hits.hits.length,0);
    report.checks.push('real canonical coordinator activates ordered PREPAREs and compact bindings without search refresh');

    // This consumer has no write or index-creation methods. All authority must
    // come from the settled certificate, never from a consumer-side CAS repair.
    const readClient={get:request=>client.get(request),indices:{
        getMapping:request=>client.indices.getMapping(request),getSettings:request=>client.indices.getSettings(request)}};
    const readStore=new ProtocolAbiFrontierStore(readClient,frontierChain,0,{readOnly:true});
    const proofReader=new ProtocolAbiProofReader({chainId:context.chainId,profile:context.protocol,store:readStore,maxAncestryBlocks:2});
    const secondProof=await proofReader.open(frontierSecond.input.source,frontierSecond.selected);
    assert.equal((await proofReader.action(secondProof,frontierSecond.input.observation.facts.actionInputs[0])).state.abiHex,'aa');
    const hiddenCertificate=await client.search({index:frontierStore.recordsIndex,query:{ids:{values:[secondProof.certificateId]}},size:1});
    assert.equal(hiddenCertificate.timed_out,false);assert.equal(hiddenCertificate._shards.failed,0);
    assert.equal(hiddenCertificate.hits.hits.length,0);
    await assert.rejects(proofReader.action(secondProof,{...frontierSecond.input.observation.facts.actionInputs[0],rawHex:'08'}),
        error=>error instanceof ProtocolAbiProofUnavailableError);
    report.checks.push('read-only exact input proof consumes an unrefreshed settled certificate and rejects changed raw bytes');

    const fork=await selectedBlock(2,20,1);await prepareBlock(fork);
    const admittedFork=await coordinator.admit(fork.selected,generation);assert.equal(admittedFork.status,'accepted');
    assert.notEqual(admittedFork.generation,generation);generation=admittedFork.generation;
    await assert.rejects(proofReader.revalidate(secondProof),error=>error instanceof ProtocolAbiProofUnavailableError);
    assert.equal((await coordinator.inspect()).head.blockNum,1);assert.deepEqual(await coordinator.drain(),{committed:1,pending:0});
    assert.equal((await coordinator.inspect()).head.blockId,positionId(20));
    report.checks.push('real generation fence and fork rewind restore an immutable ancestor state root');
    const forkProof=await proofReader.open(fork.input.source,fork.selected);
    assert.equal((await proofReader.action(forkProof,fork.input.observation.facts.actionInputs[0])).state.abiHex,'aa');
    report.checks.push('fork revokes existing consumer views before replacement activation and certifies the restored input ABI');

    const reopenedFrontier=new ProtocolAbiFrontierStore(frontierClient,frontierChain),previousControl=await reopenedFrontier.readControl();
    const restarted=new ProtocolAbiCoordinator({...coordinatorOptions,store:reopenedFrontier,ownerId:'disposable-master-b'});
    await restarted.start();assert.equal((await restarted.inspect()).head.blockId,positionId(20));
    assert.equal((await restarted.openSource(frontierContextId,'frontier-session-b')).resumeFromBlock,3);
    await assert.rejects(reopenedFrontier.compareAndSet(previousControl,previousControl.value),error=>error instanceof ProtocolAbiFrontierConflictError);
    assert.equal((await coordinator.admit(frontierSecond.selected,generation)).status,'stale');
    report.checks.push('fresh runtime owner resumes the exact frontier and fences stale writers with real ES CAS');
    await assert.rejects(proofReader.revalidate(forkProof),error=>error instanceof ProtocolAbiProofUnavailableError);
    await assert.rejects(proofReader.open(fork.input.source,fork.selected),error=>error instanceof ProtocolAbiProofUnavailableError);
    const third=await selectedBlock(3,3,20,'frontier-session-b');await prepareBlock(third);
    const restartGeneration=(await restarted.inspect()).generation;
    assert.equal((await restarted.admit(third.selected,restartGeneration)).status,'accepted');await restarted.drain();
    const firstProof=await proofReader.open(frontierFirst.input.source,frontierFirst.selected);
    assert.equal((await proofReader.finalState(firstProof,'alpha')).abiHex,'aa');
    const thirdProof=await proofReader.open(third.input.source,third.selected);
    const fourth=await selectedBlock(4,4,3,'frontier-session-b');await prepareBlock(fourth);
    assert.equal((await restarted.admit(fourth.selected,restartGeneration)).status,'accepted');incompleteHeadReceipt=true;
    await assert.rejects(restarted.drain(),/receipt/);
    await assert.rejects(proofReader.open(fourth.input.source,fourth.selected),error=>error instanceof ProtocolAbiProofUnavailableError);
    await proofReader.revalidate(thirdProof);
    report.checks.push('new owner certifies mixed-generation ancestry while primary-visible partial head receipts grant no new input proof');

    let partialControl=true;
    const receiptClient=new Proxy(client,{get(target,key){
        if(key==='create')return async request=>{const receipt=await target.create(request);
            if(partialControl&&request.id==='control'){partialControl=false;return {...receipt,_shards:{...receipt._shards,successful:0}};}return receipt;};
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const receiptStore=new ProtocolAbiFrontierStore(receiptClient,`${frontierChain}-receipt`),desiredControl={schemaVersion:1,owner:'receipt-fixture'};
    await assert.rejects(receiptStore.compareAndSet(null,desiredControl),/receipt/);
    const repairedControl=await receiptStore.compareAndSet(null,desiredControl);assert.deepEqual(repairedControl.value,desiredControl);
    report.checks.push('real control document exists after partial receipt but needs identical CAS and a fresh complete receipt');

    await client.indices.putSettings({index:frontierStore.controlIndex,settings:{'translog.durability':'async'}});
    try{await assert.rejects(reopenedFrontier.readControl(),/durability|retention/);}finally{
        await client.indices.putSettings({index:frontierStore.controlIndex,settings:{'translog.durability':'request'}});
    }
    for(const index of [frontierStore.controlIndex,frontierStore.recordsIndex]){
        await client.indices.putSettings({index,settings:{final_pipeline:pipeline}});
        try{await assert.rejects(index===frontierStore.controlIndex?reopenedFrontier.readControl():reopenedFrontier.readCommit(canonicalView.head.commitId),/retention/);}finally{
            await client.indices.putSettings({index,settings:{final_pipeline:'_none'}});
        }
    }
    report.checks.push('canonical control and immutable frontier refuse changed durability and source-pruning pipelines');

    const historyChain=`${chain}-history`,historyIndex=`${historyChain}-action-v1-000001`;
    const oldAction={global_sequence:1,act:{account:'alpha',name:'act',data:'07000000'}};
    await client.indices.create({index:historyIndex,settings:{number_of_shards:1,number_of_replicas:0},
        mappings:{properties:{global_sequence:{type:'long'},act:{enabled:false}}}});
    await client.index({index:historyIndex,id:'retained',document:oldAction,refresh:true});
    assert.deepEqual(await ensureProtocolActionMapping(client,historyChain),{inspected:1,updated:1});
    assert.deepEqual((await client.get({index:historyIndex,id:'retained'}))._source,oldAction);
    const protocol={schemaVersion:1,input:{globalSequence:'9007199254740993',rawHex:'07000000'}};
    await client.index({index:historyIndex,id:'new',document:{...oldAction,global_sequence:2,protocol},refresh:true});
    assert.deepEqual((await client.get({index:historyIndex,id:'new'}))._source.protocol,protocol);
    assert.equal((await client.count({index:historyIndex})).count,2);
    assert.deepEqual(await ensureProtocolActionMapping(client,historyChain),{inspected:1,updated:0});
    report.checks.push('additive opaque action mapping preserves retained history and exact new proof metadata without reindex');
    await checkProtocolNativeJournal(client, `${chain}-native`, report, pipeline);
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
    clearInterval(lifecycle);
    const text=JSON.stringify(report,null,2)+'\n';if(output)writeFileSync(output,text);process.stdout.write(text);
    if(report.status!=='passed')process.exitCode=1;
}
