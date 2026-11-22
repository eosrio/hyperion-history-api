import {test,expect,afterAll,afterEach} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskAbiHistoryCatalog,type DiskAbiHistoryConfiguration,type DiskAbiHistoryTip} from '../../src/indexer/protocol/disk-abi-history.js';
import {ProtocolSourceBindingStore,type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolAbiProofReader} from '../../src/indexer/protocol/abi-proof.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolSourceEquivalence} from '../../src/indexer/protocol/source-equivalence.js';
import {followProtocolStoreGenerations,protocolStoreGenerationIndices} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// The coordinator settles blocks 5..8 past a 4-block pinned catalog, then a sealed segment for 5..8 appears.
const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const chainId='1'.repeat(64),block=(n:number)=>n.toString(16).padStart(64,'0'),schemaJson='{}',nodeRevision='c'.repeat(40);
const profile:ProtocolSourceProfile={id:'fixture',profileId:'consumer-profile',components:[{id:'fixture',runtime:'node',version:'1.0.0',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const catalogs=new Set<DiskAbiHistoryCatalog>();
afterAll(async()=>{await Promise.all([...catalogs].map(catalog=>catalog.close()));});
afterEach(()=>followProtocolStoreGenerations(false));
const lines=(rows:any[])=>rows.map(row=>JSON.stringify(row)+'\n').join('');
const final=(account:string,blockNum:number,abiHex:string,abiSequence='0',present=true)=>({account,blockNum,blockId:block(blockNum),phase:'block-final',present,abiHex,abiSequence,deltaOrdinal:0});
const deploy=(n:number,seq:string,abi:string,abiSequence:string)=>({account:'alpha',blockNum:n,blockId:block(n),phase:'deployment',present:true,abiHex:abi,abiSequence,
    action:{transactionId:'a'.repeat(64),actionOrdinal:2,globalSequence:seq}});
const input=(globalSequence:string,receiptAbiSequence='1')=>({transactionId:'b'.repeat(64),actionOrdinal:1,inputActionOrdinal:1,
    account:'alpha',receiver:'alpha',name:'act',rawHex:'01',globalSequence,receiptAbiSequence});
const sequenceAt=(n:number)=>String(9007199254741000n+BigInt(n));

async function genesis(end=4) {
    const directory=await mkdtemp(join(tmpdir(),'h45-catalog-attest-')),segments=join(directory,'segments');await mkdir(segments);
    const rows=[final('alpha',1,'aa'),deploy(2,'9007199254740993','bb','1')],rowBytes=lines(rows);
    const idBytes=Buffer.from(Array.from({length:end},(_,i)=>block(i+1)).join(''),'hex');
    await writeFile(join(directory,'abi.ndjson'),rowBytes);await writeFile(join(directory,'blocks.bin'),idBytes);
    const manifest={format:'hyperion-wire-abi-history-v1',complete:true,chainId,nodeRevision,producerProfileId:'producer-profile',
        shipAbiSha256:hash(schemaJson),startBlock:1,endBlock:end,firstBlockId:block(1),lastBlockId:block(end),irreversibleBoundary:{blockNum:end,blockId:block(end)},
        lastGlobalSequence:'9007199254740999',deployments:{name:'abi.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:'blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:end}};
    const bytes=JSON.stringify(manifest),path=join(directory,'manifest.json');await writeFile(path,bytes);
    const config:DiskAbiHistoryConfiguration={interface_version:1,manifest:path,manifest_sha256:hash(bytes),producer_profile_id:'producer-profile',
        node_revision:nodeRevision,ship_abi_sha256:hash(schemaJson),segments_dir:segments};
    return {config,segments,tip:{manifestSha256:hash(bytes),endBlock:end,lastBlockId:block(end),lastGlobalSequence:'9007199254740999',totalRecords:2} as DiskAbiHistoryTip};
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

/** The disk options an API reader builds, around a catalog instance of its own (not the process-wide configured one). */
function readerOptions(f:{memory:any;chain:string},catalog:DiskAbiHistoryCatalog) {
    return {catalog,bindings:new ProtocolSourceBindingStore(f.memory.client as any,f.chain,0,{readOnly:true}),
        observations:new ProtocolAbiObservationStore(f.memory.client as any,f.chain,0,undefined,{readOnly:true})};
}
/** Another process: its own client object, so its own generation state, over the same stored data. */
const separate=<T extends object>(client:T)=>new Proxy(client,{}) as T;
type Fixture=Awaited<ReturnType<typeof settled>>;
/** Capture, observe, link, admit and commit one more block. */
async function extend(f:Fixture,n:number,facts?:any) {
    const source={chainId,blockNum:n,blockId:block(n),previousBlockId:block(n-1)},capture={kind:'unattested-ship-result-sections-v1' as const,
        schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,capture),action=input(sequenceAt(n));
    const selected=(await f.bindings.prepareSelection({schemaVersion:1,contextId:f.contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
        source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:n,blockId:block(n)},irreversible:{blockNum:n,blockId:block(n)}})).id;
    const prepared=await f.observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
        observation:{status:'observed',facts:facts??{schemaVersion:1,actionInputs:[action],deployments:[],finalStates:[]}}});
    await f.bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});
    await f.coordinator.admit(selected,(await f.coordinator.inspect()).generation);await f.coordinator.drain();
    f.sources[n]={source,selected,action,observationId:prepared.id,observationDigest:prepared.digest};
    return f.sources[n]!;
}
/** What an operator's delete, or the indexer's own, does to a retired generation. */
function dropGeneration(f:Fixture,generation:number) {
    for(const index of protocolStoreGenerationIndices(f.chain,generation)){
        f.memory.mappings.delete(index);f.memory.settings.delete(index);
        for(const id of [...f.memory.documents.keys()])if(id.startsWith(f.memory.key(index,'')))f.memory.documents.delete(id);
    }
}
async function settled(blocks:number,options:{finalStates?:(n:number)=>any[]|undefined;facts?:(n:number)=>any;coordinator?:Record<string,unknown>;remember?:boolean}={}) {
    const g=await genesis(),memory=frontierMemoryClient(),chain='catalog-attest';
    // The indexer's coordinator remembers contexts and selections, so it reads each of them from a store only once.
    const bindings=new ProtocolSourceBindingStore(memory.client as any,chain,0,options.remember?{rememberRecords:true}:{});
    const observations=new ProtocolAbiObservationStore(memory.client as any,chain);
    const store=new ProtocolAbiFrontierStore(memory.client as any,chain);
    const catalog=new DiskAbiHistoryCatalog(g.config,chainId,profile);catalogs.add(catalog);
    const refused:any[]=[];
    const coordinator=new ProtocolAbiCoordinator({chainId,profile,ownerId:'attesting-owner',bindings,observations,store,diskAbiHistory:catalog,
        nativeActionInterfaceVersion:1,catalogAttestIntervalMs:0,onCatalogRefused:refusal=>refused.push(refusal),...options.coordinator});
    await coordinator.start();
    const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const opened=await coordinator.openSource(contextId,'live-session');expect(opened.resumeFromBlock).toBe(5);
    const sources:Record<number,{source:any;selected:string;action:any;observationId?:string;observationDigest?:string}>={};
    for(let n=5;n<=4+blocks;n++){
        const source={chainId,blockNum:n,blockId:block(n),previousBlockId:block(n-1)},capture={kind:'unattested-ship-result-sections-v1' as const,
            schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,capture),action=input(sequenceAt(n));
        // Block 6 first touches gamma, which never had an ABI; block 7 adds an ABI for beta at block end.
        const finalStates=options.finalStates?.(n)??(n===6?[{account:'gamma',present:true,abiHex:'',deltaOrdinal:0}]
            :n===7?[{account:'beta',present:true,abiHex:'cc',deltaOrdinal:0}]:[]);
        const selected=(await bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
            source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:n,blockId:block(n)},irreversible:{blockNum:n,blockId:block(n)}})).id;
        const prepared=await observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
            observation:{status:'observed',facts:options.facts?.(n)??{schemaVersion:1,actionInputs:[action],deployments:[],finalStates}}});
        await bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});
        const control=await coordinator.inspect();await coordinator.admit(selected,control.generation);await coordinator.drain();
        sources[n]={source,selected,action,observationId:prepared.id,observationDigest:prepared.digest};
    }
    const attest=async()=>{await coordinator.drain();await coordinator.catalogAttested();return coordinator.inspect();};
    return {g,memory,chain,bindings,observations,store,catalog,coordinator,refused,sources,attest,contextId};
}

test('a segment that agrees with the commits is adopted, published, and followed by an independent reader',async()=>{
    const f=await settled(4);
    expect((await f.attest()).catalog).toBeUndefined();
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);
    const control=await f.attest();
    expect(control.catalog).toEqual(link);expect(f.refused).toEqual([]);expect(await f.catalog.coverageEnd()).toBe(8);
    // An API-like reader with its own catalog instance follows the published link on its first authority read.
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    const options=readerOptions(f,own);
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
        ['extra record',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc'),final('delta',6,'ee')]),/delta has a catalog record at block 6/],
        ['empty account recorded with an ABI',f=>segment(f.g.segments,f.g.tip,8,[final('gamma',6,'ee'),final('beta',7,'cc')]),/gamma ends block 6 with another ABI/],
        ['record at another block',f=>segment(f.g.segments,f.g.tip,8,[final('beta',6,'cc')]),/beta has a catalog record at block 6/],
        ['block id',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')],{ids:[block(5),block(66),block(7),block(8)]}),/block 6 id or parent differs/],
        ['global sequence',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')],{lastGlobalSequence:sequenceAt(9)}),/last global sequence/],
        ['action ABI',f=>segment(f.g.segments,f.g.tip,8,[deploy(6,sequenceAt(5),'ff','2'),final('beta',7,'cc')]),/alpha has a catalog record at block 6|decodes with another ABI/],
        // No action runs on alpha after this deployment inside the segment, so no receipt would ever show its sequence is wrong.
        ['ABI sequence',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc'),deploy(8,sequenceAt(8),'bb','7')]),/alpha deploys at block 8 with an ABI sequence that does not follow its previous record/],
        // An account's first deployment is its first: the count starts at zero.
        ['first ABI sequence',f=>segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc'),{...deploy(8,sequenceAt(8),'bb','3'),account:'zeta'}]),/zeta deploys at block 8 with an ABI sequence/],
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

test('the settled checkpoint is monotonic, bounded by the published catalog, and survives a restart',async()=>{
    const f=await settled(4);
    await expect(f.coordinator.recordSettled(6)).rejects.toThrow('outside the published catalog');
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);await f.attest();
    await f.coordinator.recordSettled(6);expect((await f.coordinator.inspect()).settled).toBe(6);
    await f.coordinator.recordSettled(5);expect((await f.coordinator.inspect()).settled).toBe(6);
    await expect(f.coordinator.recordSettled(9)).rejects.toThrow('outside the published catalog');
    await f.coordinator.recordSettled(8);expect((await f.coordinator.inspect()).settled).toBe(8);
    // Later control updates keep it, and a restarted owner carries it with the link it follows.
    await f.attest();expect((await f.coordinator.inspect())).toMatchObject({catalog:link,settled:8});
    const fresh=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(fresh);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'settled-restart',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:fresh,nativeActionInterfaceVersion:1});
    await next.start();expect(await next.inspect()).toMatchObject({catalog:link,settled:8});
    // Without the segments the link cannot be followed, so neither it nor the checkpoint is carried.
    const {segments_dir:_,...pinned}=f.g.config,blind=new DiskAbiHistoryCatalog(pinned,chainId,profile);catalogs.add(blind);
    const third=new ProtocolAbiCoordinator({chainId,profile,ownerId:'blind-restart',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:blind,nativeActionInterfaceVersion:1});
    await third.start();const control=await third.inspect();expect(control.catalog).toBeUndefined();expect(control.settled).toBeUndefined();
});

test('a store rotation rebuilds the chain in a new generation above a settled anchor and switches without a gap',async()=>{
    const f=await settled(6);
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);
    expect((await f.attest()).catalog).toEqual(link);
    // Nothing settled yet: no anchor to rotate to.
    expect(await f.coordinator.rotateStores()).toBe(false);
    await f.coordinator.recordSettled(8);
    const before=await f.coordinator.inspect();expect(before.head!.blockNum).toBe(10);expect(before.storeGeneration).toBeUndefined();
    expect(await f.coordinator.rotateStores()).toBe(true);
    const after=await f.coordinator.inspect();
    expect(after).toMatchObject({storeGeneration:1,anchor:8,previousStore:{generation:0,switchedAtBlock:10},catalog:link,settled:8});
    // Same block and id at the head, but a commit of the new generation's chain.
    expect(after.head!.blockNum).toBe(10);expect(after.head!.blockId).toBe(before.head!.blockId);expect(after.head!.commitId).not.toBe(before.head!.commitId);
    expect(f.memory.mappings.has(f.chain+'-protocol-abi-frontier-records-v1-g1')).toBe(true);
    expect(f.store.recordsIndex).toBe(f.chain+'-protocol-abi-frontier-records-v1-g1');
    // The new generation was fully prepared before control named it: its indices and the head's certificate exist.
    for(const kind of ['source-bindings','abi-observations'])expect(f.memory.mappings.has(f.chain+'-protocol-'+kind+'-v1-g1'),kind).toBe(true);
    const switched=await f.coordinator.inspect(),{protocolAbiCertificateForControl}=await import('../../src/indexer/protocol/abi-proof.js');
    expect(await f.store.readCertificate(f.store.certificateId(protocolAbiCertificateForControl(switched)))).toEqual(protocolAbiCertificateForControl(switched));
    // A second rotation waits for the previous generation to be retired.
    expect(await f.coordinator.rotateStores()).toBe(false);

    // Readers: covered blocks prove from disk; blocks above the catalog prove through the new chain, whose
    // selections and observations are still found in generation 0.
    const reading=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(reading);
    const options=readerOptions(f,reading);
    const reader=new ProtocolAbiProofReader({chainId,profile,store:f.store.asReadOnly(),diskHistory:options});
    const covered=await reader.open(f.sources[6].source,f.sources[6].selected);expect(covered.certificateId).toBe(options.catalog.catalogId);
    // A read-only reader found block 6's selection in generation 0 and copied nothing forward.
    const bindingsG1=f.chain+'-protocol-source-bindings-v1-g1',manifestIn=(index:string,id:string)=>f.memory.documents.has(index+' '+id);
    expect(manifestIn(bindingsG1,f.sources[6].selected)).toBe(false);
    for(const n of [9,10]){
        const view=await reader.open(f.sources[n].source,f.sources[n].selected);
        expect(view.certificateId).not.toBe(options.catalog.catalogId);
        expect((await reader.action(view,f.sources[n].action)).state.abiHex).toBe('bb');
        expect((await reader.finalState(view,'beta')).abiHex).toBe('cc');
    }

    // The next block is written and committed in generation 1.
    const n=11,source={chainId,blockNum:n,blockId:block(n),previousBlockId:block(n-1)},capture={kind:'unattested-ship-result-sections-v1' as const,
        schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,capture);
    const contextId=(await f.bindings.readSelection(f.sources[5].selected)).selection.contextId;
    const selected=(await f.bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
        source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:n,blockId:block(n)},irreversible:{blockNum:n,blockId:block(n)}})).id;
    const prepared=await f.observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
        observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[input(sequenceAt(n))],deployments:[],finalStates:[]}}});
    await f.bindings.prepareObservationLink({schemaVersion:1,selectionId:selected,observationId:prepared.id,observationDigest:prepared.digest});
    expect(f.observations.index).toBe(f.chain+'-protocol-abi-observations-v1-g1');
    // The writable pipeline read its source context from generation 0 and carried it forward.
    expect(manifestIn(bindingsG1,contextId)).toBe(true);
    await f.coordinator.admit(selected,(await f.coordinator.inspect()).generation);await f.coordinator.drain();
    expect((await f.coordinator.inspect()).head!.blockNum).toBe(11);
    const latest=await reader.open(source,selected);expect((await reader.action(latest,input(sequenceAt(n)))).state.abiHex).toBe('bb');

    // Retirement waits for settling past the switch block and for the age bound.
    expect(await f.coordinator.retirePreviousStore(1,0)).toBeUndefined();
    expect(await f.coordinator.retirePreviousStore(0,60000,after.previousStore!.switchedAt+1000)).toBeUndefined();
    expect(await f.coordinator.retirePreviousStore(0,0)).toBeUndefined();// settled 8 is below the switch block 10
    await segment(f.g.segments,{...link,lastGlobalSequence:sequenceAt(8),totalRecords:3},11,[],{lastGlobalSequence:sequenceAt(11)});
    expect((await f.attest()).catalog?.endBlock).toBe(11);
    await f.coordinator.recordSettled(11);
    expect(await f.coordinator.retirePreviousStore(0,0)).toBe(0);
    const retired=await f.coordinator.inspect();expect(retired.previousStore).toBeUndefined();expect(retired.storeGeneration).toBe(1);
    expect(f.store.generations.known()).toEqual({current:1,previous:null});
    // With generation 0 no longer read, the context and the new block's selection still resolve.
    const readOnly=new ProtocolSourceBindingStore(f.memory.client as any,f.chain,0,{readOnly:true});
    expect((await readOnly.readSelection(selected)).context.chainId).toBe(chainId);

    // A restarted owner keeps the rotated chain: its anchor validates against the catalog at block 8.
    const fresh=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(fresh);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'rotated-restart',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:fresh,nativeActionInterfaceVersion:1});
    await next.start();
    const restarted=await next.inspect();
    expect(restarted).toMatchObject({storeGeneration:1,anchor:8,head:{blockNum:11},settled:11});expect(restarted.previousStore).toBeUndefined();
    expect(await fresh.coverageEnd()).toBe(11);
});

/** A coordinator fixture as the indexer wires it: remembered binding records and the native store's hooks. */
async function rotating(blocks:number,options:{coordinator?:Record<string,unknown>}={}) {
    const provisioned:number[]=[],carried:string[][]=[];
    const f=await settled(blocks,{remember:true,coordinator:{provisionStoreGeneration:async(generation:number)=>{provisioned.push(generation);},
        carryForwardStoreRecords:async(selections:readonly string[])=>{carried.push([...selections]);},...options.coordinator}});
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);
    expect((await f.attest()).catalog).toEqual(link);await f.coordinator.recordSettled(8);
    return {...f,link,provisioned,carried};
}
const has=(f:Fixture,index:string,id:string)=>f.memory.documents.has(f.memory.key(f.chain+'-'+index,id));

test('a chain rotated while its head sat on the anchor restarts',async()=>{
    // Head 8, settled 8: the new chain is only its baseline at block 8, which is also its head.
    const f=await rotating(4);
    expect(await f.coordinator.rotateStores()).toBe(true);
    const control=await f.coordinator.inspect();
    expect(control).toMatchObject({storeGeneration:1,anchor:8,head:{blockNum:8}});
    // The restart reads that baseline as its head commit, which is valid only once the catalog reaches block 8.
    const fresh=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(fresh);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'anchor-restart',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:fresh,nativeActionInterfaceVersion:1});
    await next.start();
    expect(await next.inspect()).toMatchObject({storeGeneration:1,anchor:8,head:{blockNum:8,commitId:control.head!.commitId},catalog:f.link,settled:8});
    expect((await next.openSource(f.contextId,'restarted-session')).resumeFromBlock).toBe(9);
    // Without the segment the anchor cannot be validated: the start fails and the chain is kept, not replaced.
    const {segments_dir:_,...pinned}=f.g.config,blind=new DiskAbiHistoryCatalog(pinned,chainId,profile);catalogs.add(blind);
    const lost=new ProtocolAbiCoordinator({chainId,profile,ownerId:'anchor-blind',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:blind,nativeActionInterfaceVersion:1});
    await expect(lost.start()).rejects.toThrow();
    expect((await f.store.readControl())!.value).toMatchObject({ownerId:'anchor-restart',anchor:8,storeGeneration:1});
});

test('a rotated chain above its anchor refuses to start without the anchor segment',async()=>{
    const f=await rotating(6);
    expect(await f.coordinator.rotateStores()).toBe(true);
    const {segments_dir:_,...pinned}=f.g.config,blind=new DiskAbiHistoryCatalog(pinned,chainId,profile);catalogs.add(blind);
    const lost=new ProtocolAbiCoordinator({chainId,profile,ownerId:'tail-blind',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:blind,nativeActionInterfaceVersion:1});
    await expect(lost.start()).rejects.toThrow('anchored at catalog block 8');
    expect((await f.store.readControl())!.value).toMatchObject({ownerId:'attesting-owner',anchor:8,head:{blockNum:10}});
});

test('a replay that cannot read a record does not switch to an incomplete chain',async()=>{
    const f=await rotating(6);
    // Block 9's observation is unreadable while the new chain is built.
    const id=f.memory.key(f.chain+'-protocol-abi-observations-v1',f.sources[9].observationId!),kept=f.memory.documents.get(id);
    f.memory.documents.delete(id);
    const before=await f.coordinator.inspect();
    expect(await f.coordinator.rotateStores()).toBe(false);
    expect(await f.coordinator.inspect()).toMatchObject({head:before.head,phase:'following',gap:null});
    expect((await f.coordinator.inspect()).storeGeneration).toBeUndefined();
    // With the record back the same rotation completes.
    f.memory.documents.set(id,kept);
    expect(await f.coordinator.rotateStores()).toBe(true);
    expect(await f.coordinator.inspect()).toMatchObject({storeGeneration:1,head:{blockNum:10,coverageStart:1},phase:'following',gap:null});
});

test('processes that never saw the switch read through it, and a retired generation can really be deleted',async()=>{
    // As every process of a deployment configured to rotate.
    followProtocolStoreGenerations();
    const f=await rotating(6);
    // The API, started before the rotation: its own client, its own catalog, generation 0 as far as it knows.
    const apiClient=separate(f.memory.client),own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    const apiStore=new ProtocolAbiFrontierStore(apiClient as any,f.chain,0,{readOnly:true});
    const api=new ProtocolAbiProofReader({chainId,profile,store:apiStore,diskHistory:{catalog:own,
        bindings:new ProtocolSourceBindingStore(apiClient as any,f.chain,0,{readOnly:true}),
        observations:new ProtocolAbiObservationStore(apiClient as any,f.chain,0,undefined,{readOnly:true})}});
    expect((await api.open(f.sources[10].source,f.sources[10].selected)).source.blockNum).toBe(10);
    // A deserializer of the same vintage, which only ever reads selections.
    const worker=new ProtocolSourceBindingStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true});
    expect((await worker.readSelection(f.sources[10].selected)).selection.source.blockNum).toBe(10);

    expect(await f.coordinator.rotateStores()).toBe(true);
    expect(f.provisioned).toEqual([1]);
    // The reader that saw the switch first writes block 11 to generation 1.
    const next=await extend(f,11);
    expect(has(f,'protocol-source-bindings-v1-g1',next.selected)).toBe(true);expect(has(f,'protocol-source-bindings-v1',next.selected)).toBe(false);
    // Neither process was told. Each finds the record by reading control when its known generation has none.
    expect((await worker.readSelection(next.selected)).selection.source.blockNum).toBe(11);
    const view=await api.open(next.source,next.selected);
    expect((await api.action(view,next.action)).state.abiHex).toBe('bb');

    // Retire while blocks 9..11 are unsettled: everything they reference is carried into generation 1 first.
    for(const n of [9,10])expect(has(f,'protocol-source-bindings-v1-g1',f.sources[n].selected),'before '+n).toBe(false);
    expect(await f.coordinator.retirePreviousStore(-2,0)).toBe(0);
    for(const n of [9,10,11]){
        expect(has(f,'protocol-source-bindings-v1-g1',f.sources[n].selected),'selection '+n).toBe(true);
        expect(has(f,'protocol-abi-observations-v1-g1',f.sources[n].observationId!),'observation '+n).toBe(true);
    }
    expect(has(f,'protocol-source-bindings-v1-g1',f.contextId)).toBe(true);
    // The store the coordinator does not read was handed exactly the unsettled selections.
    expect(f.carried).toEqual([[11,10,9].map(n=>f.sources[n].selected)]);
    // Settled blocks were not carried: their documents are proven from disk.
    expect(has(f,'protocol-source-bindings-v1-g1',f.sources[6].selected)).toBe(false);

    dropGeneration(f,0);
    for(const index of protocolStoreGenerationIndices(f.chain,0))expect(f.memory.mappings.has(index),index).toBe(false);
    // Every unsettled block still proves, from a fresh process and from the two old ones.
    const late=new ProtocolAbiProofReader({chainId,profile,store:new ProtocolAbiFrontierStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        diskHistory:readerOptions({memory:{client:separate(f.memory.client)},chain:f.chain},own)});
    for(const reader of [late,api])for(const n of [9,10,11]){
        const opened=await reader.open(f.sources[n].source,f.sources[n].selected);
        expect((await reader.action(opened,f.sources[n].action)).state.abiHex,'block '+n).toBe('bb');
    }
    expect((await worker.readSelection(f.sources[9].selected)).selection.source.blockNum).toBe(9);
    // A writable process that still believes generation 0 is the previous one reads a record that is nowhere:
    // it reports it missing and does not bring the deleted index back.
    const stale=new ProtocolSourceBindingStore(separate(f.memory.client) as any,f.chain);
    (stale as any).bundles.generations.observe(1,0);
    await expect(stale.readSelection('h45srcsel1:'+'9'.repeat(64))).rejects.toMatchObject({code:'missing'});
    for(const index of protocolStoreGenerationIndices(f.chain,0))expect(f.memory.mappings.has(index),index).toBe(false);
    // The pipeline goes on in generation 1.
    expect((await extend(f,12)).selected).toMatch(/^h45srcsel1:/);
    expect((await f.coordinator.inspect()).head!.blockNum).toBe(12);
});

test('a second rotation follows the first, with the first generation gone',async()=>{
    const f=await rotating(6);
    expect(await f.coordinator.rotateStores()).toBe(true);
    await extend(f,11);
    let tip:DiskAbiHistoryTip={...f.link,lastGlobalSequence:sequenceAt(8),totalRecords:3};
    const seal=async(end:number)=>{const link=await segment(f.g.segments,tip,end,[],{lastGlobalSequence:sequenceAt(end)});
        tip={...link,lastGlobalSequence:sequenceAt(end),totalRecords:3};expect((await f.attest()).catalog).toEqual(link);await f.coordinator.recordSettled(end);};
    await seal(11);
    expect(await f.coordinator.retirePreviousStore(0,0)).toBe(0);dropGeneration(f,0);
    await extend(f,12);await extend(f,13);
    // Generation 1 is anchored at 8; the second rotation anchors at the newest settled link end, 11.
    expect(await f.coordinator.rotateStores()).toBe(true);
    expect(await f.coordinator.inspect()).toMatchObject({storeGeneration:2,anchor:11,previousStore:{generation:1,switchedAtBlock:13},head:{blockNum:13}});
    expect(f.provisioned).toEqual([1,2]);
    await extend(f,14);await seal(14);
    expect(await f.coordinator.retirePreviousStore(0,0)).toBe(1);dropGeneration(f,1);
    await extend(f,15);
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    const reader=new ProtocolAbiProofReader({chainId,profile,store:new ProtocolAbiFrontierStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        diskHistory:readerOptions({memory:{client:separate(f.memory.client)},chain:f.chain},own)});
    const view=await reader.open(f.sources[15].source,f.sources[15].selected);
    expect((await reader.action(view,f.sources[15].action)).state.abiHex).toBe('bb');expect((await reader.finalState(view,'beta')).abiHex).toBe('cc');
    // A restart reads the twice-rotated chain from generation 2 alone.
    const fresh=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(fresh);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'twice-rotated',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:fresh,nativeActionInterfaceVersion:1});
    await next.start();
    expect(await next.inspect()).toMatchObject({storeGeneration:2,anchor:11,head:{blockNum:15},settled:14});
});

test('blocks past bounded ancestry open through a rotation without waiting for a new address map',async()=>{
    const historicalCertificates={interfaceVersion:1,maxCommitsPerDrain:64,maxCommitBytesPerDrain:8*1024*1024,maxMillisecondsPerDrain:1000};
    const f=await rotating(6,{coordinator:{historicalCertificates}});
    for(let i=0;i<4;i++)await f.coordinator.drain();
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    // Two blocks of ancestry: block 9 is only reachable through the historical address map.
    const reader=new ProtocolAbiProofReader({chainId,profile,store:new ProtocolAbiFrontierStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        diskHistory:readerOptions({memory:{client:separate(f.memory.client)},chain:f.chain},own),historicalCertificates:true,maxAncestryBlocks:1});
    await extend(f,11);for(let i=0;i<4;i++)await f.coordinator.drain();
    const before=await f.coordinator.inspect();expect(before.historical).toBeDefined();
    expect((await reader.open(f.sources[9].source,f.sources[9].selected)).source.blockNum).toBe(9);
    expect(await f.coordinator.rotateStores()).toBe(true);
    // The switch itself publishes the new chain's map, anchored at its head: no drain has run since.
    const after=await f.coordinator.inspect();
    expect(after.historical).toMatchObject({interfaceVersion:1,anchor:{blockNum:11,commitId:after.head!.commitId}});
    expect(after.historical!.addressRootId).not.toBe(before.historical!.addressRootId);
    for(const n of [9,10]){
        const view=await reader.open(f.sources[n].source,f.sources[n].selected);
        expect(view.source.blockNum).toBe(n);expect((await reader.action(view,f.sources[n].action)).state.abiHex).toBe('bb');
    }
    // Later heads extend the same map.
    await extend(f,12);await extend(f,13);for(let i=0;i<4;i++)await f.coordinator.drain();
    expect((await f.coordinator.inspect()).historical!.anchor.blockNum).toBe(13);
    expect((await reader.open(f.sources[11].source,f.sources[11].selected)).source.blockNum).toBe(11);
});

test('sealed history stays provable while its owner has no source',async()=>{
    const f=await rotating(4);
    // A restarted owner that has not opened its source yet: control says awaiting-source.
    const fresh=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(fresh);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'no-source-yet',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:fresh,nativeActionInterfaceVersion:1});
    await next.start();expect(await next.inspect()).toMatchObject({phase:'awaiting-source',source:null,catalog:f.link});
    // A fresh API reader knows only the pinned catalog. It still follows the published link and proves block 6 from disk.
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    const reader=new ProtocolAbiProofReader({chainId,profile,store:new ProtocolAbiFrontierStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        diskHistory:readerOptions({memory:{client:separate(f.memory.client)},chain:f.chain},own),historicalCertificates:true});
    expect(await own.coverageEnd()).toBe(4);
    const view=await reader.open(f.sources[6].source,f.sources[6].selected);
    expect(await own.coverageEnd()).toBe(8);expect(view.certificateId).toBe(own.catalogId);
    expect((await reader.action(view,f.sources[6].action)).state.abiHex).toBe('bb');
    // By height as well, on a reader that has not followed anything yet.
    const second=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(second);
    const byHeight=new ProtocolAbiProofReader({chainId,profile,store:new ProtocolAbiFrontierStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        diskHistory:readerOptions({memory:{client:separate(f.memory.client)},chain:f.chain},second),historicalCertificates:true});
    expect((await byHeight.openHistorical(7)).source.blockId).toBe(block(7));
    // A block above the catalog still needs the live owner.
    await expect(reader.open({chainId,blockNum:9,blockId:block(9)},f.sources[6].selected)).rejects.toMatchObject({code:'authority_unavailable'});
});

test('an account that only ever held an empty ABI may come and go without a catalog record',async()=>{
    // gamma is first touched at block 6 and removed at block 7; the sealer records neither.
    const f=await settled(4,{finalStates:n=>n===6?[{account:'gamma',present:true,abiHex:'',deltaOrdinal:0}]
        :n===7?[{account:'gamma',present:false,abiHex:'',deltaOrdinal:0},{account:'beta',present:true,abiHex:'cc',deltaOrdinal:1}]:[]});
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);
    expect((await f.attest()).catalog).toEqual(link);expect(f.refused).toEqual([]);
});

test('a notification is checked against the ABI its original action ran under',async()=>{
    // Block 8: alpha's action runs under ABI bb, an inline action then deploys dd for alpha, and alpha's notification to
    // beta follows. Both derivations decode the notification with bb.
    const tx='d'.repeat(64),at=(offset:number)=>String(9007199254741100n+BigInt(offset));
    const origin={transactionId:tx,actionOrdinal:1,inputActionOrdinal:1,account:'alpha',receiver:'alpha',name:'act',rawHex:'01',globalSequence:at(0),receiptAbiSequence:'1'};
    const setter={transactionId:tx,actionOrdinal:2,inputActionOrdinal:2,account:'sys',receiver:'sys',name:'setabi',rawHex:'02',globalSequence:at(1),receiptAbiSequence:'0'};
    const notified={...origin,actionOrdinal:3,receiver:'beta',globalSequence:at(2),receiptAbiSequence:'0'};
    const f=await settled(4,{facts:n=>n!==8?undefined:{schemaVersion:1,actionInputs:[origin,setter,notified],
        deployments:[{account:'alpha',abiHex:'dd',action:{transactionId:tx,actionOrdinal:2},globalSequence:at(1),effect:'native-before-receipt'}],
        finalStates:[{account:'alpha',present:true,abiHex:'dd',deltaOrdinal:0}]}});
    expect((await f.coordinator.inspect()).head).toMatchObject({blockNum:8,coverageStart:1});
    const link=await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc'),
        {account:'alpha',blockNum:8,blockId:block(8),phase:'deployment',present:true,abiHex:'dd',abiSequence:'2',action:{transactionId:tx,actionOrdinal:2,globalSequence:at(1)}}],
        {lastGlobalSequence:at(2)});
    const control=await f.attest();
    expect(f.refused).toEqual([]);expect(control.catalog).toEqual(link);
});

test('retirement also carries what the commits do not name, and trusts settling only as far as it was verified',async()=>{
    followProtocolStoreGenerations();
    const f=await rotating(6);
    const capture=(n:number)=>{const source=f.sources[n].source,sections={kind:'unattested-ship-result-sections-v1' as const,schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'};
        return {source,captureSha256:protocolAbiCaptureDigest(source,sections)};};
    // A repair reader captured block 10 for itself: another selection of the same source, which the documents it
    // wrote name and no commit does.
    const repair=(await f.bindings.prepareSelection({schemaVersion:1,contextId:f.contextId,readerSessionId:'repair-session',readerRole:'repair',assignmentId:'r1',
        ...capture(10),frameSha256:'e'.repeat(64),head:{blockNum:10,blockId:block(10)},irreversible:{blockNum:10,blockId:block(10)}})).id;
    expect(repair).not.toBe(f.sources[10].selected);
    await f.bindings.prepareObservationLink({schemaVersion:1,selectionId:repair,observationId:f.sources[10].observationId!,observationDigest:f.sources[10].observationDigest!});
    // Block 11 is admitted but its deserializer has not linked an observation yet: it stays pending through the switch.
    const source={chainId,blockNum:11,blockId:block(11),previousBlockId:block(10)};
    const sections={kind:'unattested-ship-result-sections-v1' as const,schemaJson,blockHex:'01',tracesHex:'02',deltasHex:'03'},captureSha256=protocolAbiCaptureDigest(source,sections);
    const waiting=(await f.bindings.prepareSelection({schemaVersion:1,contextId:f.contextId,readerSessionId:'live-session',readerRole:'live',assignmentId:null,
        source,frameSha256:'e'.repeat(64),captureSha256,head:{blockNum:11,blockId:block(11)},irreversible:{blockNum:11,blockId:block(11)}})).id;
    await f.coordinator.admit(waiting,(await f.coordinator.inspect()).generation);await f.coordinator.drain();
    expect((await f.coordinator.inspect()).pending).toEqual([waiting]);

    expect(await f.coordinator.rotateStores()).toBe(true);
    expect((await f.coordinator.inspect()).pending).toEqual([waiting]);
    // Settling moves on to block 10 after the documents were verified through block 8.
    const next=await segment(f.g.segments,{...f.link,lastGlobalSequence:sequenceAt(8),totalRecords:3},10,[],{lastGlobalSequence:sequenceAt(10)});
    expect((await f.attest()).catalog).toEqual(next);await f.coordinator.recordSettled(10);
    for(const id of [repair,waiting,f.sources[9].selected,f.sources[10].selected])expect(has(f,'protocol-source-bindings-v1-g1',id),id).toBe(false);
    const nowhere='h45srcsel1:'+'f'.repeat(64);
    expect(await f.coordinator.retirePreviousStore(0,0,Date.now(),{through:8,selections:[repair,nowhere]})).toBe(0);
    // Blocks 9 and 10 settled after the check, so they still count as unsettled; the repair selection and the pending
    // one moved with them; a selection the documents name that is in no generation is skipped.
    for(const id of [repair,waiting,f.sources[9].selected,f.sources[10].selected])expect(has(f,'protocol-source-bindings-v1-g1',id),id).toBe(true);
    expect(has(f,'protocol-abi-observations-v1-g1',f.sources[10].observationId!)).toBe(true);
    expect(f.carried.at(-1)).toEqual(expect.arrayContaining([repair,waiting,nowhere,f.sources[9].selected]));
    dropGeneration(f,0);
    // The API proves a document that names the repair selection, and the pending block commits once it is linked.
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    const equivalence=new ProtocolSourceEquivalence(new ProtocolSourceBindingStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        new ProtocolAbiObservationStore(separate(f.memory.client) as any,f.chain,0,undefined,{readOnly:true}));
    expect((await equivalence.open(repair,f.sources[10].selected,await f.store.readCommit((await f.coordinator.inspect()).head!.commitId) as any))).toBeDefined();
    const prepared=await f.observations.prepare({schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture:sections,
        observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[input(sequenceAt(11))],deployments:[],finalStates:[]}}});
    await f.bindings.prepareObservationLink({schemaVersion:1,selectionId:waiting,observationId:prepared.id,observationDigest:prepared.digest});
    await f.coordinator.drain();
    expect(await f.coordinator.inspect()).toMatchObject({head:{blockNum:11},pending:[]});
});

test('a new pinned catalog ahead of a rotated chain replaces it, and a profile change is not held up by the old link',async()=>{
    const f=await rotating(6);
    expect(await f.coordinator.rotateStores()).toBe(true);
    expect(await f.coordinator.inspect()).toMatchObject({storeGeneration:1,anchor:8,head:{blockNum:10}});
    // The segment chain is compacted into a pinned catalog through block 12, in its own directory.
    const compacted=await genesis(12);
    const catalog=new DiskAbiHistoryCatalog(compacted.config,chainId,profile);catalogs.add(catalog);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'compacted-owner',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:catalog,nativeActionInterfaceVersion:1});
    await next.start();
    const control=await next.inspect();
    // The chain starts over at the new baseline, in the generation the stores are at, with no rotation anchor,
    // and without the link and checkpoint that belonged to the old segments.
    expect(control).toMatchObject({head:{blockNum:12,blockId:block(12)},storeGeneration:1,gap:null});
    expect(control.anchor).toBeUndefined();expect(control.catalog).toBeUndefined();expect(control.settled).toBeUndefined();
    expect((await next.openSource(f.contextId,'compacted-session')).resumeFromBlock).toBe(13);
    // Another profile on the old catalog: its chain is not kept either, so the link it cannot follow does not matter.
    const other={...profile,profileId:'another-consumer-profile'};
    const g=await rotating(6);expect(await g.coordinator.rotateStores()).toBe(true);
    const {segments_dir:__,...alone}=g.g.config,changed=new DiskAbiHistoryCatalog(alone,chainId,other);catalogs.add(changed);
    const third=new ProtocolAbiCoordinator({chainId,profile:other,ownerId:'other-profile',bindings:g.bindings,observations:g.observations,store:g.store,
        diskAbiHistory:changed,nativeActionInterfaceVersion:1});
    await third.start();
    expect((await third.inspect()).anchor).toBeUndefined();expect((await third.inspect()).head).toMatchObject({blockNum:4});
});

test('a chain rotated onto its own head queues no address for the baseline',async()=>{
    const historicalCertificates={interfaceVersion:1,maxCommitsPerDrain:64,maxCommitBytesPerDrain:8*1024*1024,maxMillisecondsPerDrain:1000};
    const f=await rotating(4,{coordinator:{historicalCertificates}});
    for(let i=0;i<3;i++)await f.coordinator.drain();
    expect(await f.coordinator.rotateStores()).toBe(true);
    for(let i=0;i<4;i++)await f.coordinator.drain();
    // The catalog answers for block 8; the new chain's map begins with the first block above it.
    const control=await f.coordinator.inspect();expect(control).toMatchObject({anchor:8,head:{blockNum:8}});expect(control.historical).toBeUndefined();
    await extend(f,9);for(let i=0;i<4;i++)await f.coordinator.drain();
    expect((await f.coordinator.inspect()).historical).toMatchObject({anchor:{blockNum:9}});
});

test('a cancelled read stops waiting for a catalog that is still following, and the next read finds it covered',async()=>{
    const f=await settled(4);
    await segment(f.g.segments,f.g.tip,8,[final('beta',7,'cc')]);await f.attest();
    // A reader that starts late has the whole chain to verify: hold that walk open as a long chain would.
    const own=new DiskAbiHistoryCatalog(f.g.config,chainId,profile);catalogs.add(own);
    let release!:()=>void,walks=0;const held=new Promise<void>(yes=>{release=yes;}),follow=own.follow.bind(own);
    own.follow=link=>{walks++;return held.then(()=>follow(link));};
    const reader=new ProtocolAbiProofReader({chainId,profile,store:f.store.asReadOnly(),diskHistory:readerOptions(f,own)});
    const controller=new AbortController(),read=reader.open(f.sources[6].source,f.sources[6].selected,{signal:controller.signal});
    const outcome=read.then(()=>'opened',error=>error.code);
    await new Promise(yes=>setTimeout(yes,20));expect(walks).toBe(1);
    controller.abort();
    expect(await Promise.race([outcome,new Promise(yes=>setTimeout(()=>yes('still waiting'),1000))])).toBe('proof_cancelled');
    expect(await own.coverageEnd()).toBe(4);
    // The walk was not the read's: it finishes, and the catalog covers the block for whoever reads next.
    release();
    const view=await reader.open(f.sources[6].source,f.sources[6].selected);
    expect(await own.coverageEnd()).toBe(8);expect(view.certificateId).toBe(own.catalogId);
});

/** The chain through `link` as one complete catalog that stands in for it, in a directory of its own. */
async function compaction(f:Fixture,rows:any[],link:{manifestSha256:string;endBlock:number;lastBlockId:string}) {
    const directory=await mkdtemp(join(tmpdir(),'h45-catalog-compact-')),end=link.endBlock,rowBytes=lines(rows);
    const idBytes=Buffer.from(Array.from({length:end},(_,i)=>block(i+1)).join(''),'hex');
    await writeFile(join(directory,'abi.ndjson'),rowBytes);await writeFile(join(directory,'blocks.bin'),idBytes);
    const manifest={format:'hyperion-wire-abi-history-v1',complete:true,chainId,nodeRevision,producerProfileId:'producer-profile',
        shipAbiSha256:hash(schemaJson),startBlock:1,endBlock:end,firstBlockId:block(1),lastBlockId:block(end),irreversibleBoundary:{blockNum:end,blockId:block(end)},
        lastGlobalSequence:sequenceAt(end),deployments:{name:'abi.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:'blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:end},compacts:link,lineage:{manifestSha256:f.g.config.manifest_sha256}};
    const bytes=JSON.stringify(manifest)+'\n',path=join(directory,'manifest.json');await writeFile(path,bytes);
    return {...f.g.config,manifest:path,manifest_sha256:hash(bytes),lineage_sha256:f.g.config.manifest_sha256} as DiskAbiHistoryConfiguration;
}

test('a compaction pinned at or below the rotation anchor keeps the rotated chain, and one past the anchor is refused',async()=>{
    // Generation 1 is anchored at block 8, generation 0 is gone, links end at 8 and 11, the head is at 13.
    const f=await rotating(6);
    expect(await f.coordinator.rotateStores()).toBe(true);
    await extend(f,11);
    const later=await segment(f.g.segments,{...f.link,lastGlobalSequence:sequenceAt(8),totalRecords:3},11,[],{lastGlobalSequence:sequenceAt(11)});
    expect((await f.attest()).catalog).toEqual(later);await f.coordinator.recordSettled(11);
    expect(await f.coordinator.retirePreviousStore(0,0)).toBe(0);dropGeneration(f,0);
    await extend(f,12);await extend(f,13);
    const before=await f.coordinator.inspect();
    expect(before).toMatchObject({storeGeneration:1,anchor:8,head:{blockNum:13},catalog:later,settled:11});
    const rows=[final('alpha',1,'aa'),deploy(2,'9007199254740993','bb','1'),final('beta',7,'cc')];

    const config=await compaction(f,rows,f.link);
    // An API process moves to the compaction first, while the indexer still runs on the old pin: it proves a
    // live block from the same stores and reads a sealed one from the catalog.
    const own=new DiskAbiHistoryCatalog(config,chainId,profile);catalogs.add(own);
    const reader=new ProtocolAbiProofReader({chainId,profile,store:new ProtocolAbiFrontierStore(separate(f.memory.client) as any,f.chain,0,{readOnly:true}),
        diskHistory:readerOptions({memory:{client:separate(f.memory.client)},chain:f.chain},own)});
    const view=await reader.open(f.sources[13].source,f.sources[13].selected);
    expect((await reader.action(view,f.sources[13].action)).state.abiHex).toBe('bb');expect((await reader.finalState(view,'beta')).abiHex).toBe('cc');
    expect(await own.coverageEnd()).toBe(11);expect((await own.finalState('beta',9))?.abiHex).toBe('cc');

    // A compaction past the anchor cannot validate the chain's baseline: the start fails and nothing is replaced.
    const past=new DiskAbiHistoryCatalog(await compaction(f,rows,later),chainId,profile);catalogs.add(past);
    expect(past.catalogId).toBe(f.catalog.catalogId);
    const refused=new ProtocolAbiCoordinator({chainId,profile,ownerId:'past-anchor',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:past,nativeActionInterfaceVersion:1});
    await expect(refused.start()).rejects.toThrow('a pinned compaction must end at or below the anchor');
    expect((await f.store.readControl())!.value).toMatchObject({ownerId:'attesting-owner',anchor:8,storeGeneration:1,head:before.head});

    // A compaction that ends at the anchor: the same lineage, so the commits, the anchor, the link and the
    // checkpoint are all kept, and the segment after the compacted link is followed from it.
    const pinned=new DiskAbiHistoryCatalog(config,chainId,profile);catalogs.add(pinned);
    const next=new ProtocolAbiCoordinator({chainId,profile,ownerId:'compacted-restart',bindings:f.bindings,observations:f.observations,store:f.store,
        diskAbiHistory:pinned,nativeActionInterfaceVersion:1});
    await next.start();
    expect(await next.inspect()).toMatchObject({storeGeneration:1,anchor:8,head:before.head,catalog:later,settled:11,gap:null});
    expect(await pinned.coverageEnd()).toBe(11);expect(await pinned.boundaries()).toEqual([8,11]);
    expect((await next.openSource(f.contextId,'compacted-session')).resumeFromBlock).toBe(14);
});
