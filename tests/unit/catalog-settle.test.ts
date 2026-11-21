import {test,expect} from 'bun:test';
import {CatalogSettler,elasticSettleIO,parseSettleRange,type CatalogSettleIO,type SettleAudit,type SettleDocument,type SettleRange} from '../../src/indexer/protocol/catalog-settle.js';
import {protocolDiskSelectionId} from '../../src/indexer/protocol/disk-source-evidence.js';

// Two actions a block. The live indexer stored them with store metadata, the range server with disk metadata.
// The fake keeps the documents as Elasticsearch would: every write gets the next sequence number of one shard.
const block=(n:number)=>n.toString(16).padStart(64,'0'),chain='settle',actionIndex=chain+'-action-v1-000001',blockIndex=chain+'-block-v1';
const names={chain,indexVersion:'v1',partitionSize:10000000},chainId='c'.repeat(64);
const position=(n:number)=>({chainId,blockNum:n,blockId:block(n),previousBlockId:block(n-1)});
const blockDoc=(n:number)=>({block_num:n,block_id:block(n),producer:'p',protocol:{id:'plugin',receipts:[]}});
const actionDoc=(n:number,i:number,protocol:any)=>({block_num:n,global_sequence:String(n*10+i),act:{account:'a',name:'x',data:{v:i}},protocol});
const disk=(n:number,i:number)=>({schemaVersion:3,source:{blockNum:n,blockId:block(n)},selectionId:protocolDiskSelectionId(position(n)),input:{i}});
const store=(n:number,i:number)=>({schemaVersion:1,source:{blockNum:n},selectionId:'h45srcsel1:'+'1'.repeat(64),input:{i}});
function rangeOf(from:number,to:number,options:{omit?:string}={}):SettleRange{
    const blocks=[];
    for(let n=from;n<=to;n++){
        const documents:SettleDocument[]=[{kind:'block',index:blockIndex,id:String(n),source:blockDoc(n)},
            ...[0,1].map(i=>({kind:'action' as const,index:actionIndex,id:String(n*10+i),source:actionDoc(n,i,disk(n,i))}))];
        blocks.push({block:n,id:block(n),documents:documents.filter(d=>d.id!==options.omit)});
    }
    return {blocks,manifest:{from,to,blocks:to-from+1,catalogSha:'seg',firstBlockId:block(from),lastBlockId:block(to)}};
}
type Stored={index:string;id:string;source:any;seq:number};
function fakeIO(overrides:Partial<CatalogSettleIO>&{attestedEnd?:number|null;settled?:number|null;indexed?:number;from?:number;to?:number;
    drop?:string[];mutate?:(id:string,source:any)=>any}={}){
    const docs=new Map<string,Stored>();let seq=-1;
    const put=(index:string,id:string,source:any)=>{docs.set(index+'/'+id,{index,id,source,seq:++seq});};
    for(let n=overrides.from??101;n<=(overrides.to??110);n++){
        put(blockIndex,String(n),blockDoc(n));
        for(const i of [0,1]){const id=String(n*10+i);let source:any=actionDoc(n,i,store(n,i));if(overrides.mutate)source=overrides.mutate(id,source);
            if(!overrides.drop?.includes(id))put(actionIndex,id,source);}
    }
    const state={settled:overrides.settled===undefined?null:overrides.settled,rewrites:[] as SettleDocument[],repairs:[] as SettleDocument[],
        ranges:[] as [number,number][],audit:null as SettleAudit|null,refreshes:0,listings:[] as [number,number][],docs,put,uuid:'u1',
        clear(){docs.clear();seq=-1;},
        get written(){return [...this.rewrites,...this.repairs];}};
    const io:CatalogSettleIO={
        position:async()=>({attestedEnd:overrides.attestedEnd===undefined?110:overrides.attestedEnd,settled:state.settled}),
        highestIndexedBlock:async()=>overrides.indexed??1000,
        catalogSource:async n=>position(n),isAdoptedSegment:async sha=>sha==='seg',
        fetchRange:async(from,to)=>{state.ranges.push([from,to]);return rangeOf(from,to);},
        liveDocuments:async(from,to)=>new Map([...docs].filter(([,d])=>d.source.block_num>=from&&d.source.block_num<=to)
            .map(([id,d])=>[id,{index:d.index,id:d.id,source:d.source}])),
        write:async(rewrites,repairs)=>{
            for(const d of repairs)if(docs.has(d.index+'/'+d.id))throw new Error('version conflict, document already exists');
            state.rewrites.push(...rewrites);state.repairs.push(...repairs);for(const d of [...rewrites,...repairs])put(d.index,d.id,d.source);},
        existing:async()=>0,
        recordSettled:async n=>{state.settled=n;},
        actionShards:async()=>[{index:actionIndex,uuid:state.uuid,shard:0,checkpoint:seq}],
        storeSelections:async after=>[...new Set([...docs.values()].filter(d=>d.index===actionIndex&&d.source.block_num>after&&d.source.protocol?.schemaVersion!==3)
            .map(d=>d.source.protocol.selectionId as string))],
        refresh:async()=>{state.refreshes++;},
        changedActions:async(shard,after,through,limit)=>{state.listings.push([after,shard.checkpoint]);
            return [...docs.values()].filter(d=>d.index===shard.index&&d.seq>after&&d.seq<=shard.checkpoint&&d.source.block_num<=through)
                .sort((a,b)=>a.seq-b.seq).slice(0,limit).map(d=>({seqNo:d.seq,block:d.source.block_num,diskBacked:d.source.protocol?.schemaVersion===3}));},
        readAudit:async()=>state.audit,writeAudit:async value=>{state.audit=structuredClone(value);},
        ...overrides,
    };
    return {io,state};
}
const settleAll=async(settler:CatalogSettler)=>{for(let i=0;i<20;i++){const step=await settler.step();if(step.status!=='settled')return step;}throw new Error('settle did not finish');};

test('a range whose live documents differ only in protocol metadata is rewritten and checkpointed',async()=>{
    const f=fakeIO();const settler=new CatalogSettler(f.io,101,names,{max_blocks:4});
    expect(await settler.step()).toEqual({status:'settled',from:101,to:104,written:8,unchanged:4,repaired:0});
    expect(f.state.settled).toBe(104);expect(f.state.written.every(d=>d.kind==='action'&&d.source.protocol.schemaVersion===3)).toBe(true);
    expect(f.state.repairs).toEqual([]);
    // Block documents are identical, so they are not rewritten; the next step continues after the checkpoint.
    expect(await settler.step()).toMatchObject({status:'settled',from:105,to:108});
    expect(await settler.step()).toMatchObject({status:'settled',from:109,to:110});
    expect(await settler.step()).toEqual({status:'idle',reason:'nothing attested and indexed past the settled block'});
    expect(f.state.ranges).toEqual([[101,104],[105,108],[109,110]]);
});

test('settling stops short of the attested end and of the indexed tip',async()=>{
    expect(await new CatalogSettler(fakeIO({attestedEnd:null}).io,101,names).step()).toMatchObject({status:'idle',reason:'no attested catalog segment'});
    const near=fakeIO({indexed:110+CatalogSettler.tipMargin-3});
    expect(await new CatalogSettler(near.io,101,names).step()).toMatchObject({status:'settled',from:101,to:107});
    const nothing=fakeIO({indexed:100+CatalogSettler.tipMargin});
    expect(await new CatalogSettler(nothing.io,101,names).step()).toMatchObject({status:'idle'});
});

test('a live document still missing near the tip waits; an old gap is repaired by creating it',async()=>{
    const recent=fakeIO({indexed:300,drop:['1021']});
    expect(await new CatalogSettler(recent.io,101,names).step()).toEqual({status:'waiting',from:101,to:110,missing:1});
    expect(recent.state.settled).toBeNull();expect(recent.state.written).toEqual([]);
    const old=fakeIO({indexed:5000,drop:['1021']});
    expect(await new CatalogSettler(old.io,101,names).step()).toMatchObject({status:'settled',repaired:1,written:20});
    // The repair is a create, never a replace: a document that appears after the check fails the step.
    expect(old.state.repairs.map(d=>d.id)).toEqual(['1021']);expect(old.state.rewrites).toHaveLength(19);
    const taken=fakeIO({indexed:5000,drop:['1021'],existing:async()=>1});
    expect(await new CatalogSettler(taken.io,101,names).step()).toMatchObject({status:'refused',message:expect.stringContaining('already used')});
    expect(taken.state.written).toEqual([]);
});

test('an undecoded live action is repaired by its disk document; any other body difference refuses',async()=>{
    const undecoded=fakeIO({mutate:(id,s)=>id==='1050'?{...s,act:{...s.act,data:'0102'},protocol:{...s.protocol,status:'incomplete'}}:s});
    expect(await new CatalogSettler(undecoded.io,101,names).step()).toMatchObject({status:'settled',repaired:1});
    const changed=fakeIO({mutate:(id,s)=>id==='1050'?{...s,act:{...s.act,data:{v:9}}}:s});
    expect(await new CatalogSettler(changed.io,101,names).step()).toMatchObject({status:'refused',message:expect.stringContaining('beyond protocol metadata')});
    expect(changed.state.settled).toBeNull();expect(changed.state.written).toEqual([]);
});

test('ranges that do not match the catalog, the live set or their own disk position are refused without writing',async()=>{
    const edit=(change:(range:SettleRange)=>void)=>({fetchRange:async(from:number,to:number)=>{const r=rangeOf(from,to);change(r);return r;}});
    const cases:[string,Partial<CatalogSettleIO>,string][]=[
        ['other range',{fetchRange:async(from,to)=>rangeOf(from,to-1)},'another range'],
        ['unadopted segment',{isAdoptedSegment:async()=>false},'not an adopted segment'],
        ['block id',{catalogSource:async n=>n===105?{...position(n),blockId:block(999)}:position(n)},'block 105 differs from the catalog'],
        ['outside the catalog',{catalogSource:async n=>n===105?null:position(n)},'block 105 differs from the catalog'],
        ['boundary',edit(r=>{(r.manifest as any).lastBlockId=block(7);}),'boundary'],
        ['live without disk',{fetchRange:async(from,to)=>rangeOf(from,to,{omit:'1031'})},'live document settle-action-v1-000001/1031 has no disk document'],
        ['other block',edit(r=>{(r.blocks[2]!.documents[1]!.source as any).block_num=1;}),'names another block'],
        ['other index',edit(r=>{(r.blocks[2]!.documents[1] as any).index='settle-delta-v1';}),'another index or id'],
        ['other action id',edit(r=>{(r.blocks[2]!.documents[1] as any).id='1';}),'another index or id'],
        ['other block id',edit(r=>{(r.blocks[2]!.documents[0]!.source as any).block_id=block(1);}),'another index, id or block id'],
        ['other partition',edit(r=>{(r.blocks[2]!.documents[1] as any).index=chain+'-action-v1-000002';}),'another index or id'],
        // A range server that returns store metadata, none at all, or another block's selection would settle documents that still need the stores.
        ['store metadata',edit(r=>{(r.blocks[2]!.documents[1]!.source as any).protocol=store(103,0);}),'action document 1030 of block 103 is not bound to its disk position'],
        ['no metadata',edit(r=>{delete (r.blocks[2]!.documents[1]!.source as any).protocol;}),'not bound to its disk position'],
        ['other selection',edit(r=>{(r.blocks[2]!.documents[1]!.source as any).protocol=disk(104,0);}),'not bound to its disk position'],
        // A frame without its block document: nothing was read for that block.
        ['no block document',edit(r=>{(r.blocks[2] as any).documents=r.blocks[2]!.documents.slice(1);}),'block 103 does not come with exactly one block document'],
        ['empty block',edit(r=>{(r.blocks[2] as any).documents=[];}),'exactly one block document'],
    ];
    for(const [name,overrides,message] of cases){
        const f=fakeIO(overrides);const step=await new CatalogSettler(f.io,101,names).step();
        expect(step.status,name).toBe('refused');expect((step as any).message,name).toContain(message);
        expect(f.state.written,name).toEqual([]);expect(f.state.settled,name).toBeNull();
    }
});

test('a settled action that is written again with store metadata is found and made disk-backed again',async()=>{
    const f=fakeIO();const settler=new CatalogSettler(f.io,101,names,{max_blocks:4});
    expect(await settleAll(settler)).toMatchObject({status:'idle'});expect(f.state.settled).toBe(110);
    expect(await settler.verify()).toEqual({through:110,selections:[]});
    // Index work that was queued before block 103 settled is written now, and a repair reader rewrites block 108.
    f.state.put(actionIndex,'1031',actionDoc(103,1,store(103,1)));
    f.state.put(actionIndex,'1080',actionDoc(108,0,store(108,0)));f.state.put(actionIndex,'1081',actionDoc(108,1,store(108,1)));
    expect(await settler.verify()).toBeNull();
    f.state.rewrites.length=0;
    // One step settles a bounded run from the lowest such block; the next one takes the rest.
    expect(await settler.step()).toEqual({status:'resettled',from:103,to:103,written:1,blocks:1});
    expect(await settler.verify()).toBeNull();
    expect(await settler.step()).toEqual({status:'resettled',from:108,to:108,written:2,blocks:1});
    expect(f.state.rewrites.map(d=>d.id)).toEqual(['1031','1080','1081']);
    expect([...f.state.docs.values()].filter(d=>d.index===actionIndex).every(d=>d.source.protocol.schemaVersion===3)).toBe(true);
    expect(await settler.verify()).toEqual({through:110,selections:[]});expect(f.state.settled).toBe(110);
    expect(await settler.step()).toMatchObject({status:'idle'});
});

test('verification names the block it holds for and the store selections the documents above it name',async()=>{
    const f=fakeIO({attestedEnd:104});const settler=new CatalogSettler(f.io,101,names);
    expect(await settler.verify()).toBeNull();
    expect(await settler.step()).toMatchObject({status:'settled',to:104});
    // Blocks 105..110 are unsettled; one of them was captured again by a repair reader, under its own selection.
    const repaired={...store(107,0),selectionId:'h45srcsel1:'+'7'.repeat(64)};
    f.state.put(actionIndex,'1070',actionDoc(107,0,repaired));
    expect(await settler.verify()).toEqual({through:104,selections:[store(105,0).selectionId,repaired.selectionId]});
    // A tail too long to list means it is not the time to retire anything.
    expect(await new CatalogSettler({...f.io,storeSelections:async()=>null},101,names).verify()).toBeNull();
});

test('audit positions stand for a block range: a jump past blocks nothing read starts the audit over',async()=>{
    // Settled through 104 under one pinned catalog, while blocks 105..108 were indexed live. Their documents are above
    // the settled block, so the audit read past them.
    const f=fakeIO({attestedEnd:104});let settler=new CatalogSettler(f.io,101,names);
    expect(await settleAll(settler)).toMatchObject({status:'idle'});
    expect(await settler.verify()).toMatchObject({through:104});
    expect(f.state.audit).toEqual({through:104,shards:{[actionIndex+'#u1#0']:expect.any(Number)}});
    const position=f.state.audit!.shards[actionIndex+'#u1#0']!;
    // A new pinned catalog now ends at 108: the checkpoint is gone and settling starts after it, at 109.
    f.state.settled=null;
    settler=new CatalogSettler({...f.io,position:async()=>({attestedEnd:110,settled:f.state.settled})},109,names);
    expect(await settler.step()).toEqual({status:'settled',from:109,to:110,written:4,unchanged:2,repaired:0});
    // 105..108 were neither settled nor read, so the stored positions no longer stand for anything.
    expect(f.state.audit).toEqual({through:110,shards:{}});expect(settler.auditPending).toBe(true);
    expect(await settler.verify()).toBeNull();
    expect(await settler.step()).toEqual({status:'resettled',from:105,to:108,written:8,blocks:4});
    expect(await settler.verify()).toEqual({through:110,selections:[]});
    expect(f.state.audit!.shards[actionIndex+'#u1#0']).toBeGreaterThan(position);
    // A checkpoint that moved without this settler (a restart between the checkpoint and the positions) does the same.
    f.state.audit={through:109,shards:f.state.audit!.shards};
    const restarted=new CatalogSettler({...f.io,position:async()=>({attestedEnd:110,settled:110})},109,names);
    f.state.listings.length=0;
    expect(await restarted.verify()).toEqual({through:110,selections:[]});expect(f.state.listings[0]![0]).toBe(-1);
});

test('a recreated action index, or sequence numbers that went back, are read from the start',async()=>{
    const f=fakeIO();const settler=new CatalogSettler(f.io,101,names);
    expect(await settleAll(settler)).toMatchObject({status:'idle'});expect(await settler.verify()).toMatchObject({through:110});
    // The index is deleted and rebuilt from live input under the same name: fewer sequence numbers, another id.
    f.state.clear();f.state.uuid='u2';
    for(let n=101;n<=103;n++)for(const i of [0,1])f.state.put(actionIndex,String(n*10+i),actionDoc(n,i,store(n,i)));
    expect(await settler.verify()).toBeNull();
    expect(await settler.step()).toMatchObject({status:'resettled',from:101,to:103,blocks:3});
    expect(Object.keys(f.state.audit!.shards)).toEqual([actionIndex+'#u1#0']);
    expect(await settler.verify()).toMatchObject({through:110});
    expect(Object.keys(f.state.audit!.shards)).toEqual([actionIndex+'#u2#0']);
    // The same shard reporting an older checkpoint than the stored position (a restore): the position is not trusted.
    const restored=fakeIO({settled:110});restored.state.audit={through:110,shards:{[actionIndex+'#u1#0']:999999}};
    expect(await new CatalogSettler(restored.io,101,names).verify()).toBeNull();expect(restored.state.listings[0]![0]).toBe(-1);
});

test('between audit passes a step only settles forward; the next pass still finds what was written meanwhile',async()=>{
    const f=fakeIO({attestedEnd:104});const settler=new CatalogSettler(f.io,101,names,{max_blocks:2,interval_ms:3600000});
    expect(await settler.step()).toMatchObject({status:'settled',to:102});
    expect(await settler.step()).toMatchObject({status:'settled',to:104});expect(settler.auditPending).toBe(false);
    const passes=f.state.listings.length;
    f.state.put(actionIndex,'1010',actionDoc(101,0,store(101,0)));
    // Inside the interval no pass runs, and its position does not move.
    expect(await settler.step()).toMatchObject({status:'idle'});expect(f.state.listings.length).toBe(passes);
    expect(await settler.verify()).toBeNull();
    expect(await settler.step()).toEqual({status:'resettled',from:101,to:101,written:1,blocks:1});
});

test('the first audit reads everything at or below the settled block, including blocks settle never visited',async()=>{
    // Blocks 95..100 are below the pinned catalog end the settler starts after, and were indexed live.
    const f=fakeIO({from:95,to:110,settled:110});const settler=new CatalogSettler(f.io,101,names,{max_blocks:4});
    expect(await settler.verify()).toBeNull();
    expect(await settler.step()).toEqual({status:'resettled',from:95,to:98,written:8,blocks:4});
    for(let i=0;i<4;i++)await settler.step();
    expect(await settler.verify()).toMatchObject({through:110});
    expect([...f.state.docs.values()].filter(d=>d.index===actionIndex).every(d=>d.source.protocol.schemaVersion===3)).toBe(true);
    // Positions are durable: another settler reads only what changed after them, and nothing did.
    const before=f.state.listings.length,next=new CatalogSettler(f.io,101,names);
    expect(await next.verify()).toMatchObject({through:110});expect(f.state.listings.length).toBe(before);
    f.state.put(actionIndex,'990',actionDoc(99,0,store(99,0)));
    expect(await next.verify()).toBeNull();expect(f.state.listings.at(-1)![0]).toBe(f.state.audit!.shards[actionIndex+'#u1#0']!);
    expect(await next.step()).toEqual({status:'resettled',from:99,to:99,written:1,blocks:1});
});

test('the audit reads a bounded number of changed documents a step and reports while it is behind',async()=>{
    const f=fakeIO({settled:110});const settler=new CatalogSettler(f.io,101,names);
    for(const document of f.state.docs.values())if(document.index===actionIndex)document.source={...document.source,protocol:disk(document.source.block_num,0)};
    const bounds=CatalogSettler as any,documents=bounds.auditDocuments,page=bounds.auditPage;
    try {
        bounds.auditDocuments=8;bounds.auditPage=4;
        expect(await settler.step()).toMatchObject({status:'idle'});expect(settler.auditPending).toBe(true);
        expect(await settler.step()).toMatchObject({status:'idle'});expect(settler.auditPending).toBe(true);
        expect(await settler.step()).toMatchObject({status:'idle'});expect(settler.auditPending).toBe(false);
        expect(f.state.listings.length).toBe(5);
    } finally {bounds.auditDocuments=documents;bounds.auditPage=page;}
    expect(await settler.verify()).toMatchObject({through:110});
    // One request spans a bounded stretch of sequence numbers, however far the shard is behind.
    const windowed=fakeIO({settled:110}),window=bounds.auditWindow;
    try {bounds.auditWindow=10;expect(await new CatalogSettler(windowed.io,101,names).verify()).toBeNull();}finally{bounds.auditWindow=window;}
    expect(windowed.state.listings).toEqual([[-1,9],[9,19],[19,29]]);
    // And a request that finds nothing still counts, so a shard whose documents are all above the settled block
    // cannot turn one pass into thousands of requests.
    const empty=fakeIO({settled:100});
    try {bounds.auditWindow=1;await new CatalogSettler(empty.io,101,names).step();}finally{bounds.auditWindow=window;}
    expect(empty.state.listings.length).toBeLessThanOrEqual(Math.ceil(bounds.auditDocuments/Math.ceil(bounds.auditPage/10)));
    // A listing that is not in sequence order, or names a block above the settled one, is not an answer.
    const wrong=fakeIO({settled:110,changedActions:async()=>[{seqNo:5,block:101,diskBacked:true},{seqNo:4,block:101,diskBacked:true}]});
    await expect(new CatalogSettler(wrong.io,101,names).step()).rejects.toThrow('out of order');
});

test('the range server framing is parsed and incomplete or failed responses are rejected',()=>{
    const frame=(n:number,lines:string[])=>{const bytes=lines.map(l=>l+'\n').join('');
        return JSON.stringify({frame:'block',block:n,id:block(n),bytes:Buffer.byteLength(bytes)})+'\n'+bytes;};
    const manifest=JSON.stringify({frame:'manifest',from:1,to:2,blocks:2,catalogSha:'seg',firstBlockId:block(1),lastBlockId:block(2)})+'\n';
    const body=JSON.stringify({frame:'start',from:1,to:2})+'\n'
        +frame(1,[JSON.stringify({index:{_index:'c-block-v1',_id:'1'}}),JSON.stringify({block_num:1})])
        +frame(2,[JSON.stringify({index:{_index:'c-block-v1',_id:'2'}}),JSON.stringify({block_num:2}),
            JSON.stringify({index:{_index:'c-action-v1-000001',_id:'20'}}),JSON.stringify({block_num:2,x:'multi\\nline'})]);
    const parsed=parseSettleRange(Buffer.from(body+manifest));
    expect(parsed.blocks.map(b=>[b.block,b.documents.map(d=>d.kind+':'+d.id)])).toEqual([[1,['block:1']],[2,['block:2','action:20']]]);
    expect(parsed.manifest.to).toBe(2);
    expect(()=>parseSettleRange(Buffer.from(body))).toThrow('no manifest');
    expect(()=>parseSettleRange(Buffer.from(body.slice(0,-5)+manifest))).toThrow();
    expect(()=>parseSettleRange(Buffer.from(body+JSON.stringify({frame:'error',message:'boom'})+'\n'))).toThrow('Range server failed: boom');
});

// The Elasticsearch side, against a client that answers as Elasticsearch does.
const whole={timed_out:false,_shards:{total:1,successful:1,failed:0}};
function elastic(client:any){
    return elasticSettleIO({client,chain,indexVersion:'v1',partitionSize:10000000,rangeServer:'http://127.0.0.1:7180',profileId:'p',
        position:async()=>({attestedEnd:null,settled:null}),recordSettled:async()=>{},catalogSource:async()=>null,isAdoptedSegment:async()=>false,
        readAudit:async()=>null,writeAudit:async()=>{}});
}

test('live documents are paged by the stored decimal sequence, which a JSON number cannot hold',async()=>{
    // 5001 actions with global sequences above 2^53: their numeric sort values collide once parsed.
    const base=9007199254740993n,requests:any[]=[];
    const hits=Array.from({length:5001},(_,i)=>({_index:actionIndex,_id:String(base+BigInt(i)),sort:[Number(base+BigInt(i))],
        _source:{block_num:101,global_sequence:String(base+BigInt(i))}}));
    const client={search:async(request:any)=>{requests.push(request);
        if(request.index.includes('-block-'))return {...whole,hits:{hits:[{_index:blockIndex,_id:'101',sort:[101],_source:{block_num:101}}]}};
        const after=request.search_after?BigInt(request.search_after[0]):-1n;
        return {...whole,hits:{hits:hits.filter(hit=>BigInt(hit._id)>after).slice(0,request.size)}};}};
    const documents=await elastic(client).liveDocuments(101,101);
    expect(documents.size).toBe(5002);
    const actionRequests=requests.filter(request=>request.index.includes('-action-'));
    expect(actionRequests.map(request=>request.search_after)).toEqual([undefined,[String(base+4999n)]]);
    expect(Number(base+4999n)).toBe(Number(base+5000n));
});

test('a search or statistics answer that does not cover every shard is not an answer',async()=>{
    const partial={timed_out:false,_shards:{total:4,successful:3,failed:1},hits:{hits:[]},aggregations:{top:{value:9}}};
    await expect(elastic({search:async()=>partial}).liveDocuments(1,2)).rejects.toThrow('Incomplete search');
    await expect(elastic({search:async()=>partial}).highestIndexedBlock()).rejects.toThrow('Incomplete search');
    await expect(elastic({search:async()=>({...whole,timed_out:true,hits:{hits:[]}})}).liveDocuments(1,2)).rejects.toThrow('Incomplete search');
    await expect(elastic({search:async()=>partial}).changedActions({index:actionIndex,uuid:'u',shard:0,checkpoint:9},-1,5,10)).rejects.toThrow('Incomplete search');
    await expect(elastic({search:async()=>partial}).storeSelections(5)).rejects.toThrow('Incomplete search');
    expect(await elastic({search:async()=>({...whole,hits:{hits:[]},aggregations:{top:{value:9}}})}).highestIndexedBlock()).toBe(9);
    const stats=(shards:any,count=2,failed=0)=>({indices:{getSettings:async()=>({[actionIndex]:{settings:{'index.number_of_shards':String(count)}}}),
        stats:async()=>({_shards:{failed},indices:{[actionIndex]:{uuid:'u9',shards}}})}});
    const copy=(primary:boolean,global_checkpoint:number,state='STARTED')=>({routing:{primary,state},seq_no:{max_seq_no:99,local_checkpoint:98,global_checkpoint}});
    // The primary's global checkpoint, not the newest sequence number: writes above it may still be running.
    expect(await elastic(stats({1:[copy(false,7),copy(true,41)],0:[copy(true,12)]})).actionShards())
        .toEqual([{index:actionIndex,uuid:'u9',shard:0,checkpoint:12},{index:actionIndex,uuid:'u9',shard:1,checkpoint:41}]);
    await expect(elastic(stats({0:[copy(true,12)],1:[copy(false,7)]})).actionShards()).rejects.toThrow('shard 1 has no started primary');
    await expect(elastic(stats({0:[copy(true,12)],1:[copy(true,7,'INITIALIZING')]})).actionShards()).rejects.toThrow('shard 1 has no started primary');
    // Statistics leave out a shard that has no assigned copy, without counting a failure: the index's own shard count tells.
    await expect(elastic(stats({0:[copy(true,12)]})).actionShards()).rejects.toThrow('shard 1 has no started primary');
    await expect(elastic(stats({0:[copy(true,12)],1:[copy(true,7)]},2,1)).actionShards()).rejects.toThrow('Incomplete');
    await expect(elastic({indices:{getSettings:async()=>({[actionIndex]:{settings:{'index.number_of_shards':'1'}}}),stats:async()=>({_shards:{failed:0},indices:{}})}})
        .actionShards()).rejects.toThrow('has no shard statistics');
    expect(await elastic({indices:{getSettings:async()=>({}),stats:async()=>({_shards:{failed:0}})}}).actionShards()).toEqual([]);
});

test('store selections above a block are listed from the documents, and a long tail is not listed at all',async()=>{
    const requests:any[]=[],selection=(n:number)=>'h45srcsel1:'+String(n).padStart(64,'0');
    const hit=(sequence:number,protocol:any)=>({_source:{global_sequence:String(sequence),protocol}});
    const client={search:async(request:any)=>{requests.push(request);
        return {...whole,hits:{hits:[hit(1,{schemaVersion:1,selectionId:selection(1)}),hit(2,{schemaVersion:3,selectionId:'h45abidiskselection1:'+'0'.repeat(64)}),
            hit(3,{schemaVersion:2,selectionId:selection(1)}),hit(4,{schemaVersion:2,selectionId:selection(2)}),hit(5,{status:'incomplete'})]}};}};
    expect(await elastic(client).storeSelections(104)).toEqual([selection(1),selection(2)]);
    expect(requests[0]).toMatchObject({query:{range:{block_num:{gt:104}}},sort:[{global_sequence:'asc'}]});
    let pages=0;
    const endless={search:async(request:any)=>{pages++;const from=request.search_after?Number(request.search_after[0]):0;
        return {...whole,hits:{hits:Array.from({length:request.size},(_,i)=>hit(from+i+1,{schemaVersion:1,selectionId:selection(1)}))}};}};
    expect(await elastic(endless).storeSelections(104)).toBeNull();expect(pages).toBe(200);
});

test('changed actions are read from one shard, in sequence order, between the audit position and the checkpoint',async()=>{
    let request:any;
    const client={search:async(value:any)=>{request=value;return {...whole,hits:{hits:[
        {sort:[6],_source:{block_num:101,protocol:{schemaVersion:3}}},{sort:[8],_source:{block_num:104,protocol:{schemaVersion:2}}},{sort:[9],_source:{block_num:105}}]}};}};
    expect(await elastic(client).changedActions({index:actionIndex,uuid:'u',shard:2,checkpoint:40},5,110,100)).toEqual([
        {seqNo:6,block:101,diskBacked:true},{seqNo:8,block:104,diskBacked:false},{seqNo:9,block:105,diskBacked:false}]);
    expect(request).toMatchObject({index:actionIndex,preference:'_shards:2',size:100,sort:[{_seq_no:'asc'}],
        query:{bool:{filter:[{range:{_seq_no:{gt:5,lte:40}}},{range:{block_num:{lte:110}}}]}}});
});

test('existence checks and writes fail on any item they cannot answer for, and repairs are creates',async()=>{
    const targets=[1,2,3].map(n=>({kind:'action' as const,index:actionIndex,id:String(n),source:{block_num:1}}));
    const mget=(docs:any[])=>elastic({mget:async()=>({docs})});
    expect(await mget([{found:true},{found:false},{error:{type:'index_not_found_exception'}}]).existing(targets)).toBe(1);
    await expect(mget([{found:true},{found:false},{error:{type:'shard_not_available'}}]).existing(targets)).rejects.toThrow('Existence check failed');
    await expect(mget([{found:true}]).existing(targets)).rejects.toThrow('Incomplete existence check');
    const bulks:any[]=[];
    const ok={bulk:async(request:any)=>{bulks.push(request.operations);
        return {errors:false,items:request.operations.filter((_:any,i:number)=>i%2===0).map((meta:any)=>({[Object.keys(meta)[0]!]:{status:meta.create?201:200}}))};}};
    await elastic(ok).write(targets.slice(0,2),targets.slice(2));
    expect(bulks[0].filter((_:any,i:number)=>i%2===0)).toEqual([{index:{_index:actionIndex,_id:'1'}},{index:{_index:actionIndex,_id:'2'}},{create:{_index:actionIndex,_id:'3'}}]);
    // More documents than one request holds are written in order, in several requests.
    bulks.length=0;
    const many=Array.from({length:2500},(_,n)=>({kind:'action' as const,index:actionIndex,id:String(n),source:{block_num:1}}));
    await elastic(ok).write(many,[]);expect(bulks.map(operations=>operations.length/2)).toEqual([1000,1000,500]);
    const conflict={bulk:async(request:any)=>({errors:true,items:[{index:{status:200}},{index:{status:200}},
        {create:{status:409,error:{type:'version_conflict_engine_exception'}}}].slice(0,request.operations.length/2)})};
    await expect(elastic(conflict).write(targets.slice(0,2),targets.slice(2))).rejects.toThrow('Settle write failed for 1 documents');
    await expect(elastic({bulk:async()=>({errors:false,items:[]})}).write(targets,[])).rejects.toThrow('Incomplete settle write receipt');
});
