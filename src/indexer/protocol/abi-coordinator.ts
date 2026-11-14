import {createHash, randomUUID} from 'node:crypto';
import {ProtocolAbiObservationStore, protocolAbiObservationId, type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {ProtocolSourceBindingStore, ProtocolSourceBindingReadError, protocolSourceContextId,
    type ProtocolSourceProfile, type ProtocolSourceSelection, type ProtocolSourcePosition} from './source-bindings.js';
import {ImmutableProtocolBundleReadError, protocolImmutableJson} from './immutable-bundle-store.js';
import {ProtocolAbiFrontierStore, ProtocolAbiFrontierConflictError, ProtocolAbiFrontierReadError, ProtocolAbiFrontierLimitError,
    type ProtocolAbiHistoricalRootPreparation, type ProtocolAbiStatePlan, type ProtocolAbiFrontierRecordInput} from './abi-frontier-store.js';
import {reduceProtocolAbiBlock, type ProtocolAbiAccountState, type ProtocolAbiBlockReduction} from './abi-reducer.js';
import {protocolAbiCertificateForControl} from './abi-proof.js';
import {validNativeGenesisCoverage, type ProtocolNativeGenesisCoverage, type ProtocolNativeGenesisVerifier} from './native-genesis.js';
import {resolveProtocolAbiHistory, historicalAddressIdentity, historicalAddressId, historicalRootCertificate,
    type ProtocolAbiHistoryOptions, type ProtocolAbiHistoricalAddress} from './abi-history.js';
import {isProtocolHex} from './hex.js';
import type {DiskAbiHistoryLink, DiskAbiHistoryPendingSegment} from './disk-abi-history.js';

type Head = {blockNum:number;blockId:string;commitId:string;stateRootId:string|null;
    lastGlobalSequence:string|null;coverageStart:number|null};
type Gap = {code:string;message:string;fromBlock:number|null};
export interface ProtocolAbiCoordinatorControl {
    schemaVersion:1; chainId:string; profile:ProtocolSourceProfile; ownerId:string; generation:string; revision:number;
    source:{contextId:string;readerSessionId:string}|null; head:Head|null; pending:string[];
    phase:'awaiting-source'|'recovering'|'following'|'incomplete'; gap:Gap|null; replayFromBlock:number|null;
    historical?:{interfaceVersion:1;addressRootId:string;activationCertificateId:string;anchor:Head};
    /** The newest catalog segment this owner checked against its own commits and adopted. Readers follow it. */
    catalog?:DiskAbiHistoryLink;
    /** Block and action documents through this block are disk-backed: settled from the published catalog. */
    settled?:number;
    /** The proof store generation written now (absent: 0, the original index names). */
    storeGeneration?:number;
    /** The generation this owner switched away from, still read until it is dropped. */
    previousStore?:{generation:number;switchedAtBlock:number;switchedAt:number};
    /** The catalog link end the current chain's disk baseline sits at (absent: the pinned catalog's end). */
    anchor?:number;
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
    /** Sealed segments past the covered end. Each is adopted only after it agrees with this owner's commits. */
    nextSegment?():Promise<DiskAbiHistoryPendingSegment|undefined>;
    adopt?(segment:DiskAbiHistoryPendingSegment):Promise<unknown>;
    follow?(link:DiskAbiHistoryLink):Promise<boolean>;
    /** Adopted link ends, and the complete ABI state at one of them, to anchor a rotated chain there. */
    boundaries?():Promise<number[]>;
    baselineAt?(blockNum:number):Promise<ProtocolAbiDiskBaseline>;
}
type HistoricalCertificate=ReturnType<typeof protocolAbiCertificateForControl>;
interface HistoricalActivation {
    anchor:ProtocolAbiCoordinatorControl;epoch:number;baseRoot:string|null;
    entries:Array<[string,ProtocolAbiHistoricalAddress]>;nextAddress:number;certificates?:HistoricalCertificate[];
    preparation?:ProtocolAbiHistoricalRootPreparation;root?:string;
    published?:ProtocolAbiCoordinatorControl;activation?:ReturnType<typeof historicalRootCertificate>;certified?:boolean;verified?:boolean;
}
export interface ProtocolAbiCoordinatorOptions {
    chainId:string; profile:ProtocolSourceProfile; ownerId:string; bindings:ProtocolSourceBindingStore;
    observations:ProtocolAbiObservationStore; store:ProtocolAbiFrontierStore;
    /** Resolves prior account state while reducing a block. Nothing else may use it, because it can remember records. */
    accountReader?:ProtocolAbiFrontierStore;
    maxPendingBlocks?:number; recoveryWindowBlocks?:number;
    /** Explicit new qualification namespace request boundary, never canonical proof. */
    qualificationGenesisStart?:true;
    verifyNativeGenesis?:ProtocolNativeGenesisVerifier;
    /** Native-aware epochs keep this requirement in immutable canonical commits, including failed extraction. */
    nativeActionInterfaceVersion?:1;
    historicalCertificates?:ProtocolAbiHistoryOptions;
    onHistoricalError?:(error:unknown)=>void;
    /** Called after a settled head's certificates have complete receipts and readback. A scheduling hint only. */
    onSettled?:(head:{blockNum:number})=>void;
    diskAbiHistory?:ProtocolAbiDiskHistory;
    /** A segment that disagrees with this owner's commits is refused once and never adopted by this owner. */
    onCatalogRefused?:(refusal:{manifestSha256:string;startBlock:number;endBlock:number;message:string})=>void;
    /** A catalog check that failed for another reason than a disagreement (unreadable segment, store error); it is retried. */
    onCatalogError?:(error:unknown)=>void;
    /** Create the other proof store indices of a generation before control switches to it (native actions, for example). */
    provisionStoreGeneration?:(generation:number)=>Promise<void>;
    /** Catalog attestation is scheduled at most this often. */
    catalogAttestIntervalMs?:number;
}
/** A sealed segment and this owner's commits disagree: the segment is never adopted. */
class CatalogDisagreement extends Error {constructor(message:string){super(message);this.name='CatalogDisagreement';}}
export class ProtocolAbiCoordinatorStaleError extends Error {
    constructor(message='Protocol ABI source was superseded'){super(message);this.name='ProtocolAbiCoordinatorStaleError';}
}
class InvalidPreparedObservation extends Error {}
/** Retained progress names a disk ABI catalog other than the configured one. Both keep the
 * classification their reads had before, so ancestry walks treat them exactly as earlier. */
class SupersededDiskCatalog extends Error {}
class SupersededDiskBaseline extends InvalidPreparedObservation {}
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

type HistoricalWalk={ownerId:string;generation:string;anchor:Head;nextCommitId:string|null;child:Commit|null;floor?:Head;
    work?:{commitId:string;commit?:Commit};
    /** Verified ancestry whose certificates are prepared together; the cursor has already moved past them. */
    pending?:Array<{commitId:string;commit:Commit;certificate:HistoricalCertificate}>;
    flush?:{count:number;prepared?:Array<{id:string;digest:string;byteLength:number}>;verified?:boolean}};
/** A batch of consecutive admitted blocks, prepared outside the serial lane and published by one control CAS. */
interface PreparedBatch {
    generation:string;head:Head|null;
    blocks:Array<{selectedId:string;selection:ProtocolSourceSelection;commit:Commit;id:string}>;
    /** The gap of the control the batch was published over, recorded by its CAS. */
    baseGap?:Gap|null;
}
/** Soft bounds per batch, checked after each block, so one block alone always fits. Each batch is one ordered
 * PREPARE of every record (split into bounded bulk requests), one readback and one control CAS. */
const batchBlocks=64,batchCommitBytes=8*1024*1024,batchRecords=4096;

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
    private historicalWalk?:HistoricalWalk;
    /** Pending-work mode only: the segment above the walk's anchor, so fresh heads do not wait for old ancestry. */
    private historicalFresh?:HistoricalWalk;
    /** Highest head whose fresh segments are contiguous with the walk's anchor. Scheduling only, never authority. */
    private historicalFreshCovered?:Head;
    private historicalFreshTurn=false;
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
    private catalogAttestAt=0;
    private catalogAttesting?:Promise<void>;
    private readonly refusedSegments=new Set<string>();
    /** Immutable records by id, read while attesting: consecutive segments walk overlapping commits. */
    private readonly attestCommits=new Map<string,Commit>();
    private readonly attestRoots=new Map<string,Record<string,string>>();
    private readonly attestBuckets=new Map<string,Record<string,string>>();
    private readonly attestStates=new Map<string,ProtocolAbiAccountState>();
    /** This owner's chain above the adopted catalog end, by block number, for attestation only. */
    private readonly attestChain=new Map<number,string>();
    private readonly rotatedAnchors=new Map<number,{value:ProtocolAbiDiskBaseline;stateRootId:string|null}>();
    private rotating?:Promise<boolean>;

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
    /** Drains never overlap each other, but only their control steps occupy the serial lane. */
    private drains:Promise<unknown>=Promise.resolve();
    /** Chain head minus source height of the last committed selection: scheduling only, never authority. */
    private sourceLag=0;
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
        if(value.catalog!==undefined&&(!value.catalog||Object.keys(value.catalog).sort().join(',')!=='endBlock,lastBlockId,manifestSha256'
            ||!hex64.test(value.catalog.manifestSha256)||!uint32(value.catalog.endBlock)||value.catalog.endBlock<1||!hex64.test(value.catalog.lastBlockId)))
            throw new Error('Invalid adopted ABI catalog link');
        if(value.settled!==undefined&&(!uint32(value.settled)||value.settled<1||!value.catalog||value.settled>value.catalog.endBlock))
            throw new Error('Invalid settled catalog block');
        const generation=value.storeGeneration??0;
        if(value.storeGeneration!==undefined&&(!Number.isSafeInteger(value.storeGeneration)||value.storeGeneration<1||value.storeGeneration>1000000))
            throw new Error('Invalid proof store generation');
        if(value.previousStore!==undefined&&(!value.previousStore||Object.keys(value.previousStore).sort().join(',')!=='generation,switchedAt,switchedAtBlock'
            ||!Number.isSafeInteger(value.previousStore.generation)||value.previousStore.generation<0||value.previousStore.generation>=generation
            ||!uint32(value.previousStore.switchedAtBlock)||!Number.isSafeInteger(value.previousStore.switchedAt)||value.previousStore.switchedAt<0))
            throw new Error('Invalid previous proof store generation');
        if(value.anchor!==undefined&&(!uint32(value.anchor)||value.anchor<1||(value.head!==null&&value.anchor>value.head.blockNum)))
            throw new Error('Invalid rotated chain anchor');
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
        // Progress bound to an earlier catalog is replaced only by a configured catalog that ends strictly
        // ahead of it and agrees on its block identity (both checked below). The newer catalog then supplies
        // the complete ABI state at its own boundary, so none of the earlier commits is carried forward.
        if(head){
            try {const commit=await this.readCommit(head.commitId);if(json(this.head(commit,head.commitId))!==json(head))throw new InvalidPreparedObservation('Stored head does not match its immutable commit');retainedCommit=commit;}
            catch(error){
                if(error instanceof SupersededDiskCatalog||error instanceof SupersededDiskBaseline)head=null;
                else {
                    if(!dataUnavailable(error))throw error;head=null;replayFromBlock=previous!.head!.blockNum;
                    reason=gap('retained_frontier_unavailable',String((error as Error).message),previous!.head!.blockNum);
                }
            }
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
                if(json(await this.readCommit(prepared.id,prepared.digest))!==json(commit))throw new Error('Disk ABI baseline readback differs');
                await catalog.revalidate();head=this.head(commit,prepared.id);reason=null;replayFromBlock=null;
            }
            await catalog.revalidate();
        }
        // Coverage a previous owner checked and published is followed again from the segments directory before it is
        // published again. A link this catalog cannot reach (another pinned lineage, missing segments) is dropped.
        let catalog:DiskAbiHistoryLink|undefined;
        if(previous?.catalog&&this.options.diskAbiHistory?.follow){
            try {if(await this.options.diskAbiHistory.follow(previous.catalog))catalog=previous.catalog;}
            catch(error){this.noteHistoricalError(error);}
        }
        const value:ProtocolAbiCoordinatorControl={schemaVersion:1,chainId:this.options.chainId,profile:this.profile,ownerId:this.options.ownerId,
            generation,revision:(previous?.revision??-1)+1,source:null,head,pending:[],phase:'awaiting-source',gap:reason,replayFromBlock,
            ...(catalog?{catalog}:{}),...(catalog&&previous?.settled!==undefined&&previous.settled<=catalog.endBlock?{settled:previous.settled}:{}),
            ...(previous?.storeGeneration!==undefined?{storeGeneration:previous.storeGeneration}:{}),
            ...(previous?.previousStore!==undefined?{previousStore:previous.previousStore}:{}),
            ...(head&&previous?.anchor!==undefined&&previous.anchor<=head.blockNum?{anchor:previous.anchor}:{})};
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

    /** A selection the live chain already committed: only its context is checked again, not the live session. */
    private async replayedSelection(selectedId:string):Promise<ProtocolSourceSelection> {
        const {selection,context}=await this.options.bindings.readSelection(selectedId);
        if(context.chainId!==this.options.chainId||!this.sameProfile(context.protocol))throw new Error('Replayed selection does not match the installed protocol');
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
    private async readCommit(commitId:string,digest?:string):Promise<Commit> {
        return this.checkedCommit(await this.options.store.readCommit(commitId,undefined,digest) as Commit,commitId);
    }
    private async checkedCommit(value:Commit,commitId:string):Promise<Commit> {
        if(value?.kind==='disk-abi-baseline'){
            if(!this.options.diskAbiHistory)throw new Error('Retained ABI progress requires its configured disk ABI catalog');
            const pinned=await this.preparedDiskBaseline();
            const disk=pinned&&value.source?.blockNum!==pinned.value.source.blockNum?await this.rotatedAnchor(value.source?.blockNum):pinned;
            if(disk&&value.catalogId!==disk.value.catalogId)throw new SupersededDiskBaseline('Invalid immutable disk ABI baseline');
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
            if(value.catalogId!==disk!.value.catalogId)throw new SupersededDiskCatalog('Retained ABI progress belongs to a different disk ABI catalog');
            if(value.source?.blockNum<=disk!.value.source.blockNum)
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

    /** Plans one block's records into the batch: the same records and IDs the per-block PREPARE produced. */
    private async planBlock(plan:ProtocolAbiStatePlan,records:ProtocolAbiFrontierRecordInput[],control:ProtocolAbiCoordinatorControl,head:Head|null,
                            selectedId:string,selected:ProtocolSourceSelection,link:{observationId:string;observationDigest:string},
                            reduction:ProtocolAbiBlockReduction):Promise<{commit:Commit;id:string}> {
        const materialize=async(value:ProtocolAbiBlockReduction)=>{
            const stateRootId=await plan.apply(value.updates,value.reset);
            const bound:ProtocolAbiFrontierRecordInput[]=[],states=new Map<ProtocolAbiAccountState,string>(),bindings:Commit['bindings']=[];
            // Almost always already stored, yet each still takes a fresh write: a stored ID is not a receipt.
            for(const binding of value.bindings)if(binding.state&&!states.has(binding.state)){
                states.set(binding.state,this.options.store.recordId('account-state',binding.state));
                bound.push({kind:'account-state',value:binding.state,expected:'present'});
            }
            for(const binding of value.bindings){
                const {rawHex,state,...input}=binding;
                bindings.push({...input,rawSha256:digest(Buffer.from(rawHex,'hex')),stateId:state?states.get(state)!:null});
            }
            const complete=!value.reset,reason=value.status==='incomplete'?gap(value.reason.code,value.reason.message,selected.source.blockNum):null;
            const commit:Commit={schemaVersion:1,kind:'canonical-abi-block',chainId:this.options.chainId,profile:this.profile,generation:control.generation,
                previousCommitId:head?.commitId??null,selectionId:selectedId,observationId:link.observationId,observationDigest:link.observationDigest,
                source:selected.source,status:complete?'complete':'incomplete',reason,stateRootId,
                lastGlobalSequence:value.lastGlobalSequence,coverageStart:complete?(head?.coverageStart??selected.source.blockNum):null,bindings,
                ...(this.options.diskAbiHistory?{catalogId:(await this.preparedDiskBaseline())!.value.catalogId}:{}),
                ...(this.options.nativeActionInterfaceVersion===1?{nativeActionInterfaceVersion:1 as const}:{}),
                ...(value.status==='complete'&&value.nativeGenesis?{nativeGenesis:value.nativeGenesis}:{})};
            const id=this.options.store.recordId('commit',commit);
            records.push(...bound,{kind:'commit',value:commit});
            return {commit,id};
        };
        try {return await materialize(reduction);} catch(error){
            if(!(error instanceof ProtocolAbiFrontierLimitError))throw error;
            // A bounded projection capacity limit grants no readiness, but must not poison history ingestion forever.
            return materialize({status:'incomplete',reset:true,bindings:[],updates:[],lastGlobalSequence:null,
                reason:{code:error.code,message:error.message}});
        }
    }

    /**
     * Reads, reduces and prepares a run of admitted blocks without holding the serial lane, so admissions keep
     * landing meanwhile. Nothing here is published: the records are immutable and unreferenced until
     * `settleBatch` checks, on the lane, that the control it was planned from is still current.
     */
    private async prepareBatch(control:ProtocolAbiCoordinatorControl,epoch:number,limit:number,
                               target?:{store:ProtocolAbiFrontierStore;reader:ProtocolAbiFrontierStore}):Promise<PreparedBatch|undefined> {
        const store=target?.store??this.options.store;
        const pending=control.pending.slice(0,Math.min(limit,batchBlocks));
        // An existence hint finds the first block whose observation is not linked yet, so only links this batch
        // can use are read, in full. That block's selection is still read, so its parent is checked as before.
        // A single pending block just reads its link, as before.
        const unlinked=pending.length>1?await this.options.bindings.firstUnlinkedSelection(pending):null;this.assertEpoch(epoch);
        const ids=unlinked===null?pending:pending.slice(0,pending.indexOf(unlinked)+1);
        // Independent reads; every one settles before anything else starts, and failures keep block order.
        const reads=await Promise.allSettled(ids.map(async selectedId=>{
            // A replay into a new store generation re-reduces selections the live chain already committed.
            const selection=target?await this.replayedSelection(selectedId):await this.selection(selectedId,control);
            if(selectedId===unlinked)return {selectedId,selection,link:null};
            try {return {selectedId,selection,link:await this.options.bindings.readObservationLink(selectedId)};}
            catch(error){if(error instanceof ProtocolSourceBindingReadError&&error.code==='missing'&&error.recordType==='observation-link')
                return {selectedId,selection,link:null};throw error;}
        }));
        this.assertEpoch(epoch);
        const plan=store.beginStatePlan(control.head?.stateRootId??null),records:ProtocolAbiFrontierRecordInput[]=[];
        const blocks:PreparedBatch['blocks']=[],reader=target?.reader??this.options.accountReader??this.options.store;
        // Accounts changed earlier in this batch resolve from the batch; the rest from the last stored root.
        let head=control.head,stored=control.head?.stateRootId??null,bytes=0;
        const changed=new Map<string,ProtocolAbiAccountState>();
        for(const read of reads){
            if(read.status==='rejected')throw read.reason;
            const {selectedId,selection:selected,link}=read.value;
            if(head&&(selected.source.blockNum!==head.blockNum+1||selected.source.previousBlockId!==head.blockId))
                throw new Error('Admitted ABI source chain is not contiguous');
            if(!link)break;
            let reduction:Awaited<ReturnType<typeof reduceProtocolAbiBlock>>;
            try {
                const record=await this.options.observations.read(link.observationId);
                const context=await this.options.bindings.readContext(selected.contextId);
                this.validateObservation(record,selected,context.schemaJson,link.observationId,link.observationDigest);
                const accounts=new Map<string,Promise<ProtocolAbiAccountState|null>>(),root=stored;
                reduction=await reduceProtocolAbiBlock(record,account=>{
                    let state=accounts.get(account);
                    if(!state){state=changed.has(account)?Promise.resolve(changed.get(account)!)
                        :reader.readAccount(root,account) as Promise<ProtocolAbiAccountState|null>;accounts.set(account,state);}
                    return state;
                },head?.lastGlobalSequence??null,this.options.verifyNativeGenesis,
                this.options.diskAbiHistory?state=>this.options.diskAbiHistory!.matchesState(state):undefined);
            } catch(error){
                if(!dataUnavailable(error))throw error;
                reduction={status:'incomplete',reset:true,bindings:[],updates:[],lastGlobalSequence:null,
                    reason:{code:'retained_input_unavailable',message:String((error as Error).message).slice(0,4096).toWellFormed()}};
            }
            this.assertEpoch(epoch);
            const planned=await this.planBlock(plan,records,control,head,selectedId,selected,link,reduction);
            if(planned.commit.status==='complete')for(const update of reduction.updates)changed.set(update.account,update.state);
            else {changed.clear();stored=null;}
            blocks.push({selectedId,selection:selected,...planned});head=this.head(planned.commit,planned.id);
            bytes+=Buffer.byteLength(json(planned.commit));
            if(bytes>=batchCommitBytes||records.length>=batchRecords)break;
        }
        if(!blocks.length)return undefined;
        // State records first only for readability: nothing references any of them until the CAS.
        const all=[...plan.records,...records];
        const prepared=await store.prepareRecords(all);this.assertEpoch(epoch);
        const commits=prepared.filter((_,index)=>all[index]!.kind==='commit');
        const readback=await store.readPreparedRecords(commits.map(value=>({kind:'commit' as const,...value})));
        for(const [index,block] of blocks.entries()){
            if(commits[index]!.id!==block.id||json(await this.checkedCommit(readback[index],block.id))!==json(block.commit))
                throw new Error('Prepared canonical ABI commit readback mismatch');
        }
        this.assertEpoch(epoch);
        return {generation:control.generation,head:control.head,blocks};
    }

    /** On the serial lane: one control CAS for the whole batch, then its certificates. */
    private async settleBatch(batch:PreparedBatch,epoch:number):Promise<Version|undefined> {
        this.assertEpoch(epoch);
        if(!this.started||this.fenced)throw new ProtocolAbiCoordinatorStaleError('ABI coordinator is not the active owner');
        let version=this.known??await this.owned();this.assertEpoch(epoch);
        const value=version.value,count=batch.blocks.length;
        // Admissions only append. Anything else that moved discards the batch; its records stay unreferenced.
        if(value.generation!==batch.generation||json(value.head)!==json(batch.head)||!value.source||value.phase==='recovering'
            ||json(value.pending.slice(0,count))!==json(batch.blocks.map(block=>block.selectedId)))return undefined;
        let reason=value.gap;batch.baseGap=value.gap;
        for(const block of batch.blocks)reason=block.commit.reason??reason;
        const last=batch.blocks.at(-1)!;
        version=await this.save(version,{...value,head:this.head(last.commit,last.id),pending:value.pending.slice(count),
            phase:last.commit.status==='complete'?'following':'incomplete',gap:reason,replayFromBlock:null});
        this.assertEpoch(epoch);
        const tip=last.selection.head;
        this.sourceLag=Number.isSafeInteger(tip?.blockNum)?Math.max(0,tip.blockNum-last.selection.source.blockNum):0;
        // Prepared commits and primary-visible control are not consumer authority.
        // Certify only after the complete CAS receipt and settled source-epoch check.
        await this.certify(version.value,epoch,batch);
        this.settledHint(version.value);
        return version;
    }

    private async certify(control:ProtocolAbiCoordinatorControl,epoch:number,batch?:PreparedBatch):Promise<void> {
        this.assertEpoch(epoch);
        const certificate=protocolAbiCertificateForControl(control);
        const certificateId=this.options.store.certificateId(certificate);
        // Every earlier head of a batch is verified ancestry of the settled head, so its certificate is the one a
        // historical walk would prepare for it under this owner and generation. Without history only the head counts.
        const heads=batch&&this.historicalCertificates?batch.blocks.map(block=>this.head(block.commit,block.id)):[control.head!];
        const certificates=heads.map(head=>protocolAbiCertificateForControl({...control,head}));
        if(this.certifiedId!==certificateId) {
            const prepared=await this.options.store.prepareCertificates(certificates);
            const stored=await this.options.store.readPreparedCertificates(prepared);
            if(stored.some((value,index)=>json(value)!==json(certificates[index])))throw new Error('Settled ABI certificate readback mismatch');
            this.assertEpoch(epoch);this.certifiedId=certificateId;
        }
        // Queue only after the ordinary settled certificate. All locator/map I/O is lower priority.
        // In pending-work mode the queue belongs to the verified walks, which reach every head through
        // its commit chain. Heads this owner has just settled on top of the covered stretch extend it
        // directly instead, which is exactly what the walk would conclude, so no walk revisits them.
        const walked=this.historicalCertificates?.allowPendingWork;
        if(walked)this.resetHistoricalQueue(certificate);
        const disk=this.options.diskAbiHistory&&await this.preparedDiskBaseline();this.assertEpoch(epoch);
        const covered=(head:Head|null)=>!!(disk&&head&&head.blockNum<=disk.value.source.blockNum);
        if(this.historicalCertificates&&walked&&batch&&control.phase==='following'&&control.gap===null&&control.replayFromBlock===null)
            this.extendSettledCoverage(control,batch.head,heads.filter(head=>!covered(head)),certificates.filter((_,index)=>!covered(heads[index]!)));
        // Each head is queued with the phase and gap it settled under, as when every block had its own CAS.
        if(this.historicalCertificates&&!walked){
            let gapAt=batch?batch.baseGap??null:control.gap;
            for(const [index,head] of heads.entries()){
                let phase=control.phase;
                if(batch){const block=batch.blocks[index]!;gapAt=block.commit.reason??gapAt;phase=block.commit.status==='complete'?'following':'incomplete';}
                const certified=certificates[index]!;
                if(covered(head)||this.historicalPublishedHead===this.options.store.certificateId(certified)
                    ||phase!=='following'||gapAt!==null||head.coverageStart!==1)continue;
                if(!this.queueHistorical(certified))this.historicalWalk=undefined;
            }
        }
        if(this.historicalCertificates&&control.historical&&!this.historicalActivation?.published)try {await this.certifyHistoricalRoot(control,epoch);}
        catch(error) {if(error instanceof ProtocolAbiCoordinatorStaleError)throw error;if(!(error instanceof HistoricalWorkYield))this.noteHistoricalError(error);}
    }
    /**
     * Pending-work mode only. Settled heads directly above the stretch the walks have covered are contiguous
     * by construction (this owner built and read back their commit chain), so their certificates enter the
     * queue as the fresh walk would have queued them, and the covered stretch moves up to them.
     */
    private extendSettledCoverage(control:ProtocolAbiCoordinatorControl,base:Head|null,heads:Head[],certificates:HistoricalCertificate[]):void {
        const walk=this.historicalWalk;
        if(!base||!walk||walk.ownerId!==control.ownerId||walk.generation!==control.generation||this.historicalFresh)return;
        const completed=this.historicalCompleted;
        const done=walk.nextCommitId===null&&!walk.pending?.length&&completed?.ownerId===control.ownerId&&completed.generation===control.generation
            &&json(completed.head)===json(walk.anchor);
        if(json(done?walk.anchor:(this.historicalFreshCovered??walk.anchor))!==json(base))return;
        // While older ancestry is still walking it keeps half of the queue, so new heads cannot starve it.
        const limit=done?this.historicalCertificates!.maxCommitsPerDrain:Math.floor(this.historicalCertificates!.maxCommitsPerDrain/2);
        let covered:Head|undefined;
        for(const [index,head] of heads.entries()){
            if(head.coverageStart!==1||this.historicalQueue.size>=limit||!this.queueHistorical(certificates[index]!))break;
            covered=head;
        }
        if(!covered)return;
        if(done){walk.anchor=copy(covered);this.historicalCompleted={...completed!,head:copy(covered)};}
        else this.historicalFreshCovered=copy(covered);
    }
    private settledHint(control:ProtocolAbiCoordinatorControl):void {
        if(control.head)try {this.options.onSettled?.({blockNum:control.head.blockNum});}catch {}
    }
    private resetHistoricalQueue(certificate:Pick<ReturnType<typeof protocolAbiCertificateForControl>,'ownerId'|'generation'>):void {
        const generation=json([certificate.ownerId,certificate.generation]);
        if(this.historicalQueueGeneration!==generation) {
            this.historicalQueue.clear();this.historicalQueueGeneration=generation;this.historicalAuthorityId=undefined;this.historicalPublishedHead=undefined;
            this.historicalActivation=undefined;
        }
    }
    private queueHistorical(certificate:ReturnType<typeof protocolAbiCertificateForControl>):boolean {
        this.resetHistoricalQueue(certificate);
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
        if(json(await this.options.store.readCertificate(prepared.id,undefined,prepared.digest))!==json(value))throw new Error('Historical root certificate readback differs');
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
        // A check also guards the next step when no store request separates them. This entry check
        // qualifies because only synchronous scope setup intervenes, and so does each check after a step.
        // Bind it to the retained operation's anchor/root, including rewinds below an older anchor.
        let checked:Version|undefined=await this.historicalAuthorityVersion(work?.anchor??control,epoch,
            work?(work.published?.historical?.addressRootId??work.baseRoot):undefined,work?.published?.historical?.activationCertificateId);
        const current=checked.value;
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
            checked=undefined;
            const selected=operation.published?.historical;
            const version=await this.historicalAuthorityVersion(operation.anchor,epoch,selected?.addressRootId??operation.baseRoot,
                selected?.activationCertificateId);
            const value=version.value;
            if(json(value.source)!==json(operation.anchor.source))throw new ProtocolAbiCoordinatorStaleError('Historical source context changed');
            if(value.pending.length&&!this.historicalCertificates!.allowPendingWork)throw new HistoricalWorkYield();
            checked=version;return version;
        };
        const checkpoint=async()=>{
            const live=()=>this.queuedAdmissions>0&&!this.historicalCertificates!.allowPendingWork;
            this.assertEpoch(epoch);
            if(live()||performance.now()>=deadline)throw new HistoricalWorkYield();
            const version=checked??await authority();checked=undefined;
            this.assertEpoch(epoch);
            if(live()||performance.now()>=deadline)throw new HistoricalWorkYield();return version;
        };
        try {
            // Every locator of the fixed scope is one step: one read of their certificates, then one ordered PREPARE.
            if(work.nextAddress<work.entries.length) {
                const remaining=work.entries.slice(work.nextAddress).map(([,address])=>address);
                if(!work.certificates) {
                    await checkpoint();
                    work.certificates=await this.options.store.readCertificates(remaining.map(address=>address.certificateId)) as HistoricalCertificate[];
                    await authority();
                }
                await checkpoint();await this.options.store.prepareHistoricalCertificateAddresses(work.certificates);
                work.nextAddress=work.entries.length;work.certificates=undefined;await authority();
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
            this.historicalWalk=walk;this.clearHistoricalFresh();
        }
        if(budget.allowPendingWork)this.startHistoricalFresh(walk,control);
        const oldest=walk;
        for(let count=0;count<budget.maxCommitsPerDrain;count++) {
            const selected=this.historicalCursor(oldest);if(!selected)break;
            walk=selected;
            const {checkpoint,authority}=this.walkScope(walk,control,epoch,deadline);
            // Durable pending blocks permit background progress; a live RPC waiting on
            // this serial lane gets priority after one completed historical work unit.
            // Break so the existing bounded activation can preserve that partial work.
            if(budget.allowPendingWork&&count>0&&this.queuedAdmissions)break;
            const work=walk.work??={commitId:walk.nextCommitId!};
            if(!work.commit) {await checkpoint();work.commit=await this.readCommit(work.commitId);await authority();}
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
                walk.child=commit;walk.nextCommitId=null;walk.work=undefined;continue;
            }
            if(commit.kind==='disk-abi-baseline'){
                // Covered prefix queries use the immutable catalog; the live address
                // walk stops at its validated boundary instead of inventing prefix commits.
                walk.child=commit;walk.nextCommitId=null;walk.work=undefined;continue;
            }
            if(commit.source.blockNum===1&&(commit.previousCommitId!==null||commit.source.previousBlockId!==null))
                throw new Error('Historical ABI genesis linkage differs');
            if(commit.source.blockNum>1&&!commit.previousCommitId)throw new Error('Historical ABI ancestry ended before genesis');
            const current=await checkpoint();
            (walk.pending??=[]).push({commitId,commit,certificate:protocolAbiCertificateForControl({...current,head:this.head(commit,commitId)})});
            walk.child=commit;walk.work=undefined;
            // Commit IDs are content hashes, so this link proves the floor without spending a slot reading it.
            walk.nextCommitId=walk.floor&&commit.previousCommitId===walk.floor.commitId?null:commit.previousCommitId;
            if(walk.pending.length>=Math.max(1,budget.maxCommitsPerDrain-this.historicalQueue.size)
                &&!await this.flushHistoricalWalk(walk,this.walkScope(walk,control,epoch,deadline))) {
                await this.activateHistorical({...control,head:oldest.anchor},epoch,deadline);return;
            }
        }
        for(const pending of [oldest,this.historicalFresh])if(pending?.pending?.length
            &&!await this.flushHistoricalWalk(pending,this.walkScope(pending,control,epoch,deadline))) {
            await this.activateHistorical({...control,head:oldest.anchor},epoch,deadline);return;
        }
        const anchor={...control,head:oldest.anchor};
        if(this.deferActivation(control))return;
        await this.activateHistorical(anchor,epoch,deadline);
        await this.completeHistoricalWalk(oldest,anchor,epoch);
    }
    /** A check also guards the next step when no store request separates them; each walk step ends with one. */
    private walkScope(walk:HistoricalWalk,control:ProtocolAbiCoordinatorControl,epoch:number,deadline:number) {
        const budget=this.historicalCertificates!,anchor={...control,head:walk.anchor};
        let checked:ProtocolAbiCoordinatorControl|undefined;
        const authority=async()=>{checked=undefined;checked=await this.assertHistoricalAuthority(anchor,epoch);};
        const checkpoint=async()=>{
            if(performance.now()>=deadline)throw new HistoricalWorkYield();
            if(this.queuedAdmissions&&!budget.allowPendingWork)throw new HistoricalWorkYield();
            this.assertEpoch(epoch);
            const current=checked??await this.assertHistoricalAuthority(anchor,epoch);checked=undefined;
            if(current.pending.length&&!budget.allowPendingWork||performance.now()>=deadline)throw new HistoricalWorkYield();return current;
        };
        return {checkpoint,authority};
    }
    /** Certificates of walked ancestry as one ordered PREPARE and one readback; false when the queue is full. */
    private async flushHistoricalWalk(walk:HistoricalWalk,{checkpoint,authority}:{checkpoint:()=>Promise<ProtocolAbiCoordinatorControl>;
        authority:()=>Promise<void>}):Promise<boolean> {
        const budget=this.historicalCertificates!;
        while(walk.pending?.length) {
            const flush=walk.flush??={count:Math.min(walk.pending.length,Math.max(0,budget.maxCommitsPerDrain-this.historicalQueue.size))};
            if(!flush.count){walk.flush=undefined;return false;}
            const batch=walk.pending.slice(0,flush.count);
            if(!flush.prepared) {
                await checkpoint();
                flush.prepared=await this.options.store.prepareCertificates(batch.map(item=>item.certificate));
                await authority();
            }
            if(!flush.verified) {
                await checkpoint();
                const stored=await this.options.store.readPreparedCertificates(flush.prepared);
                if(stored.some((value,index)=>json(value)!==json(batch[index]!.certificate)))throw new Error('Historical certificate readback differs');
                flush.verified=true;await authority();
            }
            await checkpoint();
            let queued=0;
            for(const item of batch){if(!this.queueHistorical(item.certificate))break;queued++;}
            walk.pending.splice(0,queued);walk.flush=undefined;
            if(queued)this.historicalError=undefined;
            if(queued<batch.length)return false;
        }
        return true;
    }
    /**
     * Catch-up only. Blocks within the recovery window are proven through ancestry from the settled head, so
     * their locators can wait and be published together. Publication still happens before any queued block
     * falls halfway out of that window, when the queue is full, and on every drain at the live head.
     */
    private deferActivation(control:ProtocolAbiCoordinatorControl):boolean {
        const budget=this.historicalCertificates!;
        if(!budget.allowPendingWork||this.historicalActivation||!this.historicalQueue.size||this.sourceLag<=this.recoveryWindow
            ||this.historicalQueue.size>=budget.maxCommitsPerDrain)return false;
        const half=Math.floor(this.recoveryWindow/2);
        for(const address of this.historicalQueue.values())if(control.head!.blockNum-address.identity.blockNum>=half)return false;
        return true;
    }
    private clearHistoricalFresh():void {this.historicalFresh=undefined;this.historicalFreshCovered=undefined;}
    private startHistoricalFresh(walk:HistoricalWalk,control:ProtocolAbiCoordinatorControl):void {
        if(!walk.nextCommitId)return;
        if(this.historicalFresh?.nextCommitId===null&&!this.historicalFresh.pending?.length){
            this.historicalFreshCovered=this.historicalFresh.anchor;this.historicalFresh=undefined;}
        const floor=this.historicalFreshCovered??walk.anchor;
        if(!this.historicalFresh&&control.head!.blockNum>floor.blockNum)
            this.historicalFresh={ownerId:walk.ownerId,generation:walk.generation,anchor:copy(control.head!),nextCommitId:control.head!.commitId,child:null,floor:copy(floor)};
    }
    /** Alternate so neither end can starve the other, including across drains at a one-commit budget. */
    private historicalCursor(oldest:HistoricalWalk):HistoricalWalk|undefined {
        const old=oldest.nextCommitId?oldest:undefined,fresh=this.historicalFresh?.nextCommitId?this.historicalFresh:undefined;
        if(!old||!fresh)return old??fresh;
        this.historicalFreshTurn=!this.historicalFreshTurn;
        return this.historicalFreshTurn?fresh:old;
    }
    private async completeHistoricalWalk(walk:NonNullable<ProtocolAbiCoordinator['historicalWalk']>,anchor:ProtocolAbiCoordinatorControl,epoch:number):Promise<void> {
        if(!this.historicalCertificates?.allowPendingWork||walk.nextCommitId!==null||walk.pending?.length||this.historicalQueue.size)return;
        await this.assertHistoricalAuthority(anchor,epoch);
        // Fresh segments were verified down to their floors, so they extend the finished walk contiguously.
        const fresh=this.historicalFresh;
        if(fresh?.nextCommitId===null&&!fresh.pending?.length)this.historicalFreshCovered=fresh.anchor;
        const head=this.historicalFreshCovered??walk.anchor;
        this.historicalCompleted={ownerId:walk.ownerId,generation:walk.generation,head:copy(head)};
        walk.anchor=copy(head);
        if(fresh?.nextCommitId||fresh?.pending?.length)this.historicalWalk=fresh;
        this.clearHistoricalFresh();
    }

    /**
     * Adopt sealed catalog segments that this owner's own commits confirm, and publish the newest in control.
     * A segment is checked only once this owner's settled head passed its end, and only on a following head without
     * a gap. A disagreement refuses the segment for this owner; a stretch the commits cannot reach only waits.
     */
    private scheduleCatalogAttestation(epoch:number):void {
        const catalog=this.options.diskAbiHistory;
        if(!catalog?.nextSegment||!catalog.adopt||this.catalogAttesting)return;
        const now=Date.now();if(now<this.catalogAttestAt)return;
        this.catalogAttestAt=now+(this.options.catalogAttestIntervalMs??2000);
        this.catalogAttesting=this.attestCatalog(epoch)
            .catch(error=>{if(!(error instanceof ProtocolAbiCoordinatorStaleError))try {this.options.onCatalogError?.(error);}catch {}})
            .finally(()=>{this.catalogAttesting=undefined;});
    }
    /**
     * Record that block and action documents through `blockNum` are disk-backed. Monotonic and never past the
     * published catalog end, so a later reader can rely on it, for example before stored proof records are dropped.
     */
    async recordSettled(blockNum:number):Promise<void> {return this.run(async()=>{
        const version=this.known??await this.owned(),value=version.value;
        if(!value.catalog||!uint32(blockNum)||blockNum<1||blockNum>value.catalog.endBlock)
            throw new Error('Settled block is outside the published catalog');
        if(value.settled!==undefined&&blockNum<=value.settled)return;
        await this.save(version,{...value,settled:blockNum});
    });}
    /** Settles once any running attestation pass has finished. Tests and shutdown only. */
    async catalogAttested():Promise<void> {await this.catalogAttesting;}
    private async attestCatalog(epoch:number):Promise<void> {
        const catalog=this.options.diskAbiHistory!;
        for(let step=0;step<8;step++){
            const control=this.known?.value,head=control?.head;
            if(!control||!head||control.phase!=='following'||control.gap!==null||control.replayFromBlock!==null||!control.source)return;
            const segment=await catalog.nextSegment!();this.assertEpoch(epoch);
            if(!segment||segment.link.endBlock>head.blockNum||this.refusedSegments.has(segment.link.manifestSha256))return;
            // Commits and states are immutable, so the comparison reads outside the serial lane.
            try {if(!await this.segmentAgrees(segment,head,epoch))return;}
            catch(error) {
                if(!(error instanceof CatalogDisagreement))throw error;
                this.refusedSegments.add(segment.link.manifestSha256);
                this.options.onCatalogRefused?.({manifestSha256:segment.link.manifestSha256,startBlock:segment.link.startBlock,
                    endBlock:segment.link.endBlock,message:error.message});
                return;
            }
            const published=await this.run(async()=>{
                this.assertEpoch(epoch);
                const current=this.known??await this.owned();this.assertEpoch(epoch);
                // The checked head must still be this generation's: its chain below the irreversible segment cannot change.
                if(current.value.generation!==control.generation||!current.value.head||current.value.head.blockNum<head.blockNum)return false;
                await catalog.adopt!(segment);this.assertEpoch(epoch);
                await this.save(current,{...current.value,catalog:{manifestSha256:segment.link.manifestSha256,
                    endBlock:segment.link.endBlock,lastBlockId:segment.link.lastBlockId}});
                this.assertEpoch(epoch);return true;
            });
            if(!published)return;
            for(const blockNum of [...this.attestChain.keys()])if(blockNum<segment.link.endBlock)this.attestChain.delete(blockNum);
        }
    }
    private remember<T>(map:Map<string,T>,key:string,value:T,limit:number):T {
        map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);return value;
    }
    private async attestCommit(commitId:string):Promise<Commit> {
        return this.attestCommits.get(commitId)??this.remember(this.attestCommits,commitId,await this.readCommit(commitId),4096);
    }
    private async attestState(stateId:string):Promise<ProtocolAbiAccountState> {
        return this.attestStates.get(stateId)??this.remember(this.attestStates,stateId,
            await this.options.store.readAccountState(stateId) as ProtocolAbiAccountState,4096);
    }
    /** Accounts whose state differs between two roots: their state id in each (null where absent). */
    private async changedAccounts(before:string|null,after:string|null):Promise<Map<string,{was:string|null;is:string|null}>> {
        const changed=new Map<string,{was:string|null;is:string|null}>();if(before===after)return changed;
        const buckets=async(rootId:string|null):Promise<Record<string,string>>=>rootId===null?{}
            :this.attestRoots.get(rootId)??this.remember(this.attestRoots,rootId,await this.options.store.planRoot(rootId),1024);
        const accounts=async(bucketId:string|undefined,key:string):Promise<Record<string,string>>=>bucketId===undefined?{}
            :this.attestBuckets.get(bucketId)??this.remember(this.attestBuckets,bucketId,await this.options.store.planBucket(bucketId,key),4096);
        const [left,right]=await Promise.all([buckets(before),buckets(after)]);
        for(const key of new Set([...Object.keys(left),...Object.keys(right)])){
            if(left[key]===right[key])continue;
            const [was,is]=await Promise.all([accounts(left[key],key),accounts(right[key],key)]);
            for(const account of new Set([...Object.keys(was),...Object.keys(is)]))
                if(was[account]!==is[account])changed.set(account,{was:was[account]??null,is:is[account]??null});
        }
        return changed;
    }
    /**
     * Index this owner's chain of commits from the head down to `from` (inclusive). The walk stops where it meets
     * the part of the chain it indexed before, so consecutive segments read each commit once. False if the chain
     * does not reach `from`.
     */
    private async indexChain(head:Head,from:number,epoch:number):Promise<boolean> {
        let commitId:string|null=head.commitId;
        while(commitId){
            const commit=await this.attestCommit(commitId);this.assertEpoch(epoch);
            const at=commit.source.blockNum;
            if(this.attestChain.get(at)===commitId&&this.attestChain.has(from))break;
            this.attestChain.set(at,commitId);
            if(at<=from)break;
            commitId=commit.previousCommitId;
        }
        return this.attestChain.has(from);
    }
    /**
     * Two derivations of the same irreversible blocks must agree before one replaces the other for proofs:
     * every block id and parent link, every account whose ABI state changes (and nothing else), every action's
     * ABI, and the last global sequence. False if this owner's commits do not cover the segment.
     */
    private async segmentAgrees(segment:DiskAbiHistoryPendingSegment,head:Head,epoch:number):Promise<boolean> {
        const {startBlock:start,endBlock:end}=segment.link,catalog=this.options.diskAbiHistory!;
        if(!await this.indexChain(head,start-1,epoch))return false;
        const disagree=(message:string):never=>{throw new CatalogDisagreement(message);};
        const decoding=(state:ProtocolAbiAccountState|null)=>state?.present&&state.abiHex?state.abiHex:null;
        const shape=(state:ProtocolAbiAccountState|null)=>state===null?null:json({present:state.present,abiHex:state.abiHex});
        let parent=await this.attestCommit(this.attestChain.get(start-1)!);
        if(parent.source.blockId!==await catalog.blockId(start-1))disagree('block '+(start-1)+' differs from the catalog tip');
        for(let blockNum=start;blockNum<=end;blockNum++){
            const commitId=this.attestChain.get(blockNum);if(!commitId)return false;
            const commit=await this.attestCommit(commitId);this.assertEpoch(epoch);
            if(commit.status!=='complete')disagree('block '+blockNum+' is incomplete in this owner\'s commits');
            if(commit.source.blockId!==segment.blockId(blockNum)||commit.source.previousBlockId!==parent.source.blockId
                ||commit.previousCommitId!==this.attestChain.get(blockNum-1))disagree('block '+blockNum+' id or parent differs');
            const changed=await this.changedAccounts(parent.stateRootId,commit.stateRootId),recorded=new Set(segment.changedAt(blockNum));
            for(const account of new Set([...changed.keys(),...recorded])){
                if(!changed.has(account))disagree('account '+account+' has a catalog record at block '+blockNum+' but its state does not change');
                const {was,is}=changed.get(account)!,frontier=is===null?null:await this.attestState(is),sealed=segment.finalState(account,blockNum);
                if(!recorded.has(account)){
                    // The sealer records no account that only ever held an empty ABI, while the reducer gives such an
                    // account an empty state on its first touch. Both mean the same: nothing to decode with.
                    if(was===null&&sealed===null&&frontier?.present===true&&frontier.abiHex==='')continue;
                    disagree('account '+account+' changes at block '+blockNum+' without a catalog record');
                }
                if(shape(frontier)!==shape(sealed))disagree('account '+account+' ends block '+blockNum+' with another ABI');
            }
            for(const binding of commit.bindings){
                const frontier=binding.stateId===null?null:await this.attestState(binding.stateId);
                const sealed=segment.actionState({transactionId:binding.transactionId,actionOrdinal:binding.actionOrdinal,
                    inputActionOrdinal:binding.inputActionOrdinal,account:binding.account,receiver:binding.receiver,name:binding.name,
                    rawHex:'',globalSequence:binding.globalSequence,receiptAbiSequence:binding.receiptAbiSequence},blockNum);
                if(decoding(frontier)!==decoding(sealed))disagree('action '+binding.globalSequence+' at block '+blockNum+' decodes with another ABI');
            }
            parent=commit;
        }
        if(parent.lastGlobalSequence!==segment.link.lastGlobalSequence)disagree('last global sequence at block '+end+' differs');
        return true;
    }
    /** A later adopted catalog link end as an anchor: its complete state and that state's root id, without writing. */
    private async rotatedAnchor(blockNum:number|undefined):Promise<{value:ProtocolAbiDiskBaseline;stateRootId:string|null}> {
        const catalog=this.options.diskAbiHistory;
        if(!catalog?.baselineAt||!catalog.boundaries||!uint32(blockNum)||!(await catalog.boundaries()).includes(blockNum!))
            throw new SupersededDiskBaseline('Invalid immutable disk ABI baseline');
        let anchor=this.rotatedAnchors.get(blockNum!);
        if(!anchor){
            const value=copy(await catalog.baselineAt(blockNum!));
            if(value.catalogId!==(await this.preparedDiskBaseline())!.value.catalogId||value.source.blockNum!==blockNum
                ||await catalog.blockId(blockNum!)!==value.source.blockId)throw new InvalidPreparedObservation('Rotated anchor differs from catalog');
            for(const state of value.states)if(!catalog.matchesState(state))
                throw new InvalidPreparedObservation('Rotated anchor contains an unvalidated account state');
            anchor={value,stateRootId:this.options.store.stateRootIdFor(value.states.map(state=>({account:state.account,state})))};
            this.rotatedAnchors.set(blockNum!,anchor);
        }
        return anchor;
    }
    /** The live chain's selections for the blocks after `after` through `head`, oldest first; none if it does not reach. */
    private async chainSelections(head:Head,after:Head):Promise<string[]|undefined> {
        const ids:string[]=[];let commitId:string|null=head.commitId;
        while(commitId){
            const commit=await this.attestCommit(commitId),at=commit.source.blockNum;
            if(at===after.blockNum)return commit.source.blockId===after.blockId?ids.reverse():undefined;
            if(at<after.blockNum||!commit.selectionId)return undefined;
            ids.push(commit.selectionId);commitId=commit.previousCommitId;
        }
        return undefined;
    }
    /**
     * Rotate the proof stores without a pause. The newest catalog link end at or below the settled block becomes
     * the anchor of a chain built in the next store generation: its disk baseline from the catalog, then the live
     * chain's own selections replayed on top of it. The live chain keeps serving and advancing meanwhile. When the
     * new chain reaches the live head, one control CAS on the serial lane switches every reader and writer to it;
     * the previous generation stays readable until `retirePreviousStore`. False when there is nothing to do or the
     * live chain moved in a way the new chain cannot follow (a fork, a new owner generation); try again later.
     */
    async rotateStores():Promise<boolean> {
        if(this.rotating)return this.rotating;
        const epoch=this.sourceEpoch;
        this.rotating=this.rotate(epoch).catch(error=>{if(error instanceof ProtocolAbiCoordinatorStaleError)return false;throw error;})
            .finally(()=>{this.rotating=undefined;});
        return this.rotating;
    }
    private async rotate(epoch:number):Promise<boolean> {
        const catalog=this.options.diskAbiHistory,pinned=await this.preparedDiskBaseline();
        if(!catalog?.baselineAt||!catalog.boundaries||!pinned)return false;
        const control=this.known?.value,head=control?.head;
        if(!control||!head||control.phase!=='following'||control.gap!==null||control.replayFromBlock!==null||!control.source
            ||!control.catalog||control.settled===undefined||control.previousStore!==undefined)return false;
        const after=control.anchor??pinned.value.source.blockNum;
        const anchorAt=(await catalog.boundaries()).filter(end=>end>after&&end<=control.settled!&&end<=head.blockNum).at(-1);
        if(anchorAt===undefined)return false;
        const generation=(control.storeGeneration??0)+1,target=this.options.store.forGeneration(generation),reader=target.asAccountReader();
        const anchor=await this.rotatedAnchor(anchorAt);this.assertEpoch(epoch);
        const stateRootId=await target.prepareState(null,anchor.value.states.map(state=>({account:state.account,state})),false,()=>catalog.revalidate());
        if(stateRootId!==anchor.stateRootId)throw new Error('Rotated anchor state root differs from its catalog state');
        const base:Commit={schemaVersion:1,kind:'disk-abi-baseline',chainId:this.options.chainId,profile:this.profile,generation:control.generation,
            previousCommitId:null,selectionId:null,observationId:null,observationDigest:null,source:anchor.value.source,status:'complete',reason:null,
            stateRootId,lastGlobalSequence:anchor.value.lastGlobalSequence,coverageStart:1,bindings:[],catalogId:anchor.value.catalogId,
            ...(this.options.nativeActionInterfaceVersion===1?{nativeActionInterfaceVersion:1 as const}:{})};
        const prepared=await target.prepareCommit(base);
        if(json(await target.readCommit(prepared.id,undefined,prepared.digest))!==json(base))throw new Error('Rotated anchor readback differs');
        this.assertEpoch(epoch);
        let built=this.head(base,prepared.id);
        for(let round=0;round<64;round++){
            const live=this.known?.value;
            if(!live?.head||live.generation!==control.generation||(live.storeGeneration??0)!==(control.storeGeneration??0))return false;
            const pending=await this.chainSelections(live.head,built);this.assertEpoch(epoch);
            if(!pending)return false;
            while(pending.length){
                // A batch may stop early at its byte bounds: only the blocks it built leave the queue.
                const batch=await this.prepareBatch({...live,head:built,pending:pending.slice(0,batchBlocks)},epoch,batchBlocks,{store:target,reader});
                if(!batch)return false;
                pending.splice(0,batch.blocks.length);
                const last=batch.blocks.at(-1)!;built=this.head(last.commit,last.id);
            }
            // Everything a reader of the new generation needs exists before control names it: every store index
            // and the certificate of the head it will name, so the switch never shows a half-prepared generation.
            await this.options.bindings.provisionGeneration(generation);await this.options.observations.provisionGeneration(generation);
            await this.options.provisionStoreGeneration?.(generation);
            const certificate=protocolAbiCertificateForControl({...live,head:built});
            const issued=await target.prepareCertificates([certificate]);
            if(json((await target.readPreparedCertificates(issued))[0])!==json(certificate))throw new Error('Rotated head certificate readback differs');
            this.assertEpoch(epoch);
            const outcome=await this.run(async()=>{
                this.assertEpoch(epoch);
                const version=this.known??await this.owned(),value=version.value;this.assertEpoch(epoch);
                if(!value.head||value.generation!==control.generation||(value.storeGeneration??0)!==(control.storeGeneration??0)
                    ||value.phase!=='following'||value.replayFromBlock!==null)return 'abort';
                if(value.head.blockNum>built.blockNum)return 'behind';
                if(value.head.blockNum!==built.blockNum||value.head.blockId!==built.blockId)return 'abort';
                const next:ProtocolAbiCoordinatorControl={...value,head:built,storeGeneration:generation,anchor:anchorAt,
                    previousStore:{generation:value.storeGeneration??0,switchedAtBlock:built.blockNum,switchedAt:Date.now()}};
                // The historical address map lives in the previous generation; the new chain starts without one.
                delete next.historical;
                await this.save(version,next);this.assertEpoch(epoch);
                this.certifiedId=undefined;this.historicalActivation=undefined;this.historicalWalk=undefined;this.clearHistoricalFresh();
                this.historicalCompleted=undefined;this.historicalQueue.clear();
                for(const blockNum of [...this.attestChain.keys()])if(blockNum>anchorAt)this.attestChain.delete(blockNum);
                await this.certify(this.known!.value,epoch);this.settledHint(this.known!.value);
                return 'switched';
            });
            if(outcome==='switched')return true;
            if(outcome==='abort')return false;
        }
        return false;
    }
    /** Settles once a running rotation has finished. Tests and shutdown only. */
    async storesRotated():Promise<void> {await this.rotating?.catch(()=>undefined);}
    /**
     * Stop reading the previous store generation once nothing can reference it: settled documents are disk-backed,
     * so settling `marginBlocks` past the switch block covers every document written against it, and `minimumAgeMs`
     * covers writers that had not observed the switch yet. Returns the generation the caller may now drop.
     */
    async retirePreviousStore(marginBlocks:number,minimumAgeMs:number,now=Date.now()):Promise<number|undefined> {return this.run(async()=>{
        const version=this.known??await this.owned(),value=version.value,previous=value.previousStore;
        if(!previous||value.settled===undefined||value.settled<previous.switchedAtBlock+marginBlocks||now-previous.switchedAt<minimumAgeMs)return undefined;
        const next:ProtocolAbiCoordinatorControl={...value};delete next.previousStore;
        await this.save(version,next);
        return previous.generation;
    });}
    async drain():Promise<{committed:number;pending:number}> {
        const result=this.drains.then(()=>this.drainOnce());
        this.drains=result.then(()=>undefined,()=>undefined);
        return result;
    }
    private async drainOnce():Promise<{committed:number;pending:number}> {
        const epoch=this.sourceEpoch;
        try {
            let version=await this.run(async()=>{
                const version=await this.owned();this.assertEpoch(epoch);
                if(this.options.diskAbiHistory){await this.options.diskAbiHistory.revalidate();this.assertEpoch(epoch);}
                return version;
            }),committed=0;
            while(version.value.source&&version.value.phase!=='recovering'&&version.value.pending.length&&committed<this.maximumPending){
                const batch=await this.prepareBatch(version.value,epoch,this.maximumPending-committed);
                if(!batch)break;
                const settled=await this.run(()=>this.settleBatch(batch,epoch));
                if(!settled)break;
                version=settled;committed+=batch.blocks.length;
            }
            return await this.run(async()=>{
                this.assertEpoch(epoch);
                // Admissions may have appended since; every control step below starts from the latest receipt.
                version=this.known??await this.owned();
                // A failed certificate PREPARE may follow a successful settled head CAS.
                // Retry it even without a new block; owned() has re-established durable ownership.
                if(!committed&&version.value.head&&version.value.source&&version.value.replayFromBlock===null
                    &&['following','incomplete'].includes(version.value.phase)){await this.certify(version.value,epoch);this.settledHint(version.value);}
                try {await this.extendHistorical(version.value,epoch);}
                catch(error) {
                    if(!(error instanceof HistoricalWorkYield)) {this.historicalActivation=undefined;this.historicalWalk=undefined;this.clearHistoricalFresh();}
                    if(error instanceof ProtocolAbiCoordinatorStaleError)throw error;
                    if(!(error instanceof HistoricalWorkYield))this.noteHistoricalError(error);
                }
                // Lowest priority, detached: a sealed segment never delays a drain, and a failed check never fails one.
                this.scheduleCatalogAttestation(epoch);
                return {committed,pending:version.value.pending.length};
            });
        } catch(error){if(error instanceof ProtocolAbiCoordinatorStaleError){
            this.historicalActivation=undefined;this.historicalWalk=undefined;this.clearHistoricalFresh();
            return {committed:0,pending:this.known?.value.pending.length??0};
        }throw error;}
    }
    async inspect():Promise<ProtocolAbiCoordinatorControl> {return this.run(async()=>copy((await this.owned()).value));}
}
