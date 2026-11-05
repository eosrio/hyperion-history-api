import {test,expect,afterAll} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DiskAbiHistoryCatalog,type DiskAbiHistoryConfiguration} from '../../src/indexer/protocol/disk-abi-history.js';
import {diskAbiHistoryOptions,publishDiskAbiSource} from '../../src/indexer/protocol/disk-abi-history-options.js';
import {ProtocolSourceBindingStore,protocolPublishedSourceId,type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {PortableProjectionSource} from '../../src/indexer/projection/source.js';
import {ProtocolActionConsumer} from '../../src/api/helpers/protocol-abi.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {prepared,schemaJson as wireSchema} from './portable-state-source-fixture.mjs';

const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const chainId='1'.repeat(64),block=(n:number)=>n.toString(16).padStart(64,'0'),schemaJson='{}';
const profile:ProtocolSourceProfile={id:'fixture',profileId:'consumer-profile',components:[{id:'fixture',runtime:'node',version:'1.0.0',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const catalogs=new Set<DiskAbiHistoryCatalog>();
const keep=(catalog:DiskAbiHistoryCatalog)=>{catalogs.add(catalog);return catalog;};
afterAll(async()=>{await Promise.all([...catalogs].map(catalog=>catalog.close()));});
async function artifact(rows:any[]=[],ids=[block(1),block(2),block(3),block(4)],chain=chainId,schema=schemaJson){
    const directory=await mkdtemp(join(tmpdir(),'h45-abi-catalog-')),rowBytes=rows.map(row=>JSON.stringify(row)).join('\n'),idBytes=Buffer.from(ids.join(''),'hex');
    await writeFile(join(directory,'abi.ndjson'),rowBytes);await writeFile(join(directory,'blocks.bin'),idBytes);
    const manifest={format:'hyperion-wire-abi-history-v1',complete:true,chainId:chain,nodeRevision:'c'.repeat(40),producerProfileId:'producer-profile',
        shipAbiSha256:hash(schema),startBlock:1,endBlock:ids.length,firstBlockId:ids[0],lastBlockId:ids.at(-1),irreversibleBoundary:{blockNum:ids.length,blockId:ids.at(-1)},
        lastGlobalSequence:'9007199254740999',deployments:{name:'abi.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:'blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:ids.length}};
    const bytes=JSON.stringify(manifest),path=join(directory,'manifest.json');await writeFile(path,bytes);
    const config:DiskAbiHistoryConfiguration={interface_version:1,manifest:path,manifest_sha256:hash(bytes),producer_profile_id:'producer-profile',node_revision:manifest.nodeRevision,ship_abi_sha256:hash(schema)};
    return {config,directory};
}
const final=(account:string,blockNum:number,abiHex:string,abiSequence='0',present=true)=>({account,blockNum,blockId:block(blockNum),phase:'block-final',present,abiHex,abiSequence,deltaOrdinal:0});
const deploy=(n:number,seq:string,abi:string,abiSequence:string)=>({account:'alpha',blockNum:n,blockId:block(n),phase:'deployment',present:true,abiHex:abi,abiSequence,
    action:{transactionId:'a'.repeat(64),actionOrdinal:Number(BigInt(seq)%100n)+1,globalSequence:seq}});
const input=(globalSequence:string,receiptAbiSequence:string,actionOrdinal=1)=>({transactionId:'a'.repeat(64),actionOrdinal,inputActionOrdinal:actionOrdinal,
    account:'alpha',receiver:'alpha',name:'act',rawHex:'01',globalSequence,receiptAbiSequence});

test('sparse catalog preserves exact same-value deployment epochs, receipt sequences and empty barriers',async()=>{
    const f=await artifact([final('alpha',1,'aa'),deploy(2,'9007199254740993','bb','1'),deploy(2,'9007199254740995','bb','2'),deploy(3,'9007199254740997','','3')]);
    const catalog=keep(new DiskAbiHistoryCatalog(f.config,chainId,profile));
    const first=await catalog.actionState(input('9007199254740994','1'),2),second=await catalog.actionState(input('9007199254740996','2'),2);
    expect(first?.abiHex).toBe('bb');expect(second?.abiHex).toBe('bb');expect(first?.source.observationId).not.toBe(second?.source.observationId);
    expect(await catalog.actionState(input('9007199254740994','2'),2)).toBeNull();
    expect((await catalog.actionState(input('9007199254740998','3'),3))?.abiHex).toBe('');
    expect((await catalog.baseline()).states[0].abiHex).toBe('');
    await expect(catalog.covers({chainId,blockNum:2,blockId:block(22)})).rejects.toThrow('pinned irreversible');
    expect(await catalog.covers({chainId,blockNum:5,blockId:block(5)})).toBe(false);
});

test('catalog rejects wrong pins and revokes issued data views after artifact replacement',async()=>{
    const f=await artifact([final('alpha',1,'aa')]);
    await expect(new DiskAbiHistoryCatalog({...f.config,producer_profile_id:'wrong'},chainId,profile).baseline()).rejects.toThrow('source/profile');
    const catalog=keep(new DiskAbiHistoryCatalog(f.config,chainId,profile));await catalog.baseline();
    await writeFile(join(f.directory,'blocks.bin'),Buffer.alloc(128));await expect(catalog.revalidate()).rejects.toThrow('changed or replaced');
});

async function retainedFixture(){
    const f=await artifact([final('alpha',1,'aa'),deploy(2,'9007199254740993','bb','1')]),memory=frontierMemoryClient(),chain='disk-proof';
    const bindings=new ProtocolSourceBindingStore(memory.client as any,chain),observations=new ProtocolAbiObservationStore(memory.client as any,chain);
    const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const source={chainId,blockNum:2,blockId:block(2),previousBlockId:block(1)},capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'};
    const captureSha256=protocolAbiCaptureDigest(source,capture),action=input('9007199254740994','1');
    const record={schemaVersion:1 as const,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
        observation:{status:'observed' as const,facts:{schemaVersion:1,actionInputs:[action],deployments:[],finalStates:[]}}};
    const prepared=await observations.prepare(record);
    const select=async(session:string,frameSha256='d'.repeat(64),captureSha=captureSha256)=>{
        const selected=(await bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:session,readerRole:'bulk',assignmentId:session,
            source,frameSha256,captureSha256:captureSha,head:{blockNum:4,blockId:block(4)},irreversible:{blockNum:4,blockId:block(4)}})).id;
        await bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});return selected;};
    const selected=await select('first'),options=diskAbiHistoryOptions(f.config,memory.client as any,chain,chainId,profile,{} as any)!;
    keep(options.catalog);
    return {...f,memory,chain,bindings,observations,source,action,select,selected,options};
}

test('actual proof reader and API consumer resolve covered original input without any coordinator records',async()=>{
    const f=await retainedFixture(),store=new ProtocolAbiFrontierStore(f.memory.client as any,f.chain,0,{readOnly:true});
    const reader=new ProtocolAbiProofReader({chainId,profile,store,diskHistory:f.options});
    const view=await reader.open(f.source,f.selected);expect((await reader.action(view,f.action)).state.abiHex).toBe('bb');
    expect((await reader.finalState(view,'alpha')).abiHex).toBe('bb');expect(view.certificateId.startsWith('h45abihistory1:')).toBe(true);
    expect(f.memory.calls.some((call:any)=>call.request.index===store.controlIndex||call.request.index===store.recordsIndex)).toBe(false);
    const host:any={manager:{chain:f.chain,conn:{chains:{[f.chain]:{chain_id:chainId}}},config:{settings:{protocol_abi_history:f.config}}},elastic:f.memory.client};
    const consumer=new ProtocolActionConsumer(host,{id:profile.id,provider:{profileId:profile.profileId},components:profile.components} as any);
    const apiView=await consumer.reader.open(f.source,f.selected);expect((await consumer.reader.action(apiView,f.action)).state.abiHex).toBe('bb');
    const mismatched=await f.select('same-block-different-capture','e'.repeat(64),'a'.repeat(64));
    await expect(reader.open(f.source,mismatched)).rejects.toMatchObject({code:'invalid_proof'});
    await expect(consumer.reader.open(f.source,mismatched)).rejects.toMatchObject({code:'invalid_proof'});
    const cancelled=new AbortController();cancelled.abort();await expect(reader.open(f.source,f.selected,{signal:cancelled.signal})).rejects.toMatchObject({code:'proof_cancelled'});
});

test('published source keeps first equivalent recapture, refuses conflict and exposes explicit raw-input pending',async()=>{
    const f=await retainedFixture();await publishDiskAbiSource(f.options,f.bindings,f.selected,()=>{});
    const duplicate=await f.select('second','e'.repeat(64));await publishDiskAbiSource(f.options,f.bindings,duplicate,()=>{});
    expect((await f.bindings.readPublishedSource(chainId,block(2))).selectionId).toBe(f.selected);
    const conflict=await f.select('conflict','f'.repeat(64),'a'.repeat(64));
    await expect(f.bindings.preparePublishedSource(conflict,async()=>{})).rejects.toThrow('conflicts');
    const source=new PortableProjectionSource({client:f.memory.client as any,chain:f.chain,chainId,profile,provider:{} as any,diskAbiHistory:f.config});
    const packet=await source.originalBlock(2,async()=>{});expect(packet.proof.selectionId).toBe(f.selected);expect(packet.observation.source.blockId).toBe(block(2));
    await expect(source.originalBlock(3,async()=>{})).rejects.toMatchObject({statusCode:503,code:'source_publication_pending'});
});

test('publication refuses unknown durability receipts and cannot repair them through a primary read',async()=>{
    const f=await retainedFixture(),id=protocolPublishedSourceId(chainId,block(2));
    f.memory.faults.receipt=(value:any,request:any)=>request.id===id?{...value,_shards:{total:1,successful:0,failed:1}}:value;
    await expect(publishDiskAbiSource(f.options,f.bindings,f.selected,()=>{})).rejects.toThrow();
    // The primary-visible manifest exists, but a second attempt still needs complete-copy durability.
    await expect(publishDiskAbiSource(f.options,f.bindings,f.selected,()=>{})).rejects.toThrow();
    delete f.memory.faults.receipt;await publishDiskAbiSource(f.options,f.bindings,f.selected,()=>{});
    expect((await f.bindings.readPublishedSource(chainId,block(2))).selectionId).toBe(f.selected);
});

test('one catalog baseline carries exact state into first live tail block and survives canonical fork recovery',async()=>{
    const f=await retainedFixture(),store=new ProtocolAbiFrontierStore(f.memory.client as any,f.chain);
    const coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'catalog-tail-owner',bindings:f.bindings,observations:f.observations,
        store,diskAbiHistory:f.options.catalog,nativeActionInterfaceVersion:1});
    await coordinator.start();const contextId=(await f.bindings.readSelection(f.selected)).selection.contextId;
    const opened=await coordinator.openSource(contextId,'live-session');expect(opened.resumeFromBlock).toBe(5);
    const append=async(id:number,globalSequence:string)=>{
        const source={chainId,blockNum:5,blockId:block(id),previousBlockId:block(4)},capture={kind:'unattested-ship-result-sections-v1' as const,
            schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,capture);
        const action=input(globalSequence,'1');
        const selected=(await f.bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
            source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:5,blockId:block(id)},irreversible:{blockNum:4,blockId:block(4)}})).id;
        const prepared=await f.observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
            observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[action],deployments:[],finalStates:[]}}});
        await f.bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});
        const control=await coordinator.inspect();await coordinator.admit(selected,control.generation);await coordinator.drain();return{source,selected,action};
    };
    const first=await append(5,'9007199254741000'),reader=new ProtocolAbiProofReader({chainId,profile,store:store.asReadOnly(),diskHistory:f.options});
    const live=await reader.open(first.source,first.selected),prefix=await reader.open(f.source,f.selected);
    expect((await reader.action(live,first.action)).state.abiHex).toBe('bb');expect((await reader.finalState(live,'alpha')).abiHex).toBe('bb');
    expect((await reader.inspectFinalState(live,'alpha',{atBlockNum:1}))?.abiHex).toBe('aa');
    const replacement=await append(55,'9007199254741001');await expect(reader.revalidate(live)).rejects.toMatchObject({code:'authority_changed'});
    expect((await reader.action(await reader.open(replacement.source,replacement.selected),replacement.action)).state.abiHex).toBe('bb');
    await reader.revalidate(prefix);
    const commits=[...f.memory.documents.values()].filter((entry:any)=>entry.document.kind==='manifest'&&entry.document.bundle_id.startsWith('h45abicmt1:'));
    expect(commits).toHaveLength(3);
});

test('actual captured Wire genesis and blocks2..4 feed projection source from disk identity and published captures',async()=>{
    const p=await prepared(),f=await artifact([],p.positions.map((value:any)=>value.blockId),p.options.chainId,wireSchema);
    const options=diskAbiHistoryOptions(f.config,p.options.client,p.options.chain,p.options.chainId,p.options.profile,p.options.provider)!;
    keep(options.catalog);
    for(let index=0;index<4;index++){
        const control:any=(await p.store.readControl()).value;let commit:any=await p.store.readCommit(control.head.commitId);
        while(commit.source.blockNum>index+1)commit=await p.store.readCommit(commit.previousCommitId);
        await publishDiskAbiSource(options,p.bindings,commit.selectionId,()=>{});
    }
    const source=new PortableProjectionSource({...p.options,diskAbiHistory:f.config});
    const definition:any={schemaVersion:1,id:'future',mappingRevision:'a'.repeat(64),source:{contract:'never',table:'items',abiDeployment:'future',abiSha256:'b'.repeat(64)},fields:[],initialization:{kind:'genesis'}};
    const callCount=p.memory.calls.length;
    for(let height=1;height<=4;height++){const result=await source.frame(height,definition);expect(result.frame.block.blockNum).toBe(height);expect(result.frame.changes).toEqual([]);}
    expect(p.memory.calls.slice(callCount).some((call:any)=>call.request.index?.includes('protocol-abi-frontier'))).toBe(false);
});

test('actual reader and MainDS methods publish covered Wire sources without a live coordinator admission',async()=>{
    const p=await prepared(),f=await artifact([],p.positions.map((value:any)=>value.blockId),p.options.chainId,wireSchema);
    const path=join(f.directory,'configuration.json');await writeFile(path,JSON.stringify(f.config));
    const result=spawnSync(process.env.HYPERION_TEST_NODE??'node',[fileURLToPath(new URL('./disk-abi-history-worker.mjs',import.meta.url)),path],
        {encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
    expect(result.status,result.stderr+result.stdout).toBe(0);expect(result.stdout).toContain('"passed":true');
});
