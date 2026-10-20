import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ImmutableProtocolBundleStore,ImmutableProtocolBundleReadError,protocolImmutableJson} from './immutable-bundle-store.js';

export interface ProtocolAbiFrontierToken {seqNo:number;primaryTerm:number}
export interface ProtocolAbiFrontierControl extends ProtocolAbiFrontierToken {value:unknown}
export interface ProtocolAbiAccountUpdate {account:string;state:unknown|null}
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
const immutableFields={kind:{type:'keyword'},bundle_id:{type:'keyword'},digest:{type:'keyword'},byte_length:{type:'long'},
    chunk_index:{type:'integer'},chunk_ids:{type:'keyword'},payload:{type:'binary'}} as const;
const controlFields={schemaVersion:{type:'integer'},kind:{type:'keyword'},digest:{type:'keyword'},payload:{type:'binary'}} as const;

/** Physical storage only. The coordinator owns source/profile validation, ownership, generations and readiness. */
export class ProtocolAbiFrontierStore {
    readonly controlIndex:string;
    readonly recordsIndex:string;
    private readonly bundles:ImmutableProtocolBundleStore;
    private readonly provisioning=new Map<string,Promise<void>>(); // Exactly the two owned indices, never session/account state.

    constructor(private readonly client:Client,private readonly chain:string,private readonly replicas=0,
                private readonly options:{readOnly?:boolean}={}) {
        if(!/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(chain)||!Number.isSafeInteger(replicas)||replicas<0)throw new Error('Invalid ABI frontier store configuration');
        this.controlIndex=chain+'-protocol-abi-frontier-v1';this.recordsIndex=chain+'-protocol-abi-frontier-records-v1';
        this.bundles=new ImmutableProtocolBundleStore(client,chain,replicas,'protocol-abi-frontier-records','protocol-abi-frontier-records-v1',undefined,options);
    }

    private async initialize(control:boolean,signal?:AbortSignal) {
        signal?.throwIfAborted();
        const index=control?this.controlIndex:this.recordsIndex,kind=control?'protocol-abi-frontier':'protocol-abi-frontier-records';
        const fields=control?controlFields:immutableFields;
        if(!this.provisioning.has(index)){
            const provision=(this.options.readOnly?Promise.resolve():this.provision(index,kind,fields))
                .catch(error=>{this.provisioning.delete(index);throw error;});
            this.provisioning.set(index,provision);
        }
        await this.provisioning.get(index);
        signal?.throwIfAborted();
        const mappingResponse=await this.client.indices.getMapping({index},{signal}),mapping=mappingResponse[index]?.mappings;
        signal?.throwIfAborted();
        if(Object.keys(mappingResponse).length!==1||mapping?._meta?.hyperion_kind!==kind||mapping._meta.schema_version!==1
            ||mapping.dynamic!=='strict'||mapping._source?.enabled===false
            ||(mapping._source&&(Object.hasOwn(mapping._source,'includes')||Object.hasOwn(mapping._source,'excludes')
                ||(Object.hasOwn(mapping._source,'mode')&&mapping._source.mode!=='stored')))
            ||Object.entries(fields).some(([name,field])=>mapping.properties?.[name]?.type!==field.type)) {
            throw new Error('Unowned or incompatible ABI frontier index mapping');
        }
        const settings=await this.client.indices.getSettings({index,flat_settings:true,include_defaults:true},{signal}),entry=settings[index];
        signal?.throwIfAborted();
        const mode=settingsValue(entry,'mapping.source.mode');
        if(Object.keys(settings).length!==1||!entry||settingsValue(entry,'translog.durability')!=='request'
            ||Number(settingsValue(entry,'number_of_shards'))!==1||Number(settingsValue(entry,'number_of_replicas'))!==this.replicas
            ||!['false',false].includes(settingsValue(entry,'auto_expand_replicas'))
            ||(mode!==undefined&&String(mode).toLowerCase()!=='stored')
            ||['default_pipeline','final_pipeline'].some(name=>{
                const pipeline=settingsValue(entry,name);return pipeline!==undefined&&pipeline!=='_none';
            })||['lifecycle.name','lifecycle.rollover_alias'].some(name=>{
                const lifecycle=settingsValue(entry,name);return lifecycle!==undefined&&lifecycle!=='';
            }))throw new Error('ABI frontier index durability or retention is incompatible');
    }

    private async provision(index:string,kind:string,fields:typeof immutableFields|typeof controlFields) {
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
        await this.initialize(true,signal);
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
    private async prepare(kind:ProtocolAbiFrontierRecordKind,value:unknown):Promise<{id:string;digest:string}> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare records');
        const record=this.envelope(kind,value),id=this.id(record);await this.initialize(false);
        return this.bundles.prepare(id,record);
    }
    private async read(kind:ProtocolAbiFrontierRecordKind,id:string,signal?:AbortSignal):Promise<any> {
        signal?.throwIfAborted();
        if(!validId(kind,id))throw new ProtocolAbiFrontierReadError('invalid',kind,id,'Invalid ABI frontier record ID');
        await this.initialize(false,signal);
        let raw:unknown;
        try {raw=await this.bundles.read(id,signal);}catch(error) {
            if(error instanceof ImmutableProtocolBundleReadError)throw new ProtocolAbiFrontierReadError(error.code,kind,id,error.message);
            throw error;
        }
        try {
            const record=bounded(raw,{bytes:limits[kind].bytes+1024,nodes:limits[kind].nodes+10}).value;
            if(!recordKeys(record,['schemaVersion','chain','kind','value'])||record.schemaVersion!==1||record.chain!==this.chain
                ||record.kind!==kind||this.id(record)!==id)throw new Error('Invalid frontier envelope');
            return bounded(record.value,limits[kind]).value;
        }catch{throw new ProtocolAbiFrontierReadError('invalid',kind,id,'Stored ABI frontier type, chain or identity mismatch');}
    }

    async prepareCommit(value:unknown):Promise<{id:string;digest:string}> {return this.prepare('commit',value);}
    async readCommit(id:string,signal?:AbortSignal):Promise<unknown> {return this.read('commit',id,signal);}
    /** Deterministic lookup only; computing this ID conveys no publication authority. */
    certificateId(value:unknown):string {return this.id(this.envelope('certificate',value));}
    async prepareCertificate(value:unknown):Promise<{id:string;digest:string}> {return this.prepare('certificate',value);}
    async readCertificate(id:string,signal?:AbortSignal):Promise<unknown> {return this.read('certificate',id,signal);}
    async prepareAccountState(state:unknown):Promise<{id:string;digest:string}> {
        const copy=bounded(state,limits['account-state']).value;
        if(!copy||typeof copy!=='object'||Array.isArray(copy)||!Object.hasOwn(copy,'account')||!validAccount(copy.account))throw new Error('Invalid ABI account state identity');
        return this.prepare('account-state',copy);
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
    private async bucket(id:string,key:string,signal?:AbortSignal):Promise<Record<string,string>> {
        const value=await this.read('bucket',id,signal);
        if(!recordKeys(value,['prefix','accounts'])||value.prefix!==key
            ||!recordKeysMap(value.accounts,20000,([account,stateId])=>validAccount(account)&&hash(account).slice(0,2)===key&&validId('account-state',stateId))) {
            throw new ProtocolAbiFrontierReadError('invalid','bucket',id,'Invalid ABI account bucket map');
        }
        return Object.assign(Object.create(null),value.accounts);
    }

    async prepareState(previousRootId:string|null,updates:readonly ProtocolAbiAccountUpdate[],reset=false):Promise<string|null> {
        if(this.options.readOnly)throw new Error('Read-only ABI frontier cannot prepare state');
        if(typeof reset!=='boolean'||(previousRootId!==null&&!validId('root',previousRootId)))throw new Error('Invalid ABI state root or reset');
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
        const buckets=reset?Object.create(null):await this.root(previousRootId);
        const changes=new Map<string,ProtocolAbiAccountUpdate[]>();
        for(const update of input){const key=hash(update.account).slice(0,2);if(!changes.has(key))changes.set(key,[]);changes.get(key)!.push(update);}
        let changed=reset&&previousRootId!==null;
        for(const [key,entries] of changes){
            const accounts=buckets[key]?await this.bucket(buckets[key],key):Object.create(null);
            let bucketChanged=false;
            for(const update of entries){
                if(update.state===null){if(Object.hasOwn(accounts,update.account)){delete accounts[update.account];bucketChanged=true;}continue;}
                const state=await this.prepareAccountState(update.state);
                if(accounts[update.account]!==state.id){accounts[update.account]=state.id;bucketChanged=true;}
            }
            if(!bucketChanged)continue;
            changed=true;
            if(Object.keys(accounts).length===0)delete buckets[key];
            else {
                if(Object.keys(accounts).length>20000)throw new ProtocolAbiFrontierLimitError('ABI account bucket exceeds bounded entry budget');
                buckets[key]=(await this.prepare('bucket',{prefix:key,accounts})).id;
            }
        }
        if(Object.keys(buckets).length===0)return null;
        if(!changed)return previousRootId;
        return (await this.prepare('root',{buckets})).id;
    }

    async readAccount(rootId:string|null,account:string,signal?:AbortSignal):Promise<unknown|null> {
        if(!validAccount(account))throw new Error('Invalid ABI account lookup');
        const buckets=await this.root(rootId,signal),key=hash(account).slice(0,2);
        if(!buckets[key])return null;
        const accounts=await this.bucket(buckets[key],key,signal),id=accounts[account];if(!id)return null;
        const state:any=await this.readAccountState(id,signal);
        if(state.account!==account)throw new ProtocolAbiFrontierReadError('invalid','account-state',id,'ABI bucket/account identity mismatch');
        return state;
    }
}

function recordKeysMap(value:any,maximum:number,valid:(entry:[string,unknown])=>boolean):boolean {
    return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=maximum&&Object.entries(value).every(valid);
}
