import {describe,expect,it} from 'bun:test';
import {ProtocolAbiObservationStore,protocolAbiObservationId,protocolAbiCaptureDigest,protocolAbiObservationJson,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {observationMemoryClient} from './protocol-observation-memory.mjs';
import {assertProtocolAbiObservationFacts} from '../../src/indexer/protocol/abi-observation-facts.js';

const seal=(input:ProtocolAbiObservationRecord)=>{const {inputSha256,...position}=input.source;input.source.inputSha256=protocolAbiCaptureDigest(position,input.capture);return input;};
const record=():ProtocolAbiObservationRecord=>seal({schemaVersion:1,protocol:{id:'@eosrio/hyperion-wire-plugin',profileId:'wire-fixture',
    components:[{id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)},
        {id:'wire-rust',runtime:'rust',version:'0.0.0-dev.1',sourceRevision:'c'.repeat(40),sha256:'d'.repeat(64)}]},
    source:{chainId:'1'.repeat(64),blockNum:42,blockId:'2'.repeat(64),previousBlockId:'3'.repeat(64),inputSha256:'4'.repeat(64)},
    capture:{kind:'unattested-ship-result-sections-v1',schemaJson:'{}',blockHex:'00',tracesHex:'00',deltasHex:'00'},
    observation:{status:'observed',facts:{schemaVersion:1,actionInputs:[],deployments:[],finalStates:[]}}});

describe('ABI observation PREPARE storage',()=>{
    it('durably commits chunks before the immutable manifest and reads exact IDs across refresh lag',async()=>{
        const memory=observationMemoryClient(1);const store=new ProtocolAbiObservationStore(memory.client as any,'fixture',1,{chunkBytes:130,maximumBytes:10000,maximumChunks:100});
        const input=record();input.observation={status:'observed',facts:{rawAbi:'ff'.repeat(4000),globalSequence:'18446744073709551615'}};
        const result=await store.prepare(input);expect(await store.read(result.id)).toEqual(input);
        const writes=memory.calls.filter(call=>call.method==='create');
        expect(writes.at(-1)!.request.document.kind).toBe('manifest');
        expect(writes.length).toBeGreaterThan(2);
        for(const {request} of writes){expect(request.refresh).toBe(false);expect(request.wait_for_active_shards).toBe('all');}
        for(const {request} of memory.calls.filter(call=>call.method==='get'))expect(request.realtime).toBe(true);
        expect(JSON.stringify(input)).not.toMatch(/canonical|ready|frontier/);
        expect(await store.prepare(input)).toEqual(result);
        expect(memory.calls.some(call=>call.method==='index'&&Number.isSafeInteger(call.request.if_seq_no))).toBe(true);
    });

    it('distinguishes raw captures, forks and observer artifacts but rejects changed facts under the same capture identity',async()=>{
        const memory=observationMemoryClient();const store=new ProtocolAbiObservationStore(memory.client as any,'fixture');
        const first=record();const result=await store.prepare(first);
        const changed=structuredClone(first);changed.observation={status:'incomplete',error:{code:'changed-facts',message:'Different observations'}};
        expect(protocolAbiObservationId(changed)).toBe(result.id);
        await expect(store.prepare(changed)).rejects.toThrow('Immutable ABI observation conflict');
        const fork=seal({...structuredClone(first),source:{...first.source,blockId:'6'.repeat(64)}});
        expect((await store.prepare(fork)).id).not.toBe(result.id);
        const artifact=structuredClone(first);artifact.protocol.components=[{...artifact.protocol.components[0],sha256:'7'.repeat(64)}];
        expect((await store.prepare(artifact)).id).not.toBe(result.id);
        const raw=structuredClone(first);raw.capture.tracesHex='01';seal(raw);
        expect((await store.prepare(raw)).id).not.toBe(result.id);
        expect(await store.read(result.id)).toEqual(first);
    });

    it('does not commit a manifest after a partial chunk failure and repairs identical redelivery safely',async()=>{
        const memory=observationMemoryClient();let fail=true;
        memory.faults.beforeWrite=(request:any)=>{if(fail&&request.document.chunk_index===1)throw new Error('write unavailable');};
        const store=new ProtocolAbiObservationStore(memory.client as any,'fixture',0,{chunkBytes:100,maximumBytes:10000,maximumChunks:100});
        const input=record();
        await expect(store.prepare(input)).rejects.toThrow('write unavailable');
        expect([...memory.documents.values()].some(value=>value.document.kind==='manifest')).toBe(false);
        fail=false;const prepared=await store.prepare(input);expect(await store.read(prepared.id)).toEqual(input);
    });

    it('requires a fresh complete copy receipt after an earlier partially successful write',async()=>{
        const memory=observationMemoryClient(1);let partial=true;
        memory.faults.receipt=(receipt:any)=>partial?{...receipt,_shards:{total:2,successful:1,failed:1}}:receipt;
        const store=new ProtocolAbiObservationStore(memory.client as any,'fixture',1);
        await expect(store.prepare(record())).rejects.toThrow('durable write receipt');
        await expect(store.prepare(record())).rejects.toThrow('durable write receipt');
        expect(memory.calls.some(call=>call.method==='index')).toBe(true);
        partial=false;const result=await store.prepare(record());expect(await store.read(result.id)).toEqual(record());
    });

    it('rejects unsafe index durability, incomplete receipts, corrupt reads and bounded-capacity violations',async()=>{
        const memory=observationMemoryClient();const store=new ProtocolAbiObservationStore(memory.client as any,'fixture');
        memory.faults.settings=(settings:any,request:any)=>({[request.index]:{settings:{...settings,'index.translog.durability':'async'}}});
        await expect(store.prepare(record())).rejects.toThrow('durability');
        expect(memory.documents.size).toBe(0);delete memory.faults.settings;
        memory.faults.receipt=(receipt:any)=>({...receipt,_id:'wrong'});
        await expect(store.prepare(record())).rejects.toThrow('receipt');delete memory.faults.receipt;
        const result=await store.prepare(record());
        memory.faults.read=(response:any)=>({...response,found:false});
        await expect(store.read(result.id)).rejects.toThrow('realtime read');delete memory.faults.read;
        const chunk=[...memory.documents.values()].find(value=>value.document.kind==='chunk')!;chunk.document.payload='AA==';
        await expect(store.read(result.id)).rejects.toThrow('integrity');
        const bounded=observationMemoryClient();const tiny=new ProtocolAbiObservationStore(bounded.client as any,'fixture',0,{chunkBytes:8,maximumBytes:20,maximumChunks:3});
        await expect(tiny.prepare(record())).rejects.toThrow('bounded');expect(bounded.calls.length).toBe(0);
    });

    it('retains explicit incomplete and cleared/rejected ABI facts without validating contract ABI bodies',async()=>{
        const memory=observationMemoryClient();const store=new ProtocolAbiObservationStore(memory.client as any,'fixture');
        const input=record();input.observation={status:'observed',facts:{schemaVersion:1,actionInputs:[],deployments:[{account:'alice',abiHex:''},{account:'bob',abiHex:'ff'}],finalStates:[]}};
        const first=await store.prepare(input);expect(await store.read(first.id)).toEqual(input);
        const incomplete=record();incomplete.source.blockId='8'.repeat(64);seal(incomplete);
        incomplete.observation={status:'incomplete',error:{code:'missing-traces',message:'Source traces are unavailable'}};
        const second=await store.prepare(incomplete);expect(await store.read(second.id)).toEqual(incomplete);
    });

    it('retains incomplete raw source and permits a distinct complete refill without overwriting the earlier capture',async()=>{
        const memory=observationMemoryClient();const store=new ProtocolAbiObservationStore(memory.client as any,'fixture');
        const incomplete=record();incomplete.capture.tracesHex=null;seal(incomplete);
        incomplete.observation={status:'incomplete',error:{code:'missing-traces',message:'Missing source'}};
        const first=await store.prepare(incomplete);const second=await store.prepare(record());
        expect(first.id).not.toBe(second.id);expect(await store.read(first.id)).toEqual(incomplete);expect(await store.read(second.id)).toEqual(record());
        const reversed=record();reversed.protocol.components=[...reversed.protocol.components].reverse();
        expect(await store.prepare(reversed)).toEqual(second);
    });

    it('rejects accessors, symbols, sparse arrays and aggregate JSON budgets without executing getters',()=>{
        let getters=0;const accessor=Object.defineProperty({},'value',{enumerable:true,get(){getters++;return 1;}});
        expect(()=>protocolAbiObservationJson(accessor)).toThrow('accessors');expect(getters).toBe(0);
        expect(()=>protocolAbiObservationJson({[Symbol('hidden')]:1})).toThrow('native');
        expect(()=>protocolAbiObservationJson(new Array(2))).toThrow('sparse');
        expect(()=>protocolAbiObservationJson(['xxxxxxxx','xxxxxxxx'],10)).toThrow('bounded');
        expect(()=>protocolAbiObservationJson({large:'x'.repeat(100)},20)).toThrow('bounded');
    });

    it('rejects source filtering, synthetic source and incompatible replay fields before writing',async()=>{
        for(const source of [{enabled:false},{includes:['digest']},{excludes:['payload']},{mode:'synthetic'}]) {
            const memory=observationMemoryClient();memory.faults.mapping=(mapping:any,request:any)=>({[request.index]:{mappings:{...mapping,_source:source}}});
            await expect(new ProtocolAbiObservationStore(memory.client as any,'fixture').prepare(record())).rejects.toThrow('incompatible');
            expect(memory.documents.size).toBe(0);
        }
        const memory=observationMemoryClient();memory.faults.mapping=(mapping:any,request:any)=>({[request.index]:{mappings:{...mapping,
            properties:{...mapping.properties,chunk_ids:{type:'text'}}}}});
        await expect(new ProtocolAbiObservationStore(memory.client as any,'fixture').prepare(record())).rejects.toThrow('incompatible');
        const synthetic=observationMemoryClient();synthetic.faults.settings=(settings:any,request:any)=>({[request.index]:{settings:{...settings,'index.mapping.source.mode':'synthetic'}}});
        await expect(new ProtocolAbiObservationStore(synthetic.client as any,'fixture').prepare(record())).rejects.toThrow('durability');
        const changed=observationMemoryClient(),liveStore=new ProtocolAbiObservationStore(changed.client as any,'fixture');
        await liveStore.prepare(record());const before=changed.calls.filter(call=>call.method==='create').length;
        changed.faults.mapping=(mapping:any,request:any)=>({[request.index]:{mappings:{...mapping,_source:{excludes:['payload']}}}});
        await expect(liveStore.prepare(record())).rejects.toThrow('incompatible');
        expect(changed.calls.filter(call=>call.method==='create').length).toBe(before);
        for(const key of ['index.default_pipeline','index.final_pipeline']) {
            const ingest=observationMemoryClient();ingest.faults.settings=(settings:any,request:any)=>({[request.index]:{settings:{...settings,[key]:'prune_source'}}});
            await expect(new ProtocolAbiObservationStore(ingest.client as any,'fixture').prepare(record())).rejects.toThrow('retention');
            expect(ingest.documents.size).toBe(0);
        }
    });

    it('validates nested SDK facts and lossless decimals without parsing contract ABI bodies',()=>{
        const valid:any={schemaVersion:1,actionInputs:[{transactionId:'a'.repeat(64),actionOrdinal:1,receiver:'alice',account:'alice',name:'setabi',
            rawHex:'ff',globalSequence:'18446744073709551615',receiptAbiSequence:'4294967295',inputActionOrdinal:1}],
            deployments:[{account:'alice',abiHex:'ff',action:{transactionId:'a'.repeat(64),actionOrdinal:1},globalSequence:'18446744073709551615',effect:'native-before-receipt'}],
            finalStates:[{account:'alice',present:true,abiHex:'',deltaOrdinal:0}]};
        expect(()=>assertProtocolAbiObservationFacts(valid)).not.toThrow();
        const emptyName=structuredClone(valid);emptyName.actionInputs[0].name='';
        expect(()=>assertProtocolAbiObservationFacts(emptyName)).not.toThrow();
        for(const change of [
            (facts:any)=>{facts.actionInputs=[null];},(facts:any)=>{facts.deployments=[{}];},
            (facts:any)=>{facts.actionInputs[0].globalSequence=123;},(facts:any)=>{facts.actionInputs[0].globalSequence='018';},
            (facts:any)=>{facts.actionInputs[0].receiptAbiSequence='4294967296';},(facts:any)=>{facts.deployments[0].abiHex='0';},
            (facts:any)=>{facts.finalStates[0].present=1;},(facts:any)=>{facts.finalStates[0].deltaOrdinal=-1;},
        ]){const malformed=structuredClone(valid);change(malformed);expect(()=>assertProtocolAbiObservationFacts(malformed)).toThrow('facts');}
    });
});
