import {test,expect,afterAll} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
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
    // Beyond what the directory holds: not covered yet, and no part of the chain toward it is adopted.
    expect(await reader.follow({manifestSha256:'f'.repeat(64),endBlock:20,lastBlockId:block(20)})).toBe(false);
    expect(await reader.coverageEnd()).toBe(9);
    expect(await reader.follow({manifestSha256:third.manifestSha256,endBlock:12,lastBlockId:block(12)})).toBe(true);
    expect(await reader.coverageEnd()).toBe(12);
    // A covered height reached through another digest is not the published link.
    await expect(reader.follow({manifestSha256:'e'.repeat(64),endBlock:12,lastBlockId:block(12)})).rejects.toThrow('differs from coverage');
    // A catalog without a segments directory never moves.
    const {segments_dir:_,...withoutSegments}=g.config,pinned=open(withoutSegments);
    expect(await pinned.nextSegment()).toBeUndefined();
    expect(await pinned.follow({manifestSha256:first.manifestSha256,endBlock:6,lastBlockId:block(6)})).toBe(false);
    expect(await pinned.coverageEnd()).toBe(4);
});

test('a reader that starts late follows a long chain in one pass, and readers that arrive together share it',async()=>{
    // More links than the old walk allowed, so a late reader could never have reached the published link.
    const g=await genesis([final('alpha',1,'aa')],4),links=4100;let tip=g.tip;
    for(let i=0;i<links;i++)tip=await segment(g.segments,tip,tip.endBlock+1,i===links-1?[final('alpha',tip.endBlock+1,'bb')]:[]);
    const link={manifestSha256:tip.manifestSha256,endBlock:tip.endBlock,lastBlockId:tip.lastBlockId};
    const reader=open(g.config),internals=reader as any;let listings=0,verified=0;
    const unadopted=internals.unadopted.bind(reader),verifySegment=internals.verifySegment.bind(reader);
    internals.unadopted=(...args:unknown[])=>{listings++;return unadopted(...args);};
    internals.verifySegment=(...args:unknown[])=>{verified++;return verifySegment(...args);};
    expect(await Promise.all(Array.from({length:8},()=>reader.follow(link)))).toEqual(Array(8).fill(true));
    // One listing of the directory and one verification a segment, whatever the chain's length and however many wait.
    expect({listings,verified}).toEqual({listings:1,verified:links});
    expect(await reader.coverageEnd()).toBe(4+links);expect((await reader.finalState('alpha',4+links))?.abiHex).toBe('bb');
    // A later link costs its own segment: adopted manifests are not looked at again.
    const next=await segment(g.segments,tip,tip.endBlock+2,[]);
    const before=internals.peeked.size;
    expect(await reader.follow({manifestSha256:next.manifestSha256,endBlock:next.endBlock,lastBlockId:next.lastBlockId})).toBe(true);
    expect({listings,verified,peeked:internals.peeked.size}).toEqual({listings:2,verified:links+1,peeked:before+1});
    // A failed follow does not hold up the next one.
    await expect(reader.follow({manifestSha256:'e'.repeat(64),endBlock:next.endBlock,lastBlockId:next.lastBlockId})).rejects.toThrow('differs from coverage');
    expect(await reader.follow({manifestSha256:next.manifestSha256,endBlock:next.endBlock,lastBlockId:next.lastBlockId})).toBe(true);
},60000);

test('a walk that fails is walked once for everyone waiting on its link, and again only when asked again',async()=>{
    const g=await genesis([final('alpha',1,'aa')],4),links=40,broken=30;let tip=g.tip;const paths:string[]=[];
    for(let i=0;i<links;i++){
        paths.push(join(g.segments,`abi-history.${String(tip.endBlock+1).padStart(10,'0')}-${String(tip.endBlock+1).padStart(10,'0')}.ndjson.blocks.bin`));
        tip=await segment(g.segments,tip,tip.endBlock+1,[]);}
    const link={manifestSha256:tip.manifestSha256,endBlock:tip.endBlock,lastBlockId:tip.lastBlockId};
    await writeFile(paths[broken],Buffer.from(block(999),'hex'));
    const reader=open(g.config),internals=reader as any;let verified=0;
    const verifySegment=internals.verifySegment.bind(reader);
    internals.verifySegment=(...args:unknown[])=>{verified++;return verifySegment(...args);};
    const outcomes=await Promise.all(Array.from({length:8},()=>reader.follow(link).then(()=>'followed',()=>'failed')));
    expect(outcomes).toEqual(Array(8).fill('failed'));
    // The eight shared one walk up to the unreadable segment. Nothing of it was adopted.
    expect(verified).toBe(broken+1);expect(await reader.coverageEnd()).toBe(4);expect(internals.followed.size).toBe(0);
    // Another link asked for at the same time has its own follow, after the first.
    const other={...link,manifestSha256:'e'.repeat(64)};
    const both=await Promise.all([reader.follow(link),reader.follow(other),reader.follow(link)].map(run=>run.then(()=>'followed',()=>'failed')));
    expect(both).toEqual(['failed','failed','failed']);expect(verified).toBe(3*(broken+1));
    // Once the segment is readable, the next caller walks the chain and adopts it.
    await writeFile(paths[broken],Buffer.from(block(4+broken+1),'hex'));
    expect(await reader.follow(link)).toBe(true);expect(await reader.coverageEnd()).toBe(4+links);
});

test('one walk reaches a link whose segment was sealed after the walk listed the directory',async()=>{
    const g=await genesis([final('alpha',1,'aa')],4),links=20;let tip=g.tip;
    for(let i=0;i<links-1;i++)tip=await segment(g.segments,tip,tip.endBlock+1,[]);
    // The last segment is built elsewhere to learn its link, and appears in the directory during the walk.
    const staged=await genesis([final('alpha',1,'aa')],4);let stagedTip=staged.tip;
    for(let i=0;i<links-1;i++)stagedTip=await segment(staged.segments,stagedTip,stagedTip.endBlock+1,[]);
    expect(stagedTip.manifestSha256).toBe(tip.manifestSha256);
    const last=await segment(staged.segments,stagedTip,stagedTip.endBlock+1,[final('alpha',stagedTip.endBlock+1,'bb')]);
    const reader=open(g.config),internals=reader as any;let listings=0,verified=0;
    const unadopted=internals.unadopted.bind(reader),verifySegment=internals.verifySegment.bind(reader);
    internals.unadopted=(...args:unknown[])=>{listings++;return unadopted(...args);};
    internals.verifySegment=async(...args:unknown[])=>{if(++verified===1)await segment(g.segments,tip,tip.endBlock+1,[final('alpha',tip.endBlock+1,'bb')]);return verifySegment(...args);};
    expect(await reader.follow({manifestSha256:last.manifestSha256,endBlock:last.endBlock,lastBlockId:last.lastBlockId})).toBe(true);
    expect({listings,verified}).toEqual({listings:2,verified:links});
    expect((await reader.finalState('alpha',4+links))?.abiHex).toBe('bb');
    // A link the directory cannot reach has it listed twice and stays out of reach; nothing more is adopted.
    expect(await reader.follow({manifestSha256:'e'.repeat(64),endBlock:4+links+5,lastBlockId:block(4+links+5)})).toBe(false);
    expect({listings,verified}).toEqual({listings:4,verified:links});expect(await reader.coverageEnd()).toBe(4+links);
});

test('a followed chain becomes visible at once, and a removed file is forgotten',async()=>{
    const g=await genesis([final('alpha',1,'aa')],4),links=300;let tip=g.tip;
    for(let i=0;i<links;i++)tip=await segment(g.segments,tip,tip.endBlock+1,[final('alpha',tip.endBlock+1,'b'+i.toString(16).padStart(3,'0'))]);
    const reader=open(g.config),internals=reader as any,seen=new Set<number>();await reader.coverageEnd();
    let done=false;const sampling=(async()=>{while(!done){seen.add(internals.loaded.end);await new Promise(yes=>setImmediate(yes));}})();
    expect(await reader.follow({manifestSha256:tip.manifestSha256,endBlock:tip.endBlock,lastBlockId:tip.lastBlockId})).toBe(true);
    done=true;await sampling;seen.add(internals.loaded.end);
    expect([...seen].sort((left,right)=>left-right)).toEqual([4,4+links]);
    expect((await reader.finalState('alpha',4+links))?.abiHex).toBe('b12b');expect((await reader.finalState('alpha',5))?.abiHex).toBe('b000');
    // A removed manifest is forgotten even when something that is not a manifest file took a place in the listing.
    const name=`abi-history.${String(5).padStart(10,'0')}-${String(5).padStart(10,'0')}.ndjson.manifest.json`,removed=join(g.segments,name);
    expect(internals.peeked.has(removed)).toBe(true);
    await rm(removed);await mkdir(join(g.segments,'not-a-file.manifest.json'));
    const next=await segment(g.segments,tip,tip.endBlock+1,[]);
    expect(await reader.follow({manifestSha256:next.manifestSha256,endBlock:next.endBlock,lastBlockId:next.lastBlockId})).toBe(true);
    expect(internals.peeked.has(removed)).toBe(false);
});

test('follow never adopts a planted segment that reaches the published end through another digest',async()=>{
    const g=await genesis([final('alpha',1,'aa')],4);
    const genuine=await segment(g.segments,g.tip,6,[final('alpha',6,'bb')]);
    const planted=await genesis([final('alpha',1,'aa')],4);
    // Only a planted segment is present: same base, same end and end id, different records.
    await segment(planted.segments,planted.tip,6,[final('alpha',6,'ff')]);
    const victim=open(planted.config);
    expect(await victim.follow({manifestSha256:genuine.manifestSha256,endBlock:6,lastBlockId:block(6)})).toBe(false);
    expect(await victim.coverageEnd()).toBe(4);
    // Both present: the published digest is the one adopted.
    await segment(g.segments,g.tip,6,[final('alpha',6,'ff')],{name:'zz-planted'});
    const reader=open(g.config);
    expect(await reader.nextSegment()).toBeUndefined();
    expect(await reader.follow({manifestSha256:genuine.manifestSha256,endBlock:6,lastBlockId:block(6)})).toBe(true);
    expect((await reader.finalState('alpha',6))?.abiHex).toBe('bb');
});

/** The chain through `through` as one complete catalog that stands in for that link, as `abi-scanner --compact` writes it. */
async function compaction(rows:any[],through:DiskAbiHistoryTip,segments:string,lineage:string,change:(manifest:any)=>void=()=>{}) {
    const directory=await mkdtemp(join(tmpdir(),'h45-abi-compaction-')),end=through.endBlock;
    const rowBytes=lines(rows),idBytes=Buffer.from(Array.from({length:end},(_,i)=>block(i+1)).join(''),'hex');
    await writeFile(join(directory,'abi.ndjson'),rowBytes);await writeFile(join(directory,'blocks.bin'),idBytes);
    const manifest:any={format:'hyperion-wire-abi-history-v1',complete:true,chainId,nodeRevision,producerProfileId:'producer-profile',
        shipAbiSha256:hash(schemaJson),startBlock:1,endBlock:end,firstBlockId:block(1),lastBlockId:block(end),irreversibleBoundary:{blockNum:end,blockId:block(end)},
        lastGlobalSequence:through.lastGlobalSequence,deployments:{name:'abi.ndjson',bytes:Buffer.byteLength(rowBytes),sha256:hash(rowBytes),records:rows.length},
        blockIds:{name:'blocks.bin',bytes:idBytes.length,sha256:hash(idBytes),count:end},
        compacts:{manifestSha256:through.manifestSha256,endBlock:end,lastBlockId:through.lastBlockId},lineage:{manifestSha256:lineage}};
    change(manifest);
    const bytes=JSON.stringify(manifest)+'\n',path=join(directory,'manifest.json');await writeFile(path,bytes);
    return {interface_version:1,manifest:path,manifest_sha256:hash(bytes),lineage_sha256:lineage,producer_profile_id:'producer-profile',
        node_revision:nodeRevision,ship_abi_sha256:hash(schemaJson),segments_dir:segments} as DiskAbiHistoryConfiguration;
}

test('a compaction pinned in place of the chain start keeps the lineage and is continued by the same segments',async()=>{
    const start=[final('alpha',1,'aa')],added=[deploy('alpha',6,'150','bb','1'),final('beta',6,'cc')];
    const g=await genesis(start,4),link=(tip:DiskAbiHistoryTip)=>({manifestSha256:tip.manifestSha256,endBlock:tip.endBlock,lastBlockId:tip.lastBlockId});
    const first=await segment(g.segments,g.tip,6,added),second=await segment(g.segments,first,9,[],{lastGlobalSequence:'300'});
    const third=await segment(g.segments,second,12,[final('alpha',11,'dd')],{lastGlobalSequence:'400'});
    const whole=open(g.config);expect(await whole.follow(link(third))).toBe(true);
    // The chain through its second link, as one catalog in a directory of its own.
    const config=await compaction([...start,...added],second,g.segments,g.config.manifest_sha256),compact=open(config);
    expect(compact.catalogId).toBe(whole.catalogId);
    expect(await compact.coverageEnd()).toBe(9);expect(await compact.boundaries()).toEqual([9]);
    // It stands in for the link it ends at: that link is the tip the next segment names, and both digests are adopted.
    expect(await compact.tip()).toEqual(second);
    expect(await compact.hasAdopted(second.manifestSha256)).toBe(true);expect(await compact.hasAdopted(config.manifest_sha256)).toBe(true);
    expect(await compact.hasAdopted(first.manifestSha256)).toBe(false);
    expect(await compact.baseline()).toEqual(await whole.baselineAt(9));
    expect(await compact.follow(link(second))).toBe(true);
    // The links it folded in are not known one by one, so a link inside it cannot be followed.
    await expect(compact.follow(link(first))).rejects.toThrow('inside the pinned compaction');
    await expect(compact.baselineAt(6)).rejects.toThrow('not the end of an adopted catalog link');
    // The segment after the compacted link continues it unchanged.
    expect((await compact.nextSegment())?.link).toMatchObject({startBlock:10,endBlock:12,baseSha256:second.manifestSha256,totalRecords:4});
    expect(await compact.follow(link(third))).toBe(true);
    expect(await compact.boundaries()).toEqual([9,12]);expect(await compact.tip()).toEqual(await whole.tip());
    // Every answer is the one the whole chain gives, state identity included.
    expect(await compact.baselineAt(12)).toEqual(await whole.baselineAt(12));
    for(let n=1;n<=12;n++){
        expect(await compact.source(n)).toEqual(await whole.source(n));
        for(const account of ['alpha','beta'])expect(await compact.finalState(account,n)).toEqual(await whole.finalState(account,n));
    }
    for(const [sequence,receipt] of [['149','0'],['151','1']])
        expect(await compact.actionState(input('alpha',sequence,receipt),6)).toEqual(await whole.actionState(input('alpha',sequence,receipt),6));
    expect(compact.matchesState((await whole.finalState('alpha',12))!)).toBe(true);expect(whole.matchesState((await compact.finalState('beta',7))!)).toBe(true);

    // Without a configured lineage the compaction is its own: a new deployment may start on it.
    const {lineage_sha256:_,...alone}=config,own=open(alone);
    expect(own.catalogId).toBe('h45abihistory1:'+config.manifest_sha256);expect(await own.coverageEnd()).toBe(9);
    // A lineage the manifest does not name, a catalog that is no compaction, and a compaction that ends elsewhere than its link.
    await expect(open({...config,lineage_sha256:'e'.repeat(64)}).coverageEnd()).rejects.toThrow('not a compaction of the configured lineage');
    await expect(open({...g.config,lineage_sha256:'e'.repeat(64)}).coverageEnd()).rejects.toThrow('not a compaction of the configured lineage');
    expect(await open({...g.config,lineage_sha256:g.config.manifest_sha256}).coverageEnd()).toBe(4);
    for(const change of [(m:any)=>{m.compacts.endBlock=8;},(m:any)=>{m.compacts.lastBlockId=block(8);},(m:any)=>{m.compacts.manifestSha256='x';},
        (m:any)=>{m.base={manifestSha256:second.manifestSha256,endBlock:9,lastBlockId:block(9)};}])
        await expect(open(await compaction([...start,...added],second,g.segments,g.config.manifest_sha256,change)).coverageEnd()).rejects.toThrow('invalid compaction');
    expect(()=>open({...config,lineage_sha256:'nope'})).toThrow('invalid source configuration');
});
