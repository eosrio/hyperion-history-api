import {describe,expect,it,spyOn} from 'bun:test';
import {createHash} from 'node:crypto';
import {ProtocolAbiCoordinator, type ProtocolAbiCoordinatorOptions} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolSourceBindingStore,type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,protocolAbiObservationJson,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';
import {protocolAbiCertificateForControl} from '../../src/indexer/protocol/abi-proof.js';
import {historicalAddressIdentity} from '../../src/indexer/protocol/abi-history.js';

// These are independently assembled provider facts, not encoded Wire testnet captures.
const chainId='1'.repeat(64),block=(number:number)=>number.toString(16).padStart(64,'0'),tx='a'.repeat(64);
const profile:ProtocolSourceProfile={id:'@eosrio/hyperion-wire-plugin',profileId:'frontier-fixture',components:[
    {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const schemaJson='{"version":"eosio::abi/1.1"}';
const empty=()=>({schemaVersion:1 as const,actionInputs:[] as any[],deployments:[] as any[],finalStates:[] as any[]});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const input=(ordinal:number,globalSequence:string,account='alpha',name='act',rawHex='07000000',origin=ordinal,receiver=account)=>
    ({transactionId:tx,actionOrdinal:ordinal,inputActionOrdinal:origin,receiver,account,name,rawHex,globalSequence,receiptAbiSequence:'0'});

// A validated catalog is an explicit input port; these fixed contents model its
// irreversible boundary independently of coordinator records or live selections.
function diskCatalog(end=3,manifest='c'){
    const catalogId='h45abihistory1:'+manifest.repeat(64),rowHash='d'.repeat(64);
    const state={account:'alpha',present:true,abiHex:'aabb',protocol:profile,
        source:{catalogId,observationId:'h45abidisk1:'+rowHash,chainId,blockNum:2,blockId:block(2),
            inputSha256:rowHash,phase:'block-end' as const,deltaOrdinal:0}};
    let valid=true;
    return {
        baseline:async()=>{if(!valid)throw new Error('catalog changed');return {catalogId,source:{chainId,blockNum:end,blockId:block(end),
            previousBlockId:end===1?null:block(end-1)},coverageStart:1 as const,lastGlobalSequence:'10',profile,states:[state]};},
        revalidate:async()=>{if(!valid)throw new Error('catalog changed');},
        blockId:(number:number)=>number>=1&&number<=end?block(number):null,
        matchesState:(value:unknown)=>protocolAbiObservationJson(value)===protocolAbiObservationJson(state),
        invalidate:()=>{valid=false;}
    };
}
async function fixture(options:Partial<ProtocolAbiCoordinatorOptions>={}){
    const memory=frontierMemoryClient(),client=memory.client as any;
    const bindings=new ProtocolSourceBindingStore(client,'fixture'),observations=new ProtocolAbiObservationStore(client,'fixture');
    const store=new ProtocolAbiFrontierStore(client,'fixture');
    const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const make=(ownerId:string,overrides:Partial<ProtocolAbiCoordinatorOptions>={})=>new ProtocolAbiCoordinator({chainId,profile,ownerId,bindings,observations,store,...options,...overrides});
    const coordinator=make('master-1');await coordinator.start();let session='session-a';
    let generation=(await coordinator.openSource(contextId,session)).generation;
    async function selected(number:number,identity=number,parent=number-1,facts=empty(),incomplete=false,headNumber=number,tracesHex='00'){
        const source={chainId,blockNum:number,blockId:block(identity),previousBlockId:number===1?null:block(parent)};
        const capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson,blockHex:'00',tracesHex,deltasHex:'00'};
        const captureSha256=protocolAbiCaptureDigest(source,capture),frame=Buffer.from('fixture-frame-'+identity);
        const selectionId=(await bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:session,readerRole:'live',assignmentId:null,
            source,captureSha256,frameSha256:hash(frame),head:{blockNum:headNumber,blockId:block(headNumber)},irreversible:{blockNum:0,blockId:block(0)}})).id;
        const record:ProtocolAbiObservationRecord={schemaVersion:1,protocol:profile,source:{...source,inputSha256:captureSha256},capture,
            observation:incomplete?{status:'incomplete',error:{code:'malformed-source',message:'Retained raw bytes'}}:{status:'observed',facts}};
        return {selectionId,record};
    }
    async function prepare(value:Awaited<ReturnType<typeof selected>>){
        const observed=await observations.prepare(value.record);
        await bindings.prepareObservationLink({schemaVersion:1,selectionId:value.selectionId,observationId:observed.id,observationDigest:observed.digest});
        return observed;
    }
    async function admit(value:Awaited<ReturnType<typeof selected>>){const result=await coordinator.admit(value.selectionId,generation);generation=result.generation;return result;}
    async function append(number:number,facts=empty(),identity=number,parent=number-1,incomplete=false){
        const value=await selected(number,identity,parent,facts,incomplete);await prepare(value);expect((await admit(value)).status).toBe('accepted');await coordinator.drain();return value;
    }
    return {memory,store,bindings,observations,coordinator,make,contextId,selected,prepare,admit,append,
        get generation(){return generation;},set generation(value:string){generation=value;},set session(value:string){session=value;}};
}

describe('canonical ABI runtime coordinator',()=>{
    it('activates one explicit disk baseline and reduces its first live successor with the sparse ABI state',async()=>{
        const catalog=diskCatalog(),f=await fixture({diskAbiHistory:catalog} as any);
        expect((await f.coordinator.inspect()).head).toMatchObject({blockNum:3,blockId:block(3),coverageStart:1,lastGlobalSequence:'10'});
        const baseline=(await f.coordinator.inspect()).head!,stored:any=await f.store.readCommit(baseline.commitId);
        expect(stored.kind).toBe('disk-abi-baseline');expect(stored.selectionId).toBeNull();expect(stored.observationId).toBeNull();
        expect(stored.previousCommitId).toBeNull();expect(stored.bindings).toEqual([]);
        const facts=empty();facts.actionInputs=[input(1,'11')];const next=await f.selected(4,4,3,facts);
        await f.prepare(next);expect((await f.admit(next)).status).toBe('accepted');expect((await f.coordinator.drain()).committed).toBe(1);
        const head=(await f.coordinator.inspect()).head!;expect(head).toMatchObject({blockNum:4,lastGlobalSequence:'11',coverageStart:1});
        const live:any=await f.store.readCommit(head.commitId);expect(live.kind).toBe('canonical-abi-block');
        expect(live.previousCommitId).toBe(baseline.commitId);expect(live.bindings).toHaveLength(1);
        expect(await f.store.readAccountState(live.bindings[0].stateId)).toMatchObject({account:'alpha',abiHex:'aabb',source:{catalogId:'h45abihistory1:'+'c'.repeat(64)}});
    });
    it('keeps a valid live successor across restart and resumes after it rather than reapplying the baseline',async()=>{
        const f=await fixture({diskAbiHistory:diskCatalog()} as any),facts=empty();facts.actionInputs=[input(1,'11')];
        const first=await f.append(4,facts),before=(await f.coordinator.inspect()).head!;
        const restarted=f.make('master-restarted');await restarted.start();
        expect((await restarted.inspect()).head).toEqual(before);
        await expect(f.coordinator.inspect()).rejects.toThrow('superseded');
        const opened=await restarted.openSource(f.contextId,'session-b');expect(opened.resumeFromBlock).toBe(5);
        f.session='session-b';const next=await f.selected(5);await f.prepare(next);
        expect((await restarted.admit(next.selectionId,opened.generation)).status).toBe('accepted');
        expect((await restarted.drain()).committed).toBe(1);expect((await restarted.inspect()).head!.blockNum).toBe(5);
        expect(await restarted.currentlyAdmittedSource(first.selectionId,first.record.source,'session-a',f.generation)).toBe(false);
    });
    it('advances a matching old prefix once and refuses a catalog with conflicting retained block identity',async()=>{
        const f=await fixture();await f.append(1);await f.append(2);
        const catalog=diskCatalog(),adopted=f.make('catalog-owner',{diskAbiHistory:catalog} as any);await adopted.start();
        expect((await adopted.inspect()).head).toMatchObject({blockNum:3,blockId:block(3)});
        expect(await adopted.openSource(f.contextId,'session-b')).toMatchObject({resumeFromBlock:4});
        const other=await fixture();await other.append(1);await other.append(2,empty(),20,1);
        const conflicting=other.make('conflicting-owner',{diskAbiHistory:diskCatalog()} as any);
        await expect(conflicting.start()).rejects.toThrow('conflicts with the retained canonical prefix');
        expect((await other.coordinator.inspect()).head).toMatchObject({blockNum:2,blockId:block(20)});
    });
    it('rejects rollback through the irreversible boundary and can replace a reversible first successor',async()=>{
        const f=await fixture({diskAbiHistory:diskCatalog()} as any),generation=f.generation;
        const wrongParent=await f.selected(4,40,30);await f.prepare(wrongParent);
        await expect(f.admit(wrongParent)).rejects.toThrow('forks below the irreversible disk ABI boundary');
        expect((await f.coordinator.inspect()).generation).toBe(generation);
        await f.append(4);await f.append(5);
        const replacement=await f.selected(4,40,3);await f.prepare(replacement);
        expect((await f.admit(replacement)).status).toBe('accepted');expect((await f.coordinator.drain()).committed).toBe(1);
        expect((await f.coordinator.inspect()).head).toMatchObject({blockNum:4,blockId:block(40),coverageStart:1});
        const covered=await f.selected(3,30,2);expect((await f.admit(covered)).status).toBe('stale');
        expect((await f.coordinator.inspect()).head!.blockId).toBe(block(40));
    });
    it('keeps the old owner and cursor when catalog revalidation fails before activation',async()=>{
        const f=await fixture();await f.append(1);const prior=await f.coordinator.inspect(),catalog=diskCatalog();catalog.invalidate();
        const refused=f.make('bad-catalog-owner',{diskAbiHistory:catalog} as any);
        await expect(refused.start()).rejects.toThrow('catalog changed');
        expect(await f.coordinator.inspect()).toEqual(prior);
    });
    it('refuses pre-catalog progress at or beyond the cutoff without taking ownership or rewinding it',async()=>{
        for(const completePrefix of [false,true]){
            const f=await fixture();
            if(completePrefix){await f.append(1);await f.append(2);await f.append(3);}
            await f.append(4);const before=await f.coordinator.inspect();
            const refused=f.make('unsafe-catalog-owner',{diskAbiHistory:diskCatalog()});
            await expect(refused.start()).rejects.toThrow('catalog cutoff ahead of the retained head');
            expect(await f.coordinator.inspect()).toEqual(before);
        }
        const equal=await fixture();await equal.append(3);const before=await equal.coordinator.inspect();
        await expect(equal.make('equal-cutoff-owner',{diskAbiHistory:diskCatalog()}).start()).rejects.toThrow('matching catalog ancestry');
        expect(await equal.coordinator.inspect()).toEqual(before);
    });
    it('keeps a matching catalog identity across incomplete tail commits and restart without restoring lost ABI knowledge',async()=>{
        const f=await fixture({diskAbiHistory:diskCatalog()});await f.append(4,empty(),4,3,true);
        const before=await f.coordinator.inspect(),stored:any=await f.store.readCommit(before.head!.commitId);
        expect(stored.catalogId).toBe('h45abihistory1:'+'c'.repeat(64));expect(before.head!.coverageStart).toBeNull();
        const restarted=f.make('catalog-gap-owner');await restarted.start();
        expect((await restarted.inspect()).head).toEqual(before.head);expect((await restarted.inspect()).gap).toEqual(before.gap);
        const opened=await restarted.openSource(f.contextId,'session-b');f.session='session-b';
        const facts=empty();facts.actionInputs=[input(1,'11')];const next=await f.selected(5,5,4,facts);await f.prepare(next);
        expect((await restarted.admit(next.selectionId,opened.generation)).status).toBe('accepted');await restarted.drain();
        const live:any=await f.store.readCommit((await restarted.inspect()).head!.commitId);
        expect(live.bindings[0].stateId).toBeNull();expect(live.coverageStart).toBe(5);expect(live.catalogId).toBe(stored.catalogId);
    });
    it('refuses missing or changed catalog configuration while preserving the current catalog-backed owner',async()=>{
        for(const tail of [false,true]){
            const f=await fixture({diskAbiHistory:diskCatalog()});if(tail)await f.append(4);
            const before=await f.coordinator.inspect();
            await expect(f.make('missing-catalog',{diskAbiHistory:undefined}).start()).rejects.toThrow('requires its configured disk ABI catalog');
            expect(await f.coordinator.inspect()).toEqual(before);
            await expect(f.make('foreign-catalog',{diskAbiHistory:diskCatalog(3,'e')}).start()).rejects.toThrow();
            expect(await f.coordinator.inspect()).toEqual(before);
        }
    });
    it('does not activate a sparse root if catalog custody changes while its immutable states are being prepared',async()=>{
        const f=await fixture();await f.append(1);const before=await f.coordinator.inspect(),catalog=diskCatalog();let changed=false;
        f.memory.faults.beforeWrite=(request:any)=>{if(!changed&&request.index===f.store.recordsIndex){changed=true;catalog.invalidate();}};
        await expect(f.make('changed-during-prepare',{diskAbiHistory:catalog}).start()).rejects.toThrow('catalog changed');
        delete f.memory.faults.beforeWrite;expect(changed).toBe(true);expect(await f.coordinator.inspect()).toEqual(before);
    });
    it('keeps the irreversible baseline when a later replacement has no parent in its reversible tail',async()=>{
        const f=await fixture({diskAbiHistory:diskCatalog()});await f.append(4);await f.append(5);
        const before=(await f.coordinator.inspect()).head!,replacement=await f.selected(5,50,30);await f.prepare(replacement);
        await expect(f.admit(replacement)).rejects.toThrow('cannot rewind below the irreversible disk ABI boundary');
        expect((await f.coordinator.inspect()).head).toEqual(before);expect((await f.coordinator.inspect()).gap?.code).toBe('fork_recovery_pending');
    });
    it('stops historical certificate work at the explicit baseline and publishes only live tail addresses',async()=>{
        const errors:unknown[]=[],f=await fixture({diskAbiHistory:diskCatalog(),onHistoricalError:error=>errors.push(error),
            historicalCertificates:{interfaceVersion:1,maxCommitsPerDrain:4,maxCommitBytesPerDrain:1024*1024,maxMillisecondsPerDrain:1000}});
        await f.append(4);await f.append(5);await f.coordinator.drain();
        const control=await f.coordinator.inspect(),certificate=protocolAbiCertificateForControl(control);
        expect(errors).toEqual([]);expect(control.historical).toBeDefined();
        expect(await f.store.readHistoricalCertificateAddress(historicalAddressIdentity(certificate,4))).toMatchObject({identity:{blockNum:4}});
        await expect(f.store.readHistoricalCertificateAddress(historicalAddressIdentity(certificate,3))).rejects.toThrow();
    });
    it('keeps default history behind pending work but allows bounded opt-in progress',async()=>{
        for(const allowPendingWork of [false,true]){
            const budget={interfaceVersion:1 as const,maxCommitsPerDrain:1,maxCommitBytesPerDrain:1024*1024,maxMillisecondsPerDrain:1000,...(allowPendingWork?{allowPendingWork:true as const}:{})};
            const f=await fixture({diskAbiHistory:diskCatalog(),historicalCertificates:budget});
            const first=await f.selected(4),blocked=await f.selected(5);await f.prepare(first);
            expect((await f.admit(first)).status).toBe('accepted');expect((await f.admit(blocked)).status).toBe('accepted');
            let reads=0;const read=f.store.readCommit.bind(f.store);
            f.store.readCommit=async (...args:any[])=>{reads++;return read(...args as [string]);};
            expect(await f.coordinator.drain()).toEqual({committed:1,pending:1});
            const before=reads;await f.coordinator.drain();
            if(allowPendingWork){expect(reads-before).toBeLessThanOrEqual(1);expect((await f.coordinator.inspect()).historical).toBeDefined();}
            else expect((await f.coordinator.inspect()).historical).toBeUndefined();
            await f.prepare(blocked);await f.coordinator.drain();
            for(let n=0;n<8;n++)await f.coordinator.drain();
            const control=await f.coordinator.inspect(),certificate=protocolAbiCertificateForControl(control);
            expect(await f.store.readHistoricalCertificateAddress(historicalAddressIdentity(certificate,4))).toMatchObject({identity:{blockNum:4}});
        }
    });
    it('uses a completed disk baseline only as a scheduling floor for the first live tail',async()=>{
        const f=await fixture({diskAbiHistory:diskCatalog(),historicalCertificates:{interfaceVersion:1,maxCommitsPerDrain:4,
            maxCommitBytesPerDrain:1024*1024,maxMillisecondsPerDrain:1000,allowPendingWork:true}});
        const tail=await f.selected(4);await f.admit(tail);await f.coordinator.drain();const baseline=await f.coordinator.inspect();
        expect((f.coordinator as any).historicalCompleted?.head).toEqual(baseline.head);
        expect(baseline.historical).toBeUndefined();
        await f.prepare(tail);await f.coordinator.drain();
        for(let n=0;n<4;n++)await f.coordinator.drain();
        const control=await f.coordinator.inspect(),commit:any=await f.store.readCommit(control.head!.commitId);
        expect(commit.previousCommitId).toBe(baseline.head!.commitId);
        expect(await f.store.readHistoricalCertificateAddress(historicalAddressIdentity(protocolAbiCertificateForControl(control),4))).toMatchObject({identity:{blockNum:4}});
        await expect(f.store.readHistoricalCertificateAddress(historicalAddressIdentity(protocolAbiCertificateForControl(control),3))).rejects.toThrow();
    });
    it('does not complete a historical walk after partial map preparation and retries it',async()=>{
        const errors:unknown[]=[],f=await fixture({diskAbiHistory:diskCatalog(),onHistoricalError:error=>errors.push(error),
            historicalCertificates:{interfaceVersion:1,maxCommitsPerDrain:4,maxCommitBytesPerDrain:1024*1024,maxMillisecondsPerDrain:1000,allowPendingWork:true}});
        const first=await f.selected(4),blocked=await f.selected(5);await f.prepare(first);await f.admit(first);await f.admit(blocked);
        const prepare=f.store.prepareHistoricalAddressRoot.bind(f.store);let failed=false;
        f.store.prepareHistoricalAddressRoot=async (...args:any[])=>{if(!failed){failed=true;throw new Error('controlled partial map failure');}return prepare(...args as Parameters<typeof prepare>);};
        await f.coordinator.drain();expect(failed).toBe(true);expect((f.coordinator as any).historicalCompleted).toBeUndefined();
        expect((await f.coordinator.inspect()).historical).toBeUndefined();expect(errors.length).toBeGreaterThan(0);
        await f.coordinator.drain();expect((await f.coordinator.inspect()).historical).toBeDefined();
        expect((f.coordinator as any).historicalCompleted?.head.blockNum).toBe(4);
        const replacement=f.make('replacement-owner');await replacement.start();
        expect((replacement as any).historicalCompleted).toBeUndefined();
        expect((await replacement.inspect()).historical).toBeUndefined();
    });
    it('does not complete or activate a map when its work deadline expires',async()=>{
        const f=await fixture({diskAbiHistory:diskCatalog(),historicalCertificates:{interfaceVersion:1,maxCommitsPerDrain:4,
            maxCommitBytesPerDrain:1024*1024,maxMillisecondsPerDrain:1000,allowPendingWork:true}});
        const first=await f.selected(4),blocked=await f.selected(5);await f.prepare(first);await f.admit(first);await f.admit(blocked);
        const publish=f.store.prepareHistoricalAddressRoot.bind(f.store);let now=0,entered=false;
        const clock=spyOn(performance,'now').mockImplementation(()=>now);
        f.store.prepareHistoricalAddressRoot=async (...args:any[])=>{entered=true;now=2000;return publish(...args as Parameters<typeof publish>);};
        try {await f.coordinator.drain();} finally {clock.mockRestore();f.store.prepareHistoricalAddressRoot=publish;}
        expect(entered).toBe(true);expect((await f.coordinator.inspect()).historical).toBeUndefined();
        expect((f.coordinator as any).historicalCompleted).toBeUndefined();
        await f.coordinator.drain();expect((await f.coordinator.inspect()).historical).toBeDefined();
        expect((f.coordinator as any).historicalCompleted?.head.blockNum).toBe(4);
        await f.coordinator.revokeSource('session-a');
        expect((f.coordinator as any).historicalCompleted).toBeUndefined();
        expect((await f.coordinator.inspect()).historical).toBeUndefined();
    });
    it('does not publish an admitted tail block after the catalog changes',async()=>{
        const catalog=diskCatalog(),f=await fixture({diskAbiHistory:catalog}),next=await f.selected(4);await f.prepare(next);await f.admit(next);
        const before=await f.coordinator.inspect();catalog.invalidate();await expect(f.coordinator.drain()).rejects.toThrow('catalog changed');
        expect(await f.coordinator.inspect()).toEqual(before);
    });
    it('retains local source revocation across held fork recovery without additional storage reads',async()=>{
        const f=await fixture();await f.append(1);
        const calls=f.memory.calls.length,current=f.coordinator.retainSourceFence('session-a',f.generation);
        expect(current()).toBe(true);expect(f.memory.calls).toHaveLength(calls);
        await f.append(2);expect(current()).toBe(true);
        const generation=f.generation,fork=await f.selected(2,20,1);
        const recover=(f.coordinator as any).recoverParent.bind(f.coordinator);
        let release!:()=>void,entered!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
        (f.coordinator as any).recoverParent=async(...args:any[])=>{entered();await gate;return recover(...args);};
        const pending=f.admit(fork);void pending.catch(()=>{});
        try {
            await waiting;
            const heldCalls=f.memory.calls.length;
            expect(current()).toBe(false);
            expect(f.coordinator.retainSourceFence('session-a',generation)()).toBe(false);
            expect(f.memory.calls).toHaveLength(heldCalls);
            release();await pending;
            expect(current()).toBe(false);
            expect(f.coordinator.retainSourceFence('session-a',f.generation)()).toBe(true);
        } finally {release();(f.coordinator as any).recoverParent=recover;}
    });
    it('does not restore a locally revoked session from repaired old control after failed storage',async()=>{
        const f=await fixture(),generation=f.generation,current=f.coordinator.retainSourceFence('session-a',generation);
        const save=f.store.compareAndSet.bind(f.store);
        let release!:()=>void,entered!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
        f.store.compareAndSet=async()=>{entered();await gate;throw new Error('controlled revoke write failure');};
        const pending=f.coordinator.revokeSource('session-a');void pending.catch(()=>{});
        try {
            expect(current()).toBe(false);
            expect(f.coordinator.retainSourceFence('session-a',generation)()).toBe(false);
            await waiting;release();await expect(pending).rejects.toThrow('controlled revoke write failure');
        } finally {release();f.store.compareAndSet=save;}
        expect((await f.coordinator.inspect()).source?.readerSessionId).toBe('session-a');
        expect(f.coordinator.retainSourceFence('session-a',generation)()).toBe(false);
        const opened=await f.coordinator.openSource(f.contextId,'session-b');
        expect(f.coordinator.retainSourceFence('session-b',opened.generation)()).toBe(true);
        expect(current()).toBe(false);
    });
    it('remembers an accepted replay of the committed head with a new source selection ID',async()=>{
        const f=await fixture(),first=await f.append(1);
        const conflict=await f.selected(1,1,0,empty(),false,3,'ff');
        expect((await f.admit(conflict)).status).toBe('stale');
        const {inputSha256:_conflictInputSha256,...conflictSource}=conflict.record.source;
        expect(await f.coordinator.currentlyAdmittedSource(conflict.selectionId,conflictSource,'session-a',f.generation)).toBe(false);
        const replay=await f.selected(1,1,0,empty(),false,2);
        expect(replay.selectionId).not.toBe(first.selectionId);
        expect((await f.admit(replay)).status).toBe('accepted');
        const {inputSha256:_inputSha256,...source}=replay.record.source;
        expect(await f.coordinator.currentlyAdmittedSource(replay.selectionId,source,'session-a',f.generation)).toBe(true);
    });
    it('keeps bounded live source membership through drain but revokes it on fork, reconnect and owner replacement',async()=>{
        const f=await fixture({recoveryWindowBlocks:2});
        const a=await f.selected(1),b=await f.selected(2),c=await f.selected(3);
        await f.admit(a);
        const position=(value:typeof a)=>{const {inputSha256:_inputSha256,...source}=value.record.source;return source;};
        const current=(value:typeof a,session='session-a',generation=f.generation)=>
            f.coordinator.currentlyAdmittedSource(value.selectionId,position(value),session,generation);
        expect(await current(a)).toBe(true);
        const read=f.store.readControl.bind(f.store);
        f.store.readControl=async (...args)=>{const visible=await read(...args);return {...visible!,seqNo:visible!.seqNo+1};};
        expect(await current(a)).toBe(false);
        f.store.readControl=read;
        expect(await f.coordinator.currentlyAdmittedSource(a.selectionId,
            {...position(a),blockId:block(99)},'session-a',f.generation)).toBe(false);
        expect(await current(a,'other-session')).toBe(false);
        await f.admit(b);await f.prepare(a);await f.prepare(b);await f.coordinator.drain();
        expect(await current(a)).toBe(true);expect(await current(b)).toBe(true);
        await f.admit(c);
        expect(await current(a)).toBe(false);expect(await current(b)).toBe(true);expect(await current(c)).toBe(true);
        const oldGeneration=f.generation,fork=await f.selected(2,20,1);
        await f.admit(fork);
        expect(f.generation).not.toBe(oldGeneration);
        expect(await current(b,'session-a',oldGeneration)).toBe(false);
        expect(await current(c)).toBe(false);expect(await current(fork)).toBe(true);
        await f.coordinator.revokeSource('session-a');
        expect(await current(fork)).toBe(false);
        const restarted=f.make('master-2');await restarted.start();
        expect(await current(fork)).toBe(false);
        const opened=await restarted.openSource(f.contextId,'session-b');
        expect(await restarted.currentlyAdmittedSource(fork.selectionId,position(fork),'session-b',opened.generation)).toBe(false);
    });

    it('does not hold the coordinator mutation lane during a slow current-source control read',async()=>{
        const f=await fixture({recoveryWindowBlocks:1}),a=await f.selected(1),b=await f.selected(2);
        await f.admit(a);
        const {inputSha256:_inputSha256,...position}=a.record.source;
        const read=f.store.readControl.bind(f.store);
        let release!:()=>void,entered!:()=>void,once=false;
        const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
        f.store.readControl=async (...args)=>{
            if(!once){once=true;entered();await gate;}
            return read(...args);
        };
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
            const probe=f.coordinator.currentlyAdmittedSource(a.selectionId,position,'session-a',f.generation);
            await waiting;
            const admitted=await Promise.race([f.admit(b),new Promise<never>((_resolve,reject)=>{
                timer=setTimeout(()=>{release();reject(new Error('Current-source read blocked ABI admission'));},1000);
            })]);
            expect(admitted.status).toBe('accepted');
            release();expect(await probe).toBe(false);
        } finally {if(timer)clearTimeout(timer);release();f.store.readControl=read;}
    });

    it('activates source order rather than parallel PREPARE completion, including refresh-independent restart reads',async()=>{
        const f=await fixture();const firstFacts=empty();firstFacts.finalStates=[{account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0}];
        const a=await f.selected(1,1,0,firstFacts),b=await f.selected(2);
        await f.admit(a);await f.admit(b);await f.prepare(b);
        expect(await f.coordinator.drain()).toEqual({committed:0,pending:2});expect((await f.coordinator.inspect()).head).toBeNull();
        await f.prepare(a);expect(await f.coordinator.drain()).toEqual({committed:2,pending:0});
        const view=await f.coordinator.inspect();expect(view.head?.blockNum).toBe(2);expect(view.head?.coverageStart).toBe(1);
        expect((await f.store.readAccount(view.head!.stateRootId,'alpha') as any).abiHex).toBe('aa');
        const restarted=f.make('master-2');await restarted.start();const newView=await restarted.inspect();
        expect(newView.head).toEqual(view.head);expect(newView.generation).not.toBe(view.generation);expect(newView.source).toBeNull();
        expect(await restarted.openSource(f.contextId,'session-b')).toMatchObject({resumeFromBlock:3});
        expect((await f.coordinator.admit(b.selectionId,f.generation)).status).toBe('stale');
    });

    it('persists distinct pre-publication, notification and later-input ABI bindings without latest-schema fallback',async()=>{
        const f=await fixture(),first=empty();first.finalStates=[{account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0}];await f.append(1,first);
        const facts=empty();facts.actionInputs=[input(1,'9007199254740993'),input(2,'9007199254740994','sysio','setabi'),
            input(4,'9007199254740995','alpha','act','07000000',1,'notified'),input(3,'9007199254740996')];
        facts.deployments=[{account:'alpha',abiHex:'bb',action:{transactionId:tx,actionOrdinal:2},globalSequence:'9007199254740994',effect:'native-before-receipt'}];
        facts.finalStates=[{account:'alpha',present:true,abiHex:'bb',deltaOrdinal:0}];await f.append(2,facts);
        const view=await f.coordinator.inspect(),commit=await f.store.readCommit(view.head!.commitId) as any;
        const byOrdinal=new Map<number,any>(commit.bindings.map((value:any)=>[value.actionOrdinal,value]));
        expect(byOrdinal.get(1).stateId).toBe(byOrdinal.get(4).stateId);
        expect((await f.store.readAccountState(byOrdinal.get(1).stateId) as any).abiHex).toBe('aa');
        expect((await f.store.readAccountState(byOrdinal.get(3).stateId) as any).abiHex).toBe('bb');
        expect(byOrdinal.get(2).stateId).toBeNull();expect(byOrdinal.get(1).rawSha256).toBe(hash(Buffer.from('07000000','hex')));
        expect(commit.bindings[0]).not.toHaveProperty('rawHex');expect(commit.bindings[0]).not.toHaveProperty('abiHex');
        expect(view.head!.lastGlobalSequence).toBe('9007199254740996');
    });

    it('treats incomplete inputs as an explicit ABI coverage gap and restores only independently known later accounts',async()=>{
        const f=await fixture(),first=empty();first.finalStates=[{account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0}];await f.append(1,first);
        await f.append(2,empty(),2,1,true);let view=await f.coordinator.inspect();expect(view.phase).toBe('incomplete');
        expect(view.head?.coverageStart).toBeNull();expect(view.head?.stateRootId).toBeNull();expect(view.gap?.fromBlock).toBe(2);
        const third=empty();third.actionInputs=[input(1,'1')];third.finalStates=[{account:'beta',present:true,abiHex:'',deltaOrdinal:0}];await f.append(3,third);
        view=await f.coordinator.inspect();const commit=await f.store.readCommit(view.head!.commitId) as any;
        expect(commit.bindings[0].stateId).toBeNull();expect(view.head!.coverageStart).toBe(3);
        expect(await f.store.readAccount(view.head!.stateRootId,'alpha')).toBeNull();
        expect((await f.store.readAccount(view.head!.stateRootId,'beta') as any).abiHex).toBe('');
    });

    it('revokes generation before rewinding a committed fork and restores the ancestor account root',async()=>{
        const f=await fixture({recoveryWindowBlocks:2}),first=empty();first.finalStates=[{account:'alpha',present:true,abiHex:'aa',deltaOrdinal:0}];await f.append(1,first);
        const oldSecond=empty();oldSecond.actionInputs=[input(1,'1','sysio','setabi')];
        oldSecond.deployments=[{account:'alpha',abiHex:'bb',action:{transactionId:tx,actionOrdinal:1},globalSequence:'1',effect:'native-before-receipt'}];
        oldSecond.finalStates=[{account:'alpha',present:true,abiHex:'bb',deltaOrdinal:0}];await f.append(2,oldSecond);await f.append(3);
        const previous=await f.coordinator.inspect(),forkFacts=empty();forkFacts.actionInputs=[input(1,'1')];
        const fork=await f.selected(2,20,1,forkFacts);await f.prepare(fork);await f.admit(fork);
        const rewound=await f.coordinator.inspect();expect(rewound.generation).not.toBe(previous.generation);expect(rewound.head!.blockNum).toBe(1);
        const controlWrites=f.memory.calls.filter((call:any)=>['create','index'].includes(call.method)&&call.request.index===f.store.controlIndex)
            .map((call:any)=>JSON.parse(Buffer.from(call.request.document.payload,'base64').toString()));
        expect(controlWrites.some((value:any)=>value.generation===rewound.generation&&value.phase==='recovering'&&value.head?.blockNum===3)).toBe(true);
        await f.coordinator.drain();const current=await f.coordinator.inspect(),commit=await f.store.readCommit(current.head!.commitId) as any;
        expect(current.head!.blockId).toBe(block(20));expect((await f.store.readAccountState(commit.bindings[0].stateId) as any).abiHex).toBe('aa');
    });

    it('keeps only the canonical common prefix when a fork replaces queued out-of-order work',async()=>{
        const f=await fixture();const a=await f.selected(1),b=await f.selected(2),old=await f.selected(3),replacement=await f.selected(3,30,2);
        await f.admit(a);await f.admit(b);await f.admit(old);await f.prepare(old);await f.admit(replacement);
        expect((await f.coordinator.inspect()).pending).toEqual([a.selectionId,b.selectionId,replacement.selectionId]);
        await f.prepare(a);await f.prepare(b);expect(await f.coordinator.drain()).toEqual({committed:2,pending:1});
        await f.prepare(replacement);await f.coordinator.drain();expect((await f.coordinator.inspect()).head!.blockId).toBe(block(30));
    });

    it('bounds pending admissions without deadlocking the separate PREPARE drain',async()=>{
        const f=await fixture({maxPendingBlocks:2}),a=await f.selected(1),b=await f.selected(2),c=await f.selected(3);
        await f.admit(a);await f.admit(b);expect((await f.admit(c)).status).toBe('backpressure');
        await f.prepare(a);expect(await f.coordinator.drain()).toEqual({committed:1,pending:1});
        expect((await f.admit(c)).status).toBe('accepted');expect((await f.coordinator.inspect()).pending.length).toBe(2);
    });

    it('records missing older recovery ancestry explicitly and starts later ABI knowledge UNKNOWN',async()=>{
        const f=await fixture({recoveryWindowBlocks:1});for(let number=1;number<=3;number++)await f.append(number);
        const replacement=await f.selected(2,20,1);await f.prepare(replacement);await f.admit(replacement);
        const view=await f.coordinator.inspect();expect(view.head).toBeNull();expect(view.gap?.code).toBe('source_ancestry_unavailable');
        await f.coordinator.drain();const commit=await f.store.readCommit((await f.coordinator.inspect()).head!.commitId) as any;
        expect(commit.previousCommitId).toBeNull();expect(commit.coverageStart).toBe(2);
    });

    it('preserves pending progress across transport failures and never turns unsafe storage into a successful incomplete commit',async()=>{
        const f=await fixture(),value=await f.selected(1);await f.prepare(value);await f.admit(value);
        const fault=Object.assign(new Error('ES unavailable'),{meta:{statusCode:503}});
        f.memory.faults.beforeRead=(request:any)=>{if(request.index.endsWith('protocol-abi-observations-v1'))throw fault;};
        await expect(f.coordinator.drain()).rejects.toBe(fault);delete f.memory.faults.beforeRead;
        expect((await f.coordinator.inspect()).head).toBeNull();expect((await f.coordinator.inspect()).pending).toEqual([value.selectionId]);
        expect(await f.coordinator.drain()).toEqual({committed:1,pending:0});
    });

    it('fences an in-flight drain when the physical source is revoked and resumes from committed ABI progress',async()=>{
        const f=await fixture(),value=await f.selected(1);await f.prepare(value);await f.admit(value);
        let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
        let held=false;f.memory.faults.beforeRead=async(request:any)=>{if(!held&&request.index.endsWith('protocol-abi-observations-v1')){held=true;entered();await gate;}};
        const draining=f.coordinator.drain();await waiting;const revoked=f.coordinator.revokeSource('session-a');release();
        expect((await draining).committed).toBe(0);expect(await revoked).toBe(true);delete f.memory.faults.beforeRead;
        expect((await f.coordinator.inspect()).head).toBeNull();expect((await f.coordinator.inspect()).pending).toEqual([]);
        expect(await f.coordinator.openSource(f.contextId,'session-b')).toMatchObject({resumeFromBlock:1});
    });

    it('records explicit incompleteness at a projection batch bound and keeps later history progressing',async()=>{
        const f=await fixture(),oversized=empty();
        oversized.finalStates=Array.from({length:10001},(_,index)=>({account:'account'+index,present:true,abiHex:'',deltaOrdinal:index}));
        await f.append(1,oversized);const view=await f.coordinator.inspect();
        expect(view.head!.blockNum).toBe(1);expect(view.head!.coverageStart).toBeNull();expect(view.head!.stateRootId).toBeNull();
        expect(view.gap!.code).toBe('protocol_abi_frontier_limit');
        await f.append(2);expect((await f.coordinator.inspect()).head!.blockNum).toBe(2);
    });

    it('replays an old-generation head CAS whose receipt was pending when its source was revoked',async()=>{
        const f=await fixture(),value=await f.selected(1);await f.prepare(value);await f.admit(value);
        let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;});
        let held=false;f.memory.faults.beforeWrite=async(request:any)=>{
            if(!held&&request.index===f.store.controlIndex&&JSON.parse(Buffer.from(request.document.payload,'base64').toString()).head){held=true;entered();await gate;}
        };
        const draining=f.coordinator.drain();await waiting;const revoked=f.coordinator.revokeSource('session-a');release();
        expect((await draining).committed).toBe(0);expect(await revoked).toBe(true);delete f.memory.faults.beforeWrite;
        expect((await f.coordinator.inspect()).head).toBeNull();
        expect(await f.coordinator.openSource(f.contextId,'session-b')).toMatchObject({resumeFromBlock:1});
    });

    it('retains the fork replay boundary if the runtime restarts after the durable fence and before ancestor recovery',async()=>{
        const f=await fixture();await f.append(1);await f.append(2);await f.append(3);
        const replacement=await f.selected(2,20,1);let fenceWritten=false;
        f.memory.faults.beforeWrite=(request:any)=>{
            if(request.index===f.store.controlIndex){const value=JSON.parse(Buffer.from(request.document.payload,'base64').toString());
                if(value.gap?.code==='fork_recovery_pending')fenceWritten=true;}
        };
        const fault=new Error('interrupted ancestry read');f.memory.faults.beforeRead=(request:any)=>{
            if(fenceWritten&&request.index===f.store.recordsIndex)throw fault;
        };
        await expect(f.admit(replacement)).rejects.toBe(fault);delete f.memory.faults.beforeWrite;delete f.memory.faults.beforeRead;
        const restarted=f.make('master-after-fork');await restarted.start();
        const opened=await restarted.openSource(f.contextId,'session-b');expect(opened.resumeFromBlock).toBe(2);
        f.session='session-b';const replay=await f.selected(2,20,1);await f.prepare(replay);
        expect((await restarted.admit(replay.selectionId,opened.generation)).status).toBe('accepted');
        expect((await restarted.drain()).committed).toBe(1);expect((await restarted.inspect()).gap?.code).not.toBe('fork_recovery_pending');
        const again=f.make('master-after-repaired-fork');await again.start();
        expect(await again.openSource(f.contextId,'session-c')).toMatchObject({resumeFromBlock:3});
    });

    it('retains the earliest admitted initial block across a reconnect and runtime restart before the first commit',async()=>{
        const f=await fixture(),first=await f.selected(100),second=await f.selected(101);
        await f.admit(first);await f.admit(second);await f.prepare(second);
        expect((await f.coordinator.inspect()).replayFromBlock).toBe(100);
        await f.coordinator.revokeSource('session-a');const restarted=f.make('initial-replay-owner');await restarted.start();
        const opened=await restarted.openSource(f.contextId,'session-b');expect(opened.resumeFromBlock).toBe(100);
        expect((await restarted.inspect()).head).toBeNull();expect((await restarted.inspect()).pending).toEqual([]);
        f.session='session-b';const replay=await f.selected(100);await f.prepare(replay);await restarted.admit(replay.selectionId,opened.generation);await restarted.drain();
        expect((await restarted.inspect()).head!.blockNum).toBe(100);expect((await restarted.inspect()).replayFromBlock).toBeNull();
        expect(await restarted.openSource(f.contextId,'session-c')).toMatchObject({resumeFromBlock:101});
    });
});


