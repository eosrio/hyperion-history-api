import {describe,expect,it} from 'bun:test';
import {ProtocolSourceBindingStore,type ProtocolSourceContext,type ProtocolSourceSelection} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {ImmutableProtocolBundleReadError} from '../../src/indexer/protocol/immutable-bundle-store.js';

const chain='cancellable-source';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
function transportSignals(memory:ReturnType<typeof frontierMemoryClient>){
    const signals:Array<AbortSignal|undefined>=[];
    for(const [owner,name] of [[memory.client,'get'],[memory.client.indices,'get']] as const){
        const original=(owner as any)[name];
        (owner as any)[name]=(request:any,options?:{signal?:AbortSignal})=>{signals.push(options?.signal);return original(request,options);};
    }
    return signals;
}
async function fixture(){
    const memory=frontierMemoryClient(),client=memory.client as any;
    const writer=new ProtocolSourceBindingStore(client,chain);
    const context:ProtocolSourceContext={schemaVersion:1,chainId:'1'.repeat(64),schemaJson:'{}',
        protocol:{id:'source-cancellation-fixture',profileId:'engineering-v1',components:[
            {id:'node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]}};
    const contextId=(await writer.prepareContext(context)).id;
    const source={chainId:context.chainId,blockNum:42,blockId:'2'.repeat(64),previousBlockId:'3'.repeat(64)};
    const capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson:'{}',blockHex:'00',tracesHex:'00',deltasHex:null};
    const observation:ProtocolAbiObservationRecord={schemaVersion:1,protocol:context.protocol,
        source:{...source,inputSha256:protocolAbiCaptureDigest(source,capture)},capture,
        observation:{status:'incomplete',error:{code:'fixture',message:'Retained original input'}}};
    const bounds={chunkBytes:128,maximumBytes:10000,maximumChunks:100};
    const observationWriter=new ProtocolAbiObservationStore(client,chain,0,bounds);
    const observed=await observationWriter.prepare(observation);
    const selection:ProtocolSourceSelection={schemaVersion:1,contextId,source,readerSessionId:'fixture-reader',readerRole:'live',assignmentId:null,
        frameSha256:'4'.repeat(64),captureSha256:observation.source.inputSha256,head:{blockNum:42,blockId:source.blockId},irreversible:{blockNum:0,blockId:'0'.repeat(64)}};
    const selectionId=(await writer.prepareSelection(selection)).id;
    const link={schemaVersion:1 as const,selectionId,observationId:observed.id,observationDigest:observed.digest};
    const linkId=(await writer.prepareObservationLink(link)).id;
    const quarantine={schemaVersion:1 as const,chainId:context.chainId,protocol:context.protocol,frameHex:'00ff',
        reason:{code:'fixture',message:'Untrusted original frame'},claimedSelectionId:selectionId};
    const quarantineId=(await writer.quarantine(quarantine)).id;
    const store=new ProtocolSourceBindingStore(client,chain,0,{readOnly:true});
    const observations=new ProtocolAbiObservationStore(client,chain,0,bounds,{readOnly:true});
    const reads=[
        {name:'context',index:store.index,id:contextId,read:(signal?:AbortSignal)=>store.readContext(contextId,signal),expected:context},
        {name:'selection',index:store.index,id:selectionId,read:(signal?:AbortSignal)=>store.readSelection(selectionId,signal),expected:{selection,context}},
        {name:'quarantine',index:store.index,id:quarantineId,read:(signal?:AbortSignal)=>store.readQuarantine(quarantineId,signal),expected:quarantine},
        {name:'link',index:store.index,id:linkId,read:(signal?:AbortSignal)=>store.readObservationLink(selectionId,signal),expected:link},
        {name:'observation',index:observations.index,id:observed.id,read:(signal?:AbortSignal)=>observations.read(observed.id,signal),expected:observation},
    ];
    return {memory,store,observations,reads,contextId,selectionId,linkId,observationId:observed.id};
}

describe('cancellable retained protocol source reads',()=>{
    it('rejects every pre-aborted public read with the exact reason before any storage or ID validation',async()=>{
        const f=await fixture(),abort=new AbortController(),reason=Object.freeze({cancelled:'caller disconnected'});
        abort.abort(reason);const before=f.memory.calls.length;
        for(const item of f.reads)await expect(item.read(abort.signal)).rejects.toBe(reason);
        await expect(f.store.readObservationLink('malformed',abort.signal)).rejects.toBe(reason);
        await expect(f.store.readContext('malformed',abort.signal)).rejects.toBe(reason);
        expect(f.memory.calls.length).toBe(before);
    });

    it('cancels pending manifest and chunk reads with the same signal and no later storage work',async()=>{
        for(const name of ['context','selection','quarantine','link','observation'])for(const phase of ['manifest','chunk']){
            const f=await fixture(),item=f.reads.find(item=>item.name===name)!,entered=gate(),release=gate();
            const abort=new AbortController(),reason={cancelled:name+'-'+phase},signals=transportSignals(f.memory);let held=false;
            const manifest=f.memory.documents.get(f.memory.key(item.index,item.id))!;
            const target=phase==='manifest'?item.id:manifest.document.chunk_ids[0];
            f.memory.faults.beforeRead=async(request:any)=>{
                if(!held&&request.index===item.index&&request.id===target){held=true;entered.release();await release.promise;}
            };
            const before=f.memory.calls.length,pending=item.read(abort.signal);await entered.promise;
            const calls=f.memory.calls.length;abort.abort(reason);release.release();
            await expect(pending).rejects.toBe(reason);
            expect(f.memory.calls.length).toBe(calls);expect(signals.length).toBeGreaterThan(0);
            expect(signals.every(signal=>signal===abort.signal)).toBe(true);
            expect(f.memory.calls.slice(before).some((call:any)=>['createIndex','create','index'].includes(call.method))).toBe(false);
        }
    });

    it('keeps the caller signal through nested selection, context and observation-link reads',async()=>{
        for(const [operation,targetName] of [['selection','context'],['link','selection'],['link','context']])for(const phase of ['manifest','chunk']){
            const f=await fixture(),item=f.reads.find(item=>item.name===operation)!,targetRead=f.reads.find(item=>item.name===targetName)!;
            const entered=gate(),release=gate(),abort=new AbortController(),reason=new Error(operation+' nested '+targetName);
            const signals=transportSignals(f.memory),manifest=f.memory.documents.get(f.memory.key(targetRead.index,targetRead.id))!;
            const target=phase==='manifest'?targetRead.id:manifest.document.chunk_ids[0];let held=false;
            f.memory.faults.beforeRead=async(request:any)=>{
                if(!held&&request.index===targetRead.index&&request.id===target){held=true;entered.release();await release.promise;}
            };
            const pending=item.read(abort.signal);await entered.promise;const before=f.memory.calls.length;
            abort.abort(reason);release.release();await expect(pending).rejects.toBe(reason);
            expect(f.memory.calls.length).toBe(before);expect(signals.every(signal=>signal===abort.signal)).toBe(true);
        }
    });

    it('preserves abort reason identity even when the reason resembles a storage error eligible for translation',async()=>{
        for(const name of ['context','observation'])for(const code of ['missing','incomplete','invalid','404'] as const){
            const f=await fixture(),item=f.reads.find(item=>item.name===name)!,entered=gate(),release=gate(),abort=new AbortController();
            const reason=code==='404'?Object.assign(new Error('caller reason resembles a missing manifest'),
                {meta:{statusCode:404,body:{_index:item.index,_id:item.id,found:false}}})
                :new ImmutableProtocolBundleReadError(code,item.id,'Caller-owned '+code+' reason');
            let held=false;
            f.memory.faults.beforeRead=async(request:any)=>{
                if(!held&&request.index===item.index&&request.id===item.id){held=true;entered.release();await release.promise;}
            };
            const pending=item.read(abort.signal);await entered.promise;abort.abort(reason);release.release();
            await expect(pending).rejects.toBe(reason);
        }
    });

    it('lets cancellation win over late success, malformed responses and storage failures from an uncooperative client',async()=>{
        for(const name of ['selection','link','observation'])for(const outcome of ['success','malformed','missing','outage']){
            const f=await fixture(),item=f.reads.find(item=>item.name===name)!,entered=gate(),release=gate(),abort=new AbortController();
            const reason=Symbol(name+' cancelled'),outage=new Error('late transport failure');let held=false;
            f.memory.faults.beforeRead=async(request:any)=>{
                if(!held&&request.index===item.index&&request.id===item.id){
                    held=true;entered.release();await release.promise;
                    if(outcome==='outage')throw outage;
                    if(outcome==='missing')throw Object.assign(new Error('late missing'),
                        {meta:{statusCode:404,body:{_index:item.index,_id:item.id,found:false}}});
                }
            };
            if(outcome==='malformed')f.memory.faults.read=(response:any)=>({...response,_index:'foreign-index'});
            const pending=item.read(abort.signal);await entered.promise;const before=f.memory.calls.length;
            abort.abort(reason);release.release();await expect(pending).rejects.toBe(reason);
            expect(f.memory.calls.length).toBe(before);
        }
    });

    it('allows one cold read-only consumer to abort without cancelling an independent consumer',async()=>{
        for(const name of ['selection','observation'])for(const phase of ['mapping','manifest']){
            const f=await fixture(),item=f.reads.find(item=>item.name===name)!,entered=gate(),release=gate();
            const cancelled=new AbortController(),healthy=new AbortController(),reason=new Error('Only the first consumer stopped');let held=false;
            if(phase==='mapping'){
                const original=f.memory.client.indices.get;
                f.memory.client.indices.get=async(request:any,options?:{signal?:AbortSignal})=>{
                    if(!held&&options?.signal===cancelled.signal){held=true;entered.release();await release.promise;}
                    return original(request,options);
                };
            }else f.memory.faults.beforeRead=async(request:any)=>{
                if(!held&&request.index===item.index&&request.id===item.id){held=true;entered.release();await release.promise;}
            };
            const before=f.memory.calls.length,pending=item.read(cancelled.signal);await entered.promise;
            expect(await item.read(healthy.signal)).toEqual(item.expected);
            cancelled.abort(reason);release.release();await expect(pending).rejects.toBe(reason);
            expect(healthy.signal.aborted).toBe(false);expect(await item.read(healthy.signal)).toEqual(item.expected);
            expect(f.memory.calls.slice(before).some((call:any)=>['createIndex','create','index'].includes(call.method))).toBe(false);
        }
    });

    it('preserves cancellation that becomes visible during response validation before corruption is translated',async()=>{
        for(const name of ['context','selection','quarantine','link','observation']){
            const f=await fixture(),item=f.reads.find(item=>item.name===name)!,abort=new AbortController(),reason=new Error('Cancelled at validation');
            f.memory.faults.read=(response:any,request:any)=>request.index===item.index&&request.id===item.id
                ?Object.defineProperty({...response},'_source',{get(){abort.abort(reason);return {...response._source,kind:'corrupt-manifest'};}}):response;
            await expect(item.read(abort.signal)).rejects.toBe(reason);
        }
    });

    it('preserves successful reads for omitted or active signals and propagates genuine infrastructure errors',async()=>{
        const f=await fixture(),active=new AbortController(),before=f.memory.calls.length;
        for(const item of f.reads){expect(await item.read()).toEqual(item.expected);expect(await item.read(active.signal)).toEqual(item.expected);}
        const outage=new Error('Source storage remains unavailable');f.memory.faults.beforeRead=()=>{throw outage;};
        for(const item of f.reads){await expect(item.read()).rejects.toBe(outage);await expect(item.read(active.signal)).rejects.toBe(outage);}
        expect(f.memory.calls.slice(before).some((call:any)=>['createIndex','create','index'].includes(call.method))).toBe(false);
    });
});
