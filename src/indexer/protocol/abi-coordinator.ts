import {createHash, randomUUID} from 'node:crypto';
import {ProtocolAbiObservationStore, protocolAbiObservationId, type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {ProtocolSourceBindingStore, ProtocolSourceBindingReadError, protocolSourceContextId,
    type ProtocolSourceProfile, type ProtocolSourceSelection, type ProtocolSourcePosition} from './source-bindings.js';
import {ImmutableProtocolBundleReadError, protocolImmutableJson} from './immutable-bundle-store.js';
import {ProtocolAbiFrontierStore, ProtocolAbiFrontierConflictError, ProtocolAbiFrontierReadError, ProtocolAbiFrontierLimitError} from './abi-frontier-store.js';
import {reduceProtocolAbiBlock, type ProtocolAbiAccountState, type ProtocolAbiBlockReduction} from './abi-reducer.js';
import {protocolAbiCertificateForControl} from './abi-proof.js';
import {validNativeGenesisCoverage, type ProtocolNativeGenesisCoverage, type ProtocolNativeGenesisVerifier} from './native-genesis.js';

type Head = {blockNum:number;blockId:string;commitId:string;stateRootId:string|null;
    lastGlobalSequence:string|null;coverageStart:number|null};
type Gap = {code:string;message:string;fromBlock:number|null};
export interface ProtocolAbiCoordinatorControl {
    schemaVersion:1; chainId:string; profile:ProtocolSourceProfile; ownerId:string; generation:string; revision:number;
    source:{contextId:string;readerSessionId:string}|null; head:Head|null; pending:string[];
    phase:'awaiting-source'|'recovering'|'following'|'incomplete'; gap:Gap|null; replayFromBlock:number|null;
}
interface Commit {
    schemaVersion:1; kind:'canonical-abi-block'; chainId:string; profile:ProtocolSourceProfile; generation:string;
    previousCommitId:string|null; selectionId:string; observationId:string|null; observationDigest:string|null;
    source:ProtocolSourcePosition; status:'complete'|'incomplete'; reason:Gap|null;
    stateRootId:string|null; lastGlobalSequence:string|null; coverageStart:number|null;
    nativeGenesis?:ProtocolNativeGenesisCoverage;
    bindings:Array<{transactionId:string;actionOrdinal:number;inputActionOrdinal:number;receiver:string;account:string;
        name:string;globalSequence:string;receiptAbiSequence:string;rawSha256:string;stateId:string|null}>;
}
interface Version {value:ProtocolAbiCoordinatorControl;seqNo:number;primaryTerm:number}
export interface ProtocolAbiCoordinatorOptions {
    chainId:string; profile:ProtocolSourceProfile; ownerId:string; bindings:ProtocolSourceBindingStore;
    observations:ProtocolAbiObservationStore; store:ProtocolAbiFrontierStore;
    maxPendingBlocks?:number; recoveryWindowBlocks?:number;
    verifyNativeGenesis?:ProtocolNativeGenesisVerifier;
}
export class ProtocolAbiCoordinatorStaleError extends Error {
    constructor(message='Protocol ABI source was superseded'){super(message);this.name='ProtocolAbiCoordinatorStaleError';}
}
class InvalidPreparedObservation extends Error {}
const hex64=/^[0-9a-f]{64}$/;
const id=(prefix:string,value:unknown):value is string=>typeof value==='string'&&new RegExp('^'+prefix+':[0-9a-f]{64}$').test(value);
const uint32=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=0xffffffff;
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256;
const json=(value:unknown)=>protocolImmutableJson(value);
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const copy=<T>(value:T):T=>JSON.parse(json(value));
const gap=(code:string,message:string,fromBlock:number|null):Gap=>({code,message:message.slice(0,4096).toWellFormed(),fromBlock});
const dataUnavailable=(error:unknown)=>error instanceof ProtocolAbiFrontierReadError
    ||error instanceof ImmutableProtocolBundleReadError||error instanceof InvalidPreparedObservation;

/** One runtime owner, immutable prepared inputs, and a CAS-published canonical ABI cursor.
 * Source topology and per-account/input knowledge are separate: incomplete input advances no ABI coverage. */
export class ProtocolAbiCoordinator {
    private readonly profile:ProtocolSourceProfile;
    private readonly maximumPending:number;
    private readonly recoveryWindow:number;
    private serial:Promise<unknown>=Promise.resolve();
    private known?:Version;
    private started=false;
    private fenced=false;
    private sourceEpoch=0;
    private activeSession?:string;
    private openingSession?:string;
    private certifiedId?:string;

    constructor(private readonly options:ProtocolAbiCoordinatorOptions) {
        if(!hex64.test(options.chainId)||!text(options.ownerId))throw new Error('Invalid ABI coordinator identity');
        protocolSourceContextId({schemaVersion:1,chainId:options.chainId,protocol:options.profile,schemaJson:'{}'});
        this.profile=copy(options.profile);
        this.profile.components=[...this.profile.components].sort((a,b)=>(a.runtime+':'+a.id)<(b.runtime+':'+b.id)?-1:1);
        this.maximumPending=options.maxPendingBlocks??128;this.recoveryWindow=options.recoveryWindowBlocks??256;
        if(!Number.isSafeInteger(this.maximumPending)||this.maximumPending<1||this.maximumPending>4096
            ||!Number.isSafeInteger(this.recoveryWindow)||this.recoveryWindow<1||this.recoveryWindow>4096)
            throw new Error('Invalid bounded ABI coordinator configuration');
    }

    private run<T>(action:()=>Promise<T>):Promise<T> {
        const result=this.serial.then(action);this.serial=result.then(()=>undefined,()=>undefined);return result;
    }
    private sameProfile(value:ProtocolSourceProfile):boolean {return json(value)===json(this.profile);}
    private assertEpoch(epoch:number):void {if(epoch!==this.sourceEpoch)throw new ProtocolAbiCoordinatorStaleError();}
    private validateControl(input:unknown):ProtocolAbiCoordinatorControl {
        const value=copy(input) as ProtocolAbiCoordinatorControl;
        // Draft frontier records before this field existed had no durable initial replay boundary.
        if(value&&value.replayFromBlock===undefined)value.replayFromBlock=null;
        if(!value||value.schemaVersion!==1||value.chainId!==this.options.chainId||!text(value.ownerId)||!text(value.generation)
            ||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.pending)||value.pending.length>4096
            ||new Set(value.pending).size!==value.pending.length||value.pending.some(selected=>!id('h45srcsel1',selected))
            ||!['awaiting-source','recovering','following','incomplete'].includes(value.phase)
            ||(value.replayFromBlock!==null&&(!uint32(value.replayFromBlock)||value.replayFromBlock<1))
            ||(value.source!==null&&(!id('h45srcctx1',value.source?.contextId)||!text(value.source?.readerSessionId))))
            throw new Error('Invalid canonical ABI control');
        protocolSourceContextId({schemaVersion:1,chainId:value.chainId,protocol:value.profile,schemaJson:'{}'});
        if(value.gap!==null&&(!text(value.gap?.code)||typeof value.gap?.message!=='string'||value.gap.message.length>4096
            ||(value.gap.fromBlock!==null&&!uint32(value.gap.fromBlock))))throw new Error('Invalid canonical ABI gap');
        if(value.head!==null)this.validateHead(value.head);
        if(!value.source&&value.pending.length)throw new Error('Canonical ABI pending work has no source');
        return value;
    }
    private validateHead(head:Head):void {
        if(!uint32(head?.blockNum)||head.blockNum<1||!hex64.test(head.blockId)||!id('h45abicmt1',head.commitId)
            ||(head.stateRootId!==null&&!id('h45abiroot1',head.stateRootId))
            ||(head.coverageStart!==null&&(!uint32(head.coverageStart)||head.coverageStart<1||head.coverageStart>head.blockNum))
            ||(head.lastGlobalSequence!==null&&(typeof head.lastGlobalSequence!=='string'||!/^[1-9][0-9]{0,19}$/.test(head.lastGlobalSequence)
                ||BigInt(head.lastGlobalSequence)>0xffffffffffffffffn)))throw new Error('Invalid canonical ABI head');
    }
    private async save(version:Version,next:ProtocolAbiCoordinatorControl):Promise<Version> {
        next={...next,revision:version.value.revision+1};this.validateControl(next);
        if(next.ownerId!==this.options.ownerId)throw new ProtocolAbiCoordinatorStaleError('ABI coordinator owner changed');
        try {
            const receipt=await this.options.store.compareAndSet(version,next);
            const result={...receipt,value:this.validateControl(receipt.value)};this.known=result;return result;
        } catch(error) {this.known=undefined;if(error instanceof ProtocolAbiFrontierConflictError)this.fenced=true;throw error;}
    }
    private async owned():Promise<Version> {
        if(!this.started||this.fenced)throw new ProtocolAbiCoordinatorStaleError('ABI coordinator is not the active owner');
        const stored=await this.options.store.readControl();
        if(!stored)throw new Error('Canonical ABI control disappeared');
        const version={...stored,value:this.validateControl(stored.value)};
        if(version.value.ownerId!==this.options.ownerId||!this.sameProfile(version.value.profile)){
            this.fenced=true;throw new ProtocolAbiCoordinatorStaleError('ABI coordinator owner was superseded');
        }
        if(this.known?.seqNo===version.seqNo&&this.known?.primaryTerm===version.primaryTerm)return version;
        // Unknown/partial receipts and restarts cannot turn a primary GET into a durable authority claim.
        const repaired=await this.options.store.compareAndSet(version,version.value);
        this.known={...repaired,value:this.validateControl(repaired.value)};return this.known;
    }

    async start():Promise<void> {return this.run(async()=>{
        if(this.started)throw new Error('ABI coordinator owner may only be acquired once');
        const stored=await this.options.store.readControl();
        const previous=stored?this.validateControl(stored.value):null;
        let head=previous&&this.sameProfile(previous.profile)?previous.head:null;
        let replayFromBlock=previous&&this.sameProfile(previous.profile)?previous.replayFromBlock:null;
        let reason=previous?.gap??null;
        if(previous&&!this.sameProfile(previous.profile))reason=gap('protocol_profile_changed','ABI knowledge requires initialization under the installed profile',null);
        if(head){
            try {const commit=await this.readCommit(head.commitId);if(json(this.head(commit,head.commitId))!==json(head))throw new InvalidPreparedObservation('Stored head does not match its immutable commit');}
            catch(error){if(!dataUnavailable(error))throw error;head=null;replayFromBlock=previous!.head!.blockNum;
                reason=gap('retained_frontier_unavailable',String((error as Error).message),previous!.head!.blockNum);}
        }
        const value:ProtocolAbiCoordinatorControl={schemaVersion:1,chainId:this.options.chainId,profile:this.profile,ownerId:this.options.ownerId,
            generation:randomUUID(),revision:(previous?.revision??-1)+1,source:null,head,pending:[],phase:'awaiting-source',gap:reason,replayFromBlock};
        const receipt=await this.options.store.compareAndSet(stored,value);
        this.known={...receipt,value:this.validateControl(receipt.value)};this.started=true;
    });}

    async openSource(contextId:string,readerSessionId:string):Promise<{generation:string;resumeFromBlock:number|null}> {
        if(!text(readerSessionId))throw new Error('Invalid source reader session');
        const settled=this.known?.value;
        this.openingSession=readerSessionId;const epoch=++this.sourceEpoch;
        return this.run(async()=>{
            let version=await this.owned();const context=await this.options.bindings.readContext(contextId);this.assertEpoch(epoch);
            if(context.chainId!==this.options.chainId||!this.sameProfile(context.protocol))throw new Error('Source context does not match installed protocol');
            version=await this.save(version,{...version.value,generation:randomUUID(),source:{contextId,readerSessionId},pending:[],phase:'recovering',
                head:settled?.head??(settled?null:version.value.head),gap:settled?.gap??(settled?null:version.value.gap),
                replayFromBlock:settled?settled.replayFromBlock:version.value.replayFromBlock});
            this.assertEpoch(epoch);this.activeSession=readerSessionId;
            const resume=version.value.head?version.value.head.blockNum+1:null,boundary=version.value.replayFromBlock;
            return {generation:version.value.generation,resumeFromBlock:boundary===null?resume:Math.min(resume??boundary,boundary)};
        }).finally(()=>{if(this.openingSession===readerSessionId)this.openingSession=undefined;});
    }
    async revokeSource(readerSessionId:string,generation?:string):Promise<boolean> {
        const recognized=this.activeSession===readerSessionId||this.openingSession===readerSessionId;
        const settled=recognized?this.known?.value:undefined;
        if(recognized)this.sourceEpoch++;
        return this.run(async()=>{
            const version=await this.owned();
            if(version.value.source?.readerSessionId!==readerSessionId||(generation&&generation!==version.value.generation))return false;
            await this.save(version,{...version.value,generation:randomUUID(),source:null,pending:[],phase:'awaiting-source',
                head:settled?.head??(settled?null:version.value.head),gap:settled?.gap??(settled?null:version.value.gap),
                replayFromBlock:settled?settled.replayFromBlock:version.value.replayFromBlock});
            if(this.activeSession===readerSessionId)this.activeSession=undefined;return true;
        });
    }
    private async selection(selectedId:string,control:ProtocolAbiCoordinatorControl):Promise<ProtocolSourceSelection> {
        const {selection,context}=await this.options.bindings.readSelection(selectedId);
        if(!control.source||selection.readerRole!=='live'||selection.readerSessionId!==control.source.readerSessionId
            ||selection.contextId!==control.source.contextId||context.chainId!==this.options.chainId||!this.sameProfile(context.protocol))
            throw new ProtocolAbiCoordinatorStaleError('Selection is not from the authorized live source');
        return selection;
    }

    async admit(selectedId:string,generation:string):Promise<{status:'accepted'|'backpressure'|'stale';generation:string}> {
        const epoch=this.sourceEpoch;
        try {return await this.run(async()=>{
            let version=await this.owned();this.assertEpoch(epoch);
            if(generation!==version.value.generation||!version.value.source)return {status:'stale',generation:version.value.generation};
            const selection=await this.selection(selectedId,version.value);this.assertEpoch(epoch);
            if(version.value.pending.includes(selectedId))return {status:'accepted',generation};
            const source=selection.source;
            if(version.value.head?.blockNum===source.blockNum&&version.value.head.blockId===source.blockId)return {status:'accepted',generation};
            const last=version.value.pending.length?await this.selection(version.value.pending.at(-1)!,version.value):null;
            const tip=last?.source??version.value.head;
            if(!tip||(source.blockNum===tip.blockNum+1&&source.previousBlockId===tip.blockId)){
                if(version.value.pending.length>=this.maximumPending)return {status:'backpressure',generation};
                version=await this.save(version,{...version.value,pending:[...version.value.pending,selectedId],phase:'following',
                    replayFromBlock:version.value.head?version.value.replayFromBlock:(version.value.replayFromBlock??source.blockNum)});
            } else {
                const before=version.value;
                // This durable fence linearizes fork recovery before any rewind/replay or subsequent activation.
                version=await this.save(version,{...before,generation:randomUUID(),pending:[],phase:'recovering',
                    gap:gap('fork_recovery_pending','Replacement branch requires ancestor reconciliation before activation',source.blockNum),
                    replayFromBlock:Math.min(before.replayFromBlock??source.blockNum,source.blockNum)});this.assertEpoch(epoch);
                const recovered=await this.recoverParent(before,source);this.assertEpoch(epoch);
                version=await this.save(version,{...version.value,head:recovered.head,pending:[...recovered.pending,selectedId],phase:'following',gap:recovered.gap,
                    replayFromBlock:recovered.head?null:version.value.replayFromBlock});
            }
            this.assertEpoch(epoch);return {status:'accepted',generation:version.value.generation};
        });} catch(error){if(error instanceof ProtocolAbiCoordinatorStaleError)return {status:'stale',generation:this.known?.value.generation??generation};throw error;}
    }
    private async recoverParent(before:ProtocolAbiCoordinatorControl,source:ProtocolSourcePosition):Promise<{head:Head|null;pending:string[];gap:Gap|null}> {
        const restoredGap=before.gap?.code==='fork_recovery_pending'?null:before.gap;
        for(let index=0;index<before.pending.length;index++){
            const prior=await this.selection(before.pending[index],before);
            if(prior.source.blockNum===source.blockNum-1&&prior.source.blockId===source.previousBlockId)
                return {head:before.head,pending:before.pending.slice(0,index+1),gap:restoredGap};
        }
        let head=before.head;
        for(let distance=0;head&&distance<=this.recoveryWindow;distance++){
            if(head.blockNum===source.blockNum-1&&head.blockId===source.previousBlockId)return {head,pending:[],gap:restoredGap};
            if(distance===this.recoveryWindow)break;
            try {const commit=await this.readCommit(head.commitId);head=commit.previousCommitId?this.head(await this.readCommit(commit.previousCommitId),commit.previousCommitId):null;}
            catch(error){if(!dataUnavailable(error))throw error;break;}
        }
        return {head:null,pending:[],gap:gap('source_ancestry_unavailable','Replacement parent is outside retained verified recovery coverage; ABI knowledge restarts UNKNOWN',source.blockNum)};
    }

    private head(commit:Commit,commitId:string):Head {return {blockNum:commit.source.blockNum,blockId:commit.source.blockId,commitId,
        stateRootId:commit.stateRootId,lastGlobalSequence:commit.lastGlobalSequence,coverageStart:commit.coverageStart};}
    private async readCommit(commitId:string):Promise<Commit> {
        const value=await this.options.store.readCommit(commitId) as Commit;
        if(!value||value.schemaVersion!==1||value.kind!=='canonical-abi-block'||value.chainId!==this.options.chainId||!this.sameProfile(value.profile)
            ||!text(value.generation)||!id('h45srcsel1',value.selectionId)||!value.source||value.source.chainId!==this.options.chainId
            ||!uint32(value.source.blockNum)||value.source.blockNum<1||!hex64.test(value.source.blockId)
            ||(value.source.previousBlockId!==null&&!hex64.test(value.source.previousBlockId))
            ||(value.previousCommitId!==null&&!id('h45abicmt1',value.previousCommitId))
            ||!['complete','incomplete'].includes(value.status)||!Array.isArray(value.bindings)
            ||(value.nativeGenesis!==undefined&&(!validNativeGenesisCoverage(value.nativeGenesis)||value.status!=='complete'
                ||value.source.blockNum!==1||value.source.previousBlockId!==null||value.previousCommitId!==null
                ||value.bindings.length!==0||value.lastGlobalSequence!==null||value.coverageStart!==1))
            ||(value.status==='incomplete'&&(value.bindings.length||value.stateRootId!==null||value.lastGlobalSequence!==null||value.coverageStart!==null)))
            throw new InvalidPreparedObservation('Invalid immutable canonical ABI commit');
        this.validateHead(this.head(value,commitId));return value;
    }
    private validateObservation(record:ProtocolAbiObservationRecord,selection:ProtocolSourceSelection,contextJson:string,
                                observationId:string,observationDigest:string):void {
        if(protocolAbiObservationId(record)!==observationId||digest(json(record))!==observationDigest
            ||!this.sameProfile(record.protocol)||record.capture.schemaJson!==contextJson
            ||record.source.inputSha256!==selection.captureSha256
            ||json({...selection.source,inputSha256:selection.captureSha256})!==json(record.source))
            throw new InvalidPreparedObservation('Observation does not match the admitted source selection');
    }

    private async prepareBlock(control:ProtocolAbiCoordinatorControl,selectedId:string,selected:ProtocolSourceSelection,
                               link:{observationId:string;observationDigest:string},reduction:ProtocolAbiBlockReduction):Promise<{commit:Commit;id:string}> {
        const materialize=async(value:ProtocolAbiBlockReduction)=>{
            const stateRootId=await this.options.store.prepareState(control.head?.stateRootId??null,value.updates,value.reset);
            const states=new Map<ProtocolAbiAccountState,Promise<string>>(),bindings:Commit['bindings']=[];
            for(const binding of value.bindings){
                let stateId:string|null=null;
                if(binding.state){
                    let prepared=states.get(binding.state);
                    if(!prepared){prepared=this.options.store.prepareAccountState(binding.state).then(result=>result.id);states.set(binding.state,prepared);}
                    stateId=await prepared;
                }
                const {rawHex,state:_state,...input}=binding;
                bindings.push({...input,rawSha256:digest(Buffer.from(rawHex,'hex')),stateId});
            }
            const complete=!value.reset,reason=value.status==='incomplete'?gap(value.reason.code,value.reason.message,selected.source.blockNum):null;
            const commit:Commit={schemaVersion:1,kind:'canonical-abi-block',chainId:this.options.chainId,profile:this.profile,generation:control.generation,
                previousCommitId:control.head?.commitId??null,selectionId:selectedId,observationId:link.observationId,observationDigest:link.observationDigest,
                source:selected.source,status:complete?'complete':'incomplete',reason,stateRootId,
                lastGlobalSequence:value.lastGlobalSequence,coverageStart:complete?(control.head?.coverageStart??selected.source.blockNum):null,bindings,
                ...(value.status==='complete'&&value.nativeGenesis?{nativeGenesis:value.nativeGenesis}:{})};
            const prepared=await this.options.store.prepareCommit(commit);
            if(json(await this.readCommit(prepared.id))!==json(commit))throw new Error('Prepared canonical ABI commit readback mismatch');
            return {commit,id:prepared.id};
        };
        try {return await materialize(reduction);} catch(error){
            if(!(error instanceof ProtocolAbiFrontierLimitError))throw error;
            // A bounded projection capacity limit grants no readiness, but must not poison history ingestion forever.
            return materialize({status:'incomplete',reset:true,bindings:[],updates:[],lastGlobalSequence:null,
                reason:{code:error.code,message:error.message}});
        }
    }

    private async certify(control:ProtocolAbiCoordinatorControl,epoch:number):Promise<void> {
        this.assertEpoch(epoch);
        const certificate=protocolAbiCertificateForControl(control);
        const certificateId=this.options.store.certificateId(certificate);
        if(this.certifiedId===certificateId)return;
        const certified=await this.options.store.prepareCertificate(certificate);
        if(json(await this.options.store.readCertificate(certified.id))!==json(certificate))
            throw new Error('Settled ABI certificate readback mismatch');
        this.assertEpoch(epoch);
        this.certifiedId=certificateId;
    }

    async drain():Promise<{committed:number;pending:number}> {
        const epoch=this.sourceEpoch;
        try {return await this.run(async()=>{
            let version=await this.owned(),committed=0;this.assertEpoch(epoch);
            while(version.value.source&&version.value.phase!=='recovering'&&version.value.pending.length&&committed<this.maximumPending){
                const selectedId=version.value.pending[0],selected=await this.selection(selectedId,version.value);this.assertEpoch(epoch);
                if(version.value.head&&(selected.source.blockNum!==version.value.head.blockNum+1||selected.source.previousBlockId!==version.value.head.blockId))
                    throw new Error('Admitted ABI source chain is not contiguous');
                let link:{observationId:string;observationDigest:string};
                try {link=await this.options.bindings.readObservationLink(selectedId);}
                catch(error){if(error instanceof ProtocolSourceBindingReadError&&error.code==='missing'&&error.recordType==='observation-link')break;throw error;}
                let reduction:Awaited<ReturnType<typeof reduceProtocolAbiBlock>>;
                try {
                    const record=await this.options.observations.read(link.observationId);
                    const context=await this.options.bindings.readContext(selected.contextId);
                    this.validateObservation(record,selected,context.schemaJson,link.observationId,link.observationDigest);
                    const accounts=new Map<string,Promise<ProtocolAbiAccountState|null>>();
                    reduction=await reduceProtocolAbiBlock(record,account=>{
                        let state=accounts.get(account);
                        if(!state){state=this.options.store.readAccount(version.value.head?.stateRootId??null,account) as Promise<ProtocolAbiAccountState|null>;accounts.set(account,state);}
                        return state;
                    },version.value.head?.lastGlobalSequence??null,this.options.verifyNativeGenesis);
                } catch(error){
                    if(!dataUnavailable(error))throw error;
                    reduction={status:'incomplete',reset:true,bindings:[],updates:[],lastGlobalSequence:null,
                        reason:{code:'retained_input_unavailable',message:String((error as Error).message).slice(0,4096).toWellFormed()}};
                }
                this.assertEpoch(epoch);
                const {commit,id:preparedId}=await this.prepareBlock(version.value,selectedId,selected,link,reduction);
                this.assertEpoch(epoch);
                version=await this.save(version,{...version.value,head:this.head(commit,preparedId),pending:version.value.pending.slice(1),
                    phase:commit.status==='complete'?'following':'incomplete',gap:commit.reason??version.value.gap,replayFromBlock:null});
                this.assertEpoch(epoch);
                // Prepared commits and primary-visible control are not consumer authority.
                // Certify only after the complete CAS receipt and settled source-epoch check.
                await this.certify(version.value,epoch);committed++;
            }
            // A failed certificate PREPARE may follow a successful settled head CAS.
            // Retry it even without a new block; owned() has re-established durable ownership.
            if(!committed&&version.value.head&&version.value.source&&version.value.replayFromBlock===null
                &&['following','incomplete'].includes(version.value.phase))await this.certify(version.value,epoch);
            return {committed,pending:version.value.pending.length};
        });} catch(error){if(error instanceof ProtocolAbiCoordinatorStaleError)return {committed:0,pending:this.known?.value.pending.length??0};throw error;}
    }
    async inspect():Promise<ProtocolAbiCoordinatorControl> {return this.run(async()=>copy((await this.owned()).value));}
}
