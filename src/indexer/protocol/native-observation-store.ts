import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {validateProtocolNativeActionObservations,type ProtocolNativeActionObservations} from '@eosrio/hyperion-sdk/protocol';
import {ProtocolAbiObservationStore,type ProtocolAbiObservationRecord} from './abi-observation-store.js';
import {ProtocolSourceBindingStore,ProtocolSourceBindingReadError,type ProtocolSourceContext,type ProtocolSourceObservationLink,
    type ProtocolSourcePosition,type ProtocolSourceProfile,type ProtocolSourceSelection} from './source-bindings.js';
import {ImmutableProtocolBundleStore,ImmutableProtocolBundleReadError,protocolImmutableJson,type ImmutableProtocolBundleBounds} from './immutable-bundle-store.js';

export const protocolNativeObservationBounds=Object.freeze({chunkBytes:512*1024,maximumBytes:64*1024*1024,maximumChunks:128});
export interface ProtocolNativeObservationRecord {
    schemaVersion:1;kind:'observation';nativeInterfaceVersion:1;contextId:string;
    protocol:ProtocolSourceProfile;source:ProtocolSourcePosition;
    captureRef:{abiObservationId:string;abiObservationDigest:string;inputSha256:string};
    inventory:{schemaVersion:1;inputCount:number;firstReceiverCount:number;sha256:string}|null;
    observation:{status:'observed';facts:ProtocolNativeActionObservations}|{status:'incomplete';error:{code:string;message:string}};
}
export interface ProtocolSourceNativeObservationLink {
    schemaVersion:1;kind:'source-link';selectionId:string;observationId:string;observationDigest:string;
}
export interface ProtocolNativeObservationReadback {
    linkId:string;link:ProtocolSourceNativeObservationLink;record:ProtocolNativeObservationRecord;
    selection:ProtocolSourceSelection;context:ProtocolSourceContext;
    abiObservation:ProtocolAbiObservationRecord;abiLink:ProtocolSourceObservationLink;
}
export class NativeObservationReadError extends Error {
    constructor(readonly code:'missing'|'incomplete'|'invalid',readonly recordType:'observation'|'source-link'|'reference',readonly recordId:string,message:string){
        super(message);this.name='NativeObservationReadError';
    }
}
type References=Pick<ProtocolNativeObservationReadback,'selection'|'context'|'abiObservation'|'abiLink'>;
const hex64=/^[0-9a-f]{64}$/;
const sourceSelectionId=/^h45srcsel1:[0-9a-f]{64}$/;
const nativeObservationId=/^h45natobs1:[0-9a-f]{64}$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const keys=(value:any,fields:readonly string[])=>value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const text=(value:unknown,maximum:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=maximum;
const digest=(value:unknown):value is string=>typeof value==='string'&&hex64.test(value);
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const fail=():never=>{throw new Error('Invalid native observation record');};
const freeze=<T>(value:T):T=>{
    if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
    return value;
};
function normalizeRecord(input:unknown,maximumBytes:number):ProtocolNativeObservationRecord {
    // Take one detached caller snapshot before any I/O; never retain mutable provider data.
    const record=JSON.parse(protocolImmutableJson(input,maximumBytes));
    if(!keys(record,['schemaVersion','kind','nativeInterfaceVersion','contextId','protocol','source','captureRef','inventory','observation'])
        ||record.schemaVersion!==1||record.kind!=='observation'||record.nativeInterfaceVersion!==1
        ||typeof record.contextId!=='string'||!/^h45srcctx1:[0-9a-f]{64}$/.test(record.contextId))fail();
    const profile=record.protocol;
    if(!keys(profile,['id','profileId','components'])||!text(profile.id,214)||!text(profile.profileId,256)
        ||!Array.isArray(profile.components)||profile.components.length<1||profile.components.length>64)fail();
    const seen=new Set<string>();
    for(const component of profile.components){
        if(!keys(component,['id','runtime','version','sourceRevision','sha256'])||!text(component.id,214)
            ||!['node','rust'].includes(component.runtime)||!text(component.version,128)
            ||!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(component.version)
            ||typeof component.sourceRevision!=='string'||!/^[0-9a-f]{40}$/.test(component.sourceRevision)||!digest(component.sha256))fail();
        const prerelease=component.version.split('+')[0].split('-').slice(1).join('-');
        if(prerelease&&prerelease.split('.').some((part:string)=>/^[0-9]+$/.test(part)&&part.length>1&&part[0]==='0'))fail();
        const key=component.runtime+':'+component.id;if(seen.has(key))fail();seen.add(key);
    }
    profile.components.sort((a:any,b:any)=>{const left=a.runtime+':'+a.id,right=b.runtime+':'+b.id;return left<right?-1:left>right?1:0;});
    const source=record.source;
    if(!keys(source,['chainId','blockNum','blockId','previousBlockId'])||!digest(source.chainId)||!digest(source.blockId)
        ||!count(source.blockNum)||source.blockNum<1||source.blockNum>0xffffffff
        ||(source.previousBlockId!==null&&!digest(source.previousBlockId)))fail();
    const capture=record.captureRef;
    if(!keys(capture,['abiObservationId','abiObservationDigest','inputSha256'])
        ||typeof capture.abiObservationId!=='string'||!/^h45abi1:[0-9a-f]{64}$/.test(capture.abiObservationId)
        ||!digest(capture.abiObservationDigest)||!digest(capture.inputSha256))fail();
    const inventory=record.inventory;
    if(inventory!==null&&(!keys(inventory,['schemaVersion','inputCount','firstReceiverCount','sha256'])||inventory.schemaVersion!==1
        ||!count(inventory.inputCount)||!count(inventory.firstReceiverCount)||inventory.firstReceiverCount>inventory.inputCount||!digest(inventory.sha256)))fail();
    const observation=record.observation;
    if(observation?.status==='observed'){
        if(!keys(observation,['status','facts'])||inventory===null)fail();
        const checked=validateProtocolNativeActionObservations(observation.facts);
        if(!checked.valid)throw new Error('Invalid native action observations');
        if(inventory.firstReceiverCount!==checked.observations.decisions.length)fail();
        observation.facts=checked.observations;
    }else if(observation?.status==='incomplete'){
        if(!keys(observation,['status','error'])||!keys(observation.error,['code','message'])
            ||!text(observation.error.code,128)||!text(observation.error.message,4096))fail();
    }else fail();
    return freeze(record);
}
function observationId(record:ProtocolNativeObservationRecord):string {
    return 'h45natobs1:'+hash(protocolImmutableJson(['hyperion-native-action-observation-v1',1,
        record.contextId,record.protocol,record.source,record.captureRef]));
}
/** Source/profile identity excludes derived outcomes and delivery/session/head/LIB metadata. */
export function protocolNativeObservationId(input:ProtocolNativeObservationRecord):string {
    return observationId(normalizeRecord(input,protocolNativeObservationBounds.maximumBytes));
}
export function protocolSourceNativeObservationLinkId(selectionId:string):string {
    if(typeof selectionId!=='string'||!sourceSelectionId.test(selectionId))throw new NativeObservationReadError('invalid','source-link',selectionId,'Invalid source selection ID');
    return 'h45srcnat1:'+hash(protocolImmutableJson(['hyperion-source-native-observation-v1',selectionId]));
}
function normalizeLink(input:unknown,selectionId:string):ProtocolSourceNativeObservationLink {
    const link=JSON.parse(protocolImmutableJson(input,64*1024));
    if(!keys(link,['schemaVersion','kind','selectionId','observationId','observationDigest'])||link.schemaVersion!==1||link.kind!=='source-link'
        ||link.selectionId!==selectionId||typeof link.observationId!=='string'||!nativeObservationId.test(link.observationId)||!digest(link.observationDigest))fail();
    return Object.freeze(link);
}

/** Retained evidence and exact references only; no canonical, native-decoding or readiness authority. */
export class ProtocolNativeObservationStore {
    readonly index:string;
    private readonly bundles:ImmutableProtocolBundleStore;
    private readonly sources:ProtocolSourceBindingStore;
    private readonly abis:ProtocolAbiObservationStore;
    private readonly bounds:ImmutableProtocolBundleBounds;
    private readonly readOnly:boolean;
    constructor(private readonly client:Client,private readonly chain:string,private readonly replicas=0,bounds:ImmutableProtocolBundleBounds=protocolNativeObservationBounds,options:{readOnly?:boolean}={}) {
        if(bounds.maximumBytes>protocolNativeObservationBounds.maximumBytes||bounds.maximumChunks>protocolNativeObservationBounds.maximumChunks) {
            throw new Error('Invalid native observation storage bounds');
        }
        this.bounds={...bounds};this.readOnly=options.readOnly===true;
        this.bundles=new ImmutableProtocolBundleStore(client,chain,replicas,'protocol-native-actions','protocol-native-actions-v1',bounds,{readOnly:this.readOnly});
        this.sources=new ProtocolSourceBindingStore(client,chain,replicas,{readOnly:true});
        this.abis=new ProtocolAbiObservationStore(client,chain,replicas,undefined,{readOnly:true});
        this.index=this.bundles.index;
    }
    /** A detached read handle cannot provision indices or prepare observations. */
    asReadOnly():ProtocolNativeObservationStore {
        return new ProtocolNativeObservationStore(this.client,this.chain,this.replicas,this.bounds,{readOnly:true});
    }
    private async references(selectionId:string,signal?:AbortSignal):Promise<References> {
        signal?.throwIfAborted();
        try {
            const {selection,context}=await this.sources.readSelection(selectionId,signal);
            signal?.throwIfAborted();
            const abiLink=await this.sources.readObservationLink(selectionId,signal);
            signal?.throwIfAborted();
            const abiObservation=await this.abis.read(abiLink.observationId,signal);
            signal?.throwIfAborted();
            const {inputSha256,...source}=abiObservation.source;
            if(hash(protocolImmutableJson(abiObservation))!==abiLink.observationDigest
                ||protocolImmutableJson(source)!==protocolImmutableJson(selection.source)
                ||protocolImmutableJson(abiObservation.protocol)!==protocolImmutableJson(context.protocol)
                ||abiObservation.capture.schemaJson!==context.schemaJson||selection.captureSha256!==inputSha256) {
                throw new NativeObservationReadError('invalid','reference',selectionId,'Native observation retained source references disagree');
            }
            return {selection,context,abiObservation,abiLink};
        }catch(error){
            signal?.throwIfAborted();
            if(error instanceof ProtocolSourceBindingReadError||error instanceof ImmutableProtocolBundleReadError) {
                throw new NativeObservationReadError(error.code,'reference',selectionId,error.message);
            }
            throw error;
        }finally{signal?.throwIfAborted();}
    }
    private assertReferences(record:ProtocolNativeObservationRecord,references:References,selectionId:string) {
        const {selection,context,abiObservation,abiLink}=references;
        if(record.observation.status==='observed'&&(!abiObservation.capture.blockHex||!abiObservation.capture.tracesHex)) {
            throw new NativeObservationReadError('invalid','reference',selectionId,'Observed native evidence requires original block and traces');
        }
        if(record.contextId!==selection.contextId||protocolImmutableJson(record.protocol)!==protocolImmutableJson(context.protocol)
            ||protocolImmutableJson(record.source)!==protocolImmutableJson(selection.source)
            ||record.captureRef.abiObservationId!==abiLink.observationId||record.captureRef.abiObservationDigest!==abiLink.observationDigest
            ||record.captureRef.inputSha256!==abiObservation.source.inputSha256) {
            throw new NativeObservationReadError('invalid','reference',selectionId,'Native observation does not match retained source references');
        }
    }
    private async readBundle(recordType:'observation'|'source-link',id:string,signal?:AbortSignal):Promise<unknown> {
        signal?.throwIfAborted();
        try{return await this.bundles.read(id,signal);}
        catch(error){
            signal?.throwIfAborted();
            if(error instanceof ImmutableProtocolBundleReadError)throw new NativeObservationReadError(error.code,recordType,id,error.message);
            throw error;
        }finally{signal?.throwIfAborted();}
    }
    async prepare(selectionId:string,input:ProtocolNativeObservationRecord):Promise<ProtocolNativeObservationReadback> {
        if(this.readOnly)throw new Error('Read-only native observations cannot prepare records');
        const linkId=protocolSourceNativeObservationLinkId(selectionId),record=normalizeRecord(input,this.bounds.maximumBytes);
        const id=observationId(record),observationDigest=hash(protocolImmutableJson(record,this.bounds.maximumBytes));
        this.assertReferences(record,await this.references(selectionId),selectionId);
        await this.bundles.prepare(id,record);
        const link:ProtocolSourceNativeObservationLink={schemaVersion:1,kind:'source-link',selectionId,observationId:id,observationDigest};
        await this.bundles.prepare(linkId,link);
        const opening=await this.readSelection(selectionId);
        if(opening.link.observationId!==id||opening.link.observationDigest!==observationDigest
            ||hash(protocolImmutableJson(opening.record,this.bounds.maximumBytes))!==observationDigest) {
            throw new NativeObservationReadError('invalid','observation',id,'Native observation readback differs from prepared evidence');
        }
        return opening;
    }
    async readSelection(selectionId:string,signal?:AbortSignal):Promise<ProtocolNativeObservationReadback> {
        signal?.throwIfAborted();
        try {
            const linkId=protocolSourceNativeObservationLinkId(selectionId),linkValue=await this.readBundle('source-link',linkId,signal);
            signal?.throwIfAborted();
            let link:ProtocolSourceNativeObservationLink;
            try{link=normalizeLink(linkValue,selectionId);}
            catch{signal?.throwIfAborted();throw new NativeObservationReadError('invalid','source-link',linkId,'Invalid native observation selection link');}
            const value=await this.readBundle('observation',link.observationId,signal);
            signal?.throwIfAborted();
            let record:ProtocolNativeObservationRecord;
            try {
                record=normalizeRecord(value,this.bounds.maximumBytes);
                if(observationId(record)!==link.observationId||hash(protocolImmutableJson(record,this.bounds.maximumBytes))!==link.observationDigest)fail();
            }catch{signal?.throwIfAborted();throw new NativeObservationReadError('invalid','observation',link.observationId,'Native observation identity or digest mismatch');}
            signal?.throwIfAborted();
            const references=await this.references(selectionId,signal);
            signal?.throwIfAborted();this.assertReferences(record,references,selectionId);
            return {linkId,link,record,...references};
        }finally{signal?.throwIfAborted();}
    }
}
