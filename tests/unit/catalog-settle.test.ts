import {test,expect} from 'bun:test';
import {CatalogSettler,parseSettleRange,type CatalogSettleIO,type SettleDocument,type SettleRange} from '../../src/indexer/protocol/catalog-settle.js';

// Blocks 101..110, two actions each; the live indexer stored them with store metadata, the range server with disk metadata.
const block=(n:number)=>n.toString(16).padStart(64,'0'),chain='settle',actionIndex=chain+'-action-v1-000001',blockIndex=chain+'-block-v1';
const blockDoc=(n:number)=>({block_num:n,block_id:block(n),producer:'p',protocol:{schemaVersion:1,source:{blockNum:n}}});
const actionDoc=(n:number,i:number,protocol:any)=>({block_num:n,global_sequence:String(n*10+i),act:{account:'a',name:'x',data:{v:i}},protocol});
const disk=(n:number,i:number)=>({schemaVersion:3,source:{blockNum:n,blockId:block(n)},selectionId:'h45abidiskselection1:'+'0'.repeat(64),input:{i}});
const store=(n:number,i:number)=>({schemaVersion:1,source:{blockNum:n},selectionId:'h45srcsel1:'+'1'.repeat(64),input:{i}});
function rangeOf(from:number,to:number,options:{omit?:string;extraBlockDoc?:boolean}={}):SettleRange{
    const blocks=[];
    for(let n=from;n<=to;n++){
        const documents:SettleDocument[]=[{kind:'block',index:blockIndex,id:String(n),source:blockDoc(n)},
            ...[0,1].map(i=>({kind:'action' as const,index:actionIndex,id:String(n*10+i),source:actionDoc(n,i,disk(n,i))}))];
        blocks.push({block:n,id:block(n),documents:documents.filter(d=>d.id!==options.omit)});
    }
    return {blocks,manifest:{from,to,blocks:to-from+1,catalogSha:'seg',firstBlockId:block(from),lastBlockId:block(to)}};
}
function liveOf(from:number,to:number,options:{drop?:string[];mutate?:(id:string,source:any)=>any}={}){
    const live=new Map<string,{index:string;id:string;source:any}>();
    for(let n=from;n<=to;n++){
        live.set(blockIndex+'/'+n,{index:blockIndex,id:String(n),source:blockDoc(n)});
        for(const i of [0,1]){const id=String(n*10+i);let source:any=actionDoc(n,i,store(n,i));if(options.mutate)source=options.mutate(id,source);
            if(!options.drop?.includes(id))live.set(actionIndex+'/'+id,{index:actionIndex,id,source});}
    }
    return live;
}
function fakeIO(overrides:Partial<CatalogSettleIO>&{attestedEnd?:number;settled?:number|null;indexed?:number}={}){
    const state={settled:overrides.settled===undefined?null:overrides.settled,written:[] as SettleDocument[],ranges:[] as [number,number][]};
    const io:CatalogSettleIO={
        position:async()=>({attestedEnd:overrides.attestedEnd===undefined?110:overrides.attestedEnd,settled:state.settled}),
        highestIndexedBlock:async()=>overrides.indexed??1000,
        catalogBlockId:async n=>block(n),isAdoptedSegment:async sha=>sha==='seg',
        fetchRange:async(from,to)=>{state.ranges.push([from,to]);return rangeOf(from,to);},
        liveDocuments:async(from,to)=>liveOf(from,to),
        write:async documents=>{state.written.push(...documents);},
        recordSettled:async n=>{state.settled=n;},
        ...overrides,
    };
    return {io,state};
}

test('a range whose live documents differ only in protocol metadata is rewritten and checkpointed',async()=>{
    const f=fakeIO();const settler=new CatalogSettler(f.io,101,{max_blocks:4});
    expect(await settler.step()).toEqual({status:'settled',from:101,to:104,written:8,unchanged:4,repaired:0});
    expect(f.state.settled).toBe(104);expect(f.state.written.every(d=>d.kind==='action'&&d.source.protocol.schemaVersion===3)).toBe(true);
    // Block documents are identical, so they are not rewritten; the next step continues after the checkpoint.
    expect(await settler.step()).toMatchObject({status:'settled',from:105,to:108});
    expect(await settler.step()).toMatchObject({status:'settled',from:109,to:110});
    expect(await settler.step()).toEqual({status:'idle',reason:'nothing attested and indexed past the settled block'});
    expect(f.state.ranges).toEqual([[101,104],[105,108],[109,110]]);
});

test('settling stops short of the attested end and of the indexed tip',async()=>{
    expect(await new CatalogSettler(fakeIO({attestedEnd:null as any}).io,101).step()).toMatchObject({status:'idle',reason:'no attested catalog segment'});
    const near=fakeIO({indexed:110+CatalogSettler.tipMargin-3});
    expect(await new CatalogSettler(near.io,101).step()).toMatchObject({status:'settled',from:101,to:107});
    const nothing=fakeIO({indexed:100+CatalogSettler.tipMargin});
    expect(await new CatalogSettler(nothing.io,101).step()).toMatchObject({status:'idle'});
    // Already settled to the attested end.
    expect(await new CatalogSettler(fakeIO({settled:110}).io,101).step()).toMatchObject({status:'idle'});
});

test('a live document still missing near the tip waits; an old gap is repaired',async()=>{
    const recent=fakeIO({indexed:300,liveDocuments:async(from,to)=>liveOf(from,to,{drop:['1021']})});
    expect(await new CatalogSettler(recent.io,101).step()).toEqual({status:'waiting',from:101,to:110,missing:1});
    expect(recent.state.settled).toBeNull();expect(recent.state.written).toEqual([]);
    const old=fakeIO({indexed:5000,liveDocuments:async(from,to)=>liveOf(from,to,{drop:['1021']})});
    expect(await new CatalogSettler(old.io,101).step()).toMatchObject({status:'settled',repaired:1,written:20});
    expect(old.state.written.some(d=>d.id==='1021')).toBe(true);
});

test('an undecoded live action is repaired by its disk document; any other body difference refuses',async()=>{
    const undecoded=fakeIO({liveDocuments:async(from,to)=>liveOf(from,to,{mutate:(id,s)=>id==='1050'?{...s,act:{...s.act,data:'0102'},
        protocol:{...s.protocol,status:'incomplete'}}:s})});
    expect(await new CatalogSettler(undecoded.io,101).step()).toMatchObject({status:'settled',repaired:1});
    const changed=fakeIO({liveDocuments:async(from,to)=>liveOf(from,to,{mutate:(id,s)=>id==='1050'?{...s,act:{...s.act,data:{v:9}}}:s})});
    expect(await new CatalogSettler(changed.io,101).step()).toMatchObject({status:'refused',message:expect.stringContaining('beyond protocol metadata')});
    expect(changed.state.settled).toBeNull();expect(changed.state.written).toEqual([]);
});

test('ranges that do not match the catalog or the live set are refused without writing',async()=>{
    const cases:[string,Partial<CatalogSettleIO>,string][]=[
        ['other range',{fetchRange:async(from,to)=>rangeOf(from,to-1)},'another range'],
        ['unadopted segment',{isAdoptedSegment:async()=>false},'not an adopted segment'],
        ['block id',{catalogBlockId:async n=>n===105?block(999):block(n)},'block 105 differs from the catalog'],
        ['boundary',{fetchRange:async(from,to)=>({...rangeOf(from,to),manifest:{...rangeOf(from,to).manifest,lastBlockId:block(7)}})},'boundary'],
        ['live without disk',{fetchRange:async(from,to)=>rangeOf(from,to,{omit:'1031'})},'live document settle-action-v1-000001/1031 has no disk document'],
        ['other block',{fetchRange:async(from,to)=>{const r=rangeOf(from,to);(r.blocks[2]!.documents[1]!.source as any).block_num=1;return r;}},'names another block'],
    ];
    for(const [name,overrides,message] of cases){
        const f=fakeIO(overrides);const step=await new CatalogSettler(f.io,101).step();
        expect(step.status,name).toBe('refused');expect((step as any).message,name).toContain(message);
        expect(f.state.written,name).toEqual([]);expect(f.state.settled,name).toBeNull();
    }
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
