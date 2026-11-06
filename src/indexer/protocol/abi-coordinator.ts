import {createHash, randomUUID} from 'node:crypto';
import {ProtocolAbiObservationStore, protocolAbiObservationId, type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {ProtocolSourceBindingStore, ProtocolSourceBindingReadError, protocolSourceContextId,
    type ProtocolSourceProfile, type ProtocolSourceSelection, type ProtocolSourcePosition} from './source-bindings.js';
import {ImmutableProtocolBundleReadError, protocolImmutableJson} from './immutable-bundle-store.js';
import {ProtocolAbiFrontierStore, ProtocolAbiFrontierConflictError, ProtocolAbiFrontierReadError, ProtocolAbiFrontierLimitError,
    type ProtocolAbiHistoricalRootPreparation} from './abi-frontier-store.js';
import {reduceProtocolAbiBlock, type ProtocolAbiAccountState, type ProtocolAbiBlockReduction} from './abi-reducer.js';
import {protocolAbiCertificateForControl} from './abi-proof.js';
import {validNativeGenesisCoverage, type ProtocolNativeGenesisCoverage, type ProtocolNativeGenesisVerifier} from './native-genesis.js';
import {resolveProtocolAbiHistory, historicalAddressIdentity, historicalAddressId, historicalRootCertificate,
    type ProtocolAbiHistoryOptions, type ProtocolAbiHistoricalAddress} from './abi-history.js';
import {isProtocolHex} from './hex.js';

type Head = {blockNum:number;blockId:string;commitId:string;stateRootId:string|null;
    lastGlobalSequence:string|null;coverageStart:number|null};
type Gap = {code:string;message:string;fromBlock:number|null};
export interface ProtocolAbiCoordinatorControl {
    schemaVersion:1; chainId:string; profile:ProtocolSourceProfile; ownerId:string; generation:string; revision:number;
    source:{contextId:string;readerSessionId:string}|null; head:Head|null; pending:string[];
    phase:'awaiting-source'|'recovering'|'following'|'incomplete'; gap:Gap|null; replayFromBlock:number|null;
    historical?:{interfaceVersion:1;addressRootId:string;activationCertificateId:string;anchor:Head};
}
interface Commit {
    schemaVersion:1; kind:'canonical-abi-block'|'disk-abi-baseline'; chainId:string; profile:ProtocolSourceProfile; generation:string;
    previousCommitId:string|null; selectionId:string|null; observationId:string|null; observationDigest:string|null;
    source:ProtocolSourcePosition; status:'complete'|'incomplete'; reason:Gap|null;
    stateRootId:string|null; lastGlobalSequence:string|null; coverageStart:number|null;
    nativeGenesis?:ProtocolNativeGenesisCoverage;
    nativeActionInterfaceVersion?:1;
    catalogId?:string;
    bindings:Array<{transactionId:string;actionOrdinal:number;inputActionOrdinal:number;receiver:string;account:string;
        name:string;globalSequence:string;receiptAbiSequence:string;rawSha256:string;stateId:string|null}>;
}
interface Version {value:ProtocolAbiCoordinatorControl;seqNo:number;primaryTerm:number}
export interface ProtocolAbiDiskBaseline {
    catalogId:string;source:ProtocolSourcePosition;coverageStart:1;lastGlobalSequence:string|null;
    profile:ProtocolSourceProfile;states:readonly ProtocolAbiAccountState[];
}
/** A validated immutable catalog, not a caller-supplied replacement for live source selection. */
export interface ProtocolAbiDiskHistory {
    baseline():Promise<ProtocolAbiDiskBaseline>;
    revalidate():Promise<void>;
    matchesState(state:ProtocolAbiAccountState):boolean;
    blockId(blockNum:number):string|null|undefined|Promise<string|null|undefined>;
}
type HistoricalCertificate=ReturnType<typeof protocolAbiCertificateForControl>;
interface HistoricalActivation {
    anchor:ProtocolAbiCoordinatorControl;epoch:number;baseRoot:string|null;
    entries:Array<[string,ProtocolAbiHistoricalAddress]>;nextAddress:number;certificate?:HistoricalCertificate;
    preparation?:ProtocolAbiHistoricalRootPreparation;root?:string;
    published?:ProtocolAbiCoordinatorControl;activation?:ReturnType<typeof historicalRootCertificate>;certified?:boolean;verified?:boolean;
}
export interface ProtocolAbiCoordinatorOptions {
    chainId:string; profile:ProtocolSourceProfile; ownerId:string; bindings:ProtocolSourceBindingStore;
    observations:ProtocolAbiObservationStore; store:ProtocolAbiFrontierStore;
    maxPendingBlocks?:number; recoveryWindowBlocks?:number;
    /** Explicit new qualification namespace request boundary, never canonical proof. */
    qualificationGenesisStart?:true;
    verifyNativeGenesis?:ProtocolNativeGenesisVerifier;
    /** Native-aware epochs keep this requirement in immutable canonical commits, including failed extraction. */
    nativeActionInterfaceVersion?:1;
    historicalCertificates?:ProtocolAbiHistoryOptions;
    onHistoricalError?:(error:unknown)=>void;
    diskAbiHistory?:ProtocolAbiDiskHistory;
}
export class ProtocolAbiCoordinatorStaleError extends Error {
    constructor(message='Protocol ABI source was superseded'){super(message);this.name='ProtocolAbiCoordinatorStaleError';}
}
class InvalidPreparedObservation extends Error {}
class HistoricalWorkYield extends Error {}
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
    private readonly historicalCertificates?:ProtocolAbiHistoryOptions;
    private historicalWalk?:{ownerId:string;generation:string;anchor:Head;nextCommitId:string|null;child:Commit|null;floor?:Head;
        work?:{commitId:string;commit?:Commit;certificate?:HistoricalCertificate;preparedId?:string;verified?:boolean}};
    /** Scheduling progress only. Membership is always read from the current activated immutable root. */
    private historicalCompleted?:{ownerId:string;generation:string;head:Head};
    private historicalActivation?:HistoricalActivation;
    private historicalError?:string;
    private queuedAdmissions=0;
    private historicalAuthorityId?:string;
    private historicalPublishedHead?:string;
    private historicalQueueGeneration?:string;
    private readonly historicalQueue=new Map<string,ProtocolAbiHistoricalAddress>();
    /** Process-local evidence of successful live-source CAS admissions, never a restart cursor. */
    private readonly recentSelections=new Map<string,{source:ProtocolSourcePosition;generation:string;readerSessionId:string}>();
    private diskBaseline?:Promise<{value:ProtocolAbiDiskBaseline;stateRootId:string|null}>;

    constructor(private readonly options:ProtocolAbiCoordinatorOptions) {
        if(!hex64.test(options.chainId)||!text(options.ownerId))throw new Error('Invalid ABI coordinator identity');
        if(options.qualificationGenesisStart===true&&typeof options.verifyNativeGenesis!=='function')
            throw new Error('Qualification genesis requires native genesis verification');
        if(options.nativeActionInterfaceVersion!==undefined&&options.nativeActionInterfaceVersion!==1)
            throw new Error('Unsupported native action interface marker');
        protocolSourceContextId({schemaVersion:1,chainId:options.chainId,protocol:options.profile,schemaJson:'{}'});
        this.profile=copy(options.profile);
        this.profile.components=[...this.profile.components].sort((a,b)=>(a.runtime+':'+a.id)<(b.runtime+':'+b.id)?-1:1);
        this.maximumPending=options.maxPendingBlocks??128;this.recoveryWindow=options.recoveryWindowBlocks??256;
        this.historicalCertificates=resolveProtocolAbiHistory(options.historicalCertificates);
        if(!Number.isSafeInteger(this.maximumPending)||this.maximumPending<1||this.maximumPending>4096
            ||!Number.isSafeInteger(this.recoveryWindow)||this.recoveryWindow<1||this.recoveryWindow>4096)
            throw new Error('Invalid bounded ABI coordinator configuration');
    }

    private run<T>(action:()=>Promise<T>):Promise<T> {
        const result=this.serial.then(action);this.serial=result.then(()=>undefined,()=>undefined);return result;
    }
    private sameProfile(value:ProtocolSourceProfile):boolean {return json(value)===json(this.profile);}
    private async preparedDiskBaseline():Promise<{value:ProtocolAbiDiskBaseline;stateRootId:string|null}|undefined> {
        const catalog=this.options.diskAbiHistory;if(!catalog)return undefined;
        this.diskBaseline??=(async()=>{
            await catalog.revalidate();const value=copy(await catalog.baseline());
            if(!id('h45abihistory1',value.catalogId)||value.coverageStart!==1||!this.sameProfile(value.profile)
                ||value.source?.chainId!==this.options.chainId||!uint32(value.source.blockNum)||value.source.blockNum<1
                ||!hex64.test(value.source.blockId)||(value.source.previousBlockId!==null&&!hex64.test(value.source.previousBlockId))
                ||value.source.blockNum===1&&value.source.previousBlockId!==null
                ||value.source.blockNum>1&&!hex64.test(value.source.previousBlockId??'')
                ||value.lastGlobalSequence!==null&&(!/^[1-9][0-9]{0,19}$/.test(value.lastGlobalSequence)
                    ||BigInt(value.lastGlobalSequence)>0xffffffffffffffffn)
                ||!Array.isArray(value.states)||value.states.length>10000)
                throw new InvalidPreparedObservation('Invalid disk ABI baseline');
            if(await catalog.blockId(value.source.blockNum)!==value.source.blockId
                ||value.source.blockNum>1&&await catalog.blockId(value.source.blockNum-1)!==value.source.previousBlockId)
                throw new InvalidPreparedObservation('Disk ABI baseline block identity differs from catalog');
            const seen=new Set<string>();
            for(const state of value.states){
                if(!state||!text(state.account)||seen.has(state.account)||!this.sameProfile(state.protocol)
                    ||typeof state.present!=='boolean'||typeof state.abiHex!=='string'||!isProtocolHex(state.abiHex)
                    ||state.source?.catalogId!==value.catalogId||state.source.chainId!==this.options.chainId
                    ||!uint32(state.source.blockNum)||state.source.blockNum<1||state.source.blockNum>value.source.blockNum
                    ||!id('h45abidisk1',state.source.observationId)||!hex64.test(state.source.inputSha256)
                    ||!catalog.matchesState(state)||await catalog.blockId(state.source.blockNum)!==state.source.blockId)
                    throw new InvalidPreparedObservation('Disk ABI baseline contains an unvalidated account state');
                seen.add(state.account);
            }
            await catalog.revalidate();
            const stateRootId=await this.options.store.prepareState(null,value.states.map(state=>({account:state.account,state})),false,
                ()=>catalog.revalidate());
            await catalog.revalidate();return {value,stateRootId};
        })();
        return this.diskBaseline;
    }
    private assertEpoch(epoch:number):void {if(epoch!==this.sourceEpoch){this.historicalCompleted=undefined;throw new ProtocolAbiCoordinatorStaleError();}}
    private rememberSelection(id:string,source:ProtocolSourcePosition,generation:string,readerSessionId:string):void {
        this.recentSelections.delete(id);
        this.recentSelections.set(id,{source:copy(source),generation,readerSessionId});
        while(this.recentSelections.size>this.recoveryWindow)this.recentSelections.delete(this.recentSelections.keys().next().value!);
    }
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
        if(value.historical!==undefined&&(!value.historical||Object.keys(value.historical).sort().join(',')!=='activationCertificateId,addressRootId,anchor,interfaceVersion'
            ||value.historical.interfaceVersion!==1||!id('h45abiroot1',value.historical.addressRootId)
            ||!id('h45abicert1',value.historical.activationCertificateId)))
            throw new Error('Invalid activated historical ABI address root');
        if(value.historical) {
            this.validateHead(value.historical.anchor);
            if(!value.head||value.historical.anchor.coverageStart!==1||value.historical.anchor.blockNum>value.head.blockNum
                ||value.historical.anchor.blockNum===value.head.blockNum&&json(value.historical.anchor)!==json(value.head))
                throw new Error('Historical activation anchor differs from current canonical head');
        }
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
        if(next.generation!==version.value.generation) {const {historical:_oldAuthority,...fresh}=next;next=fresh;this.historicalCompleted=undefined;}
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
            this.fenced=true;this.historicalCompleted=undefined;throw new ProtocolAbiCoordinatorStaleError('ABI coordinator owner was superseded');
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
        const disk=await this.preparedDiskBaseline();
        if(this.options.qualificationGenesisStart&&previous&&!this.sameProfile(previous.profile))
            throw new Error('Qualification genesis cannot adopt a different ABI profile');
        let head=previous&&this.sameProfile(previous.profile)?previous.head:null;
        let retainedCommit:Commit|undefined;
        let replayFromBlock=previous&&this.sameProfile(previous.profile)?previous.replayFromBlock
            :this.options.qualificationGenesisStart?1:null;
        let reason=previous?.gap??null;
        if(previous&&!this.sameProfile(previous.profile))reason=gap('protocol_profile_changed','ABI knowledge requires initialization under the installed profile',null);
        if(head){
            try {const commit=await this.readCommit(head.commitId);if(json(this.head(commit,head.commitId))!==json(head))throw new InvalidPreparedObservation('Stored head does not match its immutable commit');retainedCommit=commit;}
            catch(error){if(!dataUnavailable(error))throw error;head=null;replayFromBlock=previous!.head!.blockNum;
                reason=gap('retained_frontier_unavailable',String((error as Error).message),previous!.head!.blockNum);}
        }
        const generation=randomUUID();
        if(disk){
            const catalog=this.options.diskAbiHistory!,boundary=disk.value.source;
            const retained=head??(previous&&this.sameProfile(previous.profile)?previous.head:null);
            if(retained&&retained.blockNum<=boundary.blockNum&&await catalog.blockId(retained.blockNum)!==retained.blockId)
                throw new InvalidPreparedObservation('Disk ABI catalog conflicts with the retained canonical prefix');
            if(retained&&retained.blockNum>=boundary.blockNum&&(!head||retainedCommit?.catalogId!==disk.value.catalogId))
                throw new Error('Disk ABI activation cannot replace advanced progress without matching catalog ancestry; use a catalog cutoff ahead of the retained head');
            if(!head||head.blockNum<boundary.blockNum){
                const commit:Commit={schemaVersion:1,kind:'disk-abi-baseline',chainId:this.options.chainId,profile:this.profile,generation,
                    previousCommitId:null,selectionId:null,observationId:null,observationDigest:null,
                    source:disk.value.source,status:'complete',reason:null,stateRootId:disk.stateRootId,
                    lastGlobalSequence:disk.value.lastGlobalSequence,coverageStart:1,bindings:[],catalogId:disk.value.catalogId,
                    ...(this.options.nativeActionInterfaceVersion===1?{nativeActionInterfaceVersion:1 as const}:{})};
                const prepared=await this.options.store.prepareCommit(commit);
                if(json(await this.readCommit(prepared.id))!==json(commit))throw new Error('Disk ABI baseline readback differs');
                await catalog.revalidate();head=this.head(commit,prepared.id);reason=null;replayFromBlock=null;
            }
            await catalog.revalidate();
        }
        const value:ProtocolAbiCoordinatorControl={schemaVersion:1,chainId:this.options.chainId,profile:this.profile,ownerId:this.options.ownerId,
            generation,revision:(previous?.revision??-1)+1,source:null,head,pending:[],phase:'awaiting-source',gap:reason,replayFromBlock};
        const receipt=await this.options.store.compareAndSet(stored,value);
        this.known={...receipt,value:this.validateControl(receipt.value)};this.started=true;
    });}

    async openSource(contextId:string,readerSessionId:string):Promise<{generation:string;resumeFromBlock:number|null}> {
        if(!text(readerSessionId))throw new Error('Invalid source reader session');
        const settled=this.known?.value;
        this.recentSelections.clear();
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
        if(recognized){this.sourceEpoch++;this.activeSession=undefined;this.recentSelections.clear();}
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
        const epoch=this.sourceEpoch;this.queuedAdmissions++;
        try {return await this.run(async()=>{
            let version=await this.owned();this.assertEpoch(epoch);
            if(generation!==version.value.generation||!version.value.source)return {status:'stale',generation:version.value.generation};
            const selection=await this.selection(selectedId,version.value);this.assertEpoch(epoch);
            if(version.value.pending.includes(selectedId)){
                this.rememberSelection(selectedId,selection.source,generation,selection.readerSessionId);
                return {status:'accepted',generation};
            }
            const source=selection.source;
            const disk=await this.preparedDiskBaseline();this.assertEpoch(epoch);
            if(disk){
                await this.options.diskAbiHistory!.revalidate();this.assertEpoch(epoch);
                if(source.blockNum<=disk.value.source.blockNum)return {status:'stale',generation};
                if(source.blockNum===disk.value.source.blockNum+1&&source.previousBlockId!==disk.value.source.blockId)
                    throw new Error('Live source forks below the irreversible disk ABI boundary');
            }
            if(version.value.head?.blockNum===source.blockNum&&version.value.head.blockId===source.blockId){
                const committed=await this.readCommit(version.value.head.commitId);
                if(committed.kind!=='canonical-abi-block'||committed.selectionId===null)
                    throw new Error('Disk ABI baseline is not an ordinary live source selection');
                const original=(await this.options.bindings.readSelection(committed.selectionId)).selection;
                this.assertEpoch(epoch);
                // A new SHIP head/LIB envelope may replay the same raw source. Different traces,
                // deltas, ABI context or parent must never inherit the committed head's authority.
                if(json(committed.source)!==json(source)||json(original.source)!==json(source)
                    ||original.captureSha256!==selection.captureSha256)return {status:'stale',generation};
                this.rememberSelection(selectedId,source,generation,selection.readerSessionId);
                return {status:'accepted',generation};
            }
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
                    replayFromBlock:Math.min(before.replayFromBlock??source.blockNum,source.blockNum)});this.recentSelections.clear();this.assertEpoch(epoch);
                const recovered=await this.recoverParent(before,source);this.assertEpoch(epoch);
                version=await this.save(version,{...version.value,head:recovered.head,pending:[...recovered.pending,selectedId],phase:'following',gap:recovered.gap,
                    replayFromBlock:recovered.head?null:version.value.replayFromBlock});
            }
            this.assertEpoch(epoch);
            this.rememberSelection(selectedId,source,version.value.generation,selection.readerSessionId);
            return {status:'accepted',generation:version.value.generation};
        });} catch(error){if(error instanceof ProtocolAbiCoordinatorStaleError)return {status:'stale',generation:this.known?.value.generation??generation};throw error;}
        finally {this.queuedAdmissions--;}
    }
    /** Synchronous local revocation only. Source membership and canonical input still require their own checks. */
    retainSourceFence(readerSessionId:string,generation:string):()=>boolean {
        const epoch=this.sourceEpoch;
        return ()=>{
            const control=this.known?.value;
            return text(readerSessionId)&&text(generation)&&this.started&&!this.fenced&&!this.openingSession
                &&epoch===this.sourceEpoch&&this.activeSession===readerSessionId&&!!control
                &&control.source?.readerSessionId===readerSessionId&&control.generation===generation;
        };
    }
    /** A recent selection must still belong to this physical live session and its settled control generation. */
    async currentlyAdmittedSource(selectionId:string,source:ProtocolSourcePosition,readerSessionId:string,generation:string):Promise<boolean> {
        if(!id('h45srcsel1',selectionId)||!text(readerSessionId)||!text(generation))return false;
        // The control GET is outside the serial mutation lane. It can revoke a prior complete CAS receipt,
        // but cannot grant authority from a primary-visible write whose receipt was unknown.
        const observed=await this.options.store.readControl();
        return this.run(async()=>{
            const known=this.known,control=known?.value,admitted=this.recentSelections.get(selectionId);
            return !!observed&&!!known&&!!control&&this.started&&!this.fenced
                &&observed.seqNo===known.seqNo&&observed.primaryTerm===known.primaryTerm
                &&json(observed.value)===json(control)
                &&!!admitted&&this.activeSession===readerSessionId&&control.source?.readerSessionId===readerSessionId
                &&control.generation===generation&&['following','incomplete'].includes(control.phase)
                &&admitted.generation===generation&&admitted.readerSessionId===readerSessionId
                &&json(admitted.source)===json(source);
        });
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
            try {const commit=await this.readCommit(head.commitId);
                if(commit.kind==='disk-abi-baseline')throw new Error('Fork recovery cannot rewind below the irreversible disk ABI boundary');
                head=commit.previousCommitId?this.head(await this.readCommit(commit.previousCommitId),commit.previousCommitId):null;}
            catch(error){if(!dataUnavailable(error))throw error;break;}
        }
        return {head:null,pending:[],gap:gap('source_ancestry_unavailable','Replacement parent is outside retained verified recovery coverage; ABI knowledge restarts UNKNOWN',source.blockNum)};
    }

    private head(commit:Commit,commitId:string):Head {return {blockNum:commit.source.blockNum,blockId:commit.source.blockId,commitId,
        stateRootId:commit.stateRootId,lastGlobalSequence:commit.lastGlobalSequence,coverageStart:commit.coverageStart};}
    private async readCommit(commitId:string):Promise<Commit> {
        const value=await this.options.store.readCommit(commitId) as Commit;
        if(value?.kind==='disk-abi-baseline'){
            if(!this.options.diskAbiHistory)throw new Error('Retained ABI progress requires its configured disk ABI catalog');
            const disk=await this.preparedDiskBaseline();
            if(!disk||value.schemaVersion!==1||value.chainId!==this.options.chainId||!this.sameProfile(value.profile)
                ||!text(value.generation)||value.previousCommitId!==null||value.selectionId!==null||value.observationId!==null
                ||value.observationDigest!==null||value.catalogId!==disk.value.catalogId||json(value.source)!==json(disk.value.source)
                ||value.status!=='complete'||value.reason!==null||value.stateRootId!==disk.stateRootId
                ||value.coverageStart!==1||value.lastGlobalSequence!==disk.value.lastGlobalSequence
                ||!Array.isArray(value.bindings)||value.bindings.length!==0||value.nativeGenesis!==undefined
                ||value.nativeActionInterfaceVersion!==undefined&&value.nativeActionInterfaceVersion!==1)
                throw new InvalidPreparedObservation('Invalid immutable disk ABI baseline');
            await this.options.diskAbiHistory!.revalidate();this.validateHead(this.head(value,commitId));return value;
        }
        if(value?.catalogId!==undefined){
            if(!this.options.diskAbiHistory)throw new Error('Retained ABI progress requires its configured disk ABI catalog');
            const disk=await this.preparedDiskBaseline();
            if(value.catalogId!==disk!.value.catalogId||value.source?.blockNum<=disk!.value.source.blockNum)
                throw new Error('Retained ABI progress belongs to a different disk ABI catalog');
            await this.options.diskAbiHistory.revalidate();
        }
        if(!value||value.schemaVersion!==1||value.kind!=='canonical-abi-block'||value.chainId!==this.options.chainId||!this.sameProfile(value.profile)
            ||!text(value.generation)||!id('h45srcsel1',value.selectionId)||!value.source||value.source.chainId!==this.options.chainId
            ||!uint32(value.source.blockNum)||value.source.blockNum<1||!hex64.test(value.source.blockId)
            ||(value.source.previousBlockId!==null&&!hex64.test(value.source.previousBlockId))
            ||(value.previousCommitId!==null&&!id('h45abicmt1',value.previousCommitId))
            ||!['complete','incomplete'].includes(value.status)||!Array.isArray(value.bindings)
            ||(value.nativeActionInterfaceVersion!==undefined&&value.nativeActionInterfaceVersion!==1)
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
                ...(this.options.diskAbiHistory?{catalogId:(await this.preparedDiskBaseline())!.value.catalogId}:{}),
                ...(this.options.nativeActionInterfaceVersion===1?{nativeActionInterfaceVersion:1 as const}:{}),
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
        if(this.certifiedId!==certificateId) {
            const certified=await this.options.store.prepareCertificate(certificate);
            if(json(await this.options.store.readCertificate(certified.id))!==json(certificate))
                throw new Error('Settled ABI certificate readback mismatch');
            this.assertEpoch(epoch);this.certifiedId=certificateId;
        }
        // Queue only after the ordinary settled certificate. All locator/map I/O is lower priority.
        // During catch-up reserve the bounded queue for the in-progress verified walk.
        // Newer heads are recovered by the next walk; dropping a locator grants no membership.
        const walking=this.historicalCertificates?.allowPendingWork&&this.historicalWalk?.nextCommitId
            &&this.historicalWalk.ownerId===control.ownerId&&this.historicalWalk.generation===control.generation;
        const disk=this.options.diskAbiHistory&&await this.preparedDiskBaseline();this.assertEpoch(epoch);
        const covered=disk&&control.head&&control.head.blockNum<=disk.value.source.blockNum;
        if(this.historicalCertificates&&!covered&&!walking&&this.historicalPublishedHead!==certificateId
            &&control.phase==='following'&&control.gap===null&&control.head?.coverageStart===1)
            if(!this.queueHistorical(certificate)&&!this.historicalCertificates.allowPendingWork)this.historicalWalk=undefined;
        if(this.historicalCertificates&&control.historical&&!this.historicalActivation?.published)try {await this.certifyHistoricalRoot(control,epoch);}
        catch(error) {if(error instanceof ProtocolAbiCoordinatorStaleError)throw error;if(!(error instanceof HistoricalWorkYield))this.noteHistoricalError(error);}
    }
    private queueHistorical(certificate:ReturnType<typeof protocolAbiCertificateForControl>):boolean {
        const generation=json([certificate.ownerId,certificate.generation]);
        if(this.historicalQueueGeneration!==generation) {
            this.historicalQueue.clear();this.historicalQueueGeneration=generation;this.historicalAuthorityId=undefined;this.historicalPublishedHead=undefined;
            this.historicalActivation=undefined;
        }
        const identity=historicalAddressIdentity(certificate),key=historicalAddressId(identity);
        if(this.historicalQueue.has(key))return true;
        const address:ProtocolAbiHistoricalAddress={schemaVersion:1,kind:'historical-abi-certificate-address',identity,
            certificateId:this.options.store.certificateId(certificate)};
        const budget=this.historicalCertificates!;
        if(this.historicalQueue.size>=budget.maxCommitsPerDrain
            ||Buffer.byteLength(json([...this.historicalQueue.values(),address]))>budget.maxCommitBytesPerDrain)
            return false; // A live locator can be recovered by the verified backward walk.
        this.historicalQueue.set(key,address);
        return true;
    }
    private async certifyHistoricalRoot(control:ProtocolAbiCoordinatorControl,epoch:number):Promise<void> {
        if(!control.historical)return;
        const value=historicalRootCertificate(protocolAbiCertificateForControl({...control,head:control.historical.anchor}),control.historical.addressRootId);
        const expected=this.options.store.certificateId(value);
        if(expected!==control.historical.activationCertificateId)throw new Error('Historical activation certificate identity differs');
        if(this.historicalAuthorityId===expected)return;
        await this.assertHistoricalAuthority(control,epoch,control.historical.addressRootId,control.historical.activationCertificateId);
        const prepared=await this.options.store.prepareCertificate(value);
        await this.assertHistoricalAuthority(control,epoch,control.historical.addressRootId,control.historical.activationCertificateId);
        if(json(await this.options.store.readCertificate(prepared.id))!==json(value))throw new Error('Historical root certificate readback differs');
        await this.assertHistoricalAuthority(control,epoch,control.historical.addressRootId,control.historical.activationCertificateId);
        this.historicalAuthorityId=expected;
    }
    private async activateHistorical(control:ProtocolAbiCoordinatorControl,epoch:number,deadline:number):Promise<void> {
        if(!this.historicalQueue.size||performance.now()>=deadline)return;
        let work=this.historicalActivation;
        if(work&&(work.epoch!==epoch||work.anchor.ownerId!==control.ownerId||work.anchor.generation!==control.generation
            ||json(work.anchor.source)!==json(control.source)
            ||(work.published?.historical?.addressRootId??work.baseRoot)!==(control.historical?.addressRootId??null)))
            this.historicalActivation=work=undefined;
        // This fresh entry check also guards the first step: only synchronous scope setup intervenes.
        // Bind it to the retained operation's anchor/root, including rewinds below an older anchor.
        let entryAuthority:Version|undefined=await this.historicalAuthorityVersion(work?.anchor??control,epoch,
            work?(work.published?.historical?.addressRootId??work.baseRoot):undefined,work?.published?.historical?.activationCertificateId);
        const current=entryAuthority.value;
        if(current.pending.length&&!this.historicalCertificates!.allowPendingWork)return;
        const generation=json([current.ownerId,current.generation]);
        if(generation!==this.historicalQueueGeneration)return;
        if(!work) {
            work={anchor:copy(current),epoch,baseRoot:current.historical?.addressRootId??null,
                entries:copy([...this.historicalQueue.entries()]),nextAddress:0};
            this.historicalActivation=work;
        }
        const operation=work;
        const authority=async()=>{
            entryAuthority=undefined;
            const selected=operation.published?.historical;
            const version=await this.historicalAuthorityVersion(operation.anchor,epoch,selected?.addressRootId??operation.baseRoot,
                selected?.activationCertificateId);
            const value=version.value;
            if(json(value.source)!==json(operation.anchor.source))throw new ProtocolAbiCoordinatorStaleError('Historical source context changed');
            if(value.pending.length&&!this.historicalCertificates!.allowPendingWork)throw new HistoricalWorkYield();
            return version;
        };
        const checkpoint=async()=>{
            const live=()=>this.queuedAdmissions>0&&!this.historicalCertificates!.allowPendingWork;
            this.assertEpoch(epoch);
            if(live()||performance.now()>=deadline)throw new HistoricalWorkYield();
            const version=entryAuthority??await authority();entryAuthority=undefined;
            this.assertEpoch(epoch);
            if(live()||performance.now()>=deadline)throw new HistoricalWorkYield();return version;
        };
        try {
            while(work.nextAddress<work.entries.length) {
                const [,address]=work.entries[work.nextAddress];
                if(!work.certificate) {
                    await checkpoint();work.certificate=await this.options.store.readCertificate(address.certificateId) as HistoricalCertificate;
                    await authority();
                }
                await checkpoint();await this.options.store.prepareHistoricalCertificateAddress(work.certificate);
                work.nextAddress++;work.certificate=undefined;await authority();
            }
            if(!work.root) {
                const addresses=work.entries.map(([,value])=>value);
                work.preparation??=this.options.store.beginHistoricalAddressRoot(work.baseRoot,addresses);
                work.root=await this.options.store.prepareHistoricalAddressRoot(work.baseRoot,addresses,async()=>{await checkpoint();},work.preparation);
                await authority();
            }
            if(!work.published) {
                const observed=await checkpoint();
                work.activation=historicalRootCertificate(protocolAbiCertificateForControl(observed.value),work.root);
                const activationCertificateId=this.options.store.certificateId(work.activation);
                const settled=await this.save(observed,{...observed.value,historical:{interfaceVersion:1,addressRootId:work.root,
                    activationCertificateId,anchor:copy(observed.value.head!)}});
                work.published=settled.value;await authority();
            }
            if(!work.certified) {
                await checkpoint();await this.options.store.prepareCertificate(work.activation!);work.certified=true;await authority();
            }
            if(!work.verified) {
                await checkpoint();
                if(json(await this.options.store.readCertificate(work.published.historical!.activationCertificateId))!==json(work.activation))
                    throw new Error('Historical root certificate readback differs');
                work.verified=true;await authority();
            }
            await checkpoint();
            this.historicalAuthorityId=work.published.historical!.activationCertificateId;
            for(const [key,value] of work.entries) {
                if(json(this.historicalQueue.get(key))===json(value))this.historicalQueue.delete(key);
                if(value.identity.blockNum===work.published.head?.blockNum)this.historicalPublishedHead=value.certificateId;
            }
            this.historicalActivation=undefined;
        } catch(error) {
            // Only scheduling/live preemption may retain completed process-local work. Unknown/partial
            // writes, missing artifacts and authority loss require a fresh owned operation, never GET adoption.
            if(!(error instanceof HistoricalWorkYield))this.historicalActivation=undefined;
            throw error;
        }
    }
    private noteHistoricalError(error:unknown):void {
        const message=String(error).slice(0,4096).toWellFormed();
        if(message!==this.historicalError) {this.historicalError=message;try {this.options.onHistoricalError?.(error);}catch {}}
    }

    private async assertHistoricalAuthority(anchor:ProtocolAbiCoordinatorControl,epoch:number,expectedRoot?:string|null,activationCertificateId?:string):Promise<ProtocolAbiCoordinatorControl> {
        return (await this.historicalAuthorityVersion(anchor,epoch,expectedRoot,activationCertificateId)).value;
    }
    private async historicalAuthorityVersion(anchor:ProtocolAbiCoordinatorControl,epoch:number,expectedRoot?:string|null,activationCertificateId?:string):Promise<Version> {
        if(this.queuedAdmissions&&!this.historicalCertificates?.allowPendingWork)throw new HistoricalWorkYield();
        this.assertEpoch(epoch);const version=await this.owned(),current=version.value;this.assertEpoch(epoch);
        if(this.queuedAdmissions&&!this.historicalCertificates?.allowPendingWork)throw new HistoricalWorkYield();
        if(current.ownerId!==anchor.ownerId||current.generation!==anchor.generation||current.phase!=='following'||current.gap!==null
            ||json(current.source)!==json(anchor.source)
            ||current.replayFromBlock!==null||current.head?.coverageStart!==1||!anchor.head||current.head.blockNum<anchor.head.blockNum
            ||(current.head.blockNum===anchor.head.blockNum&&json(current.head)!==json(anchor.head))
            ||expectedRoot!==undefined&&(current.historical?.addressRootId??null)!==expectedRoot
            ||activationCertificateId!==undefined&&current.historical?.activationCertificateId!==activationCertificateId)
            throw new ProtocolAbiCoordinatorStaleError('Historical ABI source authority changed');
        return version;
    }
    /** Bounded low-priority re-certification; volatile progress is discarded after process/authority loss. */
    private async extendHistorical(control:ProtocolAbiCoordinatorControl,epoch:number):Promise<void> {
        const budget=this.historicalCertificates;
        if(this.historicalActivation&&(this.historicalActivation.epoch!==epoch
            ||this.historicalActivation.anchor.generation!==control.generation
            ||json(this.historicalActivation.anchor.source)!==json(control.source)))this.historicalActivation=undefined;
        if(!budget||control.pending.length&&!budget.allowPendingWork||control.phase!=='following'||control.gap!==null||control.replayFromBlock!==null
            ||control.head?.coverageStart!==1)return;
        const started=performance.now();let bytes=0;
        const deadline=started+budget.maxMillisecondsPerDrain;
        // Finish a fixed bounded publication before admitting more background work. Live input still
        // preempts every checkpoint; new queued addresses remain outside this operation's fixed scope.
        if(this.historicalActivation||this.historicalQueue.size>=budget.maxCommitsPerDrain) {
            await this.activateHistorical(control,epoch,deadline);
            const finished=this.historicalWalk;
            if(finished?.ownerId===control.ownerId&&finished.generation===control.generation)await this.completeHistoricalWalk(finished,{...control,head:finished.anchor},epoch);
            return;
        }
        let walk=this.historicalWalk;
        const completed=this.historicalCompleted;
        const sameCompleted=completed?.ownerId===control.ownerId&&completed.generation===control.generation?completed:undefined;
        if(!walk||walk.ownerId!==control.ownerId||walk.generation!==control.generation
            ||budget.allowPendingWork&&walk.nextCommitId===null&&sameCompleted?.head.commitId===walk.anchor.commitId
                &&control.head.blockNum>walk.anchor.blockNum) {
            walk={ownerId:control.ownerId,generation:control.generation,anchor:copy(control.head),nextCommitId:control.head.commitId,child:null,
                ...(budget.allowPendingWork&&sameCompleted?{floor:copy(sameCompleted.head)}:{})};
            this.historicalWalk=walk;
        }
        const anchor={...control,head:walk.anchor};
        const checkpoint=async()=>{
            if(performance.now()>=deadline)throw new HistoricalWorkYield();
            const current=await this.assertHistoricalAuthority(anchor,epoch);
            if(current.pending.length&&!budget.allowPendingWork||performance.now()>=deadline)throw new HistoricalWorkYield();return current;
        };
        for(let count=0;count<budget.maxCommitsPerDrain&&walk.nextCommitId;count++) {
            // Durable pending blocks permit background progress; a live RPC waiting on
            // this serial lane gets priority after one completed historical work unit.
            // Break so the existing bounded activation can preserve that partial work.
            if(budget.allowPendingWork&&count>0&&this.queuedAdmissions)break;
            const work=walk.work??={commitId:walk.nextCommitId};
            if(!work.commit) {await checkpoint();work.commit=await this.readCommit(work.commitId);await this.assertHistoricalAuthority(anchor,epoch);}
            const {commitId,commit}=work;
            const size=Buffer.byteLength(json(commit));
            if(bytes+size>budget.maxCommitBytesPerDrain) {
                if(!bytes)throw new ProtocolAbiFrontierLimitError('Historical ABI commit exceeds explicit byte budget');
                return;
            }
            bytes+=size;
            if(!walk.child) {
                if(json(this.head(commit,commitId))!==json(walk.anchor))throw new Error('Historical walk head differs from adopted canonical head');
            } else if(commit.source.blockNum+1!==walk.child.source.blockNum||commit.source.blockId!==walk.child.source.previousBlockId
                ||walk.child.previousCommitId!==commitId)throw new Error('Historical ABI ancestry is not complete and contiguous');
            if(commit.status!=='complete'||commit.coverageStart!==1)throw new Error('Historical ABI ancestry lacks complete genesis coverage');
            if(walk.floor&&commit.source.blockNum===walk.floor.blockNum){
                if(json(this.head(commit,commitId))!==json(walk.floor))throw new Error('Historical completed anchor differs from verified ancestry');
                walk.child=commit;walk.nextCommitId=null;walk.work=undefined;break;
            }
            if(commit.kind==='disk-abi-baseline'){
                // Covered prefix queries use the immutable catalog; the live address
                // walk stops at its validated boundary instead of inventing prefix commits.
                walk.child=commit;walk.nextCommitId=null;walk.work=undefined;break;
            }
            if(commit.source.blockNum===1&&(commit.previousCommitId!==null||commit.source.previousBlockId!==null))
                throw new Error('Historical ABI genesis linkage differs');
            if(commit.source.blockNum>1&&!commit.previousCommitId)throw new Error('Historical ABI ancestry ended before genesis');
            if(!work.preparedId) {
                const current=await checkpoint();work.certificate=protocolAbiCertificateForControl({...current,head:this.head(commit,commitId)});
                work.preparedId=(await this.options.store.prepareCertificate(work.certificate)).id;
                await this.assertHistoricalAuthority(anchor,epoch);
            }
            if(!work.verified) {
                await checkpoint();
                if(json(await this.options.store.readCertificate(work.preparedId))!==json(work.certificate))throw new Error('Historical certificate readback differs');
                work.verified=true;await this.assertHistoricalAuthority(anchor,epoch);
            }
            await checkpoint();
            if(!this.queueHistorical(work.certificate!)) {await this.activateHistorical(anchor,epoch,deadline);return;}
            this.historicalError=undefined;
            walk.child=commit;walk.nextCommitId=commit.previousCommitId;walk.work=undefined;
        }
        await this.activateHistorical(anchor,epoch,deadline);
        await this.completeHistoricalWalk(walk,anchor,epoch);
    }
    private async completeHistoricalWalk(walk:NonNullable<ProtocolAbiCoordinator['historicalWalk']>,anchor:ProtocolAbiCoordinatorControl,epoch:number):Promise<void> {
        if(!this.historicalCertificates?.allowPendingWork||walk.nextCommitId!==null||this.historicalQueue.size)return;
        await this.assertHistoricalAuthority(anchor,epoch);
        this.historicalCompleted={ownerId:walk.ownerId,generation:walk.generation,head:copy(walk.anchor)};
    }

    async drain():Promise<{committed:number;pending:number}> {
        const epoch=this.sourceEpoch;
        try {return await this.run(async()=>{
            let version=await this.owned(),committed=0;this.assertEpoch(epoch);
            if(this.options.diskAbiHistory){await this.options.diskAbiHistory.revalidate();this.assertEpoch(epoch);}
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
                    },version.value.head?.lastGlobalSequence??null,this.options.verifyNativeGenesis,
                    this.options.diskAbiHistory?state=>this.options.diskAbiHistory!.matchesState(state):undefined);
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
            try {await this.extendHistorical(version.value,epoch);}
            catch(error) {
                if(!(error instanceof HistoricalWorkYield)) {this.historicalActivation=undefined;this.historicalWalk=undefined;}
                if(error instanceof ProtocolAbiCoordinatorStaleError)throw error;
                if(!(error instanceof HistoricalWorkYield))this.noteHistoricalError(error);
            }
            return {committed,pending:version.value.pending.length};
        });} catch(error){if(error instanceof ProtocolAbiCoordinatorStaleError){
            this.historicalActivation=undefined;this.historicalWalk=undefined;
            return {committed:0,pending:this.known?.value.pending.length??0};
        }throw error;}
    }
    async inspect():Promise<ProtocolAbiCoordinatorControl> {return this.run(async()=>copy((await this.owned()).value));}
}
