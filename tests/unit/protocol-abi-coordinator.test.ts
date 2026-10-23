import {describe,expect,it} from 'bun:test';
import {createHash} from 'node:crypto';
import {ProtocolAbiCoordinator} from '../../src/indexer/protocol/abi-coordinator.js';
import {ProtocolAbiFrontierStore} from '../../src/indexer/protocol/abi-frontier-store.js';
import {ProtocolSourceBindingStore,type ProtocolSourceProfile} from '../../src/indexer/protocol/source-bindings.js';
import {ProtocolAbiObservationStore,protocolAbiCaptureDigest,type ProtocolAbiObservationRecord} from '../../src/indexer/protocol/abi-observation-store.js';
import {frontierMemoryClient} from './protocol-frontier-memory.mjs';

// These are independently assembled provider facts, not encoded Wire testnet captures.
const chainId='1'.repeat(64),block=(number:number)=>number.toString(16).padStart(64,'0'),tx='a'.repeat(64);
const profile:ProtocolSourceProfile={id:'@eosrio/hyperion-wire-plugin',profileId:'frontier-fixture',components:[
    {id:'wire-node',runtime:'node',version:'0.0.0-dev.1',sourceRevision:'a'.repeat(40),sha256:'b'.repeat(64)}]};
const schemaJson='{"version":"eosio::abi/1.1"}';
const empty=()=>({schemaVersion:1 as const,actionInputs:[] as any[],deployments:[] as any[],finalStates:[] as any[]});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const input=(ordinal:number,globalSequence:string,account='alpha',name='act',rawHex='07000000',origin=ordinal,receiver=account)=>
    ({transactionId:tx,actionOrdinal:ordinal,inputActionOrdinal:origin,receiver,account,name,rawHex,globalSequence,receiptAbiSequence:'0'});
async function fixture(options:{maxPendingBlocks?:number;recoveryWindowBlocks?:number}={}){
    const memory=frontierMemoryClient(),client=memory.client as any;
    const bindings=new ProtocolSourceBindingStore(client,'fixture'),observations=new ProtocolAbiObservationStore(client,'fixture');
    const store=new ProtocolAbiFrontierStore(client,'fixture');
    const contextId=(await bindings.prepareContext({schemaVersion:1,chainId,protocol:profile,schemaJson})).id;
    const make=(ownerId:string)=>new ProtocolAbiCoordinator({chainId,profile,ownerId,bindings,observations,store,...options});
    const coordinator=make('master-1');await coordinator.start();let session='session-a';
    let generation=(await coordinator.openSource(contextId,session)).generation;
    async function selected(number:number,identity=number,parent=number-1,facts=empty(),incomplete=false){
        const source={chainId,blockNum:number,blockId:block(identity),previousBlockId:number===1?null:block(parent)};
        const capture={kind:'unattested-ship-result-sections-v1' as const,schemaJson,blockHex:'00',tracesHex:'00',deltasHex:'00'};
        const captureSha256=protocolAbiCaptureDigest(source,capture),frame=Buffer.from('fixture-frame-'+identity);
        const selectionId=(await bindings.prepareSelection({schemaVersion:1,contextId,readerSessionId:session,readerRole:'live',assignmentId:null,
            source,captureSha256,frameSha256:hash(frame),head:{blockNum:number,blockId:source.blockId},irreversible:{blockNum:0,blockId:block(0)}})).id;
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
