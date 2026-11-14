import {test,expect,afterEach} from 'bun:test';
import {GenerationalProtocolBundleStore,ImmutableProtocolBundleReadError,ProtocolStoreGenerations,followProtocolStoreGenerations,
    protocolStoreIndexSuffix,protocolStoreGenerationIndices,type ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';

// Fake per-generation bundle stores: a record map per generation, every call logged.
function harness(writable:boolean,records:Record<number,Record<string,unknown>>,state:{current:number;previous:number|null}) {
    const calls:string[]=[],generations=new ProtocolStoreGenerations();
    let refreshes=0;generations.refresher=async()=>{refreshes++;generations.observe(state.current,state.previous);};
    const store=(generation:number)=>({
        index:'chain-'+protocolStoreIndexSuffix('kind-v1',generation),
        async read(id:string){calls.push(`read:${generation}:${id}`);
            if(id==='corrupt')throw new ImmutableProtocolBundleReadError('invalid',id,'corrupt');
            if(!(records[generation]??{})[id]){
                if(!records[generation])throw Object.assign(new Error('no index'),{meta:{statusCode:404,body:{error:{type:'index_not_found_exception'}}}});
                throw new ImmutableProtocolBundleReadError('missing',id,'missing');}
            return records[generation]![id];},
        async readRecords(ids:string[]){return Promise.all(ids.map(id=>this.read(id)));},
        async prepare(id:string,record:unknown){calls.push(`prepare:${generation}:${id}`);(records[generation]??={})[id]=record;return {id,digest:'d'};},
    }) as unknown as ImmutableProtocolBundleStore;
    return {calls,generations,refreshes:()=>refreshes,router:new GenerationalProtocolBundleStore(generations,store,writable)};
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
    // Batches: all in the previous generation, or mixed across both, each record from where it is.
    const mixed=harness(true,{0:{a:1,b:2},1:{c:3}},{current:1,previous:0});mixed.generations.observe(1,0);
    expect(await mixed.router.readRecords(['a','c'])).toEqual([1,3]);expect(mixed.calls).toContain('prepare:1:a');
    expect(mixed.calls).not.toContain('prepare:1:c');
});

test('only a process that follows generations reads control before it uses a stale state',async()=>{
    const records={0:{},2:{x:1}};
    const quiet=harness(true,records,{current:2,previous:null});
    // Not following: no control read; the known (initial) generation is used, and a miss does not refresh.
    await expect(quiet.router.read('x')).rejects.toMatchObject({code:'missing'});expect(quiet.calls).toEqual(['read:0:x']);expect(quiet.refreshes()).toBe(0);
    followProtocolStoreGenerations();
    const fresh=harness(true,records,{current:2,previous:null});
    // A fresh following process refreshes before its first read, so it never touches generation 0.
    expect(await fresh.router.read('x')).toBe(1);expect(fresh.refreshes()).toBe(1);expect(fresh.calls).toEqual(['read:2:x']);
    // Within the freshness bound there is no further control read; writes go to the observed current generation.
    await fresh.router.prepare('y',{v:1} as any);expect(fresh.refreshes()).toBe(1);expect(fresh.calls.at(-1)).toBe('prepare:2:y');
});
