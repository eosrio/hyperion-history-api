import {describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {ProtocolAbiFrontierStore,ProtocolAbiFrontierConflictError,ProtocolAbiFrontierReadError,ProtocolAbiFrontierLimitError} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ImmutableProtocolBundleStore,protocolImmutableJson} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const control=(revision=0,ownerId='owner-a')=>({schemaVersion:1,ownerId,generation:1,revision,head:null});
const state=(account:string,abiHex='00',present=true)=>({account,present,abiHex,source:{blockNum:42,blockId:'a'.repeat(64)}});
function stored(memory:ReturnType<typeof frontierMemoryClient>,index:string,id:string):any {
    const manifest=memory.documents.get(memory.key(index,id))!.document;
    return JSON.parse(Buffer.concat(manifest.chunk_ids.map((chunk:string)=>Buffer.from(memory.documents.get(memory.key(index,chunk))!.document.payload,'base64'))).toString('utf8'));
}
function manifestIds(memory:ReturnType<typeof frontierMemoryClient>,index:string):string[] {
    return [...memory.documents.entries()].filter(([key,value])=>key.startsWith(index+'\0')&&value.document.kind==='manifest').map(([,value])=>value.document.bundle_id);
}
async function failure(promise:Promise<unknown>):Promise<any> {try{await promise;}catch(error){return error;}throw new Error('Expected operation failure');}
async function dataError(promise:Promise<unknown>,code:string,kind:string) {
    const error=await failure(promise);expect(error).toBeInstanceOf(ProtocolAbiFrontierReadError);expect(error.code).toBe(code);expect(error.recordKind).toBe(kind);
}
function fixture(replicas=0){const memory=frontierMemoryClient(replicas);return {memory,store:new ProtocolAbiFrontierStore(memory.client as any,'fixture',replicas)};}

describe('ABI frontier durable storage',()=>{
    it('creates strict independent indices and reads commits and control across restart without search',async()=>{
        const {store,memory}=fixture(1);expect(await store.readControl()).toBeNull();
        const written=await store.compareAndSet(null,control());expect(written.value).toEqual(control());
        const commit=await store.prepareCommit({rootId:null,bindings:[{stateId:null}],blockNum:42});
        const restarted=new ProtocolAbiFrontierStore(memory.client as any,'fixture',1);
        expect(await restarted.readControl()).toEqual(written);expect(await restarted.readCommit(commit.id)).toEqual({rootId:null,bindings:[{stateId:null}],blockNum:42});
        expect(memory.mappings.size).toBe(2);expect(store.recordsIndex).not.toBe(store.controlIndex);
        for(const {request} of memory.calls.filter(call=>['create','index'].includes(call.method))){
            expect(request.wait_for_active_shards).toBe('all');expect(request.refresh).toBe(false);expect(request.pipeline).toBe('_none');
        }
        for(const {request} of memory.calls.filter(call=>call.method==='get'))expect(request.realtime).toBe(true);
        expect(memory.calls.some(call=>call.method==='search')).toBe(false);
    });

    it('uses strict CAS and never reacquires a conflicting owner or silently overwrites newer control',async()=>{
        const {store,memory}=fixture();const first=await store.compareAndSet(null,control());
        const second=await store.compareAndSet(first,control(1));expect(second.seqNo).toBeGreaterThan(first.seqNo);
        const conflict=await failure(store.compareAndSet(first,control(2,'other-owner')));
        expect(conflict).toBeInstanceOf(ProtocolAbiFrontierConflictError);expect(conflict.current).toEqual({seqNo:second.seqNo,primaryTerm:second.primaryTerm});
        expect((await store.readControl())!.value).toEqual(control(1));
        const createConflict=await failure(store.compareAndSet(null,control(0,'other-owner')));expect(createConflict).toBeInstanceOf(ProtocolAbiFrontierConflictError);
        expect((await store.readControl())!.value).toEqual(control(1));
        const writes=memory.calls.filter(call=>call.method==='index');expect(writes.every(call=>Number.isSafeInteger(call.request.if_seq_no))).toBe(true);
    });

    it('allows only one different concurrent writer to win an expected revision',async()=>{
        const {store}=fixture(),initial=await store.compareAndSet(null,control());
        const results=await Promise.allSettled([store.compareAndSet(initial,control(1,'writer-a')),store.compareAndSet(initial,control(1,'writer-b'))]);
        expect(results.filter(result=>result.status==='fulfilled').length).toBe(1);
        const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;expect(rejected.reason).toBeInstanceOf(ProtocolAbiFrontierConflictError);
        const winner=(results.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<any>).value;
        expect(await store.readControl()).toEqual(winner);
    });

    it('repairs partial and unknown-outcome control writes with fresh identical-byte CAS receipts',async()=>{
        const {store,memory}=fixture(1);let partial=true;
        memory.faults.receipt=(response:any,request:any)=>request.id==='control'&&partial?{...response,_shards:{total:2,successful:1,failed:1}}:response;
        await expect(store.compareAndSet(null,control())).rejects.toThrow('durable control receipt');
        expect((await store.readControl())!.value).toEqual(control());
        await expect(store.compareAndSet(null,control())).rejects.toThrow('durable control receipt');
        expect(memory.calls.some(call=>call.method==='index'&&call.request.id==='control')).toBe(true);
        partial=false;const repaired=await store.compareAndSet(null,control());expect(repaired.value).toEqual(control());
        const unknown=Object.assign(new Error('connection lost after write'),{code:'ECONNRESET'});let failOnce=true;
        memory.faults.receipt=(response:any,request:any)=>{if(request.id==='control'&&failOnce){failOnce=false;throw unknown;}return response;};
        await expect(store.compareAndSet(repaired,control(1))).rejects.toBe(unknown);
        const repairedAgain=await store.compareAndSet(repaired,control(1));expect(repairedAgain.value).toEqual(control(1));
    });

    it('requires full immutable receipts and repairs partial chunks without treating GET as completion',async()=>{
        const {store,memory}=fixture(1);let partial=true;
        memory.faults.receipt=(receipt:any,request:any)=>request.index===store.recordsIndex&&partial?{...receipt,_shards:{total:2,successful:1,failed:1}}:receipt;
        await expect(store.prepareCommit({blockNum:42})).rejects.toThrow('durable write receipt');
        await expect(store.prepareCommit({blockNum:42})).rejects.toThrow('durable write receipt');
        expect(manifestIds(memory,store.recordsIndex)).toEqual([]);
        partial=false;const result=await store.prepareCommit({blockNum:42});expect(await store.readCommit(result.id)).toEqual({blockNum:42});
        expect(await store.prepareCommit({blockNum:42})).toEqual(result);
    });

    it('stores account bytes once and copies only changed hash-bucket/root metadata',async()=>{
        const {store,memory}=fixture();const accounts=['account-0','account-1','account-2'];
        expect(new Set(accounts.map(account=>hash(account).slice(0,2))).size).toBe(3);
        const large='ab'.repeat(65536),initialStates=accounts.map(account=>state(account,large));
        const first=await store.prepareState(null,initialStates.map(value=>({account:value.account,state:value})));expect(first).toMatch(/^h45abiroot1:/);
        const initialManifestIds=manifestIds(memory,store.recordsIndex);expect(initialManifestIds.filter(id=>id.startsWith('h45abist1:')).length).toBe(3);
        const updated=state(accounts[0],'ff');const second=await store.prepareState(first,[{account:accounts[0],state:updated}]);expect(second).not.toBe(first);
        const newIds=manifestIds(memory,store.recordsIndex).filter(id=>!initialManifestIds.includes(id));
        expect(newIds.filter(id=>id.startsWith('h45abist1:')).length).toBe(1);
        expect(newIds.filter(id=>id.startsWith('h45abibkt1:')).length).toBe(1);
        expect(newIds.filter(id=>id.startsWith('h45abiroot1:')).length).toBe(1);
        for(const id of manifestIds(memory,store.recordsIndex).filter(id=>/h45abi(?:bkt|root)1:/.test(id)))expect(JSON.stringify(stored(memory,store.recordsIndex,id))).not.toContain('abiHex');
        const restarted=new ProtocolAbiFrontierStore(memory.client as any,'fixture');
        expect(await restarted.readAccount(first,accounts[0])).toEqual(initialStates[0]);expect(await restarted.readAccount(second,accounts[0])).toEqual(updated);
        expect(await restarted.readAccount(second,accounts[1])).toEqual(initialStates[1]);expect(await restarted.readAccount(second,'unknown')).toBeNull();
        const calls=memory.calls.length;expect(await store.prepareState(second,[])).toBe(second);
        expect(memory.calls.slice(calls).some(call=>['create','index'].includes(call.method))).toBe(false);
        const prepared=await store.prepareAccountState(updated);expect(await store.readAccountState(prepared.id)).toEqual(updated);
        expect(manifestIds(memory,store.recordsIndex).filter(id=>id.startsWith('h45abist1:')).length).toBe(4);
    });

    it('retains deletion barriers as state objects and treats null/reset as UNKNOWN without deleting history',async()=>{
        const {store,memory}=fixture();const first=await store.prepareState(null,[{account:'alice',state:state('alice')},{account:'bob',state:state('bob','',false)}]);
        expect(await store.readAccount(first,'bob')).toEqual(state('bob','',false));
        const second=await store.prepareState(first,[{account:'alice',state:null}]);expect(await store.readAccount(second,'alice')).toBeNull();
        expect(await store.readAccount(second,'bob')).toEqual(state('bob','',false));expect(await store.readAccount(first,'alice')).toEqual(state('alice'));
        expect(await store.prepareState(second,[],true)).toBeNull();expect(await store.prepareState(second,[{account:'bob',state:null}])).toBeNull();
        expect(manifestIds(memory,store.recordsIndex).length).toBeGreaterThan(0);
    });

    it('uses exact account spelling safely even for prototype-looking names',async()=>{
        const {store}=fixture();const names=['__proto__','constructor','toString'];
        const root=await store.prepareState(null,names.map(account=>({account,state:state(account)})));
        for(const account of names)expect(await store.readAccount(root,account)).toEqual(state(account));
        expect(await store.readAccount(root,'Constructor')).toBeNull();
    });

    it('distinguishes missing/incomplete/corrupt immutable data from metadata errors and transport outages',async()=>{
        const {store,memory}=fixture();const result=await store.prepareAccountState(state('alice'));
        await dataError(store.readCommit('h45abicmt1:'+'f'.repeat(64)),'missing','commit');
        await dataError(store.readCommit(result.id),'invalid','commit');
        const manifest=memory.documents.get(memory.key(store.recordsIndex,result.id))!.document;
        const chunkKey=memory.key(store.recordsIndex,manifest.chunk_ids[0]),chunk=memory.documents.get(chunkKey)!;
        memory.documents.delete(chunkKey);await dataError(store.readAccountState(result.id),'incomplete','account-state');
        memory.documents.set(chunkKey,chunk);chunk.document.payload='AA==';await dataError(store.readAccountState(result.id),'invalid','account-state');
        memory.faults.read=(response:any)=>({...response,_index:'foreign'});
        expect(await failure(store.readAccountState(result.id))).not.toBeInstanceOf(ProtocolAbiFrontierReadError);delete memory.faults.read;
        const outage=new Error('ES offline');memory.faults.beforeRead=()=>{throw outage;};await expect(store.readAccountState(result.id)).rejects.toBe(outage);
    });

    it('rejects validly hashed foreign-chain envelopes and bucket/account substitution',async()=>{
        const {store,memory}=fixture();await store.prepareCommit({seed:true});
        const foreign=new ProtocolAbiFrontierStore(memory.client as any,'foreign'),commit=await foreign.prepareCommit({blockNum:42});
        for(const [key,value] of [...memory.documents])if(key.startsWith(foreign.recordsIndex+'\0'))memory.documents.set(store.recordsIndex+key.slice(foreign.recordsIndex.length),structuredClone(value));
        await dataError(store.readCommit(commit.id),'invalid','commit');
        const prepared=await store.prepareAccountState(state('alice'));
        const raw=new ImmutableProtocolBundleStore(memory.client as any,'fixture',0,'protocol-abi-frontier-records','protocol-abi-frontier-records-v1');
        const write=async(kind:'root'|'bucket',value:unknown)=>{
            const record={schemaVersion:1,chain:'fixture',kind,value};const id=(kind==='root'?'h45abiroot1:':'h45abibkt1:')+hash(protocolImmutableJson(['hyperion-abi-frontier-'+kind+'-v1',record]));
            await raw.prepare(id,record);return id;
        };
        const key=hash('bob').slice(0,2),bucket=await write('bucket',{prefix:key,accounts:{bob:prepared.id}}),root=await write('root',{buckets:{[key]:bucket}});
        await dataError(store.readAccount(root,'bob'),'invalid','account-state');
        const wrongPrefix=await write('bucket',{prefix:'ff',accounts:{bob:prepared.id}}),badRoot=await write('root',{buckets:{[key]:wrongPrefix}});
        await dataError(store.readAccount(badRoot,'bob'),'invalid','bucket');
    });

    it('rejects digest-correct malformed UTF8 under an otherwise valid semantic content ID',async()=>{
        const {store,memory}=fixture(),value={text:'\ufffd'},commit=await store.prepareCommit(value);
        expect(await store.readCommit(commit.id)).toEqual(value);
        const saved=memory.documents.get(memory.key(store.recordsIndex,commit.id))!,originalManifest=structuredClone(saved.document);
        const bytes=Buffer.concat(originalManifest.chunk_ids.map((id:string)=>Buffer.from(memory.documents.get(memory.key(store.recordsIndex,id))!.document.payload,'base64')));
        const marker=Buffer.from('\ufffd'),offset=bytes.indexOf(marker);expect(offset).toBeGreaterThan(-1);
        const malformed=Buffer.concat([bytes.subarray(0,offset),Buffer.from([0xff]),bytes.subarray(offset+marker.length)]);
        // All physical hashes/lengths are consistent; UTF8 replacement would recover the original semantic object and ID.
        const digest=hash(malformed),chunkId=commit.id+':'+digest+':0';
        memory.documents.set(memory.key(store.recordsIndex,chunkId),{seq:0,primaryTerm:1,document:{kind:'chunk',bundle_id:commit.id,
            digest,byte_length:malformed.length,chunk_index:0,payload:malformed.toString('base64')}});
        saved.document={kind:'manifest',bundle_id:commit.id,digest,byte_length:malformed.length,chunk_ids:[chunkId]};
        await dataError(store.readCommit(commit.id),'invalid','commit');
        saved.document=originalManifest;expect(await store.readCommit(commit.id)).toEqual(value);
    });

    it('rejects malformed control metadata, digest, payload, source type and incomplete receipts',async()=>{
        for(const alter of [
            (response:any)=>({...response,_id:'foreign'}),(response:any)=>({...response,_primary_term:0}),
            (response:any)=>({...response,_source:{...response._source,digest:'f'.repeat(64)}}),
            (response:any)=>({...response,_source:{...response._source,payload:'!'}}),
            (response:any)=>({...response,_source:{...response._source,unexpected:true}}),
        ]){
            const {store,memory}=fixture();await store.compareAndSet(null,control());memory.faults.read=alter;
            expect(await failure(store.readControl())).not.toBeInstanceOf(ProtocolAbiFrontierReadError);
        }
        for(const alter of [(response:any)=>({...response,_index:'foreign'}),(response:any)=>({...response,result:'noop'}),(response:any)=>({...response,_seq_no:-1})]){
            const {store,memory}=fixture();memory.faults.receipt=alter;await expect(store.compareAndSet(null,control())).rejects.toThrow('durable control receipt');
        }
    });

    it('refuses source pruning, pipelines, ILM and unsafe durability on both owned indices before reads or writes',async()=>{
        for(const target of ['control','records'])for(const altered of [
            {mapping:{_source:{enabled:false}}},{mapping:{_source:{includes:['digest']}}},{mapping:{_source:{excludes:['payload']}}},
            {mapping:{_source:{mode:'synthetic'}}},{setting:{'index.mapping.source.mode':'synthetic'}},
            {setting:{'index.default_pipeline':'prune'}},{setting:{'index.final_pipeline':'prune'}},
            {setting:{'index.lifecycle.name':'delete-soon'}},{setting:{'index.lifecycle.rollover_alias':'another-index'}},
            {setting:{'index.translog.durability':'async'}},{setting:{'index.number_of_replicas':'9'}},
        ]){
            const {store,memory}=fixture(),token=await store.compareAndSet(null,control()),commit=await store.prepareCommit({blockNum:42});
            const index=target==='control'?store.controlIndex:store.recordsIndex;
            if(altered.mapping)memory.mappings.set(index,{...memory.mappings.get(index),...altered.mapping});
            if(altered.setting)memory.settings.set(index,{...memory.settings.get(index),...altered.setting});
            const before=memory.calls.filter(call=>['create','index'].includes(call.method)).length;
            if(target==='control'){
                await expect(store.compareAndSet(token,control(1))).rejects.toThrow();await expect(store.readControl()).rejects.toThrow();
            }else{
                await expect(store.prepareCommit({blockNum:43})).rejects.toThrow();expect(await failure(store.readCommit(commit.id))).not.toBeInstanceOf(ProtocolAbiFrontierReadError);
            }
            expect(memory.calls.filter(call=>['create','index'].includes(call.method)).length).toBe(before);
        }
    });

    it('bounds payload/node counts and rejects malformed updates before storage writes or getter execution',async()=>{
        const {store,memory}=fixture();let getters=0;
        const accessor=Object.defineProperty({},'value',{enumerable:true,get(){getters++;return 1;}});
        await expect(store.compareAndSet(null,accessor)).rejects.toThrow('accessors');expect(getters).toBe(0);
        await expect(store.compareAndSet(null,{large:'x'.repeat(1024*1024)})).rejects.toThrow('bounded');
        expect(await failure(store.compareAndSet(null,{large:'x'.repeat(1024*1024)}))).toBeInstanceOf(ProtocolAbiFrontierLimitError);
        await expect(store.compareAndSet(null,Array.from({length:21000},()=>0))).rejects.toThrow('node budget');
        expect(await failure(store.compareAndSet(null,Array.from({length:21000},()=>0)))).toBeInstanceOf(ProtocolAbiFrontierLimitError);
        const overBudget=Array.from({length:10001},(_,index)=>({account:'account-'+index,state:null}));
        expect(await failure(store.prepareState(null,overBudget))).toBeInstanceOf(ProtocolAbiFrontierLimitError);
        await expect(store.prepareAccountState({account:''})).rejects.toThrow('identity');
        await expect(store.prepareState(null,[{account:'alice',state:state('bob')}])).rejects.toThrow('update');
        await expect(store.prepareState(null,[{account:'alice',state:state('alice')},{account:'alice',state:state('alice')}])).rejects.toThrow('duplicate');
        expect(memory.calls.length).toBe(0);
        const corrupt=await failure(store.prepareAccountState({account:''}));expect(corrupt).not.toBeInstanceOf(ProtocolAbiFrontierLimitError);
        const unsafe=fixture();await unsafe.store.compareAndSet(null,control());
        unsafe.memory.settings.get(unsafe.store.controlIndex)['index.translog.durability']='async';
        expect(await failure(unsafe.store.readControl())).not.toBeInstanceOf(ProtocolAbiFrontierLimitError);
        const unavailable=fixture(),transport=new Error('ABI observation exceeds bounded JSON byte budget');
        unavailable.memory.faults.beforeWrite=()=>{throw transport;};
        expect(await failure(unavailable.store.prepareCommit({blockNum:42}))).toBe(transport);
        expect(transport).not.toBeInstanceOf(ProtocolAbiFrontierLimitError);
    });
});
