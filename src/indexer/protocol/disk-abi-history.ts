import {createHash} from 'node:crypto';
import {open, lstat, readdir, readFile, type FileHandle} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import type {ProtocolAbiActionInput} from '@eosrio/hyperion-sdk/protocol';
import type {ProtocolSourcePosition, ProtocolSourceProfile} from './source-bindings.js';
import type {ProtocolAbiAccountState} from './abi-reducer.js';
import {protocolImmutableJson} from './immutable-bundle-store.js';

/** Operator-pinned data only; this configuration never selects executable plugin code. */
export interface DiskAbiHistoryConfiguration {
    interface_version: 1; manifest: string; manifest_sha256: string;
    producer_profile_id: string; node_revision: string; ship_abi_sha256: string;
    /** The node's logs the catalog covers: proofs then recompute each source from them instead of stored copies. */
    capture?: import('./disk-capture-source.js').DiskCaptureConfiguration;
    /**
     * Where a sealer writes incremental segments (`hyperion-abi-history-segment-v1`) that extend the pinned
     * catalog. A segment is only read here; it extends coverage once it is adopted, which the ABI
     * coordinator does after checking it against its own commits. The pinned manifest stays the anchor.
     */
    segments_dir?: string;
    /** Replace live block and action documents in attested ranges with the range server's disk-backed ones. Indexer only. */
    settle?: import('./catalog-settle.js').CatalogSettleConfiguration;
    /** Rotate the proof stores into a new generation anchored at a settled catalog link end. Needs `settle`. Indexer only. */
    rotation?: {
        /** Start a rotation once the current generation's indices hold this many bytes. */
        max_bytes?: number;
        /** Retire the previous generation once settling is this many blocks past the switch block... */
        retire_margin_blocks?: number;
        /** ...and the switch is at least this old. */
        retire_after_ms?: number;
        /** Delete a retired generation's indices. Off: log their names for an operator to delete. */
        drop_previous?: boolean;
        check_interval_ms?: number;
    };
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
type Entry = {epoch: Epoch; state: ProtocolAbiAccountState};
interface PinnedFile {path: string; handle: FileHandle; identity: string}
/** The newest adopted link of the chain, as the next segment must name it. */
export interface DiskAbiHistoryTip {
    manifestSha256: string; endBlock: number; lastBlockId: string; lastGlobalSequence: string | null; totalRecords: number;
}
/** What a coordinator publishes once it adopted a segment, and what other readers follow. */
export interface DiskAbiHistoryLink {manifestSha256: string; endBlock: number; lastBlockId: string}
interface Piece {start: number; end: number; ids: Buffer}
interface Loaded {
    manifest: Manifest; files: readonly PinnedFile[]; ids: PinnedFile;
    epochs: Map<string, Entry[]>;
    states: Map<string, ProtocolAbiAccountState>;
    /** Coverage: the pinned end, then each adopted segment's end. */
    end: number; tip: DiskAbiHistoryTip; pieces: Piece[]; adopted: Set<string>;
    /** Every adopted link's end and the last global sequence there: where a chain can be anchored. */
    boundaries: Map<number, string | null>;
}
export interface DiskAbiHistoryBaseline {
    catalogId: string; source: ProtocolSourcePosition; coverageStart: 1; lastGlobalSequence: string | null;
    profile: ProtocolSourceProfile; states: readonly ProtocolAbiAccountState[];
}
const hex = /^[0-9a-f]{64}$/;
const SEGMENT_FORMAT = 'hyperion-abi-history-segment-v1';
const MAX_MANIFEST = 65536, MAX_DEPLOYMENTS = 128 * 1024 * 1024, MAX_RECORDS = 1000000;
/** Segment block ids are kept in memory (32 bytes a block). Past this, compact the chain into a new pinned catalog. */
const MAX_SEGMENT_BLOCKS = 4 * 1024 * 1024;
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
const compareEntries = (a: Entry, b: Entry) => a.epoch.blockNum-b.epoch.blockNum
    ||(a.epoch.phase===b.epoch.phase?(a.epoch.phase==='deployment'?(BigInt(a.epoch.action!.globalSequence)<BigInt(b.epoch.action!.globalSequence)?-1:1)
        :a.epoch.deltaOrdinal!-b.epoch.deltaOrdinal!):a.epoch.phase==='deployment'?-1:1);

/** A verified segment that extends the adopted chain and is not adopted yet: it answers for its own blocks. */
export class DiskAbiHistoryPendingSegment {
    constructor(readonly link: DiskAbiHistoryLink & {baseSha256: string; startBlock: number; lastGlobalSequence: string | null; totalRecords: number},
                private readonly ids: Buffer, readonly entries: readonly Entry[],
                private readonly select: (account: string, blockNum: number, globalSequence: string | undefined, extra: readonly Entry[]) => Entry | undefined,
                private readonly resolveAction: (input: ProtocolAbiActionInput, blockNum: number, extra: readonly Entry[]) => ProtocolAbiAccountState | null) {}
    private within(blockNum: number) {requireData(uint(blockNum,1)&&blockNum>=this.link.startBlock&&blockNum<=this.link.endBlock,'block outside the segment');}
    blockId(blockNum: number): string {this.within(blockNum);const at=(blockNum-this.link.startBlock)*32;return this.ids.subarray(at,at+32).toString('hex');}
    /** A copy of the segment's block membership, 32 bytes a block. */
    blockIds(): Buffer {return Buffer.from(this.ids);}
    /** Accounts with an ABI record at this block, in record order. */
    changedAt(blockNum: number): readonly string[] {this.within(blockNum);
        return [...new Set(this.entries.filter(entry=>entry.epoch.blockNum===blockNum).map(entry=>entry.epoch.account))];}
    finalState(account: string, blockNum: number): ProtocolAbiAccountState | null {this.within(blockNum);return this.select(account,blockNum,undefined,this.entries)?.state??null;}
    actionState(input: ProtocolAbiActionInput, blockNum: number): ProtocolAbiAccountState | null {this.within(blockNum);return this.resolveAction(input,blockNum,this.entries);}
}

/** Immutable sparse ABI epochs and an indexed, irreversible block identity prefix.
 * No Elasticsearch writes, live coordinator generation or synthetic live cursor are involved.
 */
export class DiskAbiHistoryCatalog {
    private static readonly configured=new Map<string,DiskAbiHistoryCatalog>();
    readonly catalogId: string;
    private loading?: Promise<Loaded>;
    private loaded?: Loaded;
    private closed=false;
    private adopting: Promise<unknown>=Promise.resolve();
    /** A followed link the directory could not reach, so frequent authority reads do not rescan it. */
    private unreachable?: {link: string; until: number};
    /** Manifests already looked at in the segments directory, by path and file identity. */
    private readonly peeked=new Map<string,{identity:string;sha?:string;base?:string}>();
    private readonly profile: ProtocolSourceProfile;
    constructor(private readonly configuration: DiskAbiHistoryConfiguration, private readonly chainId: string,
                profile: ProtocolSourceProfile) {
        requireData(configuration?.interface_version===1 && typeof configuration.manifest==='string' && configuration.manifest.length>0
            && hex.test(configuration.manifest_sha256) && hex.test(configuration.ship_abi_sha256)
            && /^[0-9a-f]{40}$/.test(configuration.node_revision) && typeof configuration.producer_profile_id==='string'
            && configuration.producer_profile_id.length>0 && hex.test(chainId)
            && (configuration.segments_dir===undefined||(typeof configuration.segments_dir==='string'&&configuration.segments_dir.length>0)),
            'invalid source configuration');
        this.configuration=freeze(snapshot(configuration));
        this.profile=freeze(snapshot({...profile,components:[...profile.components].sort((a,b)=>(a.runtime+':'+a.id).localeCompare(b.runtime+':'+b.id))}));
        // The pinned catalog names the lineage: adopted segments extend its coverage, never its identity.
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
    /** A member read whole, bounded, from a regular file that did not change while it was read. */
    private async readMember(path: string, bytes: number, digest: string): Promise<Buffer> {
        const file=await this.pin(path,bytes);
        try {
            const value=Buffer.alloc(bytes);let position=0;
            while(position<bytes){const {bytesRead}=await file.handle.read(value,position,bytes-position,position);requireData(bytesRead>0,'truncated member');position+=bytesRead;}
            requireData(identity(await file.handle.stat())===file.identity&&sha(value)===digest,'member digest mismatch');
            return value;
        }finally{await file.handle.close();}
    }
    private member(manifestPath: string, value: Member, maximum: number): string {
        requireData(value&&typeof value.name==='string'&&value.name===basename(value.name)&&!['.','..'].includes(value.name)
            &&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=maximum&&hex.test(value.sha256),'invalid member descriptor');
        return resolve(dirname(manifestPath),value.name);
    }
    /** Shape, unique position and block range of every record; each record's block id is checked by the caller. */
    private rows(raw: string, lowest: number, end: number, catalogId: string): Entry[] {
        const entries:Entry[]=[],positions=new Set<string>();
        for(const line of raw.split('\n')){
            if(!line.trim())continue;
            requireData(Buffer.byteLength(line)<=16*1024*1024,'ABI row exceeds bound');
            const row=JSON.parse(line) as Epoch;
            requireData(typeof row.account==='string'&&row.account.length>0&&row.account.length<=256&&uint(row.blockNum,1)
                &&row.blockNum>=lowest&&row.blockNum<=end&&hex.test(row.blockId)&&['deployment','block-final'].includes(row.phase)
                &&typeof row.present==='boolean'&&typeof row.abiHex==='string'&&/^(?:[0-9a-f]{2})*$/.test(row.abiHex)
                &&decimal(row.abiSequence,0xffffffffn),'invalid sparse ABI row');
            if(row.phase==='deployment')requireData(row.present&&row.action&&hex.test(row.action.transactionId)
                &&uint(row.action.actionOrdinal,1)&&decimal(row.action.globalSequence)&&row.action.globalSequence!=='0','invalid deployment action');
            else requireData(uint(row.deltaOrdinal),'invalid final-state ordinal');
            const position=row.account+':'+row.blockNum+':'+row.phase+':'+(row.phase==='deployment'?row.action!.globalSequence:row.deltaOrdinal);
            requireData(!positions.has(position),'duplicate sparse ABI position');positions.add(position);
            const rowSha=sha(line),source={observationId:'h45abidisk1:'+rowSha,inputSha256:rowSha,catalogId,
                chainId:this.chainId,blockNum:row.blockNum,blockId:row.blockId,
                ...(row.phase==='deployment'?{phase:'native-effect' as const,action:row.action!}:{phase:'block-end' as const,deltaOrdinal:row.deltaOrdinal!})};
            const state=freeze({account:row.account,present:row.present,abiHex:row.abiHex,protocol:this.profile,source});
            entries.push({epoch:freeze(row),state});
        }
        return entries;
    }
    private async load(): Promise<Loaded> {
        const files:PinnedFile[]=[];
        try {
            const manifestPath=resolve(this.configuration.manifest),stat=await lstat(manifestPath);
            requireData(stat.size>0&&stat.size<=MAX_MANIFEST,'manifest exceeds bound');
            const file=await this.pin(manifestPath,stat.size,this.configuration.manifest_sha256);files.push(file);
            const m=JSON.parse(await file.handle.readFile('utf8')) as Manifest;
            requireData(m.format==='hyperion-wire-abi-history-v1'&&m.complete===true&&m.chainId===this.chainId
                &&m.nodeRevision===this.configuration.node_revision&&m.producerProfileId===this.configuration.producer_profile_id
                &&m.shipAbiSha256===this.configuration.ship_abi_sha256,'manifest source/profile mismatch');
            requireData(m.startBlock===1&&uint(m.endBlock,1)&&hex.test(m.firstBlockId)&&hex.test(m.lastBlockId)
                &&m.irreversibleBoundary?.blockNum===m.endBlock&&m.irreversibleBoundary.blockId===m.lastBlockId
                &&(m.lastGlobalSequence===null||decimal(m.lastGlobalSequence)),'invalid irreversible coverage');
            requireData(m.blockIds?.count===m.endBlock&&m.blockIds.bytes===m.endBlock*32
                &&uint(m.deployments?.records)&&m.deployments.records<=MAX_RECORDS,'invalid coverage/member count');
            const ids=await this.pin(this.member(manifestPath,m.blockIds,128*1024*1024*1024),m.blockIds.bytes,m.blockIds.sha256);files.push(ids);
            const rows=await this.pin(this.member(manifestPath,m.deployments,MAX_DEPLOYMENTS),m.deployments.bytes,m.deployments.sha256);files.push(rows);
            const entries=this.rows(await rows.handle.readFile('utf8'),1,m.endBlock,this.catalogId);
            requireData(entries.length===m.deployments.records,'ABI row count mismatch');
            const epochs=new Map<string,Entry[]>(),states=new Map<string,ProtocolAbiAccountState>();
            for(const entry of entries){const list=epochs.get(entry.epoch.account)??[];list.push(entry);epochs.set(entry.epoch.account,list);states.set(entry.state.source.observationId,entry.state);}
            for(const list of epochs.values())list.sort(compareEntries);
            const loaded:Loaded={manifest:freeze(m),files,ids,epochs,states,end:m.endBlock,pieces:[],adopted:new Set([this.configuration.manifest_sha256]),
                boundaries:new Map([[m.endBlock,m.lastGlobalSequence]]),
                tip:{manifestSha256:this.configuration.manifest_sha256,endBlock:m.endBlock,lastBlockId:m.lastBlockId,
                    lastGlobalSequence:m.lastGlobalSequence,totalRecords:m.deployments.records}};
            requireData(await this.idAt(loaded,1)===m.firstBlockId&&await this.idAt(loaded,m.endBlock)===m.lastBlockId,'coverage boundary identity mismatch');
            for(const list of epochs.values())for(const item of list)requireData(await this.idAt(loaded,item.epoch.blockNum)===item.epoch.blockId,'ABI row differs from covered block identity');
            await this.revalidateLoaded(loaded);return loaded;
        }catch(error){await Promise.all(files.map(file=>file.handle.close().catch(()=>{})));throw error;}
    }
    private async idAt(value:Loaded,blockNum:number):Promise<string> {
        requireData(uint(blockNum,1)&&blockNum<=value.end,'block outside covered range');
        if(blockNum>value.manifest.endBlock){
            // Pieces are contiguous and ordered by start: binary search, since the chain grows by one piece a seal.
            let low=0,high=value.pieces.length-1;while(low<high){const middle=(low+high+1)>>1;if(value.pieces[middle].start<=blockNum)low=middle;else high=middle-1;}
            const piece=value.pieces[low];requireData(piece&&piece.start<=blockNum&&blockNum<=piece.end,'block outside covered range');
            const at=(blockNum-piece.start)*32;return piece.ids.subarray(at,at+32).toString('hex');
        }
        const bytes=Buffer.alloc(32),result=await value.ids.handle.read(bytes,0,32,(blockNum-1)*32);
        requireData(result.bytesRead===32,'truncated block identity index');return bytes.toString('hex');
    }
    private async revalidateLoaded(value:Loaded):Promise<void> {
        try{for(const file of value.files){const path=await lstat(file.path);requireData(path.isFile()&&!path.isSymbolicLink()
            &&identity(path)===file.identity&&identity(await file.handle.stat())===file.identity,'catalog artifact changed or replaced');}}
        catch(error){if(error instanceof DiskAbiHistoryUnavailableError)throw error;throw new DiskAbiHistoryUnavailableError('catalog artifact disappeared or became unreadable');}
    }
    async revalidate():Promise<void> {await this.revalidateLoaded(await this.data());}
    /** The end of coverage: the pinned catalog's end, then the end of the newest adopted segment. */
    async coverageEnd():Promise<number> {return (await this.data()).end;}
    /** Whether a segment (or the pinned catalog) is part of the adopted chain. */
    async hasAdopted(manifestSha256:string):Promise<boolean> {return (await this.data()).adopted.has(manifestSha256);}
    /** The newest adopted link: what the next segment names as its base. */
    async tip():Promise<DiskAbiHistoryTip> {return {...(await this.data()).tip};}
    /** Range only, and never authority: false means covers() is false for every source at this height. */
    async mayCover(blockNum:number):Promise<boolean> {const value=await this.data();return uint(blockNum,1)&&blockNum<=value.end;}
    async covers(source:Pick<ProtocolSourcePosition,'chainId'|'blockNum'|'blockId'>):Promise<boolean> {
        const value=await this.data();if(source.chainId!==this.chainId||!uint(source.blockNum,1)||source.blockNum>value.end)return false;
        requireData(hex.test(source.blockId)&&await this.idAt(value,source.blockNum)===source.blockId,'source block is outside pinned irreversible history');
        await this.revalidateLoaded(value);return true;
    }
    async source(blockNum:number):Promise<ProtocolSourcePosition> {const value=await this.data();
        return freeze({chainId:this.chainId,blockNum,blockId:await this.idAt(value,blockNum),previousBlockId:blockNum===1?null:await this.idAt(value,blockNum-1)});}
    async assertSchema(schemaJson:string):Promise<void> {const value=await this.data();requireData(sha(schemaJson)===value.manifest.shipAbiSha256,'selected source handshake differs from catalog');}
    matchesState(value:ProtocolAbiAccountState):boolean {const stored=this.loaded?.states.get(value?.source?.observationId);return !!stored&&json(stored)===json(value);}
    async blockId(blockNum:number):Promise<string|null> {const value=await this.data();return uint(blockNum,1)&&blockNum<=value.end?this.idAt(value,blockNum):null;}
    private select(value:Loaded,account:string,blockNum:number,globalSequence?:string,extra:readonly Entry[]=[]):Entry|undefined {
        const list=value.epochs.get(account)??[];
        const items=extra.length?[...list,...extra.filter(entry=>entry.epoch.account===account)]:list;
        let selected:Entry|undefined;
        for(const item of items){const row=item.epoch;if(row.blockNum>blockNum)break;
            if(row.blockNum===blockNum&&globalSequence!==undefined&&(row.phase==='block-final'||BigInt(row.action!.globalSequence)>=BigInt(globalSequence)))continue;
            selected=item;}
        return selected;
    }
    private resolveAction(value:Loaded,input:ProtocolAbiActionInput,blockNum:number,extra:readonly Entry[]=[]):ProtocolAbiAccountState|null {
        const selected=this.select(value,input.account,blockNum,input.globalSequence,extra);
        if(!selected)return null;
        if(selected.epoch.abiSequence===input.receiptAbiSequence)return selected.state;
        // A self ABI deployment executes under the prior ABI, but its receipt already contains the new sequence.
        const self=[...(value.epochs.get(input.account)??[]),...extra.filter(entry=>entry.epoch.account===input.account)]
            .find(({epoch})=>epoch.blockNum===blockNum&&epoch.phase==='deployment'
            &&epoch.action!.globalSequence===input.globalSequence&&epoch.action!.transactionId===input.transactionId
            &&epoch.action!.actionOrdinal===input.actionOrdinal&&input.actionOrdinal===input.inputActionOrdinal&&input.receiver===input.account);
        return self&&self.epoch.abiSequence===input.receiptAbiSequence
            &&BigInt(self.epoch.abiSequence)===BigInt(selected.epoch.abiSequence)+1n?selected.state:null;
    }
    async finalState(account:string,blockNum:number):Promise<ProtocolAbiAccountState|null> {const value=await this.data();
        requireData(uint(blockNum,1)&&blockNum<=value.end,'ABI state is outside covered range');return this.select(value,account,blockNum)?.state??null;}
    async actionState(input:ProtocolAbiActionInput,blockNum:number):Promise<ProtocolAbiAccountState|null> {
        const value=await this.data();requireData(uint(blockNum,1)&&blockNum<=value.end,'ABI action is outside covered range');
        return this.resolveAction(value,input,blockNum);
    }
    /** The pinned anchor: the complete ABI state at the pinned catalog's end. Adopting segments never moves it. */
    async baseline():Promise<DiskAbiHistoryBaseline> {return this.baselineAt((await this.data()).manifest.endBlock);}
    /** Adopted link ends, ascending: the blocks a chain may be anchored at. */
    async boundaries():Promise<number[]> {return [...(await this.data()).boundaries.keys()].sort((a,b)=>a-b);}
    /** The complete ABI state at an adopted link's end, as a chain anchor. */
    async baselineAt(blockNum:number):Promise<DiskAbiHistoryBaseline> {const value=await this.data();await this.revalidateLoaded(value);
        requireData(value.boundaries.has(blockNum),'block '+blockNum+' is not the end of an adopted catalog link');
        return freeze({catalogId:this.catalogId,source:await this.source(blockNum),coverageStart:1 as const,
            lastGlobalSequence:value.boundaries.get(blockNum)!,profile:this.profile,
            states:[...value.epochs.keys()].sort().map(account=>this.select(value,account,blockNum)?.state)
                .filter((state):state is ProtocolAbiAccountState=>state!==undefined)});}

    /** Manifests in the segments directory whose base is `baseSha`. Only new or changed files are read. */
    private async children(baseSha:string):Promise<{path:string;sha:string}[]> {
        const directory=this.configuration.segments_dir;if(!directory)return [];
        let names:string[];
        try {names=(await readdir(resolve(directory))).filter(name=>name.endsWith('.manifest.json')).sort();}
        catch(error:any){if(error?.code==='ENOENT')return [];throw new DiskAbiHistoryUnavailableError('segments directory is unreadable');}
        const found:{path:string;sha:string}[]=[];
        for(const name of names){
            const path=join(resolve(directory),name);let stat:Awaited<ReturnType<typeof lstat>>;
            try {stat=await lstat(path);}catch{continue;}
            if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>MAX_MANIFEST)continue;
            const id=identity(stat),known=this.peeked.get(path);let entry=known?.identity===id?known:undefined;
            if(!entry){
                entry={identity:id};
                try {const raw=await readFile(path),m=JSON.parse(raw.toString('utf8'));
                    if(m?.format===SEGMENT_FORMAT&&typeof m.base?.manifestSha256==='string'){entry.sha=sha(raw);entry.base=m.base.manifestSha256;}}
                catch{/* Not a manifest yet, or not one at all: it is looked at again once it changes. */}
                this.peeked.set(path,entry);
            }
            if(entry.base===baseSha&&entry.sha)found.push({path,sha:entry.sha});
        }
        return found;
    }
    /** Verify one segment against the tip it names, without adopting it. */
    private async verifySegment(value:Loaded,tip:DiskAbiHistoryTip,path:string,expectedSha:string,lowestPiece:number):Promise<DiskAbiHistoryPendingSegment> {
        const stat=await lstat(path);requireData(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=MAX_MANIFEST,'segment manifest exceeds bound');
        const raw=await this.readMember(path,stat.size,expectedSha),m=JSON.parse(raw.toString('utf8'));
        requireData(m?.format===SEGMENT_FORMAT&&m.complete===true&&m.chainId===this.chainId&&m.nodeRevision===this.configuration.node_revision
            &&m.producerProfileId===this.configuration.producer_profile_id&&m.shipAbiSha256===value.manifest.shipAbiSha256,'segment source/profile mismatch');
        requireData(m.base?.manifestSha256===tip.manifestSha256&&m.base.endBlock===tip.endBlock&&m.base.lastBlockId===tip.lastBlockId,
            'segment does not name the adopted tip as its base');
        requireData(uint(m.endBlock,1)&&m.startBlock===tip.endBlock+1&&m.endBlock>=m.startBlock&&hex.test(m.startBlockId)&&hex.test(m.lastBlockId)
            &&m.irreversibleBoundary?.blockNum===m.endBlock&&m.irreversibleBoundary.blockId===m.lastBlockId,'invalid segment coverage');
        requireData(m.lastGlobalSequence===null?tip.lastGlobalSequence===null
            :decimal(m.lastGlobalSequence)&&(tip.lastGlobalSequence===null||BigInt(m.lastGlobalSequence)>=BigInt(tip.lastGlobalSequence)),
            'segment goes back in global sequence');
        const count=m.endBlock-m.startBlock+1;
        requireData(m.blockIds?.count===count&&m.blockIds.bytes===count*32&&uint(m.deployments?.records)&&m.deployments.records<=MAX_RECORDS
            &&m.totalRecords===tip.totalRecords+m.deployments.records,'invalid segment member count');
        requireData(lowestPiece+count<=MAX_SEGMENT_BLOCKS,'segment chain exceeds its in-memory bound; compact it into a new pinned catalog');
        const ids=await this.readMember(this.member(path,m.blockIds,MAX_SEGMENT_BLOCKS*32),m.blockIds.bytes,m.blockIds.sha256);
        const rows=await this.readMember(this.member(path,m.deployments,MAX_DEPLOYMENTS),m.deployments.bytes,m.deployments.sha256);
        const entries=this.rows(rows.toString('utf8'),m.startBlock,m.endBlock,this.catalogId).sort(compareEntries);
        requireData(entries.length===m.deployments.records,'segment ABI row count mismatch');
        const idOf=(blockNum:number)=>ids.subarray((blockNum-m.startBlock)*32,(blockNum-m.startBlock+1)*32).toString('hex');
        requireData(idOf(m.startBlock)===m.startBlockId&&idOf(m.endBlock)===m.lastBlockId,'segment boundary identity mismatch');
        for(const entry of entries)requireData(idOf(entry.epoch.blockNum)===entry.epoch.blockId,'segment ABI row differs from its block identity');
        return new DiskAbiHistoryPendingSegment(freeze({manifestSha256:expectedSha,baseSha256:tip.manifestSha256,startBlock:m.startBlock,endBlock:m.endBlock,lastBlockId:m.lastBlockId,
                lastGlobalSequence:m.lastGlobalSequence,totalRecords:m.totalRecords}),ids,freeze(entries),
            (account,blockNum,globalSequence,extra)=>this.select(value,account,blockNum,globalSequence,extra),
            (input,blockNum,extra)=>this.resolveAction(value,input,blockNum,extra));
    }
    /**
     * The next verified segment after the adopted tip, or none. A directory with several candidates for one
     * base is ambiguous and none is offered. Nothing is adopted; a coordinator adopts after checking it.
     */
    async nextSegment():Promise<DiskAbiHistoryPendingSegment|undefined> {
        const value=await this.data(),tip={...value.tip},candidates=await this.children(tip.manifestSha256);
        if(candidates.length!==1)return undefined;
        return this.verifySegment(value,tip,candidates[0].path,candidates[0].sha,value.end-value.manifest.endBlock);
    }
    /** Extend coverage by a verified segment of the adopted tip. Serialized; adopting the tip again is a no-op. */
    adopt(segment:DiskAbiHistoryPendingSegment):Promise<DiskAbiHistoryTip> {
        const run=this.adopting.then(async()=>{
            const value=await this.data();
            if(value.adopted.has(segment.link.manifestSha256)){
                requireData(await this.idAt(value,segment.link.endBlock)===segment.link.lastBlockId,'adopted segment differs from coverage');return {...value.tip};}
            requireData(segment.link.baseSha256===value.tip.manifestSha256&&segment.link.startBlock===value.end+1,'segment does not extend the adopted tip');
            const ids=segment.blockIds();
            const touched=new Set<string>();
            for(const entry of segment.entries){const list=value.epochs.get(entry.epoch.account)??[];list.push(entry);value.epochs.set(entry.epoch.account,list);
                value.states.set(entry.state.source.observationId,entry.state);touched.add(entry.epoch.account);}
            for(const account of touched)value.epochs.get(account)!.sort(compareEntries);
            value.pieces.push({start:segment.link.startBlock,end:segment.link.endBlock,ids});
            value.end=segment.link.endBlock;value.adopted.add(segment.link.manifestSha256);
            value.boundaries.set(segment.link.endBlock,segment.link.lastGlobalSequence);
            value.tip={manifestSha256:segment.link.manifestSha256,endBlock:segment.link.endBlock,lastBlockId:segment.link.lastBlockId,
                lastGlobalSequence:segment.link.lastGlobalSequence,totalRecords:segment.link.totalRecords};
            return {...value.tip};
        });
        this.adopting=run.catch(()=>undefined);
        return run;
    }
    /**
     * Follow a link another reader adopted. The chain from the adopted tip is resolved and verified first, and only a
     * chain that ends exactly at the link's digest, end and id is adopted, whole and in order. Nothing else is adopted:
     * not a partial chain, not a different segment that happens to reach the same block. A link already covered must
     * be one of the adopted links. A link the directory cannot reach yet is not covered.
     */
    async follow(link:DiskAbiHistoryLink):Promise<boolean> {
        requireData(link&&hex.test(link.manifestSha256)&&uint(link.endBlock,1)&&hex.test(link.lastBlockId),'invalid catalog link');
        const value=await this.data();
        if(value.end>=link.endBlock){
            requireData(value.adopted.has(link.manifestSha256)&&await this.idAt(value,link.endBlock)===link.lastBlockId,
                'followed catalog link differs from coverage');
            return true;
        }
        const key=json(link);if(this.unreachable?.link===key&&Date.now()<this.unreachable.until)return false;
        const chain:DiskAbiHistoryPendingSegment[]=[];let tip={...value.tip},blocks=value.end-value.manifest.endBlock;
        while(tip.endBlock<link.endBlock&&chain.length<4096){
            const candidates=await this.children(tip.manifestSha256);
            const selected=candidates.find(candidate=>candidate.sha===link.manifestSha256)??(candidates.length===1?candidates[0]:undefined);
            if(!selected){this.unreachable={link:key,until:Date.now()+1000};return false;}
            const next=await this.verifySegment(value,tip,selected.path,selected.sha,blocks);
            chain.push(next);blocks+=next.link.endBlock-next.link.startBlock+1;
            tip={manifestSha256:next.link.manifestSha256,endBlock:next.link.endBlock,lastBlockId:next.link.lastBlockId,
                lastGlobalSequence:next.link.lastGlobalSequence,totalRecords:next.link.totalRecords};
        }
        if(tip.manifestSha256!==link.manifestSha256||tip.endBlock!==link.endBlock||tip.lastBlockId!==link.lastBlockId){
            this.unreachable={link:key,until:Date.now()+1000};return false;}
        for(const segment of chain)await this.adopt(segment);
        return true;
    }
}
