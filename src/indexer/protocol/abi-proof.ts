import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import type {ProtocolAbiAccountState} from './abi-reducer.js';
import {protocolSourceContextId,type ProtocolSourceProfile,type ProtocolSourcePosition} from './source-bindings.js';
import {ProtocolAbiFrontierReadError,type ProtocolAbiFrontierStore} from './abi-frontier-store.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import {isProtocolHex} from './hex.js';
import type {ProtocolAbiCoordinatorControl} from './abi-coordinator.js';
import {validNativeGenesisCoverage, type ProtocolNativeGenesisCoverage} from './native-genesis.js';
import type {ProjectionFrame} from '../projection/runtime.js';

export interface ProtocolAbiProofSource {readonly chainId:string;readonly blockNum:number;readonly blockId:string}
export type ProtocolAbiProofBinding=Omit<ProtocolAbiActionInput,'rawHex'> & {readonly rawSha256:string;readonly stateId:string|null};
export interface ProtocolAbiProofView {
    readonly certificateId:string;readonly commitId:string;readonly selectionId:string;
    readonly source:ProtocolSourcePosition;readonly bindings:readonly ProtocolAbiProofBinding[];
}
/** Kept outside act.data, before grouping, numeric conversion or contract enrichment. */
export interface ProtocolActionProofMetadata {
    readonly schemaVersion:1;readonly source:ProtocolAbiProofSource;readonly selectionId:string;
    readonly input:ProtocolAbiActionInput;
}
export interface ProtocolActionSourceMetadata {
    readonly schemaVersion:1;readonly source:ProtocolAbiProofSource;readonly selectionId:string;
    readonly input:Omit<ProtocolAbiActionInput,'inputActionOrdinal'>;readonly status:'incomplete';
    readonly error:{readonly code:string;readonly message:string};
}
export type ProtocolActionMetadata=ProtocolActionProofMetadata|ProtocolActionSourceMetadata;
export interface ProtocolAbiResolvedAction {readonly binding:ProtocolAbiProofBinding;readonly state:ProtocolAbiAccountState}
export interface ProtocolAbiProofReadOptions {readonly signal?:AbortSignal}
export interface ProtocolAbiProofReaderOptions {
    readonly chainId:string;readonly profile:ProtocolSourceProfile;readonly store:ProtocolAbiFrontierStore;
    readonly maxAncestryBlocks?:number;
}
export class ProtocolAbiProofUnavailableError extends Error {
    readonly statusCode=503;
    constructor(readonly code:string,message:string){super(message);this.name='ProtocolAbiProofUnavailableError';}
}

type Head=NonNullable<ProtocolAbiCoordinatorControl['head']>;
export interface ProtocolAbiHeadCertificate {
    schemaVersion:1;kind:'settled-abi-head';chainId:string;profile:ProtocolSourceProfile;
    ownerId:string;generation:string;head:Head;
}
interface CanonicalCommit {
    source:ProtocolSourcePosition;previousCommitId:string|null;selectionId:string;
    status:'complete'|'incomplete';stateRootId:string|null;bindings:ProtocolAbiProofBinding[];
    coverageStart:number|null;lastGlobalSequence:string|null;
    nativeGenesis?:ProtocolNativeGenesisCoverage;
}
interface AncestryEntry {commitId:string;commit:CanonicalCommit}
interface Issued {certificate:ProtocolAbiHeadCertificate;commit:CanonicalCommit;ancestry:Map<number,AncestryEntry>}
const hex64=/^[0-9a-f]{64}$/;
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.isWellFormed();
const actionName=(value:unknown):value is string=>typeof value==='string'&&value.length<=256&&value.isWellFormed();
const ordinal=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&Number(value)>=min;
const uint=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=0xffffffff;
const ident=(prefix:string,value:unknown):value is string=>typeof value==='string'&&value.startsWith(prefix+':')&&hex64.test(value.slice(prefix.length+1));
const json=(value:unknown)=>protocolImmutableJson(value);
const copy=<T>(value:T):T=>JSON.parse(json(value));
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function freeze<T>(value:T):T {
    if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
    return value;
}
function unavailable(code:string,message:string):never {throw new ProtocolAbiProofUnavailableError(code,message);}
function requireProof(condition:unknown,message:string):asserts condition {if(!condition)unavailable('invalid_proof',message);}
function sequence(value:unknown,positive=true,maximum=0xffffffffffffffffn):boolean {
    return typeof value==='string'&&value.length<=20&&/^(?:0|[1-9][0-9]*)$/.test(value)
        &&BigInt(value)>=(positive?1n:0n)&&BigInt(value)<=maximum;
}
function validHead(head:any):head is Head {
    return head&&uint(head.blockNum,1)&&hex64.test(head.blockId)&&ident('h45abicmt1',head.commitId)
        &&(head.stateRootId===null||ident('h45abiroot1',head.stateRootId))
        &&(head.lastGlobalSequence===null||sequence(head.lastGlobalSequence))
        &&(head.coverageStart===null||(uint(head.coverageStart,1)&&head.coverageStart<=head.blockNum));
}
/** Pure address derivation, not authority. Only settled coordinator activation may prepare these bytes. */
export function protocolAbiCertificateForControl(control:ProtocolAbiCoordinatorControl):ProtocolAbiHeadCertificate {
    if(!validHead(control.head))unavailable('authority_unavailable','Canonical ABI head is unavailable');
    return copy({schemaVersion:1,kind:'settled-abi-head',chainId:control.chainId,profile:control.profile,
        ownerId:control.ownerId,generation:control.generation,head:control.head});
}

/** Read-only applicability checks; primary-visible control may revoke authority, never grant it. */
export class ProtocolAbiProofReader {
    private readonly profile:ProtocolSourceProfile;
    private readonly maximumAncestry:number;
    private readonly issued=new WeakMap<ProtocolAbiProofView,Issued>();
    private activeReads=0;
    constructor(private readonly options:ProtocolAbiProofReaderOptions) {
        if(!hex64.test(options.chainId))throw new Error('Invalid ABI proof chain');
        protocolSourceContextId({schemaVersion:1,chainId:options.chainId,protocol:options.profile,schemaJson:'{}'});
        this.profile=copy(options.profile);
        this.profile.components=[...this.profile.components].sort((a,b)=>(a.runtime+':'+a.id)<(b.runtime+':'+b.id)?-1:1);
        this.maximumAncestry=options.maxAncestryBlocks??256;
        if(!uint(this.maximumAncestry,1)||this.maximumAncestry>4096)throw new Error('Invalid ABI proof ancestry bound');
    }
    private sameProfile(value:unknown):boolean {try{return json(value)===json(this.profile);}catch{return false;}}
    private assertActive(signal?:AbortSignal):void {
        if(signal?.aborted)unavailable('proof_cancelled','ABI proof request was cancelled');
    }
    private async retained<T>(operation:()=>Promise<T>,code='retained_data_unavailable',signal?:AbortSignal):Promise<T> {
        this.assertActive(signal);
        if(this.activeReads>=64)unavailable('proof_busy','Canonical ABI proof read budget is exhausted');
        this.activeReads++;
        try{const result=await operation();this.assertActive(signal);return result;}catch(error:any){
            this.assertActive(signal);
            if(error instanceof ProtocolAbiFrontierReadError)unavailable(error.code==='invalid'?'invalid_proof':code,error.message);
            if(error?.meta?.statusCode===404&&error?.meta?.body?.error?.type==='index_not_found_exception')
                unavailable('authority_unavailable','Canonical ABI projection has not been initialized');
            throw error;
        }finally{this.activeReads--;}
    }
    private async authority(signal?:AbortSignal):Promise<ProtocolAbiHeadCertificate> {
        const observed=await this.retained(()=>this.options.store.readControl(signal),undefined,signal);
        if(!observed)unavailable('authority_unavailable','Canonical ABI coordinator has no control record');
        const value=observed.value as ProtocolAbiCoordinatorControl;
        requireProof(value?.schemaVersion===1&&value.chainId===this.options.chainId&&text(value.ownerId)&&text(value.generation)
            &&Number.isSafeInteger(value.revision)&&value.revision>=0&&this.sameProfile(value.profile),'Incompatible canonical ABI authority');
        if(!['following','incomplete'].includes(value.phase)||value.replayFromBlock!==null||!value.source)
            unavailable('authority_unavailable','Canonical ABI source is recovering or unavailable');
        requireProof(ident('h45srcctx1',value.source.contextId)&&text(value.source.readerSessionId),'Invalid canonical ABI source');
        if(!value.head)unavailable('source_pending','Canonical ABI source has not committed');
        requireProof(validHead(value.head),'Invalid canonical ABI authority head');
        return protocolAbiCertificateForControl(value);
    }
    private validateCommit(value:any):CanonicalCommit {
        requireProof(value?.schemaVersion===1&&value.kind==='canonical-abi-block'&&value.chainId===this.options.chainId
            &&this.sameProfile(value.profile)&&text(value.generation)&&ident('h45srcsel1',value.selectionId)
            &&value.source?.chainId===this.options.chainId&&uint(value.source.blockNum,1)&&hex64.test(value.source.blockId)
            &&(value.source.previousBlockId===null||hex64.test(value.source.previousBlockId))
            &&(value.previousCommitId===null||ident('h45abicmt1',value.previousCommitId))
            &&['complete','incomplete'].includes(value.status)&&Array.isArray(value.bindings)&&value.bindings.length<=100000
            &&(value.stateRootId===null||ident('h45abiroot1',value.stateRootId))
            &&(value.lastGlobalSequence===null||sequence(value.lastGlobalSequence))
            &&(value.coverageStart===null||(uint(value.coverageStart,1)&&value.coverageStart<=value.source.blockNum)),
            'Invalid canonical ABI commit');
        if(value.status==='incomplete')requireProof(value.bindings.length===0&&value.stateRootId===null
            &&value.coverageStart===null&&value.lastGlobalSequence===null,'Incomplete ABI commit grants knowledge');
        else requireProof(ident('h45abi1',value.observationId)&&hex64.test(value.observationDigest)
            &&value.coverageStart!==null,'Complete ABI commit lacks its retained observation');
        if(value.nativeGenesis!==undefined)requireProof(validNativeGenesisCoverage(value.nativeGenesis)&&value.status==='complete'
            &&value.source.blockNum===1&&value.source.previousBlockId===null&&value.previousCommitId===null
            &&value.bindings.length===0&&value.lastGlobalSequence===null&&value.coverageStart===1,
            'Invalid native genesis coverage');
        const seen=new Set<string>();
        for(const binding of value.bindings){
            const key=binding.transactionId+':'+binding.actionOrdinal;
            requireProof(hex64.test(binding.transactionId)&&ordinal(binding.actionOrdinal,1)&&ordinal(binding.inputActionOrdinal,1)
                &&[binding.receiver,binding.account].every(text)&&actionName(binding.name)&&sequence(binding.globalSequence)
                &&sequence(binding.receiptAbiSequence,false,0xffffffffn)&&hex64.test(binding.rawSha256)
                &&(binding.stateId===null||ident('h45abist1',binding.stateId))&&!seen.has(key),'Invalid ABI input binding');
            seen.add(key);
        }
        return value;
    }
    async open(source:ProtocolAbiProofSource,selectionId?:string,{signal}:ProtocolAbiProofReadOptions={}):Promise<ProtocolAbiProofView> {
        requireProof(source?.chainId===this.options.chainId&&uint(source.blockNum,1)&&hex64.test(source.blockId)
            &&(selectionId===undefined||ident('h45srcsel1',selectionId)),'Invalid requested ABI source');
        // Snapshot caller-owned data before any storage await.
        source=copy(source);
        const certificate=await this.authority(signal);
        if(certificate.head.blockNum<source.blockNum)unavailable('source_pending','Requested ABI source has not committed');
        if(certificate.head.blockNum-source.blockNum>this.maximumAncestry)
            unavailable('ancestry_unavailable','Requested ABI source is outside verified ancestry');
        const certificateId=this.options.store.certificateId(certificate);
        const stored=await this.retained(()=>this.options.store.readCertificate(certificateId,signal),'certificate_unavailable',signal);
        requireProof(json(stored)===json(certificate),'Settled ABI certificate does not match the observed authority');
        const ancestry=new Map<number,AncestryEntry>();
        let commitId=certificate.head.commitId,commit:CanonicalCommit|undefined,child:CanonicalCommit|undefined;
        for(let distance=0;distance<=this.maximumAncestry;distance++){
            commit=this.validateCommit(await this.retained(()=>this.options.store.readCommit(commitId,signal),'ancestry_unavailable',signal));
            if(!child){
                requireProof(json({blockNum:commit.source.blockNum,blockId:commit.source.blockId,commitId,stateRootId:commit.stateRootId,
                    lastGlobalSequence:commit.lastGlobalSequence,coverageStart:commit.coverageStart})===json(certificate.head),
                    'Certified ABI head does not match its immutable commit');
            }else requireProof(commit.source.blockNum+1===child.source.blockNum&&child.source.previousBlockId===commit.source.blockId,
                'Certified ABI ancestry is not contiguous');
            ancestry.set(commit.source.blockNum,{commitId,commit:freeze(copy(commit))});
            if(commit.source.blockNum===source.blockNum)break;
            if(commit.source.blockNum<source.blockNum||!commit.previousCommitId||distance===this.maximumAncestry)
                unavailable('ancestry_unavailable','Requested ABI source has no retained canonical membership');
            child=commit;commitId=commit.previousCommitId;
        }
        requireProof(commit&&commit.source.blockNum===source.blockNum,'Requested ABI source was not resolved');
        if(commit.source.blockId!==source.blockId||(selectionId!==undefined&&selectionId!==commit.selectionId))
            unavailable('source_not_canonical','Requested ABI source selection is not canonical');
        if(commit.status!=='complete')unavailable('source_incomplete','Requested ABI source has incomplete knowledge');
        const view=freeze(copy({certificateId,commitId,selectionId:commit.selectionId,source:commit.source,bindings:commit.bindings}));
        this.issued.set(view,{certificate:freeze(copy(certificate)),commit:freeze(copy(commit)),ancestry});
        await this.revalidate(view,{signal});return view;
    }
    /** A head grant must name the exact settled certificate head, never an older source under a newer head. */
    async openHead(options:ProtocolAbiProofReadOptions={}):Promise<ProtocolAbiProofView> {
        const certificate=await this.authority(options.signal);
        const view=await this.open({chainId:this.options.chainId,blockNum:certificate.head.blockNum,blockId:certificate.head.blockId},undefined,options);
        const issued=this.issued.get(view)!;
        if(json(issued.certificate)!==json(certificate))unavailable('authority_changed','Canonical ABI head changed while opening its grant');
        return view;
    }
    /** Resolve an exact height through one issued certificate, reusing only its validated immutable links. */
    async ancestor(view:ProtocolAbiProofView,blockNum:number,options:ProtocolAbiProofReadOptions={}):Promise<ProtocolAbiProofView> {
        const issued=this.issued.get(view);if(!issued)unavailable('invalid_proof','ABI proof view was not issued by this reader');
        requireProof(uint(blockNum,1)&&blockNum<=view.source.blockNum,'Invalid requested ABI ancestor');
        if(issued.certificate.head.blockNum-blockNum>this.maximumAncestry)
            unavailable('ancestry_unavailable','Requested ABI ancestor is outside verified ancestry');
        let current=issued.ancestry.get(view.source.blockNum)!;
        while(current.commit.source.blockNum>blockNum){
            const child=current.commit;
            if(!child.previousCommitId)unavailable('ancestry_unavailable','Requested ABI ancestor is not retained');
            let previous=issued.ancestry.get(child.source.blockNum-1);
            if(!previous){
                const commit=this.validateCommit(await this.retained(()=>this.options.store.readCommit(child.previousCommitId!,options.signal),
                    'ancestry_unavailable',options.signal));
                requireProof(commit.source.blockNum+1===child.source.blockNum&&commit.source.blockId===child.source.previousBlockId,
                    'Certified ABI ancestry is not contiguous');
                previous={commitId:child.previousCommitId,commit:freeze(copy(commit))};
                issued.ancestry.set(commit.source.blockNum,previous);
            }
            requireProof(previous.commitId===child.previousCommitId&&previous.commit.source.blockId===child.source.previousBlockId,
                'Certified ABI ancestry changed');
            current=previous;
        }
        if(current.commit.status!=='complete')unavailable('source_incomplete','Requested ABI ancestor has incomplete knowledge');
        const result=freeze(copy({certificateId:view.certificateId,commitId:current.commitId,selectionId:current.commit.selectionId,
            source:current.commit.source,bindings:current.commit.bindings}));
        this.issued.set(result,{certificate:issued.certificate,commit:current.commit,ancestry:issued.ancestry});
        await this.revalidate(result,options);return result;
    }
    async waitForOpen(source:ProtocolAbiProofSource,selectionId?:string,
                      options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<ProtocolAbiProofView> {
        const timeout=options.timeoutMs??5000;
        if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw new Error('Invalid ABI proof wait bound');
        source=copy(source);const controller=new AbortController();let timedOut=false;
        const reason=()=>new ProtocolAbiProofUnavailableError(timedOut?'proof_timeout':'proof_cancelled',
            timedOut?'Canonical ABI proof wait timed out':'ABI proof request was cancelled');
        const cancel=()=>controller.abort();
        if(options.signal?.aborted)unavailable('proof_cancelled','ABI proof request was cancelled');
        options.signal?.addEventListener('abort',cancel,{once:true});
        const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
        let onAbort:()=>void=()=>{};
        const aborted=new Promise<never>((_resolve,reject)=>{
            onAbort=()=>reject(reason());controller.signal.addEventListener('abort',onAbort,{once:true});
        });
        const poll=async()=>{
            while(true){
                if(controller.signal.aborted)throw reason();
                try{
                    const view=await this.open(source,selectionId,{signal:controller.signal});
                    if(controller.signal.aborted)throw reason();
                    return view;
                }catch(error){
                    if(controller.signal.aborted)throw reason();
                    if(!(error instanceof ProtocolAbiProofUnavailableError)
                        ||!['authority_unavailable','source_pending','certificate_unavailable','proof_busy'].includes(error.code))throw error;
                    try{await delay(50,undefined,{signal:controller.signal});}
                    catch(stopped){if(controller.signal.aborted)throw reason();throw stopped;}
                }
            }
        };
        try{return await Promise.race([poll(),aborted]);}
        finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);
            controller.signal.removeEventListener('abort',onAbort);controller.abort();}
    }
    async revalidate(view:ProtocolAbiProofView,{signal}:ProtocolAbiProofReadOptions={}):Promise<void> {
        const issued=this.issued.get(view);if(!issued)unavailable('invalid_proof','ABI proof view was not issued by this reader');
        const current=await this.authority(signal),prior=issued.certificate;
        if(current.ownerId!==prior.ownerId||current.generation!==prior.generation||current.head.blockNum<prior.head.blockNum
            ||(current.head.blockNum===prior.head.blockNum&&json(current.head)!==json(prior.head)))
            unavailable('authority_changed','Canonical ABI authority changed during consumption');
    }
    /** An issued, current proof of native empty application state supplies the actual 0 -> 1 frame. */
    async nativeGenesisFrame(view:ProtocolAbiProofView,options:ProtocolAbiProofReadOptions={}):Promise<ProjectionFrame> {
        const issued=this.issued.get(view);if(!issued)unavailable('invalid_proof','ABI proof view was not issued by this reader');
        const facts=issued.commit.nativeGenesis;
        if(!facts)unavailable('native_genesis_unavailable','Source has no verified native genesis application state');
        await this.revalidate(view,options);
        return freeze({chainId:issued.commit.source.chainId,block:{blockNum:1,blockId:issued.commit.source.blockId,
            previousBlockId:facts.previousBlockId},changes:[]});
    }
    async action(view:ProtocolAbiProofView,input:Omit<ProtocolAbiActionInput,'inputActionOrdinal'> & {inputActionOrdinal?:number},
                 {signal}:ProtocolAbiProofReadOptions={}):Promise<ProtocolAbiResolvedAction> {
        this.assertActive(signal);
        const issued=this.issued.get(view);if(!issued)unavailable('invalid_proof','ABI proof view was not issued by this reader');
        requireProof(input&&hex64.test(input.transactionId)&&ordinal(input.actionOrdinal,1)&&[input.receiver,input.account].every(text)&&actionName(input.name)
            &&isProtocolHex(input.rawHex)&&sequence(input.globalSequence)&&sequence(input.receiptAbiSequence,false,0xffffffffn)
            &&(input.inputActionOrdinal===undefined||ordinal(input.inputActionOrdinal,1)),'Invalid original ABI input');
        input=copy(input);
        const binding=issued.commit.bindings.find(value=>value.transactionId===input.transactionId&&value.actionOrdinal===input.actionOrdinal);
        if(!binding||binding.receiver!==input.receiver||binding.account!==input.account||binding.name!==input.name
            ||binding.globalSequence!==input.globalSequence||binding.receiptAbiSequence!==input.receiptAbiSequence
            ||(input.inputActionOrdinal!==undefined&&binding.inputActionOrdinal!==input.inputActionOrdinal)
            ||binding.rawSha256!==hash(Buffer.from(input.rawHex,'hex')))
            unavailable('input_not_bound','Original action does not match its certified ABI input binding');
        if(!binding.stateId)unavailable('abi_state_unavailable','Action input ABI state is unknown');
        const state=this.state(await this.retained(()=>this.options.store.readAccountState(binding.stateId!,signal),undefined,signal),view,input.account);
        await this.revalidate(view,{signal});return freeze({binding,state});
    }
    async finalState(view:ProtocolAbiProofView,account:string,{signal}:ProtocolAbiProofReadOptions={}):Promise<ProtocolAbiAccountState> {
        this.assertActive(signal);
        const issued=this.issued.get(view);if(!issued)unavailable('invalid_proof','ABI proof view was not issued by this reader');
        requireProof(text(account),'Invalid final ABI account');
        const state=this.state(await this.retained(()=>this.options.store.readAccount(issued.commit.stateRootId,account,signal),undefined,signal),view,account);
        await this.revalidate(view,{signal});return state;
    }
    /** Inspect known absence/empty barriers for lifecycle fencing; this does not authorize decoding. */
    async inspectFinalState(view:ProtocolAbiProofView,account:string,
                            {signal,atBlockNum}:ProtocolAbiProofReadOptions&{atBlockNum?:number}={}):Promise<ProtocolAbiAccountState|null> {
        this.assertActive(signal);
        const issued=this.issued.get(view);if(!issued)unavailable('invalid_proof','ABI proof view was not issued by this reader');
        atBlockNum??=view.source.blockNum;
        requireProof(text(account)&&uint(atBlockNum,1)&&atBlockNum<=view.source.blockNum
            &&view.source.blockNum-atBlockNum<=this.maximumAncestry,'Invalid ABI inspection ancestry');
        let commit=issued.commit;
        while(commit.source.blockNum>atBlockNum){
            requireProof(commit.previousCommitId,'ABI inspection ancestry is not retained');
            const previous=this.validateCommit(await this.retained(()=>this.options.store.readCommit(commit.previousCommitId!,signal),'ancestry_unavailable',signal));
            requireProof(previous.status==='complete'&&previous.source.blockNum+1===commit.source.blockNum
                &&previous.source.blockId===commit.source.previousBlockId,'ABI inspection ancestry is not complete and contiguous');
            commit=previous;
        }
        const raw=await this.retained(()=>this.options.store.readAccount(commit.stateRootId,account,signal),undefined,signal);
        const state=raw===null?null:this.knownState(raw,{...view,source:commit.source},account);
        await this.revalidate(view,{signal});return state;
    }
    private state(value:any,view:ProtocolAbiProofView,account:string):ProtocolAbiAccountState {
        if(!value||value.account!==account||value.present!==true||!isProtocolHex(value.abiHex)||!value.abiHex)
            unavailable('abi_state_unavailable','Certified ABI state is unknown, absent or empty');
        return this.knownState(value,view,account);
    }
    private knownState(value:any,view:ProtocolAbiProofView,account:string):ProtocolAbiAccountState {
        requireProof(value&&value.account===account&&typeof value.present==='boolean'&&isProtocolHex(value.abiHex)
            &&this.sameProfile(value.protocol)&&value.source?.chainId===this.options.chainId
            &&uint(value.source.blockNum,1)&&value.source.blockNum<=view.source.blockNum&&hex64.test(value.source.blockId)
            &&(value.source.blockNum!==view.source.blockNum||value.source.blockId===view.source.blockId)
            &&ident('h45abi1',value.source.observationId)&&hex64.test(value.source.inputSha256),'Invalid ABI state provenance');
        requireProof(value.source.phase==='block-end'?ordinal(value.source.deltaOrdinal)
            :value.source.phase==='native-effect'&&hex64.test(value.source.action?.transactionId)
                &&ordinal(value.source.action?.actionOrdinal,1)&&sequence(value.source.action?.globalSequence),'Invalid ABI state epoch');
        return freeze(copy(value));
    }
}
