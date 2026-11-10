import {createHash} from 'node:crypto';
import {open, lstat, type FileHandle} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import type {ProtocolSourcePosition, ProtocolSourceProfile} from './source-bindings.js';
import type {ProtocolAbiAccountState} from './abi-reducer.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';

/** Operator-pinned data only; this configuration never selects executable plugin code. */
export interface DiskAbiHistoryConfiguration {
    interface_version: 1; manifest: string; manifest_sha256: string;
    producer_profile_id: string; node_revision: string; ship_abi_sha256: string;
}
interface Member {name: string; bytes: number; sha256: string}
interface Manifest {
    format: 'hyperion-wire-abi-history-v1'; chainId: string; nodeRevision: string;
    producerProfileId: string; shipAbiSha256: string; startBlock: number; endBlock: number;
    firstBlockId: string; lastBlockId: string; irreversibleBoundary: {blockNum: number; blockId: string};
    lastGlobalSequence: string | null; complete: true;
    deployments: Member & {records: number}; blockIds: Member & {count: number};
}
interface Epoch {
    account: string; blockNum: number; blockId: string; phase: 'deployment' | 'block-final';
    present: boolean; abiHex: string; abiSequence: string;
    action?: {transactionId: string; actionOrdinal: number; globalSequence: string}; deltaOrdinal?: number;
}
interface PinnedFile {path: string; handle: FileHandle; identity: string}
interface Loaded {
    manifest: Manifest; files: readonly PinnedFile[]; ids: PinnedFile;
    epochs: ReadonlyMap<string, readonly {epoch: Epoch; state: ProtocolAbiAccountState}[]>;
    states: ReadonlyMap<string, ProtocolAbiAccountState>;
}
export interface DiskAbiHistoryBaseline {
    catalogId: string; source: ProtocolSourcePosition; coverageStart: 1; lastGlobalSequence: string | null;
    profile: ProtocolSourceProfile; states: readonly ProtocolAbiAccountState[];
}
const hex = /^[0-9a-f]{64}$/;
const uint = (value: unknown, min=0): value is number => Number.isSafeInteger(value) && Number(value)>=min && Number(value)<=0xffffffff;
const decimal = (value: unknown, maximum=0xffffffffffffffffn): value is string => typeof value==='string'
    && /^(?:0|[1-9][0-9]*)$/.test(value) && value.length<=20 && BigInt(value)<=maximum;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => protocolImmutableJson(value,128*1024*1024);
const snapshot = <T>(value:T):T => JSON.parse(json(value));
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
export class DiskAbiHistoryUnavailableError extends Error {
    readonly statusCode=503;readonly code='disk_history_unavailable';
    constructor(message:string){super('Disk ABI history: '+message);this.name='DiskAbiHistoryUnavailableError';}
}
function requireData(value: unknown, message: string): asserts value {if(!value)throw new DiskAbiHistoryUnavailableError(message);}
const identity = (value: Awaited<ReturnType<FileHandle['stat']>>) =>
    [value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs].join(':');

/** Immutable sparse ABI epochs and an indexed, irreversible block identity prefix.
 * No Elasticsearch writes, live coordinator generation or synthetic live cursor are involved.
 */
export class DiskAbiHistoryCatalog {
    private static readonly configured=new Map<string,DiskAbiHistoryCatalog>();
    readonly catalogId: string;
    private loading?: Promise<Loaded>;
    private loaded?: Loaded;
    private closed=false;
    private readonly profile: ProtocolSourceProfile;
    constructor(private readonly configuration: DiskAbiHistoryConfiguration, private readonly chainId: string,
                profile: ProtocolSourceProfile) {
        requireData(configuration?.interface_version===1 && typeof configuration.manifest==='string' && configuration.manifest.length>0
            && hex.test(configuration.manifest_sha256) && hex.test(configuration.ship_abi_sha256)
            && /^[0-9a-f]{40}$/.test(configuration.node_revision) && typeof configuration.producer_profile_id==='string'
            && configuration.producer_profile_id.length>0 && hex.test(chainId),'invalid source configuration');
        this.configuration=freeze(snapshot(configuration));
        this.profile=freeze(snapshot({...profile,components:[...profile.components].sort((a,b)=>(a.runtime+':'+a.id).localeCompare(b.runtime+':'+b.id))}));
        this.catalogId='h45abihistory1:'+configuration.manifest_sha256;
    }
    static fromConfiguration(configuration: DiskAbiHistoryConfiguration | undefined, chainId: string,
                             profile: ProtocolSourceProfile): DiskAbiHistoryCatalog | undefined {
        if(!configuration)return;
        const key=json({configuration,chainId,profile});let value=this.configured.get(key);
        if(!value){requireData(this.configured.size<16,'configured catalog budget exhausted; controlled restart required');
            value=new DiskAbiHistoryCatalog(configuration,chainId,profile);this.configured.set(key,value);}
        return value;
    }
    private data(): Promise<Loaded> {requireData(!this.closed,'catalog is closed');return this.loading ??= this.load().then(value=>(this.loaded=value),error=>{
        if(error instanceof DiskAbiHistoryUnavailableError)throw error;throw new DiskAbiHistoryUnavailableError('artifact could not be validated');});}
    async close():Promise<void> {if(this.closed)return;this.closed=true;if(this.loading){const value=await this.loading.catch(()=>undefined);
        if(value)await Promise.all(value.files.map(file=>file.handle.close()));}}
    private async pin(path: string, expectedBytes?: number, expectedSha?: string): Promise<PinnedFile> {
        const before=await lstat(path);requireData(before.isFile()&&!before.isSymbolicLink(),'member must be a regular file');
        if(expectedBytes!==undefined)requireData(before.size===expectedBytes,'member length mismatch');
        const handle=await open(path,'r');
        try {
            const opened=await handle.stat();requireData(identity(before)===identity(opened),'member changed while opening');
            if(expectedSha!==undefined){
                const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;
                while(position<opened.size){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,opened.size-position),position);
                    requireData(bytesRead>0,'truncated member');digest.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
                requireData(digest.digest('hex')===expectedSha,'member digest mismatch');
            }
            requireData(identity(await handle.stat())===identity(opened),'member changed while hashing');
            return {path,handle,identity:identity(opened)};
        }catch(error){await handle.close();throw error;}
    }
    private async load(): Promise<Loaded> {
        const files:PinnedFile[]=[];
        try {
            const manifestPath=resolve(this.configuration.manifest),stat=await lstat(manifestPath);
            requireData(stat.size>0&&stat.size<=65536,'manifest exceeds bound');
            const file=await this.pin(manifestPath,stat.size,this.configuration.manifest_sha256);files.push(file);
            const m=JSON.parse(await file.handle.readFile('utf8')) as Manifest;
            requireData(m.format==='hyperion-wire-abi-history-v1'&&m.complete===true&&m.chainId===this.chainId
                &&m.nodeRevision===this.configuration.node_revision&&m.producerProfileId===this.configuration.producer_profile_id
                &&m.shipAbiSha256===this.configuration.ship_abi_sha256,'manifest source/profile mismatch');
            requireData(m.startBlock===1&&uint(m.endBlock,1)&&hex.test(m.firstBlockId)&&hex.test(m.lastBlockId)
                &&m.irreversibleBoundary?.blockNum===m.endBlock&&m.irreversibleBoundary.blockId===m.lastBlockId
                &&(m.lastGlobalSequence===null||decimal(m.lastGlobalSequence)),'invalid irreversible coverage');
            const member=(value:Member,maximum:number)=>{
                requireData(value&&typeof value.name==='string'&&value.name===basename(value.name)&&!['.','..'].includes(value.name)
                    &&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=maximum&&hex.test(value.sha256),'invalid member descriptor');
                return resolve(dirname(manifestPath),value.name);
            };
            requireData(m.blockIds?.count===m.endBlock&&m.blockIds.bytes===m.endBlock*32
                &&uint(m.deployments?.records)&&m.deployments.records<=1000000,'invalid coverage/member count');
            const ids=await this.pin(member(m.blockIds,128*1024*1024*1024),m.blockIds.bytes,m.blockIds.sha256);files.push(ids);
            const rows=await this.pin(member(m.deployments,128*1024*1024),m.deployments.bytes,m.deployments.sha256);files.push(rows);
            const raw=await rows.handle.readFile('utf8'),epochs=new Map<string,{epoch:Epoch;state:ProtocolAbiAccountState}[]>(),states=new Map<string,ProtocolAbiAccountState>();
            let count=0;const positions=new Set<string>();
            for(const line of raw.split('\n')){
                if(!line.trim())continue;
                requireData(Buffer.byteLength(line)<=16*1024*1024,'ABI row exceeds bound');
                const row=JSON.parse(line) as Epoch;
                requireData(typeof row.account==='string'&&row.account.length>0&&row.account.length<=256&&uint(row.blockNum,1)
                    &&row.blockNum<=m.endBlock&&hex.test(row.blockId)&&['deployment','block-final'].includes(row.phase)
                    &&typeof row.present==='boolean'&&typeof row.abiHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(row.abiHex)
                    &&decimal(row.abiSequence,0xffffffffn),'invalid sparse ABI row');
                if(row.phase==='deployment')requireData(row.present&&row.action&&hex.test(row.action.transactionId)
                    &&uint(row.action.actionOrdinal,1)&&decimal(row.action.globalSequence)&&row.action.globalSequence!=='0','invalid deployment action');
                else requireData(uint(row.deltaOrdinal),'invalid final-state ordinal');
                const position=row.account+':'+row.blockNum+':'+row.phase+':'+(row.phase==='deployment'?row.action!.globalSequence:row.deltaOrdinal);
                requireData(!positions.has(position),'duplicate sparse ABI position');positions.add(position);
                const rowSha=sha(line),source={observationId:'h45abidisk1:'+rowSha,inputSha256:rowSha,catalogId:this.catalogId,
                    chainId:this.chainId,blockNum:row.blockNum,blockId:row.blockId,
                    ...(row.phase==='deployment'?{phase:'native-effect' as const,action:row.action!}:{phase:'block-end' as const,deltaOrdinal:row.deltaOrdinal!})};
                const state=freeze({account:row.account,present:row.present,abiHex:row.abiHex,protocol:this.profile,source});
                const list=epochs.get(row.account)??[];list.push({epoch:freeze(row),state});epochs.set(row.account,list);states.set(source.observationId,state);count++;
            }
            requireData(count===m.deployments.records,'ABI row count mismatch');
            for(const list of epochs.values())list.sort((a,b)=>a.epoch.blockNum-b.epoch.blockNum
                ||(a.epoch.phase===b.epoch.phase?(a.epoch.phase==='deployment'?(BigInt(a.epoch.action!.globalSequence)<BigInt(b.epoch.action!.globalSequence)?-1:1):a.epoch.deltaOrdinal!-b.epoch.deltaOrdinal!):a.epoch.phase==='deployment'?-1:1));
            const loaded={manifest:freeze(m),files,ids,epochs,states};
            requireData(await this.idAt(loaded,1)===m.firstBlockId&&await this.idAt(loaded,m.endBlock)===m.lastBlockId,'coverage boundary identity mismatch');
            for(const list of epochs.values())for(const item of list)requireData(await this.idAt(loaded,item.epoch.blockNum)===item.epoch.blockId,'ABI row differs from covered block identity');
            await this.revalidateLoaded(loaded);return loaded;
        }catch(error){await Promise.all(files.map(file=>file.handle.close().catch(()=>{})));throw error;}
    }
    private async idAt(value:Loaded,blockNum:number):Promise<string> {
        requireData(uint(blockNum,1)&&blockNum<=value.manifest.endBlock,'block outside covered range');
        const bytes=Buffer.alloc(32),result=await value.ids.handle.read(bytes,0,32,(blockNum-1)*32);
        requireData(result.bytesRead===32,'truncated block identity index');return bytes.toString('hex');
    }
    private async revalidateLoaded(value:Loaded):Promise<void> {
        try{for(const file of value.files){const path=await lstat(file.path);requireData(path.isFile()&&!path.isSymbolicLink()
            &&identity(path)===file.identity&&identity(await file.handle.stat())===file.identity,'catalog artifact changed or replaced');}}
        catch(error){if(error instanceof DiskAbiHistoryUnavailableError)throw error;throw new DiskAbiHistoryUnavailableError('catalog artifact disappeared or became unreadable');}
    }
    async revalidate():Promise<void> {await this.revalidateLoaded(await this.data());}
    /** Range only, and never authority: false means covers() is false for every source at this height. */
    async mayCover(blockNum:number):Promise<boolean> {const value=await this.data();return uint(blockNum,1)&&blockNum<=value.manifest.endBlock;}
    async covers(source:Pick<ProtocolSourcePosition,'chainId'|'blockNum'|'blockId'>):Promise<boolean> {
        const value=await this.data();if(source.chainId!==this.chainId||!uint(source.blockNum,1)||source.blockNum>value.manifest.endBlock)return false;
        requireData(hex.test(source.blockId)&&await this.idAt(value,source.blockNum)===source.blockId,'source block is outside pinned irreversible history');
        await this.revalidateLoaded(value);return true;
    }
    async source(blockNum:number):Promise<ProtocolSourcePosition> {const value=await this.data();
        return freeze({chainId:this.chainId,blockNum,blockId:await this.idAt(value,blockNum),previousBlockId:blockNum===1?null:await this.idAt(value,blockNum-1)});}
    async assertSchema(schemaJson:string):Promise<void> {const value=await this.data();requireData(sha(schemaJson)===value.manifest.shipAbiSha256,'selected source handshake differs from catalog');}
    matchesState(value:ProtocolAbiAccountState):boolean {const stored=this.loaded?.states.get(value?.source?.observationId);return !!stored&&json(stored)===json(value);}
    async blockId(blockNum:number):Promise<string|null> {const value=await this.data();return uint(blockNum,1)&&blockNum<=value.manifest.endBlock?this.idAt(value,blockNum):null;}
    private select(value:Loaded,account:string,blockNum:number,globalSequence?:string):{epoch:Epoch;state:ProtocolAbiAccountState}|undefined {
        const list=value.epochs.get(account);if(!list)return;
        let selected:typeof list[number]|undefined;
        for(const item of list){const row=item.epoch;if(row.blockNum>blockNum)break;
            if(row.blockNum===blockNum&&globalSequence!==undefined&&(row.phase==='block-final'||BigInt(row.action!.globalSequence)>=BigInt(globalSequence)))continue;
            selected=item;}
        return selected;
    }
    async finalState(account:string,blockNum:number):Promise<ProtocolAbiAccountState|null> {const value=await this.data();
        requireData(uint(blockNum,1)&&blockNum<=value.manifest.endBlock,'ABI state is outside covered range');return this.select(value,account,blockNum)?.state??null;}
    async actionState(input:ProtocolAbiActionInput,blockNum:number):Promise<ProtocolAbiAccountState|null> {
        const value=await this.data();requireData(uint(blockNum,1)&&blockNum<=value.manifest.endBlock,'ABI action is outside covered range');
        const selected=this.select(value,input.account,blockNum,input.globalSequence);
        if(!selected)return null;
        if(selected.epoch.abiSequence===input.receiptAbiSequence)return selected.state;
        // A self ABI deployment executes under the prior ABI, but its receipt already contains the new sequence.
        const self=value.epochs.get(input.account)?.find(({epoch})=>epoch.blockNum===blockNum&&epoch.phase==='deployment'
            &&epoch.action!.globalSequence===input.globalSequence&&epoch.action!.transactionId===input.transactionId
            &&epoch.action!.actionOrdinal===input.actionOrdinal&&input.actionOrdinal===input.inputActionOrdinal&&input.receiver===input.account);
        return self&&self.epoch.abiSequence===input.receiptAbiSequence
            &&BigInt(self.epoch.abiSequence)===BigInt(selected.epoch.abiSequence)+1n?selected.state:null;
    }
    async baseline():Promise<DiskAbiHistoryBaseline> {const value=await this.data();await this.revalidateLoaded(value);
        return freeze({catalogId:this.catalogId,source:await this.source(value.manifest.endBlock),coverageStart:1 as const,
            lastGlobalSequence:value.manifest.lastGlobalSequence,profile:this.profile,
            states:[...value.epochs.keys()].sort().map(account=>this.select(value,account,value.manifest.endBlock)!.state)});}
}
