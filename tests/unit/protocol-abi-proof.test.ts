import {describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import type {ProtocolAbiActionInput,ProtocolAbiDeploymentObservation,ProtocolAbiFinalStateObservation} from '@eosrio/hyperion-sdk/protocol';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {ProtocolSourceBindingStore,type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiProofReader,ProtocolAbiProofUnavailableError,protocolAbiCertificateForControl,type ProtocolAbiProofSource} from '../../src/indexer/protocol/abi-proof.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

const chainId='1'.repeat(64),transactionId='a'.repeat(64),chain='proof-fixture';
const block=(value:number)=>value.toString(16).padStart(64,'0');
const profile:ProtocolSourceProfile={id:'@eosrio/hyperion-wire-plugin',profileId:'proof-engineering-v1',components:[
    {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'b'.repeat(40),sha256:'c'.repeat(64)}]};
const schemaJson='{"version":"eosio::abi/1.1"}';
const sha256=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const facts=()=>({schemaVersion:1 as const,actionInputs:[] as ProtocolAbiActionInput[],
    deployments:[] as ProtocolAbiDeploymentObservation[],finalStates:[] as ProtocolAbiFinalStateObservation[]});
const action=(actionOrdinal:number,globalSequence:string,account='alpha',name='act',rawHex='07000000',
              inputActionOrdinal=actionOrdinal,receiver=account):ProtocolAbiActionInput=>
    ({transactionId,actionOrdinal,inputActionOrdinal,receiver,account,name,rawHex,globalSequence,receiptAbiSequence:'0'});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
async function unavailable(promise:Promise<unknown>):Promise<ProtocolAbiProofUnavailableError>{
    let caught:unknown;try{await promise;}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(ProtocolAbiProofUnavailableError);
    expect(caught).toMatchObject({statusCode:503});return caught as ProtocolAbiProofUnavailableError;
}

function publicationFacts(nextAbi='bb'){
    const result=facts();
    result.actionInputs=[action(1,'9007199254740993'),action(2,'9007199254740994','sysio','setabi','fe'),
        action(4,'9007199254740995','alpha','act','07000000',1,'notified'),action(3,'9007199254740996')];
    result.deployments=[{account:'alpha',abiHex:nextAbi,action:{transactionId,actionOrdinal:2},
        globalSequence:'9007199254740994',effect:'native-before-receipt'}];
    result.finalStates=[{account:'alpha',present:true,abiHex:nextAbi,deltaOrdinal:0}];
    return result;
}
async function seed(f:Awaited<ReturnType<typeof fixture>>,abiHex='aa',present=true){
    const initial=facts();initial.finalStates=[{account:'alpha',present,abiHex,deltaOrdinal:0}];return f.append(1,initial);
}

/** Independent opaque ABI facts exercise proof selection; they do not qualify a Wire value codec. */
async function fixture(){
    const memory=frontierMemoryClient(),client=memory.client as any;
    const sources=new ProtocolSourceBindingStore(client,chain),observations=new ProtocolAbiObservationStore(client,chain);
    const store=new ProtocolAbiFrontierStore(client,chain);
    const contextId=(await sources.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const make=(ownerId:string)=>new ProtocolAbiCoordinator({chainId,profile,ownerId,bindings:sources,observations,store});
    let coordinator=make('master-one'),session='reader-one';await coordinator.start();
    let generation=(await coordinator.openSource(contextId,session)).generation;
    const source=(number:number,identity=number):ProtocolAbiProofSource=>({chainId,blockNum:number,blockId:block(identity)});
    async function selected(number:number,observation=facts(),identity=number,parent=number-1,incomplete=false){
        const position={...source(number,identity),previousBlockId:number===1?null:block(parent)};
        const capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson,blockHex:'00',tracesHex:'00',deltasHex:'00'};
        const captureSha256=protocolAbiCaptureDigest(position,capture);
        const selectionId=(await sources.prepareSelection({schemaVersion:1,contextId,readerSessionId:session,readerRole:'live',assignmentId:null,
            source:position,captureSha256,frameSha256:sha256(Buffer.from('independent-frame-'+identity)),
            head:{blockNum:number,blockId:block(identity)},irreversible:{blockNum:0,blockId:block(0)}})).id;
        const record:ProtocolAbiObservationRecord={schemaVersion:1,protocol:profile,source:{...position,inputSha256:captureSha256},capture,
            observation:incomplete?{status:'incomplete',error:{code:'incomplete-source',message:'Original input retained'}}:{status:'observed',facts:observation}};
        return {selectionId,record};
    }
    async function prepare(value:Awaited<ReturnType<typeof selected>>){
        const prepared=await observations.prepare(value.record);
        await sources.prepareObservationLink({schemaVersion:1,selectionId:value.selectionId,observationId:prepared.id,observationDigest:prepared.digest});
        return prepared;
    }
    async function admit(value:Awaited<ReturnType<typeof selected>>){
        const admitted=await coordinator.admit(value.selectionId,generation);generation=admitted.generation;
        expect(admitted.status).toBe('accepted');return admitted;
    }
    async function append(number:number,observation=facts(),identity=number,parent=number-1,incomplete=false){
        const value=await selected(number,observation,identity,parent,incomplete);await prepare(value);await admit(value);
        await coordinator.drain();return {...value,head:(await coordinator.inspect()).head!};
    }
    async function replaceOwner(ownerId:string,readerSessionId:string){
        coordinator=make(ownerId);await coordinator.start();session=readerSessionId;
        const opened=await coordinator.openSource(contextId,session);generation=opened.generation;return opened;
    }
    const reader=(maximum?:number,selectedProfile=profile)=>new ProtocolAbiProofReader({chainId,profile:selectedProfile,
        store:new ProtocolAbiFrontierStore(client,chain,0,{readOnly:true}),...(maximum===undefined?{}:{maxAncestryBlocks:maximum})});
    return {memory,store,sources,source,selected,prepare,admit,append,replaceOwner,reader,
        get coordinator(){return coordinator;},get session(){return session;}};
}

describe('source-bound canonical ABI consumers',()=>{
    it('reads a settled certificate and final account state without consumer writes or control CAS',async()=>{
        const f=await fixture(),seed=facts();seed.finalStates=[{account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0}];
        const first=await f.append(1,seed),reader=f.reader();
        const before=f.memory.calls.filter((call:any)=>['createIndex','create','index'].includes(call.method)).length;
        const view=await reader.open(f.source(1),first.selectionId);
        expect(view.source).toMatchObject(f.source(1));expect(view.selectionId).toBe(first.selectionId);expect(view.commitId).toBe(first.head.commitId);
        expect((await reader.finalState(view,'alpha')).abiHex).toBe('aa');await reader.revalidate(view);
        expect(f.memory.calls.filter((call:any)=>['createIndex','create','index'].includes(call.method)).length).toBe(before);
    });

    it('keeps first-receiver and notification input ABIs distinct from later inputs and the final block root',async()=>{
        const f=await fixture(),first=await seed(f),observed=publicationFacts(),second=await f.append(2,observed),reader=f.reader();
        const view=await reader.open(f.source(2),second.selectionId);
        const {inputActionOrdinal:_origin,...originUnknown}=observed.actionInputs[0];
        const before=await reader.action(view,originUnknown),notification=await reader.action(view,observed.actionInputs[2]);
        const later=await reader.action(view,observed.actionInputs[3]);
        expect(before.binding.inputActionOrdinal).toBe(1);expect(before.binding.globalSequence).toBe('9007199254740993');
        expect(before.state.abiHex).toBe('aa');expect(notification.state.abiHex).toBe('aa');
        expect(before.binding.stateId).toBe(notification.binding.stateId);expect(later.state.abiHex).toBe('bb');
        expect(later.binding.stateId).not.toBe(before.binding.stateId);
        expect((await reader.finalState(view,'alpha')).abiHex).toBe('bb');
        const earlier=await reader.open(f.source(1),first.selectionId);
        expect((await reader.finalState(earlier,'alpha')).abiHex).toBe('aa');
    });

    it('checks every original anchor, raw hash and lossless sequence, including an explicitly supplied origin',async()=>{
        const f=await fixture();await seed(f);const observed=publicationFacts();await f.append(2,observed);
        const reader=f.reader(),view=await reader.open(f.source(2)),original=observed.actionInputs[0];
        const altered:Partial<ProtocolAbiActionInput>[]=[{transactionId:'f'.repeat(64)},{actionOrdinal:99},{inputActionOrdinal:2},
            {receiver:'elsewhere'},{account:'beta'},{name:'other'},{rawHex:'08000000'},
            {globalSequence:String(Number(original.globalSequence))},{receiptAbiSequence:'1'}];
        for(const change of altered)await unavailable(reader.action(view,{...original,...change}));
        expect((await reader.action(view,original)).state.abiHex).toBe('aa');
        await unavailable(reader.open({...f.source(2),blockId:'f'.repeat(64)}));
        await unavailable(reader.open({...f.source(2),chainId:'f'.repeat(64)}));
        await unavailable(reader.open(f.source(2),'h45srcsel1:'+'f'.repeat(64)));
        const wrongProfile=structuredClone(profile);wrongProfile.components=[{...wrongProfile.components[0],sha256:'d'.repeat(64)}];
        await unavailable(f.reader(undefined,wrongProfile).open(f.source(2)));
    });

    it('does not let a source-valid empty action name invalidate unrelated bindings in the same block',async()=>{
        const f=await fixture();await seed(f);const observed=facts();
        observed.actionInputs=[action(1,'1','alpha',''),action(2,'2')];await f.append(2,observed);
        const reader=f.reader(),view=await reader.open(f.source(2));
        expect((await reader.action(view,observed.actionInputs[0])).binding.name).toBe('');
        expect((await reader.action(view,observed.actionInputs[1])).state.abiHex).toBe('aa');
    });

    it('refuses cloned proof views and freezes the issued source and binding snapshot',async()=>{
        const f=await fixture();await seed(f);const observed=publicationFacts();await f.append(2,observed);
        const reader=f.reader(),view=await reader.open(f.source(2));
        expect(Object.isFrozen(view)).toBe(true);expect(Object.isFrozen(view.source)).toBe(true);expect(Object.isFrozen(view.bindings)).toBe(true);
        expect(Object.isFrozen(view.bindings[0])).toBe(true);
        await unavailable(reader.revalidate({...view}));
        await unavailable(reader.finalState({...view},'alpha'));
        await unavailable(reader.action({...view,bindings:[{...view.bindings[0],stateId:'h45abist1:'+'0'.repeat(64)}]},observed.actionInputs[0]));
    });

    it('never promotes an initial UNKNOWN input from a later known final state',async()=>{
        const f=await fixture(),unknown=facts();unknown.actionInputs=[action(1,'1')];const first=await f.append(1,unknown);
        const known=facts();known.finalStates=[{account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0}];await f.append(2,known);
        const reader=f.reader(),view=await reader.open(f.source(1),first.selectionId);
        await unavailable(reader.action(view,unknown.actionInputs[0]));await unavailable(reader.finalState(view,'alpha'));
        expect((await reader.finalState(await reader.open(f.source(2)),'alpha')).abiHex).toBe('aa');
    });

    it('preserves deleted and empty barriers without falling back to earlier ABI bytes',async()=>{
        for(const [present,abiHex] of [[false,'aa'],[true,'']] as const){
            const f=await fixture();await seed(f,abiHex,present);const next=facts();next.actionInputs=[action(1,'1')];await f.append(2,next);
            const reader=f.reader(),view=await reader.open(f.source(2));
            await unavailable(reader.action(view,next.actionInputs[0]));await unavailable(reader.finalState(view,'alpha'));
        }
        const f=await fixture();await seed(f);const clear=publicationFacts('');await f.append(2,clear);
        const reader=f.reader(),view=await reader.open(f.source(2));
        expect((await reader.action(view,clear.actionInputs[0])).state.abiHex).toBe('aa');
        expect((await reader.action(view,clear.actionInputs[2])).state.abiHex).toBe('aa');
        await unavailable(reader.action(view,clear.actionInputs[3]));await unavailable(reader.finalState(view,'alpha'));
    });

    it('retains an incomplete gap and never carries pre-gap account knowledge into a later complete block',async()=>{
        const f=await fixture(),first=await seed(f);await f.append(2,facts(),2,1,true);
        const third=facts();third.actionInputs=[action(1,'1')];third.finalStates=[{account:'beta',present:true,abiHex:'bb',deltaOrdinal:0}];await f.append(3,third);
        const reader=f.reader();await unavailable(reader.open(f.source(2)));
        const view=await reader.open(f.source(3));await unavailable(reader.action(view,third.actionInputs[0]));
        await unavailable(reader.finalState(view,'alpha'));expect((await reader.finalState(view,'beta')).abiHex).toBe('bb');
        expect((await reader.finalState(await reader.open(f.source(1),first.selectionId),'alpha')).abiHex).toBe('aa');
    });

    it('does not certify PREPARE or a primary-visible control write whose complete receipt is still pending',async()=>{
        const f=await fixture();await seed(f);const value=await f.selected(2);await f.prepare(value);
        const reader=f.reader();await unavailable(reader.open(f.source(2)));await f.admit(value);
        await unavailable(reader.open(f.source(2)));
        const entered=gate(),release=gate();let held=false;
        f.memory.faults.receipt=async(receipt:any,request:any)=>{
            if(!held&&request.index===f.store.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64').toString()).head?.blockNum===2){
                held=true;entered.release();await release.promise;
            }
            return receipt;
        };
        const draining=f.coordinator.drain();await entered.promise;
        try {expect((await f.store.readControl())!.value).toMatchObject({head:{blockNum:2}});await unavailable(reader.open(f.source(2)));}
        finally {release.release();delete f.memory.faults.receipt;}
        await draining;expect((await reader.open(f.source(2))).selectionId).toBe(value.selectionId);
    });

    it('refuses primary-visible partial control receipts instead of manufacturing a certificate or repairing owner CAS',async()=>{
        const f=await fixture();await seed(f);const value=await f.selected(2);await f.prepare(value);await f.admit(value);
        f.memory.faults.receipt=(receipt:any,request:any)=>request.index===f.store.controlIndex
            &&JSON.parse(Buffer.from(request.document.payload,'base64').toString()).head?.blockNum===2
            ?{...receipt,_shards:{total:1,successful:0,failed:1}}:receipt;
        await expect(f.coordinator.drain()).rejects.toThrow('durable control receipt');delete f.memory.faults.receipt;
        expect((await f.store.readControl())!.value).toMatchObject({head:{blockNum:2}});
        const before=f.memory.calls.filter((call:any)=>['createIndex','create','index'].includes(call.method)).length;
        await unavailable(f.reader().open(f.source(2)));
        expect(f.memory.calls.filter((call:any)=>['createIndex','create','index'].includes(call.method)).length).toBe(before);
    });

    it('never publishes a certificate when source revocation interrupts the canonical control receipt',async()=>{
        const f=await fixture();await seed(f);const value=await f.selected(2);await f.prepare(value);await f.admit(value);
        const entered=gate(),release=gate();let held=false;
        f.memory.faults.receipt=async(receipt:any,request:any)=>{
            if(!held&&request.index===f.store.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64').toString()).head?.blockNum===2){
                held=true;entered.release();await release.promise;
            }
            return receipt;
        };
        const draining=f.coordinator.drain();await entered.promise;
        const uncertain=(await f.store.readControl())!.value;
        const certificateId=f.store.certificateId(protocolAbiCertificateForControl(uncertain as any));
        const revoking=f.coordinator.revokeSource(f.session);release.release();
        expect((await draining).committed).toBe(0);expect(await revoking).toBe(true);delete f.memory.faults.receipt;
        expect(f.memory.documents.has(f.memory.key(f.store.recordsIndex,certificateId))).toBe(false);
        await unavailable(f.reader().open(f.source(2)));
        expect((await f.coordinator.inspect()).head!.blockNum).toBe(1);
    });

    it('expires a bounded proof wait while the underlying storage read remains in flight',async()=>{
        const f=await fixture();await seed(f);const reader=f.reader(),entered=gate(),release=gate();let held=false;
        f.memory.faults.beforeRead=async(request:any)=>{
            if(!held&&request.index===f.store.controlIndex){held=true;entered.release();await release.promise;}
        };
        const waiting=reader.waitForOpen(f.source(1),undefined,{timeoutMs:20})
            .then(value=>({kind:'resolved' as const,value}),error=>({kind:'rejected' as const,error}));
        await entered.promise;let timer:ReturnType<typeof setTimeout>|undefined;
        const result=await Promise.race([waiting,new Promise<{kind:'still_pending'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'still_pending'}),250);})]);
        release.release();if(timer)clearTimeout(timer);delete f.memory.faults.beforeRead;await waiting;
        expect(result.kind).toBe('rejected');
        if(result.kind==='rejected')expect(result.error).toMatchObject({statusCode:503});
    });

    it('cancels a proof wait during a storage await and refuses its later successful read',async()=>{
        const f=await fixture();await seed(f);const reader=f.reader(),entered=gate(),release=gate(),abort=new AbortController();let held=false;
        f.memory.faults.beforeRead=async(request:any)=>{
            if(!held&&request.index===f.store.controlIndex){held=true;entered.release();await release.promise;}
        };
        const waiting=reader.waitForOpen(f.source(1),undefined,{timeoutMs:1000,signal:abort.signal})
            .then(value=>({kind:'resolved' as const,value}),error=>({kind:'rejected' as const,error}));
        await entered.promise;abort.abort();let timer:ReturnType<typeof setTimeout>|undefined;
        const result=await Promise.race([waiting,new Promise<{kind:'still_pending'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'still_pending'}),250);})]);
        release.release();if(timer)clearTimeout(timer);delete f.memory.faults.beforeRead;
        const settled=await waiting;expect(result.kind).toBe('rejected');expect(settled.kind).toBe('rejected');
        if(result.kind==='rejected')expect(result.error).toMatchObject({statusCode:503,code:'proof_cancelled'});
    });

    it('allows mixed-generation ancestors only through a new settled certificate after owner replacement',async()=>{
        const f=await fixture(),first=await seed(f);await f.append(2);const reader=f.reader(),old=await reader.open(f.source(1),first.selectionId);
        const opened=await f.replaceOwner('master-two','reader-two');expect(opened.resumeFromBlock).toBe(3);
        await unavailable(reader.revalidate(old));await unavailable(reader.open(f.source(1)));
        await f.append(3);const current=await reader.open(f.source(1),first.selectionId);
        expect(current.certificateId).not.toBe(old.certificateId);expect(current.commitId).toBe(old.commitId);
        expect((await reader.finalState(current,'alpha')).abiHex).toBe('aa');await unavailable(reader.revalidate(old));
    });

    it('revokes old branch proofs before replacement PREPARE and restores the ancestor input ABI',async()=>{
        const f=await fixture();await seed(f);await f.append(2,publicationFacts());
        const reader=f.reader(),old=await reader.open(f.source(2));
        const replacementFacts=facts();replacementFacts.actionInputs=[action(1,'1')];
        const replacement=await f.selected(2,replacementFacts,20,1);await f.admit(replacement);
        await unavailable(reader.revalidate(old));await unavailable(reader.open(f.source(2)));
        await f.prepare(replacement);await f.coordinator.drain();
        await unavailable(reader.open(f.source(2)));const view=await reader.open(f.source(2,20),replacement.selectionId);
        expect((await reader.action(view,replacementFacts.actionInputs[0])).state.abiHex).toBe('aa');
        expect((await reader.finalState(view,'alpha')).abiHex).toBe('aa');
    });

    it('rechecks source revocation during an ancestor read and after asynchronous consumer work',async()=>{
        const f=await fixture(),first=await seed(f);await f.append(2);
        const reader=f.reader();let revoked=false;
        f.memory.faults.beforeRead=async(request:any)=>{
            if(!revoked&&request.index===f.store.recordsIndex&&request.id===first.head.commitId){
                revoked=true;await f.coordinator.revokeSource(f.session);
            }
        };
        await unavailable(reader.open(f.source(1)));delete f.memory.faults.beforeRead;expect(revoked).toBe(true);
        await f.replaceOwner('master-after-revoke','reader-after-revoke');const next=facts();next.actionInputs=[action(1,'1')];await f.append(3,next);
        const view=await reader.open(f.source(3));const resolved=await reader.action(view,next.actionInputs[0]);
        expect(await Promise.resolve(resolved.state.abiHex)).toBe('aa');
        await f.coordinator.revokeSource(f.session);await unavailable(reader.revalidate(view));
    });

    it('refuses action and final-state results if authority is revoked during their state read',async()=>{
        for(const mode of ['action','final'] as const){
            const f=await fixture();await seed(f);const observed=facts();observed.actionInputs=[action(1,'1')];
            const second=await f.append(2,observed),reader=f.reader(),view=await reader.open(f.source(2));
            const heldId=mode==='action'?view.bindings[0].stateId:second.head.stateRootId;let revoked=false;
            expect(heldId).not.toBeNull();
            f.memory.faults.beforeRead=async(request:any)=>{
                if(!revoked&&request.index===f.store.recordsIndex&&request.id===heldId){
                    revoked=true;await f.coordinator.revokeSource(f.session);
                }
            };
            await unavailable(mode==='action'?reader.action(view,observed.actionInputs[0]):reader.finalState(view,'alpha'));
            delete f.memory.faults.beforeRead;expect(revoked).toBe(true);
        }
    });

    it('bounds historical ancestry and treats missing or corrupt certificates and ancestors as typed unavailable',async()=>{
        const f=await fixture(),first=await seed(f),second=await f.append(2);await f.append(3);await f.append(4);
        const bounded=f.reader(1);expect((await bounded.open(f.source(4))).source.blockNum).toBe(4);await unavailable(bounded.open(f.source(1)));
        for(const limit of [0,4097,1.5])expect(()=>f.reader(limit)).toThrow();
        const reader=f.reader(),view=await reader.open(f.source(1),first.selectionId);
        const certificateKey=f.memory.key(f.store.recordsIndex,view.certificateId),certificate=f.memory.documents.get(certificateKey)!;
        expect(certificate).toBeDefined();f.memory.documents.delete(certificateKey);await unavailable(reader.open(f.source(1)));
        f.memory.documents.set(certificateKey,certificate);
        const chunkKey=f.memory.key(f.store.recordsIndex,certificate.document.chunk_ids[0]),chunk=f.memory.documents.get(chunkKey)!;
        const payload=chunk.document.payload;chunk.document.payload='AA==';await unavailable(reader.open(f.source(1)));chunk.document.payload=payload;
        const ancestorKey=f.memory.key(f.store.recordsIndex,second.head.commitId),ancestor=f.memory.documents.get(ancestorKey)!;
        f.memory.documents.delete(ancestorKey);await unavailable(reader.open(f.source(1)));f.memory.documents.set(ancestorKey,ancestor);
        expect((await reader.open(f.source(1))).commitId).toBe(first.head.commitId);
    });

    it('does not provision missing proof indices and distinguishes storage outages and unsafe settings from proof unavailability',async()=>{
        const emptyMemory=frontierMemoryClient(),emptyReader=new ProtocolAbiProofReader({chainId,profile,
            store:new ProtocolAbiFrontierStore(emptyMemory.client as any,chain,0,{readOnly:true})});
        await unavailable(emptyReader.open({chainId,blockNum:1,blockId:block(1)}));
        expect(emptyMemory.calls.some((call:any)=>['createIndex','create','index'].includes(call.method))).toBe(false);
        const f=await fixture();await seed(f);const reader=f.reader(),outage=new Error('Proof transport unavailable');
        f.memory.faults.beforeRead=()=>{throw outage;};await expect(reader.open(f.source(1))).rejects.toBe(outage);delete f.memory.faults.beforeRead;
        f.memory.faults.settings=(value:any,request:any)=>({[request.index]:{settings:{...value,'index.translog.durability':'async'}}});
        let error:unknown;try{await reader.open(f.source(1));}catch(caught){error=caught;}
        expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(ProtocolAbiProofUnavailableError);
    });
});
