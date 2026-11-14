import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import type {ProtocolComponent} from '@eosrio/hyperion-sdk/protocol';
import {GenerationalProtocolBundleStore, protocolStoreGenerations, protocolStoreIndexSuffix,
    ImmutableProtocolBundleStore, ImmutableProtocolBundleReadError, ProtocolImmutableRecordMemo, protocolImmutableJson,
    protocolBundleMembershipHintBounds} from './immutable-bundle-store.js';
import {isProtocolHex} from './hex.js';

export const protocolSourceSelectionHeader = 'hyperion-source-selection-v1';
export interface ProtocolSourceProfile {id:string;profileId:string;components:readonly ProtocolComponent[]}
export interface ProtocolSourceContext {
    schemaVersion:1;
    chainId:string;
    protocol:ProtocolSourceProfile;
    /** Exact selected handshake text, retained once; its formatting is part of this context. */
    schemaJson:string;
}
export interface ProtocolSourcePosition {chainId:string;blockNum:number;blockId:string;previousBlockId:string|null}
export interface ProtocolSourceSelection {
    schemaVersion:1;
    contextId:string;
    readerSessionId:string;
    readerRole:'live'|'bulk'|'repair';
    assignmentId:string|null;
    source:ProtocolSourcePosition;
    frameSha256:string;
    captureSha256:string;
    head:{blockNum:number;blockId:string};
    irreversible:{blockNum:number;blockId:string};
}
export interface ProtocolSourceQuarantine {
    schemaVersion:1;
    chainId:string;
    protocol:ProtocolSourceProfile;
    frameHex:string;
    reason:{code:string;message:string};
    claimedSelectionId:string|null;
}
export interface ProtocolSourceObservationLink {
    schemaVersion:1;selectionId:string;observationId:string;observationDigest:string;
}
/** A raw-input locator. Canonical membership still comes from the independently pinned catalog. */
export interface ProtocolPublishedSource {
    schemaVersion:1;kind:'published-source';source:ProtocolSourcePosition;contextId:string;captureSha256:string;
    selectionId:string;observationId:string;observationDigest:string;
}
type SourceRecords = {context:ProtocolSourceContext;selection:ProtocolSourceSelection;quarantine:ProtocolSourceQuarantine;
    'observation-link':ProtocolSourceObservationLink;'published-source':ProtocolPublishedSource};
export type ProtocolSourceBindingReadCode = 'missing'|'incomplete'|'invalid';
export class ProtocolSourceBindingReadError extends Error {
    constructor(readonly code:ProtocolSourceBindingReadCode, readonly recordType:keyof SourceRecords,
                readonly recordId:string, message:string) {super(message);this.name='ProtocolSourceBindingReadError';}
}

const hex64 = /^[0-9a-f]{64}$/;
const contextId = /^h45srcctx1:[0-9a-f]{64}$/;
const selectionId = /^h45srcsel1:[0-9a-f]{64}$/;
const quarantineId = /^h45srcq1:[0-9a-f]{64}$/;
const observationLinkId = /^h45srcobs1:[0-9a-f]{64}$/;
const publicationId = /^h45srcpub1:[0-9a-f]{64}$/;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const text = (value:unknown,maximum=256):value is string => typeof value==='string'&&value.length>0&&value.length<=maximum;
const uint32 = (value:unknown,minimum=0):value is number => Number.isSafeInteger(value)&&Number(value)>=minimum&&Number(value)<=0xffffffff;
const keys = (value:any,required:readonly string[]) => value&&typeof value==='object'&&!Array.isArray(value)
    && Object.keys(value).length===required.length&&required.every(key=>Object.hasOwn(value,key));
const fail = ():never => {throw new Error('Invalid protocol source binding record');};
const snapshot = <T>(value:unknown,maximum:number):T => JSON.parse(protocolImmutableJson(value,maximum));
const freeze = <T>(value:T):T => {
    if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
    return value;
};

function profile(value:any):ProtocolSourceProfile {
    if(!keys(value,['id','profileId','components'])||!text(value.id,214)||!text(value.profileId)
        ||!Array.isArray(value.components)||value.components.length<1||value.components.length>64)fail();
    const seen=new Set<string>();
    for(const component of value.components){
        if(!keys(component,['id','runtime','version','sourceRevision','sha256'])||!text(component.id,214)
            ||!['node','rust'].includes(component.runtime)||!text(component.version,128)
            ||!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(component.version)
            ||typeof component.sourceRevision!=='string'||!/^[0-9a-f]{40}$/.test(component.sourceRevision)
            ||typeof component.sha256!=='string'||!hex64.test(component.sha256))fail();
        const prerelease=component.version.split('+')[0].split('-').slice(1).join('-');
        if(prerelease&&prerelease.split('.').some((part:string)=>/^[0-9]+$/.test(part)&&part.length>1&&part[0]==='0'))fail();
        const key=component.runtime+':'+component.id;if(seen.has(key))fail();seen.add(key);
    }
    value.components.sort((a:ProtocolComponent,b:ProtocolComponent)=>{
        const left=a.runtime+':'+a.id,right=b.runtime+':'+b.id;return left<right?-1:left>right?1:0;
    });
    return value;
}

function context(value:unknown):ProtocolSourceContext {
    const record=snapshot<any>(value,8*1024*1024);
    if(!keys(record,['schemaVersion','chainId','protocol','schemaJson'])||record.schemaVersion!==1
        ||typeof record.chainId!=='string'||!hex64.test(record.chainId)||typeof record.schemaJson!=='string')fail();
    profile(record.protocol);
    let schema;try{schema=JSON.parse(record.schemaJson);}catch{fail();}
    if(!schema||typeof schema!=='object'||Array.isArray(schema))fail();
    return record;
}
function selection(value:unknown):ProtocolSourceSelection {
    const record=snapshot<any>(value,64*1024);
    if(!keys(record,['schemaVersion','contextId','readerSessionId','readerRole','assignmentId','source','frameSha256','captureSha256','head','irreversible'])
        ||record.schemaVersion!==1||typeof record.contextId!=='string'||!contextId.test(record.contextId)
        ||!text(record.readerSessionId)||!['live','bulk','repair'].includes(record.readerRole)
        ||(record.assignmentId!==null&&!text(record.assignmentId))
        ||!keys(record.source,['chainId','blockNum','blockId','previousBlockId'])
        ||typeof record.source.chainId!=='string'||!hex64.test(record.source.chainId)||!uint32(record.source.blockNum,1)
        ||typeof record.source.blockId!=='string'||!hex64.test(record.source.blockId)
        ||(record.source.previousBlockId!==null&&(typeof record.source.previousBlockId!=='string'||!hex64.test(record.source.previousBlockId)))
        ||typeof record.frameSha256!=='string'||!hex64.test(record.frameSha256)||typeof record.captureSha256!=='string'||!hex64.test(record.captureSha256))fail();
    for(const position of [record.head,record.irreversible]){
        if(!keys(position,['blockNum','blockId'])||!uint32(position.blockNum)||typeof position.blockId!=='string'||!hex64.test(position.blockId))fail();
    }
    if(record.head.blockNum<record.source.blockNum||record.irreversible.blockNum>record.head.blockNum)fail();
    return record;
}
function quarantine(value:unknown):ProtocolSourceQuarantine {
    const record=snapshot<any>(value,128*1024*1024);
    if(!keys(record,['schemaVersion','chainId','protocol','frameHex','reason','claimedSelectionId'])||record.schemaVersion!==1
        ||typeof record.chainId!=='string'||!hex64.test(record.chainId)||typeof record.frameHex!=='string'
        ||!isProtocolHex(record.frameHex)||!keys(record.reason,['code','message'])
        ||!text(record.reason.code,256)||!text(record.reason.message,4096)
        ||(record.claimedSelectionId!==null&&(typeof record.claimedSelectionId!=='string'||record.claimedSelectionId.length>4096)))fail();
    profile(record.protocol);return record;
}
function observationLink(value:unknown):ProtocolSourceObservationLink {
    const record=snapshot<any>(value,64*1024);
    if(!keys(record,['schemaVersion','selectionId','observationId','observationDigest'])||record.schemaVersion!==1
        ||typeof record.selectionId!=='string'||!selectionId.test(record.selectionId)||typeof record.observationId!=='string'
        ||!/^h45abi1:[0-9a-f]{64}$/.test(record.observationId)||typeof record.observationDigest!=='string'||!hex64.test(record.observationDigest))fail();
    return record;
}
function publication(value:unknown):ProtocolPublishedSource {
    const record=snapshot<any>(value,64*1024);
    if(!keys(record,['schemaVersion','kind','source','contextId','captureSha256','selectionId','observationId','observationDigest'])
        ||record.schemaVersion!==1||record.kind!=='published-source'||!contextId.test(record.contextId)
        ||!hex64.test(record.captureSha256)||!keys(record.source,['chainId','blockNum','blockId','previousBlockId'])
        ||!hex64.test(record.source.chainId)||!uint32(record.source.blockNum,1)||!hex64.test(record.source.blockId)
        ||record.source.previousBlockId!==null&&!hex64.test(record.source.previousBlockId))fail();
    observationLink({schemaVersion:1,selectionId:record.selectionId,observationId:record.observationId,observationDigest:record.observationDigest});
    return record;
}
function id(prefix:string,domain:string,value:unknown):string {return prefix+hash(protocolImmutableJson([domain,value]));}
export function protocolSourceContextId(value:ProtocolSourceContext):string {return id('h45srcctx1:','hyperion-source-context-v1',context(value));}
export function protocolSourceSelectionId(value:ProtocolSourceSelection):string {return id('h45srcsel1:','hyperion-source-selection-v1',selection(value));}
export function protocolSourceQuarantineId(value:ProtocolSourceQuarantine):string {return id('h45srcq1:','hyperion-source-quarantine-v1',quarantine(value));}
export function protocolSourceObservationLinkId(value:string):string {
    if(typeof value!=='string'||!selectionId.test(value))fail();return 'h45srcobs1:'+hash(value);
}
export function protocolPublishedSourceId(chainId:string,blockId:string):string {
    if(!hex64.test(chainId)||!hex64.test(blockId))fail();return id('h45srcpub1:','hyperion-published-source-v1',{chainId,blockId});
}

/** Durable source association only. Neither a stored selection nor a capsule grants progress or ABI authority. */
export class ProtocolSourceBindingStore {
    private readonly bundles:GenerationalProtocolBundleStore;
    /** Contexts and selections only: their IDs hash their content. An observation link's ID does not, so it is always read. */
    private readonly remembered?:ProtocolImmutableRecordMemo;
    get index():string{return this.bundles.index;}
    constructor(client:Client,chain:string,replicas=0,options:{readOnly?:boolean;metadataReadBoundMs?:number;rememberRecords?:boolean}={}) {
        const {rememberRecords,...bundleOptions}=options;
        this.bundles=new GenerationalProtocolBundleStore(protocolStoreGenerations(client,chain,replicas),generation=>new ImmutableProtocolBundleStore(client,chain,replicas,
            'protocol-source-bindings',protocolStoreIndexSuffix('protocol-source-bindings-v1',generation),undefined,bundleOptions),options.readOnly!==true);
        if(rememberRecords===true)this.remembered=new ProtocolImmutableRecordMemo(16*1024*1024);
    }
    async prepareContext(input:ProtocolSourceContext):Promise<{id:string}> {
        const value=context(input),recordId=protocolSourceContextId(value);await this.bundles.prepare(recordId,value);return {id:recordId};
    }
    async prepareSelection(input:ProtocolSourceSelection):Promise<{id:string}> {
        const value=selection(input),storedContext=await this.readRecord('context',value.contextId);
        if(storedContext.chainId!==value.source.chainId)fail();
        const recordId=protocolSourceSelectionId(value);await this.bundles.prepare(recordId,value);return {id:recordId};
    }
    async quarantine(input:ProtocolSourceQuarantine):Promise<{id:string}> {
        const value=quarantine(input),recordId=protocolSourceQuarantineId(value);await this.bundles.prepare(recordId,value);return {id:recordId};
    }
    async readSelection(recordId:string,signal?:AbortSignal):Promise<{selection:ProtocolSourceSelection;context:ProtocolSourceContext}> {
        signal?.throwIfAborted();
        const value=await this.readRecord('selection',recordId,signal),storedContext=await this.readRecord('context',value.contextId,signal);
        signal?.throwIfAborted();
        if(storedContext.chainId!==value.source.chainId)throw new ProtocolSourceBindingReadError('invalid','selection',recordId,'Source context chain mismatch');
        return {selection:value,context:storedContext};
    }
    async readContext(recordId:string,signal?:AbortSignal):Promise<ProtocolSourceContext> {
        signal?.throwIfAborted();const value=await this.readRecord('context',recordId,signal);
        signal?.throwIfAborted();return value;
    }
    async readQuarantine(recordId:string,signal?:AbortSignal):Promise<ProtocolSourceQuarantine> {
        signal?.throwIfAborted();const value=await this.readRecord('quarantine',recordId,signal);
        signal?.throwIfAborted();return value;
    }
    async prepareObservationLink(input:ProtocolSourceObservationLink):Promise<{id:string}> {
        const value=observationLink(input);await this.readSelection(value.selectionId);
        const recordId=protocolSourceObservationLinkId(value.selectionId);
        await this.bundles.prepare(recordId,value);return {id:recordId};
    }
    async readObservationLink(selectedId:string,signal?:AbortSignal):Promise<ProtocolSourceObservationLink> {
        signal?.throwIfAborted();
        if(typeof selectedId!=='string'||!selectionId.test(selectedId))throw new ProtocolSourceBindingReadError('invalid','observation-link',selectedId,'Invalid source selection ID');
        const recordId=protocolSourceObservationLinkId(selectedId);
        const value=await this.readRecord('observation-link',recordId,signal);
        signal?.throwIfAborted();
        if(value.selectionId!==selectedId)throw new ProtocolSourceBindingReadError('invalid','observation-link',recordId,'Source observation link mismatch');
        await this.readSelection(selectedId,signal);signal?.throwIfAborted();return value;
    }
    /** Realtime existence hint only: the first selection, in order, whose observation link is not stored yet.
     * A present link still has to be read in full, and a link that appears later is found by the next call. */
    async firstUnlinkedSelection(selectedIds:readonly string[],signal?:AbortSignal):Promise<string|null> {
        if(!Array.isArray(selectedIds)||selectedIds.some(value=>typeof value!=='string'||!selectionId.test(value)))
            throw new Error('Invalid source selection IDs');
        for(let start=0;start<selectedIds.length;start+=protocolBundleMembershipHintBounds.maximumItems){
            const group=selectedIds.slice(start,start+protocolBundleMembershipHintBounds.maximumItems);
            const missing=await this.bundles.missingManifestHint(group.map(value=>protocolSourceObservationLinkId(value)),signal);
            if(missing!==null)return group[group.findIndex(value=>protocolSourceObservationLinkId(value)===missing)]!;
        }
        return null;
    }
    /** The caller validates catalog membership and complete original observation before publication. */
    async preparePublishedSource(selectedId:string,checkpoint:()=>Promise<void>):Promise<ProtocolPublishedSource> {
        await checkpoint();const {selection}=await this.readSelection(selectedId),link=await this.readObservationLink(selectedId);
        const value=publication({kind:'published-source',source:selection.source,contextId:selection.contextId,
            captureSha256:selection.captureSha256,...link});
        const recordId=protocolPublishedSourceId(value.source.chainId,value.source.blockId);
        const equivalent=(prior:ProtocolPublishedSource)=>{
            const {selectionId:_old,...left}=prior,{selectionId:_new,...right}=value;
            if(protocolImmutableJson(left)!==protocolImmutableJson(right))throw new Error('Published source conflicts with original capture');
            return prior;
        };
        let prior:ProtocolPublishedSource|undefined;
        try{prior=await this.readRecord('published-source',recordId);}catch(error){
            if(!(error instanceof ProtocolSourceBindingReadError)||error.code!=='missing')throw error;
        }
        await checkpoint();if(prior){equivalent(prior);await this.bundles.prepare(recordId,prior);await checkpoint();return prior;}
        try{await this.bundles.prepare(recordId,value);}catch(error){
            // A concurrent equivalent recapture may have won. Partial/unknown writes remain retryable failures.
            if(!(error instanceof Error)||!error.message.startsWith('Immutable ABI observation conflict:'))throw error;
            const settled=await this.readRecord('published-source',recordId);equivalent(settled);await checkpoint();
            await this.bundles.prepare(recordId,settled);await checkpoint();return settled;
        }
        const settled=await this.readRecord('published-source',recordId);await checkpoint();return equivalent(settled);
    }
    async readPublishedSource(chainId:string,blockId:string,signal?:AbortSignal):Promise<ProtocolPublishedSource> {
        const value=await this.readRecord('published-source',protocolPublishedSourceId(chainId,blockId),signal);
        const {selection}=await this.readSelection(value.selectionId,signal),link=await this.readObservationLink(value.selectionId,signal);
        if(protocolImmutableJson(selection.source)!==protocolImmutableJson(value.source)||selection.contextId!==value.contextId
            ||selection.captureSha256!==value.captureSha256||link.observationId!==value.observationId||link.observationDigest!==value.observationDigest)
            throw new ProtocolSourceBindingReadError('invalid','published-source',protocolPublishedSourceId(chainId,blockId),'Published source reference differs');
        return value;
    }
    private async readRecord<K extends keyof SourceRecords>(kind:K,recordId:string,signal?:AbortSignal):Promise<SourceRecords[K]> {
        signal?.throwIfAborted();
        const syntax={context:contextId,selection:selectionId,quarantine:quarantineId,'observation-link':observationLinkId,'published-source':publicationId}[kind];
        if(typeof recordId!=='string'||!syntax.test(recordId))throw new ProtocolSourceBindingReadError('invalid',kind,recordId,'Invalid source binding ID');
        const memo=kind==='context'||kind==='selection'?this.remembered:undefined,known=memo?.get(recordId);
        if(known!==undefined)return known as SourceRecords[K];
        let value:unknown;
        try {value=await this.bundles.read(recordId,signal);} catch(error) {
            signal?.throwIfAborted();
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolSourceBindingReadError(error.code,kind,recordId,error.message);
            throw error; // Infrastructure, unsafe retention and malformed ES receipts must prevent ACK.
        }
        signal?.throwIfAborted();
        try {
            const normalized=kind==='context'?context(value):kind==='selection'?selection(value):kind==='quarantine'?quarantine(value)
                :kind==='published-source'?publication(value):observationLink(value);
            const expected=kind==='context'?protocolSourceContextId(normalized as ProtocolSourceContext)
                :kind==='selection'?protocolSourceSelectionId(normalized as ProtocolSourceSelection):kind==='quarantine'?protocolSourceQuarantineId(normalized as ProtocolSourceQuarantine)
                :kind==='published-source'?protocolPublishedSourceId((normalized as ProtocolPublishedSource).source.chainId,(normalized as ProtocolPublishedSource).source.blockId)
                :protocolSourceObservationLinkId((normalized as ProtocolSourceObservationLink).selectionId);
            if(expected!==recordId)fail();const result=freeze(normalized) as SourceRecords[K];
            memo?.set(recordId,result,protocolImmutableJson(result).length);
            signal?.throwIfAborted();return result;
        } catch {
            signal?.throwIfAborted();
            throw new ProtocolSourceBindingReadError('invalid',kind,recordId,'Stored source binding type or identity mismatch');
        }
    }
}
