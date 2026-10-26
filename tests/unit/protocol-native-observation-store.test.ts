import {describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {ProtocolNativeObservationStore,NativeObservationReadError,protocolNativeObservationId,protocolSourceNativeObservationLinkId,protocolNativeObservationBounds,
    type ProtocolNativeObservationRecord} from '../../src/indexer/protocol/native-observation-store.js';
import {ProtocolSourceBindingStore,protocolSourceObservationLinkId,type ProtocolSourceContext,type ProtocolSourceSelection} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {ImmutableProtocolBundleStore,ImmutableProtocolBundleReadError,protocolImmutableJson} from '../../src/indexer/protocol/immutable-bundle-store.js';

const chain='native-store-fixture',hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const clone=<T>(value:T):T=>structuredClone(value);
const isWrite=(call:any)=>['createIndex','create','index'].includes(call.method);
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
function transportSignals(client:any){
    const signals:Array<AbortSignal|undefined>=[];
    for(const [owner,name] of [[client,'get'],[client.indices,'getMapping'],[client.indices,'getSettings']] as const){
        const original=owner[name];owner[name]=(request:any,options?:{signal?:AbortSignal})=>{
            signals.push(options?.signal);return original(request,options);
        };
    }
    return signals;
}
const target=(request:any,phase:string)=>request.index===chain+'-protocol-native-actions-v1'
    &&(phase==='link'?request.document.bundle_id.startsWith('h45srcnat1:'):
        request.document.bundle_id.startsWith('h45natobs1:')&&request.document.kind===phase);
// Synthetic storage receipts/bytes only: inventory completeness belongs to the independent host derivation.
async function fixture(replicas=0,options:{capture?:Partial<ProtocolAbiObservationRecord['capture']>;abiProtocol?:ProtocolSourceContext['protocol'];abiLinkDigest?:string;
    components?:ProtocolSourceContext['protocol']['components']}={}){
    const memory=frontierMemoryClient(replicas),client=memory.client as any;
    const sources=new ProtocolSourceBindingStore(client,chain,replicas),abis=new ProtocolAbiObservationStore(client,chain,replicas);
    const context:ProtocolSourceContext={schemaVersion:1,chainId:'1'.repeat(64),schemaJson:'{}',protocol:{id:'journal-fixture',profileId:'engineering-v1',
        components:options.components??[{id:'node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]}};
    const contextId=(await sources.prepareContext(context)).id;
    const source={chainId:context.chainId,blockNum:42,blockId:'2'.repeat(64),previousBlockId:'3'.repeat(64)};
    const capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson:context.schemaJson,blockHex:'00',tracesHex:'00',deltasHex:null,...options.capture};
    const abiObservation:ProtocolAbiObservationRecord={schemaVersion:1,protocol:options.abiProtocol??context.protocol,
        source:{...source,inputSha256:protocolAbiCaptureDigest(source,capture)},capture,
        observation:{status:'incomplete',error:{code:'fixture_abi_incomplete',message:'Original source remains retained'}}};
    const observed=await abis.prepare(abiObservation);
    const selection:ProtocolSourceSelection={schemaVersion:1,contextId,source,readerSessionId:'fixture-reader',readerRole:'live',assignmentId:null,
        frameSha256:'4'.repeat(64),captureSha256:abiObservation.source.inputSha256,head:{blockNum:42,blockId:source.blockId},irreversible:{blockNum:0,blockId:'0'.repeat(64)}};
    const selectionId=(await sources.prepareSelection(selection)).id;
    const abiLink={schemaVersion:1 as const,selectionId,observationId:observed.id,observationDigest:options.abiLinkDigest??observed.digest};
    await sources.prepareObservationLink(abiLink);
    const record:ProtocolNativeObservationRecord={schemaVersion:1,kind:'observation',nativeInterfaceVersion:1,contextId,protocol:context.protocol,source,
        captureRef:{abiObservationId:observed.id,abiObservationDigest:observed.digest,inputSha256:abiObservation.source.inputSha256},
        inventory:{schemaVersion:1,inputCount:1,firstReceiverCount:1,sha256:'f'.repeat(64)},
        observation:{status:'observed',facts:{schemaVersion:1,decisions:[{origin:{transactionId:'a'.repeat(64),actionOrdinal:1,rawSha256:hash('00')},kind:'contract'}]}}};
    const store=new ProtocolNativeObservationStore(client,chain,replicas);
    return {memory,client,sources,abis,context,selection,selectionId,abiObservation,abiLink,record,store};
}

describe('durable native observations without ABI authority',()=>{
    it('returns a complete referenced readback and reopens it without writes even when ABI extraction was incomplete',async()=>{
        const f=await fixture(),prepared=await f.store.prepare(f.selectionId,f.record);
        expect(prepared.record).toEqual(f.record);expect(prepared.selection).toEqual(f.selection);
        expect(prepared.context).toEqual(f.context);expect(prepared.abiObservation).toEqual(f.abiObservation);expect(prepared.abiLink).toEqual(f.abiLink);
        const reader=new ProtocolNativeObservationStore(f.client,chain,0,undefined,{readOnly:true}),before=f.memory.calls.length;
        expect(await reader.readSelection(f.selectionId)).toEqual(prepared);
        expect(f.memory.calls.slice(before).some((call:any)=>['createIndex','create','index'].includes(call.method))).toBe(false);
    });

    it('reuses immutable source evidence across deliveries and conflicts on changed outcomes without changing ABI bytes',async()=>{
        const f=await fixture(),first=await f.store.prepare(f.selectionId,f.record),before=protocolImmutableJson(await f.abis.read(f.abiLink.observationId));
        expect(await f.store.prepare(f.selectionId,clone(f.record))).toEqual(first);
        const delivery={...f.selection,readerSessionId:'another-reader',readerRole:'repair' as const,head:{blockNum:99,blockId:'9'.repeat(64)}};
        const anotherId=(await f.sources.prepareSelection(delivery)).id;
        await f.sources.prepareObservationLink({...f.abiLink,selectionId:anotherId});
        const another=await f.store.prepare(anotherId,f.record);
        expect(another.linkId).not.toBe(first.linkId);expect(another.link.observationId).toBe(first.link.observationId);
        expect(another.link.observationDigest).toBe(first.link.observationDigest);
        const changed=clone(f.record);changed.observation={status:'incomplete',error:{code:'changed',message:'A changed derived result conflicts'}};
        expect(protocolNativeObservationId(changed)).toBe(first.link.observationId);
        await expect(f.store.prepare(f.selectionId,changed)).rejects.toThrow(/conflict/);
        expect(protocolImmutableJson(await f.abis.read(f.abiLink.observationId))).toBe(before);
        expect((await f.store.readSelection(f.selectionId)).record).toEqual(f.record);
    });

    it('validates every exact source reference before creating native storage',async()=>{
        const changes:Array<(value:ProtocolNativeObservationRecord)=>void>=[
            value=>{value.contextId='h45srcctx1:'+'a'.repeat(64);},
            value=>{value.source.chainId='a'.repeat(64);},value=>{value.source.blockNum++;},
            value=>{value.source.blockId='a'.repeat(64);},value=>{value.source.previousBlockId=null;},
            value=>{value.protocol.id='other';},value=>{value.protocol.profileId='other';},
            value=>{(value.protocol.components[0] as any).id='other';},
            value=>{(value.protocol.components[0] as any).runtime='rust';},
            value=>{(value.protocol.components[0] as any).version='1.0.0';},
            value=>{(value.protocol.components[0] as any).sourceRevision='f'.repeat(40);},
            value=>{(value.protocol.components[0] as any).sha256='e'.repeat(64);},
            value=>{value.captureRef.abiObservationId='h45abi1:'+'a'.repeat(64);},
            value=>{value.captureRef.abiObservationDigest='a'.repeat(64);},
            value=>{value.captureRef.inputSha256='a'.repeat(64);},
        ];
        for(const change of changes){
            const f=await fixture(),changed=clone(f.record),before=f.memory.calls.length;change(changed);
            await expect(f.store.prepare(f.selectionId,changed)).rejects.toMatchObject({code:'invalid',recordType:'reference'});
            expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
        }
    });

    it('requires bounded portable SDK facts and a nonnull inventory with exact first-receiver count for observed evidence',async()=>{
        const changes:Array<(value:any)=>void>=[
            value=>{value.inventory=null;},value=>{value.inventory.firstReceiverCount=0;},
            value=>{value.inventory.firstReceiverCount=2;},value=>{value.inventory.inputCount=-1;},
            value=>{value.inventory.sha256='F'.repeat(64);},value=>{value.observation.facts.decisions=[];},
            value=>{value.observation.facts.decisions.push(clone(value.observation.facts.decisions[0]));value.inventory.inputCount=2;value.inventory.firstReceiverCount=2;},
            value=>{value.observation.facts.decisions[0].kind='native';},
            value=>{value.observation.facts.decisions[0].origin.rawSha256='bad';},
            value=>{value.observation.facts.extra=true;},value=>{value.captureRef.extra='not allowed';},
            value=>{value.protocol.components.push(clone(value.protocol.components[0]));},
            value=>{value.nativeInterfaceVersion=2;},value=>{value.observation={status:'incomplete',error:{code:'',message:'empty code'}};},
        ];
        for(const change of changes){
            const f=await fixture(),changed=clone(f.record),before=f.memory.calls.length;change(changed);
            await expect(f.store.prepare(f.selectionId,changed)).rejects.toThrow();expect(f.memory.calls.length).toBe(before);
        }
        const f=await fixture(),before=f.memory.calls.length;
        const hostile=clone(f.record);let invoked=0;
        Object.defineProperty(hostile.observation,'facts',{enumerable:true,get(){invoked++;throw new Error('Getter must not execute');}});
        await expect(f.store.prepare(f.selectionId,hostile)).rejects.toThrow();expect(invoked).toBe(0);expect(f.memory.calls.length).toBe(before);
        const bounded=new ProtocolNativeObservationStore(f.client,chain,0,{chunkBytes:128,maximumBytes:512,maximumChunks:128});
        await expect(bounded.prepare(f.selectionId,f.record)).rejects.toThrow(/budget/);expect(f.memory.calls.length).toBe(before);
    });

    it('retains explicit whole-source incompleteness with null or valid inventory and detaches caller data before awaited storage',async()=>{
        for(const inventory of [null,{schemaVersion:1 as const,inputCount:1,firstReceiverCount:1,sha256:'f'.repeat(64)}]){
            const f=await fixture(),record=clone(f.record);
            record.inventory=inventory;record.observation={status:'incomplete',error:{code:'native_source_traces_absent',message:'Original traces are unavailable'}};
            const expected=clone(record),original=f.client.get;
            let mutate=true;f.client.get=async(request:any,options:any)=>{
                if(mutate){mutate=false;record.source.blockNum=7;record.observation={status:'incomplete',error:{code:'mutated',message:'Caller changed'}};
                    if(record.inventory)record.inventory.sha256='0'.repeat(64);}
                return original(request,options);
            };
            const prepared=await f.store.prepare(f.selectionId,record);
            expect(prepared.record).toEqual(expected);expect(Object.isFrozen(prepared.record)).toBe(true);
        }
    });

    it('requires complete configured-copy receipts for every native chunk, manifest and link, including retries after unknown outcomes',async()=>{
        for(const phase of ['chunk','manifest','link'])for(const outcome of ['partial','unknown']){
            const f=await fixture(1),outage=new Error('Unknown durable outcome');let held=false;
            f.memory.faults.receipt=(response:any,request:any)=>{
                if(!held&&target(request,phase)){held=true;if(outcome==='unknown')throw outage;
                    return {...response,_shards:{total:2,successful:1,failed:0}};}
                return response;
            };
            if(outcome==='unknown')await expect(f.store.prepare(f.selectionId,f.record)).rejects.toBe(outage);
            else await expect(f.store.prepare(f.selectionId,f.record)).rejects.toThrow(/receipt/);
            expect(held).toBe(true);
            f.memory.faults.receipt=undefined;const before=f.memory.calls.length;
            const retried=await f.store.prepare(f.selectionId,f.record);
            expect(retried.record).toEqual(f.record);
            expect(f.memory.calls.slice(before).some((call:any)=>call.method==='index'&&target(call.request,phase))).toBe(true);
        }
    });

    it('never promotes readable data into durable success while retry CAS receipts remain partial or stale',async()=>{
        const f=await fixture(1);let partial=true;
        f.memory.faults.receipt=(response:any,request:any)=>target(request,'link')&&request.document.kind==='manifest'&&partial
            ?{...response,_shards:{total:2,successful:1,failed:0}}:response;
        await expect(f.store.prepare(f.selectionId,f.record)).rejects.toThrow(/receipt/);
        expect((await f.store.readSelection(f.selectionId)).record).toEqual(f.record);
        await expect(f.store.prepare(f.selectionId,f.record)).rejects.toThrow(/receipt/);
        partial=false;expect((await f.store.prepare(f.selectionId,f.record)).record).toEqual(f.record);
        const original=f.client.index;
        f.client.index=async(request:any,options:any)=>{
            if(request.index===f.store.index)throw Object.assign(new Error('stale CAS'),{meta:{statusCode:409,body:{error:{type:'version_conflict_engine_exception'}}}});
            return original(request,options);
        };
        await expect(f.store.prepare(f.selectionId,f.record)).rejects.toThrow(/CAS retry budget/);
    });

    it('preserves missing, incomplete and corrupt native/reference distinctions while genuine storage errors escape',async()=>{
        for(const scope of ['link','record','context','selection','abi-link','abi'])for(const fault of ['missing','incomplete','invalid']){
            const f=await fixture(),opening=await f.store.prepare(f.selectionId,f.record);
            const targets={link:[f.store.index,opening.linkId],record:[f.store.index,opening.link.observationId],context:[f.sources.index,f.selection.contextId],
                selection:[f.sources.index,f.selectionId],'abi-link':[f.sources.index,protocolSourceObservationLinkId(f.selectionId)],
                abi:[f.abis.index,f.abiLink.observationId]};
            const [index,id]=targets[scope as keyof typeof targets],stored=f.memory.documents.get(f.memory.key(index,id))!;
            if(fault==='missing')f.memory.documents.delete(f.memory.key(index,id));
            if(fault==='incomplete')f.memory.documents.delete(f.memory.key(index,stored.document.chunk_ids[0]));
            if(fault==='invalid')stored.document.digest='0'.repeat(64);
            await expect(f.store.readSelection(f.selectionId)).rejects.toMatchObject({code:fault,recordType:['link','record'].includes(scope)?scope==='link'?'source-link':'observation':'reference'});
        }
        const f=await fixture();await f.store.prepare(f.selectionId,f.record);
        const outage=new Error('Storage offline');f.memory.faults.beforeRead=()=>{throw outage;};
        await expect(f.store.readSelection(f.selectionId)).rejects.toBe(outage);
    });

    it('rejects pre-aborted reads before validation/I/O and cancels every nested manifest/chunk with the same caller signal',async()=>{
        const initial=await fixture(),aborted=new AbortController(),reason=Object.freeze({caller:'gone'}),before=initial.memory.calls.length;
        aborted.abort(reason);await expect(initial.store.readSelection('bad',aborted.signal)).rejects.toBe(reason);
        expect(initial.memory.calls.length).toBe(before);
        for(const scope of ['link','record','context','selection','abi-link','abi'])for(const phase of ['manifest','chunk']){
            const f=await fixture(),opening=await f.store.prepare(f.selectionId,f.record),reader=new ProtocolNativeObservationStore(f.client,chain,0,undefined,{readOnly:true});
            const targets={link:[f.store.index,opening.linkId],record:[f.store.index,opening.link.observationId],context:[f.sources.index,f.selection.contextId],
                selection:[f.sources.index,f.selectionId],'abi-link':[f.sources.index,protocolSourceObservationLinkId(f.selectionId)],abi:[f.abis.index,f.abiLink.observationId]};
            const [index,id]=targets[scope as keyof typeof targets],manifest=f.memory.documents.get(f.memory.key(index,id))!;
            const targetId=phase==='manifest'?id:manifest.document.chunk_ids[0],entered=gate(),release=gate(),abort=new AbortController();
            const signals=transportSignals(f.client),reason=Symbol(scope+' '+phase);let held=false;
            f.memory.faults.beforeRead=async(request:any)=>{if(!held&&request.index===index&&request.id===targetId){held=true;entered.release();await release.promise;}};
            const before=f.memory.calls.length,pending=reader.readSelection(f.selectionId,abort.signal);await entered.promise;
            const calls=f.memory.calls.length;abort.abort(reason);release.release();await expect(pending).rejects.toBe(reason);
            expect(f.memory.calls.length).toBe(calls);expect(signals.length).toBeGreaterThan(0);expect(signals.every(signal=>signal===abort.signal)).toBe(true);
            expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
        }
    });

    it('preserves exact abort reason over late success, malformed storage and errors resembling typed/404 read failures',async()=>{
        for(const scope of ['link','abi'])for(const outcome of ['success','malformed','outage','404','typed']){
            const f=await fixture(),opening=await f.store.prepare(f.selectionId,f.record),abort=new AbortController(),entered=gate(),release=gate();
            const index=scope==='link'?f.store.index:f.abis.index,id=scope==='link'?opening.linkId:f.abiLink.observationId;
            const reason=outcome==='404'?Object.assign(new Error('Caller-owned missing reason'),{meta:{statusCode:404,body:{_index:index,_id:id,found:false}}})
                :outcome==='typed'?new ImmutableProtocolBundleReadError('missing',id,'Caller-owned typed reason'):new Error('Caller cancelled '+outcome);
            let held=false;f.memory.faults.beforeRead=async(request:any)=>{
                if(!held&&request.index===index&&request.id===id){held=true;entered.release();await release.promise;
                    if(outcome==='outage')throw new Error('Late storage failure');if(outcome==='404'||outcome==='typed')throw reason;}
            };
            if(outcome==='malformed')f.memory.faults.read=(response:any,request:any)=>request.index===index&&request.id===id?{...response,_index:'foreign-index'}:response;
            const pending=f.store.readSelection(f.selectionId,abort.signal);await entered.promise;
            abort.abort(reason);release.release();await expect(pending).rejects.toBe(reason);
        }
    });

    it('allows independent cold read-only consumers to finish while another cancels during mapping validation',async()=>{
        const f=await fixture(),opening=await f.store.prepare(f.selectionId,f.record),reader=new ProtocolNativeObservationStore(f.client,chain,0,undefined,{readOnly:true});
        const entered=gate(),release=gate(),abort=new AbortController(),healthy=new AbortController(),reason=new Error('Only one read stopped');
        const original=f.client.indices.getMapping;let held=false;
        f.client.indices.getMapping=async(request:any,options:any)=>{
            if(!held&&options?.signal===abort.signal){held=true;entered.release();await release.promise;}
            return original(request,options);
        };
        const before=f.memory.calls.length,pending=reader.readSelection(f.selectionId,abort.signal);await entered.promise;
        expect(await reader.readSelection(f.selectionId,healthy.signal)).toEqual(opening);
        abort.abort(reason);release.release();await expect(pending).rejects.toBe(reason);
        expect(healthy.signal.aborted).toBe(false);expect(await reader.readSelection(f.selectionId)).toEqual(opening);
        expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
        await expect(reader.prepare(f.selectionId,f.record)).rejects.toThrow(/Read-only/);
        expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
    });

    it('captures read-only mode so caller mutation cannot introduce provisioning during a read',async()=>{
        const f=await fixture(),opening=await f.store.prepare(f.selectionId,f.record),options={readOnly:true};
        const reader=new ProtocolNativeObservationStore(f.client,chain,0,undefined,options),before=f.memory.calls.length;
        options.readOnly=false;
        expect(await reader.readSelection(f.selectionId)).toEqual(opening);
        expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
        await expect(reader.prepare(f.selectionId,f.record)).rejects.toThrow(/Read-only/);
    });

    it('keeps absent original sections incomplete while allowing a present encoded-empty vector with a host inventory',async()=>{
        for(const capture of [{blockHex:null},{blockHex:''},{tracesHex:null},{tracesHex:''}]){
            const f=await fixture(0,{capture}),before=f.memory.calls.length;
            await expect(f.store.prepare(f.selectionId,f.record)).rejects.toMatchObject({code:'invalid',recordType:'reference'});
            expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
            const incomplete=clone(f.record);incomplete.inventory=null;
            incomplete.observation={status:'incomplete',error:{code:'native_source_traces_absent',message:'Original source sections unavailable'}};
            expect((await f.store.prepare(f.selectionId,incomplete)).record).toEqual(incomplete);
        }
        const f=await fixture();f.record.inventory={schemaVersion:1,inputCount:0,firstReceiverCount:0,sha256:'f'.repeat(64)};
        f.record.observation={status:'observed',facts:{schemaVersion:1,decisions:[]}};
        expect((await f.store.prepare(f.selectionId,f.record)).record).toEqual(f.record);
    });

    it('matches independently calculated identity domains and preserves source-vector decision order plus per-origin incompleteness',async()=>{
        const f=await fixture();
        // Golden IDs use independent Python sorted UTF-8 JSON/hashlib and the accepted domain literals.
        expect(protocolNativeObservationId(f.record)).toBe('h45natobs1:fffb5c7da85fa17bed9800e127f301bcf83334de0dd98d229bb59dd079cbf6cd');
        expect(protocolSourceNativeObservationLinkId(f.selectionId)).toBe('h45srcnat1:81c9c2e3bfa388b29741e17c3198ae4117509b457131f5ff845c9423454fcc0d');
        const components=[{id:'rust',runtime:'rust' as const,version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'d'.repeat(64)},
            {id:'node',runtime:'node' as const,version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}];
        const ordered=await fixture(0,{components}),record=clone(ordered.record);
        record.inventory={schemaVersion:1,inputCount:3,firstReceiverCount:2,sha256:'f'.repeat(64)};
        record.observation={status:'observed',facts:{schemaVersion:1,decisions:[
            {origin:{transactionId:'e'.repeat(64),actionOrdinal:9,rawSha256:'9'.repeat(64)},kind:'incomplete',error:{code:'unsupported',message:'Only this origin is incomplete'}},
            {origin:{transactionId:'a'.repeat(64),actionOrdinal:1,rawSha256:'1'.repeat(64)},kind:'native',nativeKind:'opaque.fixture.v1'}]}};
        const reordered=clone(record);reordered.protocol.components=[...record.protocol.components].reverse();
        expect(protocolNativeObservationId(reordered)).toBe(protocolNativeObservationId(record));
        const opening=await ordered.store.prepare(ordered.selectionId,record);
        expect(opening.record.protocol.components.map(component=>component.runtime)).toEqual(['node','rust']);
        expect(opening.record.observation).toEqual(record.observation);
        expect(protocolNativeObservationBounds).toEqual({chunkBytes:524288,maximumBytes:67108864,maximumChunks:128});
        expect(Object.isFrozen(protocolNativeObservationBounds)).toBe(true);
    });

    it('rejects self-consistent but mismatched old capture/profile/handshake references before native writes',async()=>{
        const other={id:'other-protocol',profileId:'other-v1',components:[{id:'node',runtime:'node' as const,version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
        for(const options of [{capture:{schemaJson:'{} '}},{capture:{schemaJson:null}},{abiProtocol:other},{abiLinkDigest:'0'.repeat(64)}]){
            const f=await fixture(0,options),before=f.memory.calls.length;
            await expect(f.store.prepare(f.selectionId,f.record)).rejects.toMatchObject({code:'invalid',recordType:'reference'});
            expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
        }
    });

    it('revalidates original references after writes and refuses a missing capture chunk at final readback',async()=>{
        const f=await fixture(),manifest=f.memory.documents.get(f.memory.key(f.abis.index,f.abiLink.observationId))!;
        const chunkId=manifest.document.chunk_ids[0],chunk=clone(f.memory.documents.get(f.memory.key(f.abis.index,chunkId)));
        let removed=false;f.memory.faults.receipt=(response:any,request:any)=>{
            if(target(request,'link')&&request.document.kind==='manifest'){removed=true;f.memory.documents.delete(f.memory.key(f.abis.index,chunkId));}
            return response;
        };
        await expect(f.store.prepare(f.selectionId,f.record)).rejects.toMatchObject({code:'incomplete',recordType:'reference'});
        expect(removed).toBe(true);f.memory.faults.receipt=undefined;f.memory.documents.set(f.memory.key(f.abis.index,chunkId),chunk);
        expect((await f.store.prepare(f.selectionId,f.record)).record).toEqual(f.record);
    });

    it('survives crashes between chunk/manifest/link writes only after a fresh durable retry',async()=>{
        for(const phase of ['chunk','manifest','link','link-manifest']){
            const f=await fixture(),crash=new Error('Process lost at '+phase);let held=false;
            f.memory.faults.beforeWrite=(request:any)=>{
                if(!held&&(phase==='link-manifest'?target(request,'link')&&request.document.kind==='manifest':target(request,phase))){held=true;throw crash;}
            };
            await expect(f.store.prepare(f.selectionId,f.record)).rejects.toBe(crash);expect(held).toBe(true);
            await expect(f.store.readSelection(f.selectionId)).rejects.toMatchObject({code:'missing'});
            f.memory.faults.beforeWrite=undefined;
            expect((await f.store.prepare(f.selectionId,f.record)).record).toEqual(f.record);
        }
    });

    it('rejects typed record/link substitutions even when their immutable bundle hashes are internally valid',async()=>{
        for(const fault of ['record-kind','record-id','reference','link-selection','link-id','link-digest']){
            const f=await fixture(),record=clone(f.record);
            if(fault==='record-kind')(record as any).kind='source-link';
            if(fault==='record-id')record.source.blockNum++;
            if(fault==='reference')record.captureRef.inputSha256='0'.repeat(64);
            const recordId=fault==='reference'?protocolNativeObservationId(record):protocolNativeObservationId(f.record);
            const link={schemaVersion:1,kind:'source-link',selectionId:f.selectionId,observationId:recordId,observationDigest:hash(protocolImmutableJson(record))};
            if(fault==='link-selection')link.selectionId='h45srcsel1:'+'0'.repeat(64);
            if(fault==='link-id')link.observationId=f.abiLink.observationId;
            if(fault==='link-digest')link.observationDigest='0'.repeat(64);
            const bundles=new ImmutableProtocolBundleStore(f.client,chain,0,'protocol-native-actions','protocol-native-actions-v1');
            await bundles.prepare(recordId,record);await bundles.prepare(protocolSourceNativeObservationLinkId(f.selectionId),link);
            await expect(f.store.readSelection(f.selectionId)).rejects.toBeInstanceOf(NativeObservationReadError);
        }
    });

    it('rejects unsafe durability, retention and mapping changes on native and referenced indexes without performing read-side writes',async()=>{
        for(const scope of ['native','source','abi'])for(const fault of ['async','replicas','shards','auto-expand','pipeline','synthetic','source-filter','mapping']){
            const f=await fixture();await f.store.prepare(f.selectionId,f.record);
            const index=scope==='native'?f.store.index:scope==='source'?f.sources.index:f.abis.index;
            const settings=f.memory.settings.get(index),mapping=f.memory.mappings.get(index);
            if(fault==='async')settings['index.translog.durability']='async';
            if(fault==='replicas')settings['index.number_of_replicas']='1';
            if(fault==='shards')settings['index.number_of_shards']='2';
            if(fault==='auto-expand')settings['index.auto_expand_replicas']='true';
            if(fault==='pipeline')settings['index.final_pipeline']='mutate-originals';
            if(fault==='synthetic')settings['index.mapping.source.mode']='synthetic';
            if(fault==='source-filter')mapping._source={excludes:['payload']};
            if(fault==='mapping')mapping._meta.hyperion_kind='foreign';
            const reader=new ProtocolNativeObservationStore(f.client,chain,0,undefined,{readOnly:true}),before=f.memory.calls.length;
            await expect(reader.readSelection(f.selectionId)).rejects.toThrow(/incompatible|Unowned/);
            expect(f.memory.calls.slice(before).some(isWrite)).toBe(false);
        }
        const f=await fixture(),before=f.memory.calls.length;
        for(const bounds of [{chunkBytes:0,maximumBytes:1024,maximumChunks:1},
            {chunkBytes:128,maximumBytes:67108865,maximumChunks:128},{chunkBytes:128,maximumBytes:1024,maximumChunks:129}]){
            expect(()=>new ProtocolNativeObservationStore(f.client,chain,0,bounds)).toThrow(/bounds/);
        }
        expect(f.memory.calls.length).toBe(before);
    });
});
