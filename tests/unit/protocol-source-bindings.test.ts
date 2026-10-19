import {describe,expect,it} from 'bun:test';
import {ProtocolSourceBindingStore,ProtocolSourceBindingReadError,protocolSourceContextId,protocolSourceSelectionId,
    type ProtocolSourceContext,type ProtocolSourceSelection,type ProtocolSourceQuarantine} from '../../src/indexer/protocol/source-bindings.js';
import {ImmutableProtocolBundleStore} from '../../src/indexer/protocol/immutable-bundle-store.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {observationMemoryClient} from './protocol-observation-memory.mjs';

const context=():ProtocolSourceContext=>({schemaVersion:1,chainId:'1'.repeat(64),schemaJson:'{"version":"eosio::abi/1.1"}',
    protocol:{id:'@eosrio/hyperion-wire-plugin',profileId:'wire-source-fixture',components:[
        {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)},
        {id:'wire-rust',runtime:'rust',version:'0.0.0-dev.1',sourceRevision:'c'.repeat(40),sha256:'d'.repeat(64)}]}});
const selection=(contextId:string):ProtocolSourceSelection=>({schemaVersion:1,contextId,readerSessionId:'reader-fixture-1',readerRole:'bulk',assignmentId:'42-43',
    source:{chainId:'1'.repeat(64),blockNum:42,blockId:'2'.repeat(64),previousBlockId:'3'.repeat(64)},
    frameSha256:'4'.repeat(64),captureSha256:'5'.repeat(64),head:{blockNum:45,blockId:'6'.repeat(64)},irreversible:{blockNum:40,blockId:'7'.repeat(64)}});
const quarantine=():ProtocolSourceQuarantine=>({schemaVersion:1,chainId:context().chainId,protocol:context().protocol,
    frameHex:'00ff112233',reason:{code:'missing-selection',message:'Untrusted source binding'},claimedSelectionId:null});
async function ready(replicas=0){
    const memory=observationMemoryClient(replicas),store=new ProtocolSourceBindingStore(memory.client as any,'fixture',replicas);
    const prepared=await store.prepareContext(context()),input=selection(prepared.id),selected=await store.prepareSelection(input);
    return {memory,store,input,id:selected.id,contextId:prepared.id};
}
async function readError(promise:Promise<unknown>,code:string,recordType:string){
    let error:any;try{await promise;}catch(caught){error=caught;}
    expect(error).toBeInstanceOf(ProtocolSourceBindingReadError);expect(error.code).toBe(code);expect(error.recordType).toBe(recordType);return error;
}

describe('durable protocol source bindings',()=>{
    it('preserves baseline observation IDs and persisted byte digests after extracting shared persistence',async()=>{
        // Golden values independently executed against the complete a29749fc adapter, including Unicode and reversed artifact order.
        const memory=observationMemoryClient(),store=new ProtocolAbiObservationStore(memory.client as any,'fixture',0,{chunkBytes:256,maximumBytes:10000,maximumChunks:100});
        const source=selection('h45srcctx1:'+'a'.repeat(64)).source;
        const capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson:context().schemaJson,blockHex:'00ff',tracesHex:'0102',deltasHex:null};
        const input:ProtocolAbiObservationRecord={schemaVersion:1,protocol:context().protocol,
            source:{...source,inputSha256:protocolAbiCaptureDigest(source,capture)},capture,
            observation:{status:'incomplete',error:{code:'raw-source',message:'Unicode retained: λ'}}};
        input.protocol.components=[...input.protocol.components].reverse();
        expect(await store.prepare(input)).toEqual({id:'h45abi1:90881131df1c6eccac8afde1fc1437a69dfd92e6dea09befb680052ce183887d',
            digest:'33a1a5576990159c34c81cfde5fe88b0409a17defb5834dfa23f6b3dbe0a150b'});
        expect(memory.documents.size).toBe(6);
    });

    it('retains one exact context across selections and identical redelivery with fresh durable receipts',async()=>{
        const {memory,store,input,id,contextId}=await ready(1);
        const read=await store.readSelection(id);expect(read).toEqual({selection:input,context:context()});
        expect(Object.isFrozen(read.context.protocol.components)).toBe(true);expect(Object.isFrozen(read.selection.source)).toBe(true);
        expect(await store.prepareContext(context())).toEqual({id:contextId});expect(await store.prepareSelection(input)).toEqual({id});
        const reversed=context();reversed.protocol.components=[...reversed.protocol.components].reverse();
        expect(await store.prepareContext(reversed)).toEqual({id:contextId});
        const next=selection(contextId);next.source.blockNum++;next.source.blockId='8'.repeat(64);next.readerSessionId='replacement-reader';
        const nextId=(await store.prepareSelection(next)).id;expect(nextId).not.toBe(id);
        expect((await store.readSelection(nextId)).context).toEqual(context());expect(await store.readSelection(id)).toEqual(read);
        expect([...memory.documents.keys()].filter(key=>/^h45srcctx1:[a-f0-9]{64}$/.test(key))).toEqual([contextId]);
        expect(memory.calls.some(call=>call.method==='index')).toBe(true);
        for(const {request} of memory.calls.filter(call=>['create','index'].includes(call.method))){
            expect(request.wait_for_active_shards).toBe('all');expect(request.pipeline).toBe('_none');expect(request.refresh).toBe(false);
        }
        for(const {request} of memory.calls.filter(call=>call.method==='get'))expect(request.realtime).toBe(true);
        expect(JSON.stringify(read)).not.toMatch(/canonical|ready|frontier/);
    });

    it('separates exact frames, captures, schemas, pins and reader provenance without expiring admitted selections',async()=>{
        const {store,input,id}=await ready();
        for(const edit of [
            (value:ProtocolSourceSelection)=>{value.frameSha256='8'.repeat(64);},
            (value:ProtocolSourceSelection)=>{value.captureSha256='8'.repeat(64);},
            (value:ProtocolSourceSelection)=>{value.readerSessionId='second';},
            (value:ProtocolSourceSelection)=>{value.head.blockNum++;},
            (value:ProtocolSourceSelection)=>{value.source.blockId='8'.repeat(64);},
        ]){const changed=structuredClone(input);edit(changed);expect((await store.prepareSelection(changed)).id).not.toBe(id);}
        for(const edit of [
            (value:ProtocolSourceContext)=>{value.schemaJson='{ "version": "eosio::abi/1.1" }';},
            (value:ProtocolSourceContext)=>{value.protocol.profileId='different-profile';},
            (value:ProtocolSourceContext)=>{value.protocol.components=[{...value.protocol.components[0],sha256:'8'.repeat(64)}];},
        ]){const changed=context();edit(changed);expect((await store.prepareContext(changed)).id).not.toBe(input.contextId);}
        expect((await store.readSelection(id)).selection).toEqual(input);
    });

    it('durably retains exact quarantined bytes without requiring a valid claimed selection',async()=>{
        const memory=observationMemoryClient(),store=new ProtocolSourceBindingStore(memory.client as any,'fixture');
        const capsule=quarantine();capsule.claimedSelectionId='invalid:claimed-header';
        const result=await store.quarantine(capsule);expect(await store.readQuarantine(result.id)).toEqual(capsule);
        expect(await store.quarantine(capsule)).toEqual(result);
        const changed=structuredClone(capsule);changed.frameHex='00ff112234';expect((await store.quarantine(changed)).id).not.toBe(result.id);
        expect([...memory.documents.keys()].some(key=>key.startsWith('h45srcsel1:'))).toBe(false);
    });

    it('links one immutable PREPARE result to each selection and rejects divergent redo',async()=>{
        const {store,id}=await ready();
        const link={schemaVersion:1 as const,selectionId:id,observationId:'h45abi1:'+'8'.repeat(64),observationDigest:'9'.repeat(64)};
        const result=await store.prepareObservationLink(link);expect(await store.readObservationLink(id)).toEqual(link);
        expect(await store.prepareObservationLink(link)).toEqual(result);
        await expect(store.prepareObservationLink({...link,observationDigest:'a'.repeat(64)})).rejects.toThrow('Immutable');
        await expect(store.prepareObservationLink({...link,observationId:'h45abi1:'+'a'.repeat(64)})).rejects.toThrow('Immutable');
        expect(await store.readObservationLink(id)).toEqual(link);
        await readError(store.prepareObservationLink({...link,selectionId:'h45srcsel1:'+'f'.repeat(64)}),'missing','selection');
    });

    it('distinguishes exact missing and partially retained records from unsafe ES responses or outages',async()=>{
        const {store,memory,id,contextId}=await ready();
        await readError(store.readSelection('h45srcsel1:'+'f'.repeat(64)),'missing','selection');
        await readError(store.readSelection('malformed'),'invalid','selection');
        const manifest=memory.documents.get(id)!;memory.documents.delete(manifest.document.chunk_ids![0]);
        await readError(store.readSelection(id),'incomplete','selection');
        memory.faults.read=(response:any)=>({...response,_index:'foreign-index'});
        const error=await store.readSelection(id).catch(value=>value);expect(error).not.toBeInstanceOf(ProtocolSourceBindingReadError);
        delete memory.faults.read;
        const expected=Object.assign(new Error('service unavailable'),{meta:{statusCode:503}});
        memory.faults.read=()=>{throw expected;};await expect(store.readSelection(id)).rejects.toBe(expected);delete memory.faults.read;
        const second=await ready();second.memory.documents.delete(second.contextId);
        await readError(second.store.readSelection(second.id),'missing','context');
        expect(contextId).toMatch(/^h45srcctx1:/);
    });

    it('rejects corrupted bytes, correctly hashed foreign sources and record-type/hash substitution',async()=>{
        const {store,memory,id}=await ready();
        const chunk=memory.documents.get(memory.documents.get(id)!.document.chunk_ids![0])!;chunk.document.payload='AA==';
        await readError(store.readSelection(id),'invalid','selection');
        const second=await ready();
        const raw=new ImmutableProtocolBundleStore(second.memory.client as any,'fixture',0,'protocol-source-bindings','protocol-source-bindings-v1');
        const foreign=selection(second.contextId);foreign.source.chainId='f'.repeat(64);
        const foreignId=protocolSourceSelectionId(foreign);await raw.prepare(foreignId,foreign);
        await readError(second.store.readSelection(foreignId),'invalid','selection');
        const forged=selection(second.contextId);forged.frameSha256='e'.repeat(64);
        const fakeId='h45srcsel1:'+'a'.repeat(64);await raw.prepare(fakeId,forged);
        await readError(second.store.readSelection(fakeId),'invalid','selection');
        const wrongType='h45srcsel1:'+'b'.repeat(64);await raw.prepare(wrongType,context());
        await readError(second.store.readSelection(wrongType),'invalid','selection');
    });

    it('requires complete-copy create/CAS receipts and never blesses an earlier partial write via GET',async()=>{
        const memory=observationMemoryClient(1),store=new ProtocolSourceBindingStore(memory.client as any,'fixture',1);let partial=true;
        memory.faults.receipt=(receipt:any)=>partial?{...receipt,_shards:{total:2,successful:1,failed:1}}:receipt;
        await expect(store.prepareContext(context())).rejects.toThrow('durable write receipt');
        await expect(store.prepareContext(context())).rejects.toThrow('durable write receipt');expect(memory.calls.some(call=>call.method==='index')).toBe(true);
        partial=false;const prepared=await store.prepareContext(context());expect(prepared.id).toBe(protocolSourceContextId(context()));
    });

    it('checks source and ingest-pipeline retention again before both read and write',async()=>{
        for(const fault of [
            {mapping:{_source:{enabled:false}}},{mapping:{_source:{includes:['digest']}}},{mapping:{_source:{excludes:['payload']}}},
            {mapping:{_source:{mode:'synthetic'}}},{setting:{'index.mapping.source.mode':'synthetic'}},
            {setting:{'index.default_pipeline':'prune'}},{setting:{'index.final_pipeline':'prune'}},{setting:{'index.translog.durability':'async'}},
        ]){
            const {store,memory,id}=await ready();
            if(fault.mapping)memory.faults.mapping=(value:any,request:any)=>({[request.index]:{mappings:{...value,...fault.mapping}}});
            if(fault.setting)memory.faults.settings=(value:any,request:any)=>({[request.index]:{settings:{...value,...fault.setting}}});
            const before=memory.calls.filter(call=>['create','index'].includes(call.method)).length;
            await expect(store.prepareContext(context())).rejects.toThrow();
            const error=await store.readSelection(id).catch(value=>value);expect(error).not.toBeInstanceOf(ProtocolSourceBindingReadError);
            expect(memory.calls.filter(call=>['create','index'].includes(call.method)).length).toBe(before);
        }
    });

    it('validates portable bounded record types before any storage call or accessor evaluation',async()=>{
        const memory=observationMemoryClient(),store=new ProtocolSourceBindingStore(memory.client as any,'fixture');
        let getters=0;const accessor=Object.defineProperty(context(),'schemaJson',{enumerable:true,get(){getters++;return '{}';}});
        await expect(store.prepareContext(accessor)).rejects.toThrow('accessors');expect(getters).toBe(0);
        const duplicate=context();duplicate.protocol.components=[duplicate.protocol.components[0],duplicate.protocol.components[0]];
        const incorrect=context();incorrect.protocol.components=[{...incorrect.protocol.components[0],version:'^1.0.0'}];
        const oversized=context();oversized.schemaJson='x'.repeat(8*1024*1024);
        for(const input of [duplicate,incorrect,oversized,{...context(),canonical:true},{...context(),schemaJson:'[]'}])await expect(store.prepareContext(input)).rejects.toThrow();
        for(const input of [{...quarantine(),frameHex:'0'},{...quarantine(),claimedSelectionId:23}])await expect(store.quarantine(input as any)).rejects.toThrow();
        expect(memory.calls.length).toBe(0);
        const good=await store.prepareContext(context());
        await expect(store.prepareSelection({...selection(good.id),source:{...selection(good.id).source,chainId:'f'.repeat(64)}})).rejects.toThrow();
    });
});
