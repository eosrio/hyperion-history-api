import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import type {ProtocolComponent} from '@eosrio/hyperion-sdk/protocol';
import {ImmutableProtocolBundleStore, ImmutableProtocolBundleReadError, protocolImmutableJson} from './immutable-bundle-store.js';
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
type SourceRecords = {context:ProtocolSourceContext;selection:ProtocolSourceSelection;quarantine:ProtocolSourceQuarantine;
    'observation-link':ProtocolSourceObservationLink};
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
function id(prefix:string,domain:string,value:unknown):string {return prefix+hash(protocolImmutableJson([domain,value]));}
export function protocolSourceContextId(value:ProtocolSourceContext):string {return id('h45srcctx1:','hyperion-source-context-v1',context(value));}
export function protocolSourceSelectionId(value:ProtocolSourceSelection):string {return id('h45srcsel1:','hyperion-source-selection-v1',selection(value));}
export function protocolSourceQuarantineId(value:ProtocolSourceQuarantine):string {return id('h45srcq1:','hyperion-source-quarantine-v1',quarantine(value));}
export function protocolSourceObservationLinkId(value:string):string {
    if(typeof value!=='string'||!selectionId.test(value))fail();return 'h45srcobs1:'+hash(value);
}

/** Durable source association only. Neither a stored selection nor a capsule grants progress or ABI authority. */
export class ProtocolSourceBindingStore {
    private readonly bundles:ImmutableProtocolBundleStore;
    get index():string{return this.bundles.index;}
    constructor(client:Client,chain:string,replicas=0,options:{readOnly?:boolean}={}) {
        this.bundles=new ImmutableProtocolBundleStore(client,chain,replicas,'protocol-source-bindings','protocol-source-bindings-v1',undefined,options);
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
    async readSelection(recordId:string):Promise<{selection:ProtocolSourceSelection;context:ProtocolSourceContext}> {
        const value=await this.readRecord('selection',recordId),storedContext=await this.readRecord('context',value.contextId);
        if(storedContext.chainId!==value.source.chainId)throw new ProtocolSourceBindingReadError('invalid','selection',recordId,'Source context chain mismatch');
        return {selection:value,context:storedContext};
    }
    async readContext(recordId:string):Promise<ProtocolSourceContext> {return this.readRecord('context',recordId);}
    async readQuarantine(recordId:string):Promise<ProtocolSourceQuarantine> {return this.readRecord('quarantine',recordId);}
    async prepareObservationLink(input:ProtocolSourceObservationLink):Promise<{id:string}> {
        const value=observationLink(input);await this.readSelection(value.selectionId);
        const recordId=protocolSourceObservationLinkId(value.selectionId);
        await this.bundles.prepare(recordId,value);return {id:recordId};
    }
    async readObservationLink(selectedId:string):Promise<ProtocolSourceObservationLink> {
        if(typeof selectedId!=='string'||!selectionId.test(selectedId))throw new ProtocolSourceBindingReadError('invalid','observation-link',selectedId,'Invalid source selection ID');
        const recordId=protocolSourceObservationLinkId(selectedId);
        const value=await this.readRecord('observation-link',recordId);
        if(value.selectionId!==selectedId)throw new ProtocolSourceBindingReadError('invalid','observation-link',recordId,'Source observation link mismatch');
        await this.readSelection(selectedId);return value;
    }
    private async readRecord<K extends keyof SourceRecords>(kind:K,recordId:string):Promise<SourceRecords[K]> {
        const syntax={context:contextId,selection:selectionId,quarantine:quarantineId,'observation-link':observationLinkId}[kind];
        if(typeof recordId!=='string'||!syntax.test(recordId))throw new ProtocolSourceBindingReadError('invalid',kind,recordId,'Invalid source binding ID');
        let value:unknown;
        try {value=await this.bundles.read(recordId);} catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolSourceBindingReadError(error.code,kind,recordId,error.message);
            throw error; // Infrastructure, unsafe retention and malformed ES receipts must prevent ACK.
        }
        try {
            const normalized=kind==='context'?context(value):kind==='selection'?selection(value):kind==='quarantine'?quarantine(value):observationLink(value);
            const expected=kind==='context'?protocolSourceContextId(normalized as ProtocolSourceContext)
                :kind==='selection'?protocolSourceSelectionId(normalized as ProtocolSourceSelection):kind==='quarantine'?protocolSourceQuarantineId(normalized as ProtocolSourceQuarantine)
                :protocolSourceObservationLinkId((normalized as ProtocolSourceObservationLink).selectionId);
            if(expected!==recordId)fail();return freeze(normalized) as any;
        } catch {throw new ProtocolSourceBindingReadError('invalid',kind,recordId,'Stored source binding type or identity mismatch');}
    }
}
