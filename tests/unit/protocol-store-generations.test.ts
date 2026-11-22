import {test,expect,afterEach} from 'bun:test';
import {GenerationalProtocolBundleStore,ImmutableProtocolBundleReadError,ProtocolStoreGenerations,followProtocolStoreGenerations,
    protocolStoreIndexSuffix,protocolStoreGenerationIndices,type ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';

// Fake per-generation bundle stores: a record map per generation, every call logged.
function harness(writable:boolean,records:Record<number,Record<string,unknown>>,state:{current:number;previous:number|null}) {
    const calls:string[]=[],generations=new ProtocolStoreGenerations();
    let refreshes=0;generations.refresher=async()=>{refreshes++;generations.observe(state.current,state.previous);};
    const made:string[]=[];
    const noIndex=()=>Object.assign(new Error('no index'),{meta:{statusCode:404,body:{error:{type:'index_not_found_exception'}}}});
    const store=(generation:number,readOnly:boolean)=>(made.push(`${generation}:${readOnly?'read':'write'}`),{
        index:'chain-'+protocolStoreIndexSuffix('kind-v1',generation),
        async missingManifestHint(ids:string[]){calls.push(`hint:${generation}:${ids.join(',')}`);
            // A writable store creates its index on first use; a read-only one finds none.
            if(!records[generation]){if(readOnly)throw noIndex();records[generation]={};}
            return ids.find(id=>!(id in records[generation]!))??null;},
        async read(id:string){calls.push(`read:${generation}:${id}`);
            if(id==='corrupt')throw new ImmutableProtocolBundleReadError('invalid',id,'corrupt');
            if(!(records[generation]??{})[id]){
                if(!records[generation]){if(readOnly)throw noIndex();records[generation]={};}
                throw new ImmutableProtocolBundleReadError('missing',id,'missing');}
            return records[generation]![id];},
        async readRecords(ids:string[]){return Promise.all(ids.map(id=>this.read(id)));},
        async prepare(id:string,record:unknown){if(readOnly)throw new Error('read-only');
            calls.push(`prepare:${generation}:${id}`);(records[generation]??={})[id]=record;return {id,digest:'d'};},
    }) as unknown as ImmutableProtocolBundleStore;
    // As the real stores do: a read-only owner never gets a writable store.
    return {calls,made,generations,refreshes:()=>refreshes,
        router:new GenerationalProtocolBundleStore(generations,(generation,readOnly)=>store(generation,readOnly||!writable),writable)};
}
afterEach(()=>followProtocolStoreGenerations(false));

test('index names keep generation 0 and suffix later generations',()=>{
    expect(protocolStoreIndexSuffix('protocol-abi-observations-v1',0)).toBe('protocol-abi-observations-v1');
    expect(protocolStoreIndexSuffix('protocol-abi-observations-v1',3)).toBe('protocol-abi-observations-v1-g3');
    expect(protocolStoreGenerationIndices('c',2)).toEqual(['c-protocol-abi-frontier-records-v1-g2','c-protocol-abi-observations-v1-g2',
        'c-protocol-source-bindings-v1-g2','c-protocol-native-actions-v1-g2']);
    expect(()=>new ProtocolStoreGenerations().observe(1,1)).toThrow();
});

test('a writable store reads the previous generation on a miss and carries the record forward; a read-only one does not',async()=>{
    const records={0:{ctx:{v:1}},1:{}};
    const writer=harness(true,records,{current:1,previous:0});writer.generations.observe(1,0);
    expect(await writer.router.read('ctx')).toEqual({v:1});
    expect(writer.calls).toEqual(['read:1:ctx','read:0:ctx','prepare:1:ctx']);
    expect(await writer.router.read('ctx')).toEqual({v:1});expect(writer.calls.at(-1)).toBe('read:1:ctx');
    const reader=harness(false,{0:{ctx:{v:1}},1:{}},{current:1,previous:0});reader.generations.observe(1,0);
    expect(await reader.router.read('ctx')).toEqual({v:1});expect(reader.calls).toEqual(['read:1:ctx','read:0:ctx']);
    // Corrupt records never fall back; a record in neither generation stays missing.
    await expect(writer.router.read('corrupt')).rejects.toThrow('corrupt');expect(writer.calls.at(-1)).toBe('read:1:corrupt');
    await expect(writer.router.read('absent')).rejects.toMatchObject({code:'missing'});
    // A generation without an index holds no records either.
    const gap=harness(false,{0:{ctx:{v:2}}},{current:1,previous:0});gap.generations.observe(1,0);
    expect(await gap.router.read('ctx')).toEqual({v:2});
    // A record in no known generation is reported missing only after control was read again.
    expect(writer.refreshes()).toBe(1);
    // Batches: all in the previous generation, or mixed across both, each record from where it is.
    const mixed=harness(true,{0:{a:1,b:2},1:{c:3}},{current:1,previous:0});mixed.generations.observe(1,0);
    expect(await mixed.router.readRecords(['a','c'])).toEqual([1,3]);expect(mixed.calls).toContain('prepare:1:a');
    expect(mixed.calls).not.toContain('prepare:1:c');
});

test('a record written to a generation this process has not heard of is found by reading control on the miss',async()=>{
    // A deserializer saw generation 0 a moment ago; the switch to 1 happened since, and the reader that saw it
    // first wrote the block's selection there. Inside the freshness bound nothing else would read control.
    followProtocolStoreGenerations();
    const live={current:0,previous:null as number|null},records:Record<number,Record<string,unknown>>={0:{old:1}};
    const worker=harness(false,records,live);worker.generations.observe(0,null);
    expect(await worker.router.read('old')).toBe(1);expect(worker.refreshes()).toBe(0);
    live.current=1;live.previous=0;records[1]={selection:{block:7}};
    expect(worker.generations.stale()).toBe(false);
    expect(await worker.router.read('selection')).toEqual({block:7});
    expect(worker.refreshes()).toBe(1);expect(worker.calls.slice(-2)).toEqual(['read:0:selection','read:1:selection']);
    // Unchanged generations: the record is missing, after exactly one more control read.
    await expect(worker.router.read('absent')).rejects.toMatchObject({code:'missing'});expect(worker.refreshes()).toBe(2);
    // A process that was never told its deployment rotates still follows once it has seen a generation above 0.
    followProtocolStoreGenerations(false);
    const seen=harness(false,{1:{},2:{x:1}},{current:2,previous:1});seen.generations.observe(1,null);
    expect(seen.generations.following()).toBe(true);
    expect(await seen.router.read('x')).toBe(1);expect(seen.calls.at(-1)).toBe('read:2:x');
});

test('a deployment that never rotates reads control for nothing',async()=>{
    const quiet=harness(true,{0:{a:1}},{current:0,previous:null});
    expect(quiet.generations.following()).toBe(false);
    await expect(quiet.router.read('absent')).rejects.toMatchObject({code:'missing'});
    expect(await quiet.router.read('a')).toBe(1);await quiet.router.prepare('b',{v:1} as any);
    expect(quiet.refreshes()).toBe(0);expect(quiet.calls).toEqual(['read:0:absent','read:0:a','prepare:0:b']);
});

test('a control read that was already running when a record was missed is not taken for the answer',async()=>{
    const generations=new ProtocolStoreGenerations();let reads=0;const gates:Array<()=>void>=[];
    const live={current:0,previous:null as number|null};
    generations.refresher=async()=>{reads++;const seen={...live};await new Promise<void>(resolve=>gates.push(resolve));generations.observe(seen.current,seen.previous);};
    const first=generations.refreshed();await Promise.resolve();await Promise.resolve();
    expect(reads).toBe(1);
    // The switch lands after the first read took its snapshot; two misses arrive while that read is still running.
    live.current=1;live.previous=0;
    const second=generations.refreshed(),third=generations.refreshed();
    gates.shift()!();expect(await first).toEqual({current:0,previous:null});
    await new Promise(resolve=>setTimeout(resolve,0));expect(reads).toBe(2);
    gates.shift()!();
    expect(await second).toEqual({current:1,previous:0});expect(await third).toEqual({current:1,previous:0});expect(reads).toBe(2);
});

test('a writable store never creates the index of a generation it only reads',async()=>{
    // Generation 0 was retired and dropped; this writable worker last saw {current:1, previous:0}.
    const records:Record<number,Record<string,unknown>>={1:{a:1}};
    const worker=harness(true,records,{current:1,previous:0});worker.generations.observe(1,0);
    await expect(worker.router.read('late')).rejects.toMatchObject({code:'missing'});
    expect(records[0]).toBeUndefined();expect(worker.made).toEqual(['1:write','0:read']);
    expect(await worker.router.missingManifestHint(['a','late'])).toBe('late');expect(records[0]).toBeUndefined();
});

test('records are carried forward by identity before a generation is retired',async()=>{
    const records:Record<number,Record<string,unknown>>={0:{a:1,b:2,c:3},1:{b:2}};
    const owner=harness(true,records,{current:1,previous:0});owner.generations.observe(1,0);
    expect(await owner.router.carryForward(['a','b','c'])).toEqual({copied:2,absent:[]});
    expect(records[1]).toEqual({a:1,b:2,c:3});expect(owner.calls.filter(call=>call.startsWith('prepare'))).toEqual(['prepare:1:a','prepare:1:c']);
    expect((await owner.router.carryForward(['a','b','c'])).copied).toBe(0);
    // A record in neither generation fails the carry unless the caller expects it may not exist.
    await expect(owner.router.carryForward(['a','nowhere'])).rejects.toMatchObject({code:'missing'});
    expect(await owner.router.carryForward(['nowhere','a'],true)).toEqual({copied:0,absent:['nowhere']});
    // Whether a record is in place is asked in batches: a record that is nowhere costs no control read.
    expect(owner.refreshes()).toBe(0);
    await expect(harness(false,records,{current:1,previous:0}).router.carryForward(['a'])).rejects.toThrow('Read-only');
});

test('a process that follows generations reads control before it uses a stale state',async()=>{
    const records={0:{},2:{x:1}};
    followProtocolStoreGenerations();
    const fresh=harness(true,records,{current:2,previous:null});
    // A fresh following process refreshes before its first read, so it never touches generation 0.
    expect(await fresh.router.read('x')).toBe(1);expect(fresh.refreshes()).toBe(1);expect(fresh.calls).toEqual(['read:2:x']);
    // Within the freshness bound there is no further control read; writes go to the observed current generation.
    await fresh.router.prepare('y',{v:1} as any);expect(fresh.refreshes()).toBe(1);expect(fresh.calls.at(-1)).toBe('prepare:2:y');
});
