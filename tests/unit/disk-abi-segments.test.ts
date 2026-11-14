import {test,expect,afterAll} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskAbiHistoryCatalog,type DiskAbiHistoryConfiguration,type DiskAbiHistoryTip} from '../../src/indexer/protocol/disk-abi-history.js';
import type {ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';

// Segments in the sealer's own layout: abi-history.<start>-<end>.ndjson, .ndjson.blocks.bin, .ndjson.manifest.json.
const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const chainId='1'.repeat(64),block=(n:number)=>n.toString(16).padStart(64,'0'),schemaJson='{}',nodeRevision='c'.repeat(40);
const profile:ProtocolSourceProfile={id:'fixture',profileId:'consumer-profile',components:[{id:'fixture',runtime:'node',version:'1.0.0',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const catalogs=new Set<DiskAbiHistoryCatalog>();
afterAll(async()=>{await Promise.all([...catalogs].map(catalog=>catalog.close()));});
const final=(account:string,blockNum:number,abiHex:string,abiSequence='0',present=true)=>({account,blockNum,blockId:block(blockNum),phase:'block-final',present,abiHex,abiSequence,deltaOrdinal:0});
const deploy=(account:string,n:number,seq:string,abi:string,abiSequence:string)=>({account,blockNum:n,blockId:block(n),phase:'deployment',present:true,abiHex:abi,abiSequence,
    action:{transactionId:'a'.repeat(64),actionOrdinal:2,globalSequence:seq}});
const input=(account:string,globalSequence:string,receiptAbiSequence:string)=>({transactionId:'a'.repeat(64),actionOrdinal:1,inputActionOrdinal:1,
    account,receiver:account,name:'act',rawHex:'01',globalSequence,receiptAbiSequence});
const lines=(rows:any[])=>rows.map(row=>JSON.stringify(row)+'\n').join('');

async function genesis(rows:any[],end:number) {
    const directory=await mkdtemp(join(tmpdir(),'h45-abi-segments-')),segments=join(directory,'segments');await mkdir(segments);
    const rowBytes=lines(rows),idBytes=Buffer.from(Array.from({length:end},(_,i)=>block(i+1)).join(''),'hex');
    await writeFile(join(directory,'abi.ndjson'),rowBytes);await writeFile(join(directory,'blocks.bin'),idBytes);
    const manifest={format:'hyperion-wire-abi-history-v1',complete:true,chainId,nodeRevision,producerProfileId:'producer-profile',
        shipAbiSha256:hash(schemaJson),startBlock:1,endBlock:end,firstBlockId:block(1),lastBlockId:block(end),irreversibleBoundary:{blockNum:end,blockId:block(end)},
        lastGlobalSequence:'100',deployments:{name:'abi.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:'blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:end}};
    const bytes=JSON.stringify(manifest),path=join(directory,'manifest.json');await writeFile(path,bytes);
    const config:DiskAbiHistoryConfiguration={interface_version:1,manifest:path,manifest_sha256:hash(bytes),producer_profile_id:'producer-profile',
        node_revision:nodeRevision,ship_abi_sha256:hash(schemaJson),segments_dir:segments};
    return {config,segments,tip:{manifestSha256:hash(bytes),endBlock:end,lastBlockId:block(end),lastGlobalSequence:'100',totalRecords:rows.length} as DiskAbiHistoryTip};
}
interface SegmentOptions {ids?:string[];lastGlobalSequence?:string|null;records?:number;totalRecords?:number;base?:Partial<{manifestSha256:string;endBlock:number;lastBlockId:string}>;name?:string;lastBlockId?:string}
async function segment(dir:string,tip:DiskAbiHistoryTip,end:number,rows:any[],options:SegmentOptions={}) {
    const start=tip.endBlock+1,stem=options.name??`abi-history.${String(start).padStart(10,'0')}-${String(end).padStart(10,'0')}`;
    const ids=options.ids??Array.from({length:end-start+1},(_,i)=>block(start+i)),rowBytes=lines(rows),idBytes=Buffer.from(ids.join(''),'hex');
    await writeFile(join(dir,stem+'.ndjson'),rowBytes);await writeFile(join(dir,stem+'.ndjson.blocks.bin'),idBytes);
    const lastGlobalSequence=options.lastGlobalSequence===undefined?'200':options.lastGlobalSequence,records=options.records??rows.length;
    const manifest={format:'hyperion-abi-history-segment-v1',chainId,nodeRevision,producerProfileId:'producer-profile',producerRevision:'d'.repeat(40),
        shipAbiSha256:hash(schemaJson),base:{manifestSha256:tip.manifestSha256,endBlock:tip.endBlock,lastBlockId:tip.lastBlockId,...options.base},
        startBlock:start,endBlock:end,startBlockId:ids[0],lastBlockId:options.lastBlockId??ids.at(-1),irreversibleBoundary:{blockNum:end,blockId:options.lastBlockId??ids.at(-1)},complete:true,
        lastGlobalSequence,totalRecords:options.totalRecords??tip.totalRecords+records,
        deployments:{name:stem+'.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records},
        blockIds:{name:stem+'.ndjson.blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:end-start+1}};
    const text=JSON.stringify(manifest)+'\n';await writeFile(join(dir,stem+'.ndjson.manifest.json'),text);
    return {manifestSha256:hash(text),endBlock:end,lastBlockId:ids.at(-1)!,lastGlobalSequence,totalRecords:manifest.totalRecords} as DiskAbiHistoryTip;
}
const open=(config:DiskAbiHistoryConfiguration)=>{const catalog=new DiskAbiHistoryCatalog(config,chainId,profile);catalogs.add(catalog);return catalog;};

test('a verified segment answers for its blocks before adoption and extends coverage only once adopted',async()=>{
    const g=await genesis([final('alpha',1,'aa')],4),catalog=open(g.config);
    await segment(g.segments,g.tip,7,[deploy('alpha',6,'150','bb','1'),final('beta',7,'cc')]);
    const baseline=await catalog.baseline(),pending=(await catalog.nextSegment())!;
    expect(pending.link).toMatchObject({startBlock:5,endBlock:7,baseSha256:g.tip.manifestSha256,totalRecords:3});
    expect(pending.blockId(6)).toBe(block(6));expect(pending.changedAt(6)).toEqual(['alpha']);expect(pending.changedAt(5)).toEqual([]);
    expect(pending.finalState('alpha',5)?.abiHex).toBe('aa');expect(pending.finalState('alpha',6)?.abiHex).toBe('bb');
    expect(pending.actionState(input('alpha','149','0'),6)?.abiHex).toBe('aa');expect(pending.actionState(input('alpha','151','1'),6)?.abiHex).toBe('bb');
    expect(pending.finalState('beta',6)).toBeNull();expect(pending.finalState('beta',7)?.abiHex).toBe('cc');
    // Not covered until adopted.
    expect(await catalog.covers({chainId,blockNum:6,blockId:block(6)})).toBe(false);expect(await catalog.coverageEnd()).toBe(4);
    await expect(catalog.finalState('alpha',6)).rejects.toThrow('outside covered range');
    const tip=await catalog.adopt(pending);
    expect(tip).toMatchObject({endBlock:7,lastBlockId:block(7),totalRecords:3});
    expect(await catalog.coverageEnd()).toBe(7);expect(await catalog.covers({chainId,blockNum:6,blockId:block(6)})).toBe(true);
    await expect(catalog.covers({chainId,blockNum:6,blockId:block(66)})).rejects.toThrow('pinned irreversible');
    expect((await catalog.source(5)).previousBlockId).toBe(block(4));
    expect((await catalog.finalState('alpha',7))?.abiHex).toBe('bb');expect((await catalog.actionState(input('alpha','151','1'),6))?.abiHex).toBe('bb');
    expect(catalog.matchesState((await catalog.finalState('beta',7))!)).toBe(true);
    // The anchor and the lineage do not move.
    expect(await catalog.baseline()).toEqual(baseline);expect(baseline.source.blockNum).toBe(4);expect(baseline.states.map(state=>state.account)).toEqual(['alpha']);
    expect((await catalog.finalState('beta',7))!.source.catalogId).toBe(catalog.catalogId);
    // Adopting the same segment again changes nothing; no further segment is offered.
    expect(await catalog.adopt(pending)).toEqual(tip);expect(await catalog.nextSegment()).toBeUndefined();
});

test('segments that do not extend the adopted tip exactly are refused',async()=>{
    const cases:[string,(g:Awaited<ReturnType<typeof genesis>>)=>Promise<unknown>,string][]=[
        ['wrong base digest',g=>segment(g.segments,g.tip,6,[],{base:{manifestSha256:'e'.repeat(64)}}),'none'],
        ['wrong base end',g=>segment(g.segments,g.tip,6,[],{base:{endBlock:3}}),'does not name'],
        ['wrong base id',g=>segment(g.segments,g.tip,6,[],{base:{lastBlockId:block(9)}}),'does not name'],
        ['record count',g=>segment(g.segments,g.tip,6,[final('alpha',6,'bb')],{records:2}),'row count mismatch'],
        ['chain count',g=>segment(g.segments,g.tip,6,[],{totalRecords:5}),'member count'],
        ['global sequence back',g=>segment(g.segments,g.tip,6,[],{lastGlobalSequence:'99'}),'global sequence'],
        ['global sequence lost',g=>segment(g.segments,g.tip,6,[],{lastGlobalSequence:null}),'global sequence'],
        ['row outside segment',g=>segment(g.segments,g.tip,6,[final('alpha',4,'bb')]),'invalid sparse ABI row'],
        ['row id differs',g=>segment(g.segments,g.tip,6,[{...final('alpha',6,'bb'),blockId:block(60)}]),'differs from its block identity'],
        ['boundary id differs',g=>segment(g.segments,g.tip,6,[],{lastBlockId:block(61)}),'boundary identity'],
    ];
    for(const [name,make,expected] of cases){
        const g=await genesis([final('alpha',1,'aa')],4),catalog=open(g.config);await make(g);
        if(expected==='none'){expect(await catalog.nextSegment(),name).toBeUndefined();continue;}
        await expect(catalog.nextSegment(),name).rejects.toThrow(expected);
        expect(await catalog.coverageEnd(),name).toBe(4);
    }
    // A tampered member is refused by digest.
    const g=await genesis([],4),catalog=open(g.config);await segment(g.segments,g.tip,6,[final('alpha',6,'bb')]);
    await writeFile(join(g.segments,'abi-history.0000000005-0000000006.ndjson'),lines([final('alpha',6,'cc')]));
    await expect(catalog.nextSegment()).rejects.toThrow('digest');
    // Two candidates for one base are ambiguous: neither is offered.
    const h=await genesis([],4),ambiguous=open(h.config);await segment(h.segments,h.tip,6,[]);await segment(h.segments,h.tip,7,[]);
    expect(await ambiguous.nextSegment()).toBeUndefined();
    // A file that is not a manifest yet is skipped, then read once it changes.
    const k=await genesis([],4),late=open(k.config);await writeFile(join(k.segments,'abi-history.0000000005-0000000006.ndjson.manifest.json'),'{');
    expect(await late.nextSegment()).toBeUndefined();
    await segment(k.segments,k.tip,6,[]);expect((await late.nextSegment())?.link.endBlock).toBe(6);
});

test('follow adopts a chain up to a published link and refuses a link that differs from coverage',async()=>{
    const g=await genesis([final('alpha',1,'aa')],4);
    const first=await segment(g.segments,g.tip,6,[final('alpha',6,'bb')]),second=await segment(g.segments,first,9,[final('alpha',8,'cc')],{lastGlobalSequence:'300'});
    const third=await segment(g.segments,second,12,[],{lastGlobalSequence:'300'});
    const reader=open(g.config);
    expect(await reader.follow({manifestSha256:second.manifestSha256,endBlock:9,lastBlockId:block(9)})).toBe(true);
    expect(await reader.coverageEnd()).toBe(9);expect((await reader.finalState('alpha',8))?.abiHex).toBe('cc');
    expect(await reader.follow({manifestSha256:first.manifestSha256,endBlock:6,lastBlockId:block(6)})).toBe(true);
    await expect(reader.follow({manifestSha256:first.manifestSha256,endBlock:6,lastBlockId:block(7)})).rejects.toThrow('differs from coverage');
    // Beyond what the directory holds: not covered yet, and nothing past it is adopted.
    expect(await reader.follow({manifestSha256:'f'.repeat(64),endBlock:20,lastBlockId:block(20)})).toBe(false);
    expect(await reader.coverageEnd()).toBe(12);expect(third.endBlock).toBe(12);
    // A catalog without a segments directory never moves.
    const {segments_dir:_,...withoutSegments}=g.config,pinned=open(withoutSegments);
    expect(await pinned.nextSegment()).toBeUndefined();
    expect(await pinned.follow({manifestSha256:first.manifestSha256,endBlock:6,lastBlockId:block(6)})).toBe(false);
    expect(await pinned.coverageEnd()).toBe(4);
});
