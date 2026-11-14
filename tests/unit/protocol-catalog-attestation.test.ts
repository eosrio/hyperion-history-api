import {test,expect,afterAll} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskAbiHistoryCatalog,type DiskAbiHistoryConfiguration,type DiskAbiHistoryTip} from '../../src/indexer/protocol/disk-abi-history.js';
import {diskAbiHistoryOptions} from '../../src/indexer/protocol/disk-abi-history-options.js';
import {ProtocolSourceBindingStore,type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// The coordinator settles blocks 5..8 past a 4-block pinned catalog, then a sealed segment for 5..8 appears.
const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const chainId='1'.repeat(64),block=(n:number)=>n.toString(16).padStart(64,'0'),schemaJson='{}',nodeRevision='c'.repeat(40);
const profile:ProtocolSourceProfile={id:'fixture',profileId:'consumer-profile',components:[{id:'fixture',runtime:'node',version:'1.0.0',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const catalogs=new Set<DiskAbiHistoryCatalog>();
afterAll(async()=>{await Promise.all([...catalogs].map(catalog=>catalog.close()));});
const lines=(rows:any[])=>rows.map(row=>JSON.stringify(row)+'\n').join('');
const final=(account:string,blockNum:number,abiHex:string,abiSequence='0',present=true)=>({account,blockNum,blockId:block(blockNum),phase:'block-final',present,abiHex,abiSequence,deltaOrdinal:0});
const deploy=(n:number,seq:string,abi:string,abiSequence:string)=>({account:'alpha',blockNum:n,blockId:block(n),phase:'deployment',present:true,abiHex:abi,abiSequence,
    action:{transactionId:'a'.repeat(64),actionOrdinal:2,globalSequence:seq}});
const input=(globalSequence:string,receiptAbiSequence='1')=>({transactionId:'b'.repeat(64),actionOrdinal:1,inputActionOrdinal:1,
    account:'alpha',receiver:'alpha',name:'act',rawHex:'01',globalSequence,receiptAbiSequence});
const sequenceAt=(n:number)=>String(9007199254741000n+BigInt(n));

async function genesis() {
    const directory=await mkdtemp(join(tmpdir(),'h45-catalog-attest-')),segments=join(directory,'segments');await mkdir(segments);
    const rows=[final('alpha',1,'aa'),deploy(2,'9007199254740993','bb','1')],rowBytes=lines(rows);
    const idBytes=Buffer.from([1,2,3,4].map(block).join(''),'hex');
    await writeFile(join(directory,'abi.ndjson'),rowBytes);await writeFile(join(directory,'blocks.bin'),idBytes);
    const manifest={format:'hyperion-wire-abi-history-v1',complete:true,chainId,nodeRevision,producerProfileId:'producer-profile',
        shipAbiSha256:hash(schemaJson),startBlock:1,endBlock:4,firstBlockId:block(1),lastBlockId:block(4),irreversibleBoundary:{blockNum:4,blockId:block(4)},
        lastGlobalSequence:'9007199254740999',deployments:{name:'abi.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:'blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:4}};
    const bytes=JSON.stringify(manifest),path=join(directory,'manifest.json');await writeFile(path,bytes);
    const config:DiskAbiHistoryConfiguration={interface_version:1,manifest:path,manifest_sha256:hash(bytes),producer_profile_id:'producer-profile',
        node_revision:nodeRevision,ship_abi_sha256:hash(schemaJson),segments_dir:segments};
    return {config,segments,tip:{manifestSha256:hash(bytes),endBlock:4,lastBlockId:block(4),lastGlobalSequence:'9007199254740999',totalRecords:2} as DiskAbiHistoryTip};
}
async function segment(dir:string,tip:DiskAbiHistoryTip,end:number,rows:any[],{ids,lastGlobalSequence,name}:{ids?:string[];lastGlobalSequence?:string;name?:string}={}) {
    const start=tip.endBlock+1,stem=name??`abi-history.${String(start).padStart(10,'0')}-${String(end).padStart(10,'0')}`;
    const blockIds=ids??Array.from({length:end-start+1},(_,i)=>block(start+i)),rowBytes=lines(rows),idBytes=Buffer.from(blockIds.join(''),'hex');
    await writeFile(join(dir,stem+'.ndjson'),rowBytes);await writeFile(join(dir,stem+'.ndjson.blocks.bin'),idBytes);
    const manifest={format:'hyperion-abi-history-segment-v1',chainId,nodeRevision,producerProfileId:'producer-profile',shipAbiSha256:hash(schemaJson),
        base:{manifestSha256:tip.manifestSha256,endBlock:tip.endBlock,lastBlockId:tip.lastBlockId},startBlock:start,endBlock:end,
        startBlockId:blockIds[0],lastBlockId:blockIds.at(-1),irreversibleBoundary:{blockNum:end,blockId:blockIds.at(-1)},complete:true,
        lastGlobalSequence:lastGlobalSequence??sequenceAt(end),totalRecords:tip.totalRecords+rows.length,
        deployments:{name:stem+'.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:stem+'.ndjson.blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:end-start+1}};
    const text=JSON.stringify(manifest)+'\n';await writeFile(join(dir,stem+'.ndjson.manifest.json'),text);
    return {manifestSha256:hash(text),endBlock:end,lastBlockId:blockIds.at(-1)!};
}

async function settled(blocks:number) {
    const g=await genesis(),memory=frontierMemoryClient(),chain='catalog-attest';
    const bindings=new ProtocolSourceBindingStore(memory.client as any,chain),observations=new ProtocolAbiObservationStore(memory.client as any,chain);
    const store=new ProtocolAbiFrontierStore(memory.client as any,chain);
    const catalog=new DiskAbiHistoryCatalog(g.config,chainId,profile);catalogs.add(catalog);
    const refused:any[]=[];
    const coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'attesting-owner',bindings,observations,store,diskAbiHistory:catalog,
        nativeActionInterfaceVersion:1,catalogAttestIntervalMs:0,onCatalogRefused:refusal=>refused.push(refusal)});
    await coordinator.start();
    const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const opened=await coordinator.openSource(contextId,'live-session');expect(opened.resumeFromBlock).toBe(5);
    const sources:Record<number,{source:any;selected:string;action:any}>={};
    for(let n=5;n<=4+blocks;n++){
        const source={chainId,blockNum:n,blockId:block(n),previousBlockId:block(n-1)},capture={kind:'unattested-ship-result-sections-v1' as const,
            schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,capture),action=input(sequenceAt(n));
        // Block 7 adds an ABI for beta at block end.
        const finalStates=n===7?[{account:'beta',present:true,abiHex:'cc',deltaOrdinal:0}]:[];
        const selected=(await bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
            source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:n,blockId:block(n)},irreversible:{blockNum:n,blockId:block(n)}})).id;
        const prepared=await observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
            observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[action],deployments:[],finalStates}}});
        await bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});
        const control=await coordinator.inspect();await coordinator.admit(selected,control.generation);await coordinator.drain();
        sources[n]={source,selected,action};
    }
    const attest=async()=>{await coordinator.drain();await coordinator.catalogAttested();return coordinator.inspect();};
    return {g,memory,chain,bindings,observations,store,catalog,coordinator,refused,sources,attest};
}

test('a segment that agrees with the commits is adopted, published, and followed by an independent reader',async()=>{
    const f=await settled(4);
    expect((await f.attest()).catalog).toBeUndefined();
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);
    const control=await f.attest();
    expect(control.catalog).toEqual(link);expect(f.refused).toEqual([]);expect(await f.catalog.coverageEnd()).toBe(8);
    // An API-like reader with its own catalog instance follows the published link on its first authority read.
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    const options={...diskAbiHistoryOptions(f.g.config,f.memory.client as any,f.chain,chainId,profile,{} as any)!,catalog:own};
    const reader=new ProtocolAbiProofReader({chainId,profile,store:f.store.asReadOnly(),diskHistory:options});
    expect(await own.coverageEnd()).toBe(4);
    const view=await reader.open(f.sources[6].source,f.sources[6].selected);
    expect(await own.coverageEnd()).toBe(8);
    expect(view.certificateId).toBe(own.catalogId);
    expect((await reader.action(view,f.sources[6].action)).state.abiHex).toBe('bb');
    expect((await own.finalState('beta',7))?.abiHex).toBe('cc');
    // A restarted owner follows the previous owner's link again and keeps publishing it.
    const fresh=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(fresh);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'restarted-owner',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:fresh,nativeActionInterfaceVersion:1,catalogAttestIntervalMs:0});
    await next.start();
    expect((await next.inspect()).catalog).toEqual(link);expect(await fresh.coverageEnd()).toBe(8);
});

test('a segment that disagrees with the commits is refused and never adopted',async()=>{
    const cases:[string,(f:Awaited<ReturnType<typeof settled>>)=>Promise<unknown>,RegExp][]=[
        ['other ABI',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'dd')]),/beta ends block 7 with another ABI/],
        ['missing record',f=>segment(f.g.segments,f.g.tip,8,[]),/beta changes at block 7 without a catalog record/],
        ['extra record',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc'),final('gamma',6,'ee')]),/gamma has a catalog record at block 6/],
        ['record at another block',f=>segment(f.g.segments,f.g.tip,8,[final('beta',6,'cc')]),/beta has a catalog record at block 6/],
        ['block id',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')],{ids:[block(5),block(66),block(7),block(8)]}),/block 6 id or parent differs/],
        ['global sequence',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')],{lastGlobalSequence:sequenceAt(9)}),/last global sequence/],
        ['action ABI',f=>segment(f.g.segments,f.g.tip,8,[deploy(6,sequenceAt(5),'ff','1'),final('beta',7,'cc')]),/alpha|decodes with another ABI/],
    ];
    for(const [name,make,expected] of cases){
        const f=await settled(4);await make(f);
        const control=await f.attest();
        expect(control.catalog,name).toBeUndefined();expect(await f.catalog.coverageEnd(),name).toBe(4);
        expect(f.refused,name).toHaveLength(1);expect(f.refused[0].message,name).toMatch(expected);
        // Refused once for this owner: later drains do not check or report it again.
        await f.attest();expect(f.refused,name).toHaveLength(1);
    }
});

test('a segment past the settled head waits, and is adopted once the commits reach it',async()=>{
    const f=await settled(3);
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);
    expect((await f.attest()).catalog).toBeUndefined();expect(f.refused).toEqual([]);expect(await f.catalog.coverageEnd()).toBe(4);
    // Settle block 8, then the same segment is checked and adopted.
    const n=8,source={chainId,blockNum:n,blockId:block(n),previousBlockId:block(n-1)},capture={kind:'unattested-ship-result-sections-v1' as const,
        schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,capture);
    const contextId=(await f.bindings.readSelection(f.sources[5].selected)).selection.contextId;
    const selected=(await f.bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
        source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:n,blockId:block(n)},irreversible:{blockNum:n,blockId:block(n)}})).id;
    const prepared=await f.observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
        observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[input(sequenceAt(n))],deployments:[],finalStates:[]}}});
    await f.bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});
    await f.coordinator.admit(selected,(await f.coordinator.inspect()).generation);
    expect((await f.attest()).catalog).toEqual(link);expect(await f.catalog.coverageEnd()).toBe(8);
});
