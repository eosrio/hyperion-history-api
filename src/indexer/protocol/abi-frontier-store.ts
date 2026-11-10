import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleStore,ImmutableProtocolBundleReadError,ProtocolImmutableRecordMemo,ProtocolMetadataFreshness,protocolImmutableJson,
    type ImmutableProtocolBundleExpectation} from './immutable-bundle-store.js';
export type {ImmutableProtocolBundleExpectation as ProtocolAbiFrontierExpectation} from './immutable-bundle-store.js';
import {historicalAddressId, historicalAddressIdentity, ProtocolAbiHistoricalAddressReadError,
    type ProtocolAbiHistoricalAddress, type ProtocolAbiHistoricalAddressIdentity} from './abi-history.js';
import type {ProtocolAbiHeadCertificate} from './abi-proof.js';

export interface ProtocolAbiFrontierToken {seqNo:number;primaryTerm:number}
export interface ProtocolAbiFrontierControl extends ProtocolAbiFrontierToken {value:unknown}
export interface ProtocolAbiAccountUpdate {account:string;state:unknown|null}
declare const historicalPreparation:unique symbol;
/** Process-local capability. Only the issuing store can resume it; it contains no serialized authority. */
export interface ProtocolAbiHistoricalRootPreparation {readonly [historicalPreparation]:true}
export type ProtocolAbiFrontierRecordKind='commit'|'account-state'|'bucket'|'root'|'certificate';
export class ProtocolAbiFrontierReadError extends Error {
    constructor(readonly code:'missing'|'incomplete'|'invalid',readonly recordKind:ProtocolAbiFrontierRecordKind,
                readonly recordId:string,message:string) {super(message);this.name='ProtocolAbiFrontierReadError';}
}
export class ProtocolAbiFrontierConflictError extends Error {
    readonly code='protocol_abi_frontier_conflict';
    constructor(readonly current:ProtocolAbiFrontierToken|null) {super('ABI frontier control compare-and-set conflict');this.name='ProtocolAbiFrontierConflictError';}
}
export class ProtocolAbiFrontierLimitError extends Error {
    readonly code='protocol_abi_frontier_limit';
    constructor(message:string) {super(message);this.name='ProtocolAbiFrontierLimitError';}
}

const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const hex64=/^[0-9a-f]{64}$/;
const prefix={commit:'h45abicmt1:','account-state':'h45abist1:',bucket:'h45abibkt1:',root:'h45abiroot1:',certificate:'h45abicert1:'};
const immutableLimit={bytes:128*1024*1024,nodes:1000000};
const limits={commit:immutableLimit,'account-state':immutableLimit,
    bucket:{bytes:4*1024*1024,nodes:50000},root:{bytes:64*1024,nodes:1024},certificate:{bytes:64*1024,nodes:2048},
    control:{bytes:1024*1024,nodes:20000}};
const recordKeys=(value:any,keys:readonly string[])=>value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const validAccount=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.isWellFormed();
const validToken=(value:any):value is ProtocolAbiFrontierToken=>value&&Number.isSafeInteger(value.seqNo)&&value.seqNo>=0
    &&Number.isSafeInteger(value.primaryTerm)&&value.primaryTerm>=1;
const validId=(kind:ProtocolAbiFrontierRecordKind,id:unknown):id is string=>typeof id==='string'
    &&id.startsWith(prefix[kind])&&hex64.test(id.slice(prefix[kind].length));
const settingsValue=(entry:any,name:string)=>entry?.settings?.[`index.${name}`]??entry?.settings?.index?.[name]
    ??entry?.defaults?.[`index.${name}`]??entry?.defaults?.index?.[name];

/** Detach portable data and impose a smaller aggregate node budget before any store operation. */
function bounded(value:unknown,maximum:{bytes:number;nodes:number}):{value:any;json:string} {
    let json:string;
    try {json=protocolImmutableJson(value,maximum.bytes);}catch(error) {
        if(error instanceof Error&&['ABI observation exceeds bounded JSON byte budget','ABI observation exceeds bounded JSON node/depth budget'].includes(error.message)) {
            throw new ProtocolAbiFrontierLimitError(error.message);
        }
        throw error;
    }
    const copy=JSON.parse(json);
    const pending=[copy];let count=0;
    while(pending.length){
        const item=pending.pop();if(++count>maximum.nodes)throw new ProtocolAbiFrontierLimitError('ABI frontier record exceeds bounded node budget');
        if(item&&typeof item==='object')for(const child of Object.values(item))pending.push(child);
    }
    return {value:copy,json};
}

interface FrontierRecord {schemaVersion:1;chain:string;kind:ProtocolAbiFrontierRecordKind;value:any}
interface ControlDocument {schemaVersion:1;kind:'control';digest:string;payload:string}
const controlFields={schemaVersion:{type:'integer'},kind:{type:'keyword'},digest:{type:'keyword'},payload:{type:'binary'}} as const;

function deepFreeze<T>(value:T):T {
    const pending:unknown[]=[value];
    while(pending.length){
        const item=pending.pop();
        if(!item||typeof item!=='object'||Object.isFrozen(item))continue;
        Object.freeze(item);
        for(const child of Object.values(item))pending.push(child);
    }
    return value;
}

export {ProtocolImmutableRecordMemo as ProtocolAbiFrontierRecordMemo};

/** Physical storage only. The coordinator owns source/profile validation, ownership, generations and readiness. */
export class ProtocolAbiFrontierStore {
    readonly controlIndex:string;
    readonly recordsIndex:string;
    private readonly bundles:ImmutableProtocolBundleStore;
    private provisioned?:Promise<void>;
    private readonly metadata:ProtocolMetadataFreshness;
    private readonly verifiedBuckets=new WeakMap<object,Readonly<Record<string,string>>>();
    private readonly historicalPreparations=new WeakMap<ProtocolAbiHistoricalRootPreparation,{
        input:string;steps:AsyncGenerator<void,string>;result?:string;
    }>();

    constructor(private readonly client:Client,private readonly chain:string,private readonly replicas=0,
                private readonly options:{readOnly?:boolean;recordMemo?:ProtocolImmutableRecordMemo;metadataReadBoundMs?:number}={}) {
        if(!/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(chain)||!Number.isSafeInteger(replicas)||replicas<0)throw new Error('Invalid ABI frontier store configuration');
        this.controlIndex=chain+'-protocol-abi-frontier-v1';this.recordsIndex=chain+'-protocol-abi-frontier-records-v1';
        this.bundles=new ImmutableProtocolBundleStore(client,chain,replicas,'protocol-abi-frontier-records','protocol-abi-frontier-records-v1',undefined,
            {readOnly:options.readOnly,rejectLifecycle:true,metadataReadBoundMs:options.metadataReadBoundMs});
        this.metadata=new ProtocolMetadataFreshness(options.metadataReadBoundMs);
    }

    /** Preserve the physical namespace while refusing provisioning and writes. */
    asReadOnly():ProtocolAbiFrontierStore {
        return new ProtocolAbiFrontierStore(this.client,this.chain,this.replicas,{readOnly:true,recordMemo:this.options.recordMemo,
            metadataReadBoundMs:this.options.metadataReadBoundMs});
    }

    /** A separate handle for reducing blocks, so only account reads ever skip a store read. Writes, readback and activation keep this store. */
    asAccountReader():ProtocolAbiFrontierStore {
        return new ProtocolAbiFrontierStore(this.client,this.chain,this.replicas,{readOnly:true,recordMemo:new ProtocolImmutableRecordMemo(),
            metadataReadBoundMs:this.options.metadataReadBoundMs});
    }

    /** Control index only: immutable records are checked by their bundle store. */
    private async initialize(write:boolean,signal?:AbortSignal) {
        signal?.throwIfAborted();
        await this.metadata.run(write,()=>this.validate(signal));
        signal?.throwIfAborted();
    }
    private async validate(signal?:AbortSignal) {
        signal?.throwIfAborted();
        const index=this.controlIndex,kind='protocol-abi-frontier',fields=controlFields;
        this.provisioned??=(this.options.readOnly?Promise.resolve():this.provision(index,kind,fields))
            .catch(error=>{this.provisioned=undefined;throw error;});
        await this.provisioned;
        signal?.throwIfAborted();
        const metadata=await this.client.indices.get({index,features:['mappings','settings'],flat_settings:true,include_defaults:true},{signal});
        const mapping=metadata[index]?.mappings;
        signal?.throwIfAborted();
        if(Object.keys(metadata).length!==1||metadata[index]?.data_stream!==undefined
            ||mapping?._meta?.hyperion_kind!==kind||mapping._meta.schema_version!==1
            ||mapping.dynamic!=='strict'||mapping._source?.enabled===false
            ||(mapping._source&&(Object.hasOwn(mapping._source,'includes')||Object.hasOwn(mapping._source,'excludes')
                ||(Object.hasOwn(mapping._source,'mode')&&mapping._source.mode!=='stored')))
            ||Object.entries(fields).some(([name,field])=>mapping.properties?.[name]?.type!==field.type)) {
            throw new Error('Unowned or incompatible ABI frontier index mapping');
        }
        const entry=metadata[index];
        signal?.throwIfAborted();
        const mode=settingsValue(entry,'mapping.source.mode');
        if(!entry||settingsValue(entry,'translog.durability')!=='request'
            ||Number(settingsValue(entry,'number_of_shards'))!==1||Number(settingsValue(entry,'number_of_replicas'))!==this.replicas
            ||!['false',false].includes(settingsValue(entry,'auto_expand_replicas'))
            ||(mode!==undefined&&String(mode).toLowerCase()!=='stored')
            ||['default_pipeline','final_pipeline'].some(name=>{
                const pipeline=settingsValue(entry,name);return pipeline!==undefined&&pipeline!=='_none';
            })||['lifecycle.name','lifecycle.rollover_alias'].some(name=>{
                const lifecycle=settingsValue(entry,name);return lifecycle!==undefined&&lifecycle!=='';
            }))throw new Error('ABI frontier index durability or retention is incompatible');
    }

    private async provision(index:string,kind:string,fields:typeof controlFields) {
        try {
            const created=await this.client.indices.create({index,settings:{number_of_shards:1,number_of_replicas:this.replicas,
                'translog.durability':'request',auto_expand_replicas:'false',default_pipeline:'_none',final_pipeline:'_none'},
                mappings:{_meta:{hyperion_kind:kind,schema_version:1},dynamic:'strict',properties:fields}});
            if(created.acknowledged!==true||created.shards_acknowledged!==true||created.index!==index)throw new Error('ABI frontier index creation was not acknowledged');
        } catch(error:any) {
            if(error?.meta?.statusCode!==400||error?.meta?.body?.error?.type!=='resource_already_exists_exception')throw error;
        }
    }

    private document(value:unknown):{document:ControlDocument;value:unknown} {
        const copy=bounded(value,limits.control),payload=Buffer.from(copy.json);
        return {document:{schemaVersion:1,kind:'control',digest:hash(payload),payload:payload.toString('base64')},value:copy.value};
    }

    /** Read tokens describe observed bytes only; only compareAndSet returns a fresh complete-copy receipt. */
    async readControl(signal?:AbortSignal):Promise<ProtocolAbiFrontierControl|null> {
        await this.initialize(false,signal);
        let response:any;
        try {response=await this.client.get({index:this.controlIndex,id:'control',realtime:true,_source:true},{signal});signal?.throwIfAborted();} catch(error:any) {
            if(error?.meta?.statusCode===404&&error?.meta?.body?.found===false&&error?.meta?.body?._index===this.controlIndex
                &&error?.meta?.body?._id==='control')return null;
            throw error;
        }
        if(!response||response._index!==this.controlIndex||response._id!=='control'||response.found!==true
            ||!validToken({seqNo:response._seq_no,primaryTerm:response._primary_term}))throw new Error('Incomplete ABI frontier control realtime read');
        const doc=response._source;
        if(!recordKeys(doc,['schemaVersion','kind','digest','payload'])||doc.schemaVersion!==1||doc.kind!=='control'
            ||typeof doc.digest!=='string'||!hex64.test(doc.digest)||typeof doc.payload!=='string'
            ||doc.payload.length>Math.ceil(limits.control.bytes/3)*4)throw new Error('Invalid ABI frontier control source');
        const bytes=Buffer.from(doc.payload,'base64');
        if(bytes.toString('base64')!==doc.payload||hash(bytes)!==doc.digest)throw new Error('ABI frontier control integrity mismatch');
        let value;
        try {value=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Invalid ABI frontier control JSON');}
        const copy=bounded(value,limits.control);
        if(!Buffer.from(copy.json).equals(bytes))throw new Error('Noncanonical ABI frontier control bytes');
        return {value:copy.value,seqNo:response._seq_no,primaryTerm:response._primary_term};
    }

    private writeToken(response:any,result:'created'|'updated',value:unknown):ProtocolAbiFrontierControl {
        if(response?._index!==this.controlIndex||response._id!=='control'||response.result!==result
            ||!validToken({seqNo:response._seq_no,primaryTerm:response._primary_term})||response._shards?.total!==this.replicas+1
            ||response._shards?.successful!==this.replicas+1||response._shards?.failed!==0)throw new Error('Incomplete ABI frontier durable control receipt');
        return {value,seqNo:response._seq_no,primaryTerm:response._primary_term};
    }

    async compareAndSet(expected:ProtocolAbiFrontierToken|null,nextControl:unknown):Promise<ProtocolAbiFrontierControl> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot publish control');
        if(expected!==null&&!validToken(expected))throw new Error('Invalid ABI frontier expected CAS token');
        const desired=this.document(nextControl);
        let token=expected===null?null:{seqNo:expected.seqNo,primaryTerm:expected.primaryTerm};
        for(let attempt=0;attempt<4;attempt++){
            await this.initialize(true);
            try {
                const request={index:this.controlIndex,id:'control',document:desired.document,refresh:false as const,wait_for_active_shards:'all' as const,pipeline:'_none'};
                const receipt=token===null?await this.client.create(request):await this.client.index({...request,if_seq_no:token.seqNo,if_primary_term:token.primaryTerm});
                return this.writeToken(receipt,token===null?'created':'updated',desired.value);
            } catch(error:any) {
                if(error?.meta?.statusCode!==409||error?.meta?.body?.error?.type!=='version_conflict_engine_exception')throw error;
            }
            const current=await this.readControl();
            if(!current||this.document(current.value).document.payload!==desired.document.payload) {
                throw new ProtocolAbiFrontierConflictError(current?{seqNo:current.seqNo,primaryTerm:current.primaryTerm}:null);
            }
            // Identical-byte repair only. A GET never completes a partial/unknown write.
            // Different control bytes (including owner/generation/revision) never reacquire ownership here.
            token={seqNo:current.seqNo,primaryTerm:current.primaryTerm};
        }
        throw new ProtocolAbiFrontierConflictError(token);
    }

    private envelope(kind:ProtocolAbiFrontierRecordKind,value:unknown):FrontierRecord {
        const record:FrontierRecord={schemaVersion:1,chain:this.chain,kind,value:bounded(value,limits[kind]).value};
        // Account for envelope overhead before the unchanged immutable helper can reject it.
        bounded(record,immutableLimit);return record;
    }
    private id(record:FrontierRecord):string {
        return prefix[record.kind]+hash(bounded(['hyperion-abi-frontier-'+record.kind+'-v1',record],immutableLimit).json);
    }
    /** Every frontier ID hashes its whole record, so a differing manifest cannot be waiting under it. */
    private async prepare(kind:ProtocolAbiFrontierRecordKind,value:unknown,expected:ImmutableProtocolBundleExpectation='absent'):Promise<{id:string;digest:string}> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare records');
        const record=this.envelope(kind,value),id=this.id(record);
        return this.bundles.prepare(id,record,undefined,expected);
    }
    /** A digest marks a readback of a fresh PREPARE, which always reaches the store. */
    private async read(kind:ProtocolAbiFrontierRecordKind,id:string,signal?:AbortSignal,digest?:string):Promise<any> {
        signal?.throwIfAborted();
        if(!validId(kind,id))throw new ProtocolAbiFrontierReadError('invalid',kind,id,'Invalid ABI frontier record ID');
        const remembered=digest===undefined?this.options.recordMemo?.get(id):undefined;
        if(remembered!==undefined)return remembered;
        // The bundle read freshly validates the same records index, including frontier retention rules.
        // Keep the response owned inside that operation; only a record verified below may be remembered.
        let raw:unknown;
        try {raw=await this.bundles.read(id,signal,digest);}catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolAbiFrontierReadError(error.code,kind,id,error.message);
            throw error;
        }
        return this.verified(kind,id,raw);
    }
    private verified(kind:ProtocolAbiFrontierRecordKind,id:string,raw:unknown):any {
        try {
            const record=bounded(raw,{bytes:limits[kind].bytes+1024,nodes:limits[kind].nodes+10}).value;
            if(!recordKeys(record,['schemaVersion','chain','kind','value'])||record.schemaVersion!==1||record.chain!==this.chain
                ||record.kind!==kind||this.id(record)!==id)throw new Error('Invalid frontier envelope');
            const verified=bounded(record.value,limits[kind]);
            if(!this.options.recordMemo)return verified.value;
            // Buckets also retain their verified map, so they count twice against the budget.
            this.options.recordMemo.set(id,deepFreeze(verified.value),verified.json.length*(kind==='bucket'?2:1));
            return verified.value;
        }catch{throw new ProtocolAbiFrontierReadError('invalid',kind,id,'Stored ABI frontier type, chain or identity mismatch');}
    }

    /** Pure identity of a record; computing it grants nothing. */
    recordId(kind:ProtocolAbiFrontierRecordKind,value:unknown):string {
        return this.id(this.envelope(kind,kind==='account-state'?this.accountStateValue(value):value));
    }
    private accountStateValue(state:unknown):unknown {
        const copy=bounded(state,limits['account-state']).value;
        if(!copy||typeof copy!=='object'||Array.isArray(copy)||!Object.hasOwn(copy,'account')||!validAccount(copy.account))throw new Error('Invalid ABI account state identity');
        return copy;
    }
    /**
     * Several records in one ordered PREPARE: all chunks, then all manifests, each document with its own complete
     * receipt. Callers publish nothing that references these records until this resolves.
     */
    async prepareRecords(items:readonly ProtocolAbiFrontierRecordInput[]):Promise<Array<{id:string;digest:string;byteLength:number}>> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare records');
        const planned=items.map(item=>{
            const record=this.envelope(item.kind,item.kind==='account-state'?this.accountStateValue(item.value):item.value);
            return {id:this.id(record),record,expected:item.expected??'absent' as const,byteLength:Buffer.byteLength(protocolImmutableJson(record))};
        });
        const prepared=await this.bundles.prepareMany(planned);
        return prepared.map((value,index)=>({id:value.id,digest:value.digest,byteLength:planned[index]!.byteLength}));
    }
    /** Readback of fresh PREPAREs from `prepareRecords`; it never consults a memo. */
    async readPreparedRecords(items:readonly {kind:ProtocolAbiFrontierRecordKind;id:string;digest:string;byteLength:number}[]):Promise<any[]> {
        for(const item of items)if(!validId(item.kind,item.id))throw new ProtocolAbiFrontierReadError('invalid',item.kind,item.id,'Invalid ABI frontier record ID');
        let raw:unknown[];
        try {raw=await this.bundles.readPreparedMany(items.map(({id,digest,byteLength})=>({id,digest,byteLength})));}catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError){
                const item=items.find(value=>value.id===error.recordId)??items[0]!;
                throw new ProtocolAbiFrontierReadError(error.code,item.kind,error.recordId,error.message);
            }
            throw error;
        }
        return raw.map((value,index)=>this.verified(items[index]!.kind,items[index]!.id,value));
    }

    /** Ordered fresh reads of several records of one kind: two packed requests, each record checked as `read` does. */
    async readRecords(kind:ProtocolAbiFrontierRecordKind,ids:readonly string[]):Promise<any[]> {
        for(const id of ids)if(!validId(kind,id))throw new ProtocolAbiFrontierReadError('invalid',kind,id,'Invalid ABI frontier record ID');
        const distinct=[...new Set(ids)];
        let raw:unknown[];
        try {raw=await this.bundles.readRecords(distinct);}catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolAbiFrontierReadError(error.code,kind,error.recordId,error.message);
            throw error;
        }
        const values=new Map(distinct.map((id,index)=>[id,this.verified(kind,id,raw[index])]));
        return ids.map(id=>values.get(id));
    }
    /** One certificate keeps the single-record request order; several are one ordered PREPARE. */
    async prepareCertificates(values:readonly unknown[]):Promise<Array<{id:string;digest:string;byteLength:number}>> {
        if(values.length===1){
            const prepared=await this.prepareCertificate(values[0]);
            return [{...prepared,byteLength:Buffer.byteLength(protocolImmutableJson(this.envelope('certificate',values[0])))}];
        }
        return this.prepareRecords(values.map(value=>({kind:'certificate' as const,value})));
    }
    /** Readback of `prepareCertificates`, with the same single-record request order. */
    async readPreparedCertificates(prepared:readonly {id:string;digest:string;byteLength:number}[]):Promise<unknown[]> {
        if(prepared.length===1)return [await this.readCertificate(prepared[0]!.id,undefined,prepared[0]!.digest)];
        return this.readPreparedRecords(prepared.map(value=>({kind:'certificate' as const,...value})));
    }
    async readCertificates(ids:readonly string[]):Promise<unknown[]> {
        return ids.length===1?[await this.readCertificate(ids[0]!)]:this.readRecords('certificate',ids);
    }
    /** Batched `prepareHistoricalCertificateAddress`: the same exact-certificate check, records and readback. */
    async prepareHistoricalCertificateAddresses(certificates:readonly ProtocolAbiHeadCertificate[]):Promise<Array<{id:string;digest:string}>> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare historical addresses');
        if(certificates.length===1)return [await this.prepareHistoricalCertificateAddress(certificates[0]!)];
        const copied=certificates.map(certificate=>bounded(certificate,limits.certificate).value as ProtocolAbiHeadCertificate);
        const stored=await this.readCertificates(copied.map(certificate=>this.certificateId(certificate)));
        const addresses=copied.map((certificate,index)=>{
            if(protocolImmutableJson(stored[index])!==protocolImmutableJson(certificate))throw new Error('Historical address requires an exact settled certificate');
            const identity=historicalAddressIdentity(certificate);
            return {identity,address:{schemaVersion:1,kind:'historical-abi-certificate-address',identity,certificateId:this.certificateId(certificate)} as ProtocolAbiHistoricalAddress};
        });
        const records=addresses.map(({identity,address})=>({id:historicalAddressId(identity),
            record:{schemaVersion:1,chain:this.chain,kind:'historical-certificate-address',value:address}}));
        const prepared=await this.bundles.prepareMany(records);
        const readback=await this.readHistoricalCertificateAddresses(addresses.map(({identity})=>identity),prepared.map((value,index)=>({digest:value.digest,
            byteLength:Buffer.byteLength(protocolImmutableJson(records[index]!.record))})));
        for(const [index,value] of readback.entries())
            if(protocolImmutableJson(value)!==protocolImmutableJson(addresses[index]!.address))throw new Error('Historical certificate address readback differs');
        return prepared.map(({id,digest})=>({id,digest}));
    }
    /** Batched exact locator reads, each checked as `readHistoricalCertificateAddress` does. A digest marks a fresh readback. */
    async readHistoricalCertificateAddresses(identities:readonly ProtocolAbiHistoricalAddressIdentity[],
                                             prepared?:readonly {digest:string;byteLength:number}[]):Promise<ProtocolAbiHistoricalAddress[]> {
        if(identities.length===1)return [await this.readHistoricalCertificateAddress(identities[0]!,undefined,prepared?.[0]?.digest)];
        const expected=identities.map(identity=>JSON.parse(protocolImmutableJson(identity,64*1024)));
        const ids=expected.map(identity=>historicalAddressId(identity));
        let raw:unknown[];
        try {raw=prepared?await this.bundles.readPreparedMany(ids.map((id,index)=>({id,...prepared[index]!})))
            :await this.bundles.readRecords([...new Set(ids)]).then(values=>{const byId=new Map([...new Set(ids)].map((id,index)=>[id,values[index]]));return ids.map(id=>byId.get(id));});}
        catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolAbiHistoricalAddressReadError(error.code,error.recordId,error.message);
            throw error;
        }
        return raw.map((value,index)=>this.verifiedAddress(raw[index],expected[index],ids[index]!));
    }
    private verifiedAddress(raw:unknown,expected:ProtocolAbiHistoricalAddressIdentity,id:string):ProtocolAbiHistoricalAddress {
        try {
            const record=bounded(raw,{bytes:64*1024,nodes:2048}).value,address=record.value;
            if(!recordKeys(record,['schemaVersion','chain','kind','value'])||record.schemaVersion!==1||record.chain!==this.chain
                ||record.kind!=='historical-certificate-address'||!recordKeys(address,['schemaVersion','kind','identity','certificateId'])
                ||address.schemaVersion!==1||address.kind!=='historical-abi-certificate-address'
                ||protocolImmutableJson(address.identity)!==protocolImmutableJson(expected)||!validId('certificate',address.certificateId))
                throw new Error('Historical certificate address differs');
            return address;
        } catch {throw new ProtocolAbiHistoricalAddressReadError('invalid',id,'Stored historical certificate address identity differs');}
    }

    /**
     * Plans the state records of several consecutive blocks without writing any of them. Each step yields the
     * same root, buckets and account records `prepareState` would prepare, so the IDs are identical. The base
     * root and each touched bucket are read once per plan, from this writing store.
     */
    beginStatePlan(previousRootId:string|null):ProtocolAbiStatePlan {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare state');
        if(previousRootId!==null&&!validId('root',previousRootId))throw new Error('Invalid ABI state root or reset');
        return new ProtocolAbiStatePlan(this,previousRootId);
    }
    /** @internal Plan support: verified fresh reads from this store. */
    async planRoot(id:string):Promise<Record<string,string>> {return this.root(id);}
    /** @internal */
    async planBucket(id:string,key:string):Promise<Record<string,string>> {return this.bucket(id,key);}
    /** @internal */
    planUpdates(updates:readonly ProtocolAbiAccountUpdate[]):ProtocolAbiAccountUpdate[] {return this.stateUpdates(updates);}

    async prepareCommit(value:unknown):Promise<{id:string;digest:string}> {return this.prepare('commit',value);}
    async readCommit(id:string,signal?:AbortSignal,digest?:string):Promise<unknown> {return this.read('commit',id,signal,digest);}
    /** Deterministic lookup only; computing this ID conveys no publication authority. */
    certificateId(value:unknown):string {return this.id(this.envelope('certificate',value));}
    async prepareCertificate(value:unknown):Promise<{id:string;digest:string}> {return this.prepare('certificate',value);}
    async readCertificate(id:string,signal?:AbortSignal,digest?:string):Promise<unknown> {return this.read('certificate',id,signal,digest);}
    /** Additive address index in the existing immutable store; the referenced certificate remains authority. */
    async prepareHistoricalCertificateAddress(certificate:ProtocolAbiHeadCertificate):Promise<{id:string;digest:string}> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare historical addresses');
        const copied=bounded(certificate,limits.certificate).value as ProtocolAbiHeadCertificate;
        const identity=historicalAddressIdentity(copied),id=historicalAddressId(identity),certificateId=this.certificateId(copied);
        if(protocolImmutableJson(await this.readCertificate(certificateId))!==protocolImmutableJson(copied))
            throw new Error('Historical address requires an exact settled certificate');
        const address:ProtocolAbiHistoricalAddress={schemaVersion:1,kind:'historical-abi-certificate-address',identity,certificateId};
        const prepared=await this.bundles.prepare(id,{schemaVersion:1,chain:this.chain,kind:'historical-certificate-address',value:address});
        if(protocolImmutableJson(await this.readHistoricalCertificateAddress(identity,undefined,prepared.digest))!==protocolImmutableJson(address))
            throw new Error('Historical certificate address readback differs');
        return prepared;
    }
    async readHistoricalCertificateAddress(identity:ProtocolAbiHistoricalAddressIdentity,signal?:AbortSignal,digest?:string):Promise<ProtocolAbiHistoricalAddress> {
        const expected=JSON.parse(protocolImmutableJson(identity,64*1024)),id=historicalAddressId(expected);
        let raw:unknown;
        try {raw=await this.bundles.read(id,signal,digest);} catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolAbiHistoricalAddressReadError(error.code,id,error.message);
            throw error;
        }
        try {
            const record=bounded(raw,{bytes:64*1024,nodes:2048}).value,address=record.value;
            if(!recordKeys(record,['schemaVersion','chain','kind','value'])||record.schemaVersion!==1||record.chain!==this.chain
                ||record.kind!=='historical-certificate-address'||!recordKeys(address,['schemaVersion','kind','identity','certificateId'])
                ||address.schemaVersion!==1||address.kind!=='historical-abi-certificate-address'
                ||protocolImmutableJson(address.identity)!==protocolImmutableJson(expected)||!validId('certificate',address.certificateId))
                throw new Error('Historical certificate address differs');
            return address;
        } catch {throw new ProtocolAbiHistoricalAddressReadError('invalid',id,'Stored historical certificate address identity differs');}
    }
    beginHistoricalAddressRoot(previousRootId:string|null,addresses:readonly ProtocolAbiHistoricalAddress[]):ProtocolAbiHistoricalRootPreparation {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare historical roots');
        if(previousRootId!==null&&!validId('root',previousRootId))throw new Error('Invalid historical ABI state root');
        const input=bounded(addresses,{bytes:64*1024*1024,nodes:500000});
        if(!Array.isArray(input.value)||input.value.length>10000)throw new Error('Invalid bounded historical addresses');
        const handle=Object.freeze({}) as ProtocolAbiHistoricalRootPreparation;
        this.historicalPreparations.set(handle,{input:protocolImmutableJson([previousRootId,input.value]),
            steps:this.historicalRootSteps(previousRootId,input.value)});
        return handle;
    }
    /** Each yield retains completed neutral work and has no outstanding I/O. No stored IDs are fresh receipts. */
    private async *historicalRootSteps(previousRootId:string|null,addresses:readonly ProtocolAbiHistoricalAddress[]):AsyncGenerator<void,string> {
        const changes=new Map<string,Array<{account:string;state:unknown;address:ProtocolAbiHistoricalAddress}>>(),seen=new Set<string>();
        for(const address of addresses) {
            const account=historicalAddressId(address.identity),key=hash(account).slice(0,2);
            if(seen.has(account))throw new Error('Duplicate historical address');seen.add(account);
            if(!changes.has(key))changes.set(key,[]);
            const state={account,kind:'historical-certificate-address-entry',address};bounded(state,limits['account-state']);
            changes.get(key)!.push({account,state,address});
        }
        // Each read step covers every touched bucket, locator or prior entry at once; the map's records are then
        // one ordered PREPARE. Nothing references them until the coordinator's control CAS publishes the root.
        const buckets=await this.root(previousRootId);yield;
        const keys=[...changes.keys()].filter(key=>buckets[key]),accountsOf=new Map<string,Record<string,string>>();
        if(keys.length){
            const values=await this.readRecords('bucket',keys.map(key=>buckets[key]!));
            for(const [index,key] of keys.entries())accountsOf.set(key,Object.assign(Object.create(null),this.checkedBucket(buckets[key]!,key,values[index])));
            yield;
        }
        const pending=[...changes.values()].flat();
        // Locators are always read fresh: the map may only point at their exact stored bytes.
        if(pending.length){
            const locators=await this.readHistoricalCertificateAddresses(pending.map(({address})=>address.identity));yield;
            for(const [index,{address}] of pending.entries())
                if(protocolImmutableJson(locators[index])!==protocolImmutableJson(address))throw new Error('Historical map address differs from its exact locator');
        }
        const priors=pending.filter(({account})=>accountsOf.get(hash(account).slice(0,2))?.[account]);
        if(priors.length){
            const values=await this.readRecords('account-state',priors.map(({account})=>accountsOf.get(hash(account).slice(0,2))![account]!));yield;
            for(const [index,{state}] of priors.entries())
                if(protocolImmutableJson(values[index])!==protocolImmutableJson(state))throw new Error('Historical address map cannot replace an existing height');
        }
        const records:ProtocolAbiFrontierRecordInput[]=[];
        let changed=false;
        for(const [key,entries] of changes) {
            const accounts=accountsOf.get(key)??Object.create(null);
            let bucketChanged=false;
            for(const {account,state} of entries) {
                // Always freshly prepare, including unchanged content. A prior map entry is not a receipt.
                const id=this.recordId('account-state',state);records.push({kind:'account-state',value:state});
                if(accounts[account]!==id){accounts[account]=id;bucketChanged=true;}
            }
            if(!bucketChanged)continue;
            if(Object.keys(accounts).length>20000)throw new ProtocolAbiFrontierLimitError('ABI account bucket exceeds bounded entry budget');
            const value={prefix:key,accounts};buckets[key]=this.recordId('bucket',value);records.push({kind:'bucket',value});changed=true;
        }
        if(!Object.keys(buckets).length)throw new Error('Historical address map cannot be empty');
        const root=changed?this.recordId('root',{buckets}):previousRootId!;
        if(changed)records.push({kind:'root',value:{buckets}});
        if(records.length){await this.prepareRecords(records);yield;}
        return root;
    }
    private checkedBucket(id:string,key:string,value:any):Readonly<Record<string,string>> {
        const known=this.verifiedBuckets.get(value);
        if(known&&value.prefix===key)return known;
        if(!recordKeys(value,['prefix','accounts'])||value.prefix!==key
            ||!recordKeysMap(value.accounts,20000,([account,stateId])=>validAccount(account)&&hash(account).slice(0,2)===key&&validId('account-state',stateId))) {
            throw new ProtocolAbiFrontierReadError('invalid','bucket',id,'Invalid ABI account bucket map');
        }
        return Object.freeze(Object.assign(Object.create(null),value.accounts));
    }
    /** Existing single-call entry point; an optional store-issued handle resumes the exact same operation. */
    async prepareHistoricalAddressRoot(previousRootId:string|null,addresses:readonly ProtocolAbiHistoricalAddress[],checkpoint?:()=>Promise<void>,
                                       preparation?:ProtocolAbiHistoricalRootPreparation):Promise<string> {
        const handle=preparation??this.beginHistoricalAddressRoot(previousRootId,addresses),work=this.historicalPreparations.get(handle);
        if(!work||work.input!==protocolImmutableJson([previousRootId,addresses]))throw new Error('Historical preparation belongs to another store or scope');
        // One check between steps: nothing happens between one step's end and the next step's start.
        if(checkpoint&&work.result===undefined)await checkpoint();
        while(work.result===undefined) {
            try {
                const step=await work.steps.next();if(step.done)work.result=step.value;
            } catch(error) {this.historicalPreparations.delete(handle);throw error;}
            if(checkpoint)await checkpoint();
        }
        this.historicalPreparations.delete(handle);
        return work.result;
    }
    async readHistoricalAddressRoot(rootId:string,identity:ProtocolAbiHistoricalAddressIdentity,signal?:AbortSignal):Promise<ProtocolAbiHistoricalAddress> {
        const key=historicalAddressId(identity),state:any=await this.readAccount(rootId,key,signal);
        if(!state||!recordKeys(state,['account','kind','address'])||state.account!==key||state.kind!=='historical-certificate-address-entry'
            ||protocolImmutableJson(state.address?.identity)!==protocolImmutableJson(identity))
            throw new ProtocolAbiHistoricalAddressReadError('missing',key,'Historical address is not in the activated root');
        const address=await this.readHistoricalCertificateAddress(identity,signal);
        if(protocolImmutableJson(address)!==protocolImmutableJson(state.address))
            throw new ProtocolAbiHistoricalAddressReadError('invalid',key,'Historical locator differs from activated root membership');
        return address;
    }
    async prepareAccountState(state:unknown,expected?:ImmutableProtocolBundleExpectation):Promise<{id:string;digest:string}> {
        const copy=bounded(state,limits['account-state']).value;
        if(!copy||typeof copy!=='object'||Array.isArray(copy)||!Object.hasOwn(copy,'account')||!validAccount(copy.account))throw new Error('Invalid ABI account state identity');
        return this.prepare('account-state',copy,expected);
    }
    async readAccountState(id:string,signal?:AbortSignal):Promise<unknown> {
        const state=await this.read('account-state',id,signal);
        if(!state||typeof state!=='object'||Array.isArray(state)||!Object.hasOwn(state,'account')||!validAccount(state.account)) {
            throw new ProtocolAbiFrontierReadError('invalid','account-state',id,'Invalid ABI account state identity');
        }
        return state;
    }

    private async root(id:string|null,signal?:AbortSignal):Promise<Record<string,string>> {
        signal?.throwIfAborted();
        if(id===null)return Object.create(null);
        const value=await this.read('root',id,signal);
        if(!recordKeys(value,['buckets'])||!recordKeysMap(value.buckets,256,([key,entry])=>/^[0-9a-f]{2}$/.test(key)&&validId('bucket',entry))) {
            throw new ProtocolAbiFrontierReadError('invalid','root',id,'Invalid ABI root bucket map');
        }
        return Object.assign(Object.create(null),value.buckets);
    }
    /** Shared and read-only. The per-entry checks are a pure function of content its ID already binds. */
    private async verifiedBucket(id:string,key:string,signal?:AbortSignal):Promise<Readonly<Record<string,string>>> {
        const value=await this.read('bucket',id,signal);
        const known=this.verifiedBuckets.get(value);
        if(known&&value.prefix===key)return known;
        if(!recordKeys(value,['prefix','accounts'])||value.prefix!==key
            ||!recordKeysMap(value.accounts,20000,([account,stateId])=>validAccount(account)&&hash(account).slice(0,2)===key&&validId('account-state',stateId))) {
            throw new ProtocolAbiFrontierReadError('invalid','bucket',id,'Invalid ABI account bucket map');
        }
        const accounts:Readonly<Record<string,string>>=Object.freeze(Object.assign(Object.create(null),value.accounts));
        if(this.options.recordMemo)this.verifiedBuckets.set(value,accounts);
        return accounts;
    }
    private async bucket(id:string,key:string,signal?:AbortSignal):Promise<Record<string,string>> {
        return Object.assign(Object.create(null),await this.verifiedBucket(id,key,signal));
    }

    private stateUpdates(updates:readonly ProtocolAbiAccountUpdate[]):ProtocolAbiAccountUpdate[] {
        const input=bounded(updates,{bytes:64*1024*1024,nodes:500000}).value;
        if(!Array.isArray(input))throw new Error('Invalid ABI state updates');
        if(input.length>10000)throw new ProtocolAbiFrontierLimitError('ABI state updates exceed bounded batch budget');
        const seen=new Set<string>();
        for(const update of input){
            if(!recordKeys(update,['account','state'])||!validAccount(update.account)||seen.has(update.account)
                ||(update.state!==null&&(!update.state||typeof update.state!=='object'||Array.isArray(update.state)
                    ||!Object.hasOwn(update.state,'account')||update.state.account!==update.account)))throw new Error('Invalid or duplicate ABI state update');
            seen.add(update.account);if(update.state!==null)bounded(update.state,limits['account-state']);
        }
        return input;
    }

    /** Pure identity of a new sparse account root; read-only consumers can bind a
     * disk baseline without creating state records or trusting an arbitrary root. */
    stateRootIdFor(updates:readonly ProtocolAbiAccountUpdate[]):string|null {
        const input=this.stateUpdates(updates),groups=new Map<string,Record<string,string>>();
        for(const update of input){
            if(update.state===null)continue;
            const key=hash(update.account).slice(0,2);
            let accounts=groups.get(key);if(!accounts){accounts=Object.create(null) as Record<string,string>;groups.set(key,accounts);}
            accounts[update.account]=this.id(this.envelope('account-state',update.state));
        }
        if(!groups.size)return null;
        const buckets:Record<string,string>=Object.create(null);
        for(const [prefix,accounts] of groups)buckets[prefix]=this.id(this.envelope('bucket',{prefix,accounts}));
        return this.id(this.envelope('root',{buckets}));
    }

    async prepareState(previousRootId:string|null,updates:readonly ProtocolAbiAccountUpdate[],reset=false,checkpoint?:()=>Promise<void>):Promise<string|null> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare state');
        if(typeof reset!=='boolean'||(previousRootId!==null&&!validId('root',previousRootId)))throw new Error('Invalid ABI state root or reset');
        const input=this.stateUpdates(updates);
        if(checkpoint)await checkpoint();
        const buckets=reset?Object.create(null):await this.root(previousRootId);
        if(checkpoint)await checkpoint();
        const changes=new Map<string,ProtocolAbiAccountUpdate[]>();
        for(const update of input){const key=hash(update.account).slice(0,2);if(!changes.has(key))changes.set(key,[]);changes.get(key)!.push(update);}
        let changed=reset&&previousRootId!==null;
        for(const [key,entries] of changes){
            if(checkpoint)await checkpoint();
            const accounts=buckets[key]?await this.bucket(buckets[key],key):Object.create(null);
            if(checkpoint)await checkpoint();
            let bucketChanged=false;
            for(const update of entries){
                if(checkpoint)await checkpoint();
                if(update.state===null){if(Object.hasOwn(accounts,update.account)){delete accounts[update.account];bucketChanged=true;}continue;}
                const state=await this.prepareAccountState(update.state);
                if(checkpoint)await checkpoint();
                if(accounts[update.account]!==state.id){accounts[update.account]=state.id;bucketChanged=true;}
            }
            if(!bucketChanged)continue;
            changed=true;
            if(Object.keys(accounts).length===0)delete buckets[key];
            else {
                if(Object.keys(accounts).length>20000)throw new ProtocolAbiFrontierLimitError('ABI account bucket exceeds bounded entry budget');
                if(checkpoint)await checkpoint();
                buckets[key]=(await this.prepare('bucket',{prefix:key,accounts})).id;
                if(checkpoint)await checkpoint();
            }
        }
        if(Object.keys(buckets).length===0)return null;
        if(!changed)return previousRootId;
        if(checkpoint)await checkpoint();
        const root=(await this.prepare('root',{buckets})).id;
        if(checkpoint)await checkpoint();
        return root;
    }

    async readAccount(rootId:string|null,account:string,signal?:AbortSignal):Promise<unknown|null> {
        if(!validAccount(account))throw new Error('Invalid ABI account lookup');
        const buckets=await this.root(rootId,signal),key=hash(account).slice(0,2);
        if(!buckets[key])return null;
        const accounts=await this.verifiedBucket(buckets[key],key,signal),id=accounts[account];if(!id)return null;
        const state:any=await this.readAccountState(id,signal);
        if(state.account!==account)throw new ProtocolAbiFrontierReadError('invalid','account-state',id,'ABI bucket/account identity mismatch');
        return state;
    }
}

export interface ProtocolAbiFrontierRecordInput {kind:ProtocolAbiFrontierRecordKind;value:unknown;expected?:ImmutableProtocolBundleExpectation}

/** Process-local planning of consecutive state roots; it writes nothing and is never authority. */
export class ProtocolAbiStatePlan {
    private rootId:string|null;
    private buckets?:Record<string,string>;
    private readonly bucketValues=new Map<string,Readonly<Record<string,string>>>();
    private readonly planned:ProtocolAbiFrontierRecordInput[]=[];
    constructor(private readonly store:ProtocolAbiFrontierStore,previousRootId:string|null) {this.rootId=previousRootId;}
    /** Every record the applied steps need, in step order, to be prepared before anything references them. */
    get records():readonly ProtocolAbiFrontierRecordInput[] {return this.planned;}
    /** One block, as `prepareState(current, updates, reset)`. A failed step leaves the plan unchanged. */
    async apply(updates:readonly ProtocolAbiAccountUpdate[],reset=false):Promise<string|null> {
        if(typeof reset!=='boolean')throw new Error('Invalid ABI state root or reset');
        const input=this.store.planUpdates(updates);
        // A reset never reads the old root; anything else reads it once, which is how a lost root is noticed.
        const buckets:Record<string,string>=Object.assign(Object.create(null),reset?{}:await this.currentBuckets());
        const changes=new Map<string,ProtocolAbiAccountUpdate[]>();
        for(const update of input){const key=createHash('sha256').update(update.account).digest('hex').slice(0,2);
            if(!changes.has(key))changes.set(key,[]);changes.get(key)!.push(update);}
        const records:ProtocolAbiFrontierRecordInput[]=[],written=new Map<string,Readonly<Record<string,string>>>();
        let changed=reset&&this.rootId!==null;
        for(const [key,entries] of changes){
            const accounts:Record<string,string>=Object.assign(Object.create(null),buckets[key]?await this.bucket(buckets[key],key):{});
            let bucketChanged=false;
            for(const update of entries){
                if(update.state===null){if(Object.hasOwn(accounts,update.account)){delete accounts[update.account];bucketChanged=true;}continue;}
                // Always freshly prepared, including unchanged content: a stored ID is not a receipt.
                const id=this.store.recordId('account-state',update.state);
                records.push({kind:'account-state',value:update.state});
                if(accounts[update.account]!==id){accounts[update.account]=id;bucketChanged=true;}
            }
            if(!bucketChanged)continue;
            changed=true;
            if(Object.keys(accounts).length===0)delete buckets[key];
            else {
                if(Object.keys(accounts).length>20000)throw new ProtocolAbiFrontierLimitError('ABI account bucket exceeds bounded entry budget');
                const value={prefix:key,accounts},id=this.store.recordId('bucket',value);
                records.push({kind:'bucket',value});buckets[key]=id;written.set(id,Object.freeze({...accounts}));
            }
        }
        let root:string|null;
        if(Object.keys(buckets).length===0)root=null;
        else if(!changed)root=this.rootId;
        else {const value={buckets};root=this.store.recordId('root',value);records.push({kind:'root',value});}
        this.planned.push(...records);
        for(const [id,accounts] of written)this.bucketValues.set(id,accounts);
        this.rootId=root;this.buckets=root===null?Object.create(null):buckets;
        return root;
    }
    private async currentBuckets():Promise<Record<string,string>> {
        this.buckets??=this.rootId===null?Object.create(null):await this.store.planRoot(this.rootId);
        return this.buckets!;
    }
    private async bucket(id:string,key:string):Promise<Readonly<Record<string,string>>> {
        let accounts=this.bucketValues.get(id);
        if(!accounts){accounts=Object.freeze(await this.store.planBucket(id,key));this.bucketValues.set(id,accounts);}
        return accounts;
    }
}

function recordKeysMap(value:any,maximum:number,valid:(entry:[string,unknown])=>boolean):boolean {
    return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=maximum&&Object.entries(value).every(valid);
}
