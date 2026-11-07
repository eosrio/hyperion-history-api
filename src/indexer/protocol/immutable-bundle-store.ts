import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {ownedBoundedProtocolMget} from './bounded-document-read.js';
import {boundedCanonicalJson} from '../helpers/bounded-json.js';
import {currentProofConsumerScope, proofConsumerSignal, trackProofConsumerOperation, type ProofConsumerScope} from './proof-consumer-scope.js';
interface StoredDocument {
    kind: 'chunk' | 'manifest';
    bundle_id: string;
    digest: string;
    byte_length: number;
    chunk_index?: number;
    chunk_ids?: string[];
    payload?: string;
}

const sha256=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const hex64=/^[0-9a-f]{64}$/;
const settingsValue = (entry: any, name: string) => entry?.settings?.[`index.${name}`]
    ?? entry?.settings?.index?.[name] ?? entry?.defaults?.[`index.${name}`] ?? entry?.defaults?.index?.[name];

/** Bound JSON before assembly; descriptors avoid invoking accessors or toJSON. */
export function protocolImmutableJson(input: unknown, maximumBytes = 128 * 1024 * 1024): string {
    return boundedCanonicalJson(input, {maximumBytes, numberPolicy: 'safe-integer', errorPrefix: 'ABI observation'});
}
const canonical = protocolImmutableJson;

/** Per-request bounds only; callers may scan multiple batches within their existing record budget. */
export const protocolBundleMembershipHintBounds = Object.freeze({maximumItems: 256,
    maximumRequestBytes: 64 * 1024, maximumResponseBytes: 1024 * 1024});

async function checkedIo<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    try {return await operation();} finally {signal?.throwIfAborted();}
}

/** The most a read may rely on an earlier metadata check. A write never relies on one. */
export const protocolMetadataReadBoundMs=1000;
/** Process-local and never authority. Zero, the default, checks every read; only measured hot stores opt in. */
export class ProtocolMetadataFreshness {
    private validatedAt?:number;
    private failures=0;
    constructor(private readonly boundMs=0) {
        if(!Number.isSafeInteger(boundMs)||boundMs<0||boundMs>protocolMetadataReadBoundMs)throw new Error('Invalid metadata read bound');
    }
    async run(write:boolean,validate:()=>Promise<void>):Promise<void> {
        if(!write&&this.validatedAt!==undefined&&performance.now()-this.validatedAt<this.boundMs)return;
        // Measured from before the request, so the metadata seen is at least this recent.
        const started=performance.now(),seen=this.failures;
        try {await validate();}
        catch(error) {this.failures++;this.validatedAt=undefined;throw error;}
        // An overlapping check that failed outranks this older success.
        if(seen===this.failures&&(this.validatedAt===undefined||started>this.validatedAt))this.validatedAt=started;
    }
}

/**
 * Process-local memo of fully verified records. Each ID is a hash of the record's own content, so a
 * remembered value can only be the value its ID names. It remembers bytes, never authority: control,
 * ownership, generation, root membership and historical locators are read fresh by their callers,
 * and missing or invalid results are never remembered. Stores use one only when asked to.
 */
export class ProtocolImmutableRecordMemo {
    private readonly entries=new Map<string,{value:unknown;bytes:number}>();
    private retainedBytes=0;
    constructor(private readonly maximumBytes=64*1024*1024) {
        if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1)throw new Error('Invalid ABI frontier record memo budget');
    }
    get(id:string):unknown {
        const entry=this.entries.get(id);
        if(!entry)return undefined;
        this.entries.delete(id);this.entries.set(id,entry);
        return entry.value;
    }
    set(id:string,value:unknown,bytes:number):void {
        if(bytes>this.maximumBytes/8||this.entries.has(id))return;
        this.entries.set(id,{value,bytes});this.retainedBytes+=bytes;
        for(const [oldest,entry] of this.entries){
            if(this.retainedBytes<=this.maximumBytes)break;
            this.entries.delete(oldest);this.retainedBytes-=entry.bytes;
        }
    }
}

export type ImmutableProtocolBundleReadCode='missing'|'incomplete'|'invalid';
export class ImmutableProtocolBundleReadError extends Error {
    constructor(readonly code:ImmutableProtocolBundleReadCode,readonly recordId:string,message:string) {
        super(message);this.name='ImmutableProtocolBundleReadError';
    }
}
export interface ImmutableProtocolBundleBounds {chunkBytes:number;maximumBytes:number;maximumChunks:number}
/**
 * What the caller expects to find, which only decides the cheapest order of requests. Every document
 * still takes its own write and complete receipt, chunks before the manifest.
 * 'absent' skips the opening manifest read, so use it only when the ID hashes the whole record:
 * the manifest write still compares any bytes it finds. 'present' finds a one-chunk record's two
 * documents in one read and reasserts them directly.
 */
export type ImmutableProtocolBundleExpectation='absent'|'present';
declare const freshPrepareBrand: unique symbol;
export interface FreshBundlePrepare {readonly id:string;readonly digest:string;readonly [freshPrepareBrand]:true}
const freshPrepares=new WeakMap<object,{store:ImmutableProtocolBundleStore;id:string;digest:string;scope?:ProofConsumerScope}>();
/** A record read cannot recreate the actual acknowledged immutable PREPARE return. */
export function assertFreshBundlePrepare(store:ImmutableProtocolBundleStore,proof:FreshBundlePrepare,id:string,digest:string):ProofConsumerScope|undefined {
    const issued=freshPrepares.get(proof);
    if(!issued||issued.store!==store||issued.id!==id||issued.digest!==digest
        ||(currentProofConsumerScope()!==undefined&&issued.scope!==currentProofConsumerScope()))
        throw new Error('Immutable bundle lacks a fresh acknowledged prepare result');
    issued.scope?.assertActive();
    freshPrepares.delete(proof);
    return issued.scope;
}
/** Immutable bytes only; no canonical or readiness authority. */
export class ImmutableProtocolBundleStore {
    readonly index:string;
    private initialized?:Promise<void>;
    private readonly bounds:ImmutableProtocolBundleBounds;
    private readonly metadata:ProtocolMetadataFreshness;

    constructor(private readonly client:Client,chain:string,private readonly replicas:number,
                private readonly kind:string,suffix:string,
                bounds:ImmutableProtocolBundleBounds={chunkBytes:512*1024,maximumBytes:128*1024*1024,maximumChunks:256},
                private readonly options:{readOnly?:boolean;rejectLifecycle?:boolean;metadataReadBoundMs?:number}={}) {
        if(!/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(chain)||!/^[a-z0-9-]{1,80}$/.test(suffix)||!/^[a-z0-9-]{1,80}$/.test(kind)
            ||!Number.isSafeInteger(replicas)||replicas<0
            ||!Number.isSafeInteger(bounds.chunkBytes)||bounds.chunkBytes<1||bounds.chunkBytes>1024*1024
            ||!Number.isSafeInteger(bounds.maximumBytes)||bounds.maximumBytes<1||bounds.maximumBytes>128*1024*1024
            ||!Number.isSafeInteger(bounds.maximumChunks)||bounds.maximumChunks<1||bounds.maximumChunks>256) {
            throw new Error('Invalid ABI observation storage bounds');
        }
        this.index=chain+'-'+suffix;this.bounds={...bounds};this.metadata=new ProtocolMetadataFreshness(options.metadataReadBoundMs);
    }

    private isMissing(error:any,id:string):boolean {
        return error?.meta?.statusCode===404&&error?.meta?.body?.found===false
            &&error?.meta?.body?._index===this.index&&error?.meta?.body?._id===id;
    }
    private async initialize(signal?:AbortSignal,write=false) {
        signal?.throwIfAborted();
        await this.metadata.run(write,()=>this.validate(signal));
        signal?.throwIfAborted();
    }
    private async validate(signal?:AbortSignal) {
        signal?.throwIfAborted();
        if (!this.initialized) this.initialized = (this.options.readOnly?Promise.resolve():this.provision(signal))
            .catch(error => {this.initialized = undefined; throw error;});
        await this.initialized;
        signal?.throwIfAborted();
        const metadata = await checkedIo(signal, () => this.client.indices.get({index: this.index,
            features: ['mappings', 'settings'], flat_settings: true, include_defaults: true}, {signal}));
        this.validateMapping(metadata);
        // Do not retain a stale startup assumption if an operator changes this projection's durability:
        // every write repeats this check, and so does every read unless this store opted into the read bound.
        signal?.throwIfAborted();
        const entry = metadata[this.index];
        const sourceMode = settingsValue(entry, 'mapping.source.mode');
        if (!entry || settingsValue(entry, 'translog.durability') !== 'request'
            || Number(settingsValue(entry, 'number_of_shards')) !== 1
            || Number(settingsValue(entry, 'number_of_replicas')) !== this.replicas
            || !['false', false].includes(settingsValue(entry, 'auto_expand_replicas'))
            || (sourceMode !== undefined && String(sourceMode).toLowerCase() !== 'stored')
            || [settingsValue(entry, 'default_pipeline'), settingsValue(entry, 'final_pipeline')]
                .some(pipeline => pipeline !== undefined && pipeline !== '_none')
            || (this.options.rejectLifecycle === true && ['lifecycle.name', 'lifecycle.rollover_alias'].some(name => {
                const lifecycle = settingsValue(entry, name); return lifecycle !== undefined && lifecycle !== '';
            }))) {
            throw new Error('ABI observation index durability or retention is incompatible: ' + JSON.stringify({
                durability: settingsValue(entry, 'translog.durability'), shards: settingsValue(entry, 'number_of_shards'),
                replicas: settingsValue(entry, 'number_of_replicas'), autoExpand: settingsValue(entry, 'auto_expand_replicas'), sourceMode,
                defaultPipeline: settingsValue(entry, 'default_pipeline'), finalPipeline: settingsValue(entry, 'final_pipeline')}));
        }
    }

    private async provision(signal?: AbortSignal) {
        try {
            const created = await checkedIo(signal, () => this.client.indices.create({index: this.index,
                settings: {number_of_shards: 1, number_of_replicas: this.replicas,
                    'translog.durability': 'request', auto_expand_replicas: 'false', default_pipeline: '_none', final_pipeline: '_none'},
                mappings: {_meta: {hyperion_kind: this.kind, schema_version: 1}, dynamic: 'strict',
                    properties: {kind: {type: 'keyword'}, bundle_id: {type: 'keyword'}, digest: {type: 'keyword'},
                        byte_length: {type: 'long'}, chunk_index: {type: 'integer'}, chunk_ids: {type: 'keyword'}, payload: {type: 'binary'}}}}, {signal}));
            if (created.acknowledged !== true || created.shards_acknowledged !== true || created.index !== this.index) {
                throw new Error('ABI observation index creation was not acknowledged');
            }
        } catch (error: any) {
            signal?.throwIfAborted();
            if (error?.meta?.statusCode !== 400 || error?.meta?.body?.error?.type !== 'resource_already_exists_exception') throw error;
        }
    }

    private validateMapping(mappings: Awaited<ReturnType<Client['indices']['get']>>) {
        const mapping = mappings[this.index]?.mappings;
        const expectedFields = {kind: 'keyword', bundle_id: 'keyword', digest: 'keyword', byte_length: 'long',
            chunk_index: 'integer', chunk_ids: 'keyword', payload: 'binary'};
        if (Object.keys(mappings).length !== 1 || mappings[this.index]?.data_stream !== undefined
            || mapping?._meta?.hyperion_kind !== this.kind
            || mapping._meta.schema_version !== 1 || mapping.dynamic !== 'strict' || mapping._source?.enabled === false
            || (mapping._source && (Object.hasOwn(mapping._source, 'includes') || Object.hasOwn(mapping._source, 'excludes')
                || (Object.hasOwn(mapping._source, 'mode') && mapping._source.mode !== 'stored')))
            || Object.entries(expectedFields).some(([field, type]) => mapping.properties?.[field]?.type !== type)) {
            throw new Error('Unowned or incompatible ABI observation index');
        }
    }

    private assertWrite(response: any, id: string, result: 'created' | 'updated') {
        if (!response || response._index !== this.index || response._id !== id || response.result !== result
            || response._shards?.failed !== 0 || response._shards?.total !== this.replicas + 1
            || response._shards?.successful !== this.replicas + 1 || !Number.isSafeInteger(response._seq_no)
            || response._seq_no < 0 || !Number.isSafeInteger(response._primary_term) || response._primary_term < 1) {
            throw new Error('Incomplete ABI observation durable write receipt');
        }
    }

    private async get(id: string, signal?:AbortSignal): Promise<any> {
        signal?.throwIfAborted();
        const response: any = await checkedIo(signal, () => this.client.get({index: this.index, id, realtime: true, _source: true}, {signal}));
        signal?.throwIfAborted();
        if (!response || response._index !== this.index || response._id !== id || response.found !== true
            || !response._source || !Number.isSafeInteger(response._seq_no) || response._seq_no < 0
            || !Number.isSafeInteger(response._primary_term) || response._primary_term < 1) throw new Error('Incomplete ABI observation realtime read');
        return response;
    }

    /** A read cannot make an earlier write durable; only this write's complete receipt can. False means another write won. */
    private async writeIdentical(id: string, document: StoredDocument, existing: any, signal?: AbortSignal): Promise<boolean> {
        try {
            const response = await checkedIo(signal, () => this.client.index({index: this.index, id, document, refresh: false,
                wait_for_active_shards: 'all', pipeline: '_none', if_seq_no: existing._seq_no, if_primary_term: existing._primary_term}, {signal}));
            this.assertWrite(response, id, 'updated');
            return true;
        } catch (error: any) {
            signal?.throwIfAborted();
            if (error?.meta?.statusCode !== 409 || error?.meta?.body?.error?.type !== 'version_conflict_engine_exception') throw error;
            return false;
        }
    }

    private async createImmutable(id: string, document: StoredDocument, signal?: AbortSignal) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const response = await checkedIo(signal, () => this.client.create({index: this.index, id, document, refresh: false,
                    wait_for_active_shards: 'all', pipeline: '_none'}, {signal}));
                this.assertWrite(response, id, 'created');
                return;
            } catch (error: any) {
                signal?.throwIfAborted();
                if (error?.meta?.statusCode !== 409 || error?.meta?.body?.error?.type !== 'version_conflict_engine_exception') throw error;
            }
            const existing = await this.get(id, signal);
            if (canonical(existing._source) !== canonical(document)) throw new Error(`Immutable ABI observation conflict: ${id}`);
            // A prior partial/unknown receipt cannot become durable just because GET found it.
            // Reassert identical bytes under CAS and require a fresh complete copy receipt.
            if (await this.writeIdentical(id, document, existing, signal)) return;
        }
        throw new Error('ABI observation CAS retry budget exhausted');
    }

    /** Chunk first, as ever. False leaves nothing written: a missing document takes the ordinary create path. */
    private async reassertStored(id: string, manifest: StoredDocument, chunkId: string, chunk: StoredDocument, signal?: AbortSignal): Promise<boolean> {
        const [storedManifest, storedChunk] = await this.readDocuments([id, chunkId], this.documentPackBytes(), signal);
        if (storedManifest!.found && canonical(storedManifest!._source) !== canonical(manifest)) throw new Error(`Immutable ABI observation conflict: ${id}`);
        if (!storedManifest!.found || !storedChunk!.found) return false;
        if (canonical(storedChunk!._source) !== canonical(chunk)) throw new Error(`Immutable ABI observation conflict: ${chunkId}`);
        if (!await this.writeIdentical(chunkId, chunk, storedChunk, signal)) await this.createImmutable(chunkId, chunk, signal);
        if (!await this.writeIdentical(id, manifest, storedManifest, signal)) await this.createImmutable(id, manifest, signal);
        return true;
    }

    async prepare(id:string, record:unknown, signal?: AbortSignal, expected?:ImmutableProtocolBundleExpectation): Promise<FreshBundlePrepare> {
        const scope=currentProofConsumerScope();
        signal?.throwIfAborted();
        if(this.options.readOnly)throw new Error('Read-only protocol bundles cannot prepare records');
        const bytes=Buffer.from(canonical(record,this.bounds.maximumBytes));
        return this.prepareBytes(id,bytes,signal,scope,expected);
    }

    /** Opaque candidate custody only; generic protocol records keep safe-integer canonicalization. */
    async prepareCandidateBytes(id:string, input:Uint8Array, signal?:AbortSignal):Promise<FreshBundlePrepare> {
        signal?.throwIfAborted();
        if(this.options.readOnly)throw new Error('Read-only protocol bundles cannot prepare records');
        if(this.kind!=='stateful-candidate-v2'||!/^h45statecandidate2:[0-9a-f]{64}:[0-9a-f]{64}$/.test(id)||!(input instanceof Uint8Array)) throw new Error('Invalid candidate custody bytes');
        if (input.byteLength < 1 || input.byteLength > this.bounds.maximumBytes) throw new Error('Candidate custody exceeds raw byte bound');
        return this.prepareBytes(id,Buffer.from(input),signal);
    }

    private async prepareBytes(id:string,bytes:Buffer,signal?:AbortSignal,scope=currentProofConsumerScope(),expected?:ImmutableProtocolBundleExpectation):Promise<FreshBundlePrepare> {
        signal?.throwIfAborted();
        if(this.options.readOnly)throw new Error('Read-only protocol bundles cannot prepare records');
        const count = Math.ceil(bytes.length / this.bounds.chunkBytes);
        if (bytes.length > this.bounds.maximumBytes || count > this.bounds.maximumChunks) throw new Error('ABI observation exceeds bounded storage budget');
        await this.initialize(signal,true);
        const digest = sha256(bytes);
        const chunks = Array.from({length: count}, (_, index) => `${id}:${digest}:${index}`);
        const manifest: StoredDocument = {kind: 'manifest', bundle_id: id, digest, byte_length: bytes.length, chunk_ids: chunks};
        const chunk = (index: number): StoredDocument => {
            const payload = bytes.subarray(index * this.bounds.chunkBytes, (index + 1) * this.bounds.chunkBytes);
            return {kind: 'chunk', bundle_id: id, digest: sha256(payload), byte_length: payload.length, chunk_index: index, payload: payload.toString('base64')};
        };
        const single = expected === 'present' && count === 1;
        if (!single || !await this.reassertStored(id, manifest, chunks[0]!, chunk(0), signal)) {
            if (!single && expected !== 'absent') await this.assertManifestUnchanged(id, manifest, signal);
            for (let index = 0; index < count; index++) await this.createImmutable(chunks[index]!, chunk(index), signal);
            // The immutable manifest is the sole PREPARE completion marker; partial chunks grant nothing.
            await this.createImmutable(id, manifest, signal);
        }
        const result=Object.freeze({id,digest}) as FreshBundlePrepare;
        scope?.assertActive();freshPrepares.set(result,{store:this,id,digest,scope});return result;
    }

    private async assertManifestUnchanged(id: string, manifest: StoredDocument, signal?: AbortSignal) {
        try {
            const existing = await this.get(id, signal);
            if (canonical(existing._source) !== canonical(manifest)) throw new Error(`Immutable ABI observation conflict: ${id}`);
        } catch (error: any) {
            signal?.throwIfAborted();
            const missing = error?.meta?.body;
            if (error?.meta?.statusCode !== 404 || missing?.found !== false || missing?._index !== this.index || missing?._id !== id) throw error;
        }
    }

    /** Realtime existence hint only: presence grants no integrity, durability or canonical authority. */
    async missingManifestHint(input: readonly string[], signal?: AbortSignal): Promise<string | null> {
        signal?.throwIfAborted();
        const scope = currentProofConsumerScope(); scope?.assertActive();
        signal = proofConsumerSignal(signal);
        if (!Array.isArray(input) || input.length < 1 || input.length > protocolBundleMembershipHintBounds.maximumItems)
            throw new Error('Immutable bundle membership hint exceeds its item bound');
        const ids = [...input];
        if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)) || new Set(ids).size !== ids.length)
            throw new Error('Invalid immutable bundle membership hint IDs');
        canonical({ids}, protocolBundleMembershipHintBounds.maximumRequestBytes);
        await this.initialize(signal); scope?.assertActive();
        const response: any = await trackProofConsumerOperation(() => ownedBoundedProtocolMget(this.client, this.index, ids, false, protocolBundleMembershipHintBounds.maximumResponseBytes, 'Immutable bundle membership hint', signal), scope);
        scope?.assertActive();
        if (!response || Object.keys(response).length !== 1 || !Array.isArray(response.docs) || response.docs.length !== ids.length)
            throw new Error('Incomplete immutable bundle membership hint response');
        canonical(response, protocolBundleMembershipHintBounds.maximumResponseBytes);
        let missing: string | null = null;
        for (let index = 0; index < ids.length; index++) {
            const doc = response.docs[index];
            if (doc && Object.hasOwn(doc, 'error'))
                throw new Error('Failed immutable bundle membership hint item', {cause: doc.error});
            if (!doc || doc._index !== this.index || doc._id !== ids[index] || typeof doc.found !== 'boolean'
                || Object.keys(doc).some(key => !['_index', '_id', 'found', '_version', '_seq_no', '_primary_term'].includes(key))
                || ['_version', '_seq_no', '_primary_term'].some(key => Object.hasOwn(doc, key)
                    && (!Number.isSafeInteger(doc[key]) || doc[key] < (key === '_seq_no' ? 0 : 1))))
                throw new Error('Invalid or failed immutable bundle membership hint item');
            if (!doc.found) missing ??= ids[index];
        }
        signal?.throwIfAborted(); scope?.assertActive();
        return missing;
    }

    private validateManifest(id: string, manifest: any): StoredDocument {
        if (manifest.kind !== 'manifest' || manifest.bundle_id !== id || !hex64.test(manifest.digest)
            || !Number.isSafeInteger(manifest.byte_length) || manifest.byte_length < 1 || manifest.byte_length > this.bounds.maximumBytes
            || !Array.isArray(manifest.chunk_ids) || !manifest.chunk_ids.length || manifest.chunk_ids.length > this.bounds.maximumChunks
            || new Set(manifest.chunk_ids).size !== manifest.chunk_ids.length) throw new ImmutableProtocolBundleReadError('invalid',id,'Invalid ABI observation manifest');
        return manifest;
    }

    private decodeChunk(id: string, chunk: any, index: number): Buffer {
        if (chunk.kind !== 'chunk' || chunk.bundle_id !== id || chunk.chunk_index !== index || typeof chunk.payload !== 'string'
            || chunk.payload.length > Math.ceil(this.bounds.chunkBytes / 3) * 4
            || !Number.isSafeInteger(chunk.byte_length) || chunk.byte_length < 1 || chunk.byte_length > this.bounds.chunkBytes) {
            throw new ImmutableProtocolBundleReadError('invalid',id,'Invalid ABI observation chunk');
        }
        const payload = Buffer.from(chunk.payload, 'base64');
        if (payload.toString('base64') !== chunk.payload || payload.length !== chunk.byte_length || sha256(payload) !== chunk.digest) {
            throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation chunk integrity mismatch');
        }
        return payload;
    }

    private decodeRecord(id: string, manifest: StoredDocument, payloads: Buffer[], bytes: number): unknown {
        const payload = Buffer.concat(payloads);
        if (bytes !== manifest.byte_length || sha256(payload) !== manifest.digest) throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation bundle integrity mismatch');
        try {
            const record=JSON.parse(payload.toString('utf8'));
            if(!Buffer.from(canonical(record)).equals(payload))throw new Error('Noncanonical bundle');
            return record;
        } catch {throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation source identity mismatch');}
    }

    /** Fresh independent reads only. Manifest bytes reserve the whole window before any payload is acquired. */
    async readMany(input: readonly string[], maximumRetainedBytes: number, signal?: AbortSignal): Promise<unknown[]> {
        const scope = currentProofConsumerScope(); scope?.assertActive();
        signal = proofConsumerSignal(signal); signal?.throwIfAborted();
        if (!Array.isArray(input) || input.length < 1 || input.length > 4 || new Set(input).size !== input.length
            || input.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id))
            || !Number.isSafeInteger(maximumRetainedBytes) || maximumRetainedBytes < 1 || maximumRetainedBytes > 128 * 1024 * 1024)
            throw new Error('Invalid immutable bundle staged read budget');
        const ids = [...input];
        // One fresh validation per original logical read, unless this store opted into the read bound.
        for (const id of ids) {await this.initialize(signal); scope?.assertActive();}
        const responseBytes = this.documentPackBytes();
        const manifests = new Map<string, StoredDocument>();
        const manifestItems = ids.map(id => ({id, maximumBytes: 4096 + this.bounds.maximumChunks * (id.length + 82)}));
        for (const batch of this.readPacks(manifestItems, responseBytes)) {
            const docs = await this.readDocuments(batch.map(x => x.id), responseBytes, signal);
            for (const [offset, doc] of docs.entries()) {
                const id = batch[offset]!.id;
                if (!doc.found) throw new ImmutableProtocolBundleReadError('missing', id, 'Immutable protocol bundle is missing');
                manifests.set(id, this.validateManifest(id, doc._source));
            }
        }
        const retainedBytes = [...manifests.values()].reduce((total, manifest) => total + manifest.byte_length, 0);
        if (retainedBytes > maximumRetainedBytes)
            throw new ImmutableProtocolBundleReadError('invalid', ids[0]!, 'Immutable bundle staged read exceeds aggregate retained byte budget');
        const payloads = new Map(ids.map(id => [id, [] as Buffer[]]));
        const totals = new Map(ids.map(id => [id, 0]));
        const chunks = ids.flatMap(id => {
            const manifest = manifests.get(id)!;
            return manifest.chunk_ids!.map((chunkId, index) => {
                if (chunkId !== `${id}:${manifest.digest}:${index}`)
                    throw new ImmutableProtocolBundleReadError('invalid', id, 'Invalid ABI observation chunk identity');
                return {id: chunkId, bundle: id, index,
                    maximumBytes: 4096 + Math.ceil(Math.min(this.bounds.chunkBytes, manifest.byte_length) / 3) * 4 + chunkId.length * 3};
            });
        });
        for (const batch of this.readPacks(chunks, responseBytes)) {
            const docs = await this.readDocuments(batch.map(x => x.id), responseBytes, signal);
            for (const [offset, doc] of docs.entries()) {
                const expected = batch[offset]!;
                if (!doc.found) throw new ImmutableProtocolBundleReadError('incomplete', expected.bundle, 'Immutable protocol bundle has a missing chunk');
                const payload = this.decodeChunk(expected.bundle, doc._source, expected.index);
                const total = totals.get(expected.bundle)! + payload.length;
                // The declared reservation cannot be overrun by a malformed chunk before final assembly.
                if (total > manifests.get(expected.bundle)!.byte_length)
                    throw new ImmutableProtocolBundleReadError('invalid', expected.bundle, 'ABI observation read exceeds its reserved bundle bytes');
                totals.set(expected.bundle, total); payloads.get(expected.bundle)!.push(payload);
            }
        }
        const records: unknown[] = [];
        for (const id of ids) {
            signal?.throwIfAborted(); scope?.assertActive();
            const parts = payloads.get(id)!;
            records.push(this.decodeRecord(id, manifests.get(id)!, parts, totals.get(id)!));
            parts.length = 0; // Release raw chunks before retaining the next decoded record.
        }
        signal?.throwIfAborted(); scope?.assertActive();
        return records;
    }

    private documentPackBytes(): number {return Math.max(1024 * 1024, Math.ceil(this.bounds.chunkBytes / 3) * 4 + 8192);}

    private *readPacks<T extends {id: string; maximumBytes: number}>(items: readonly T[], responseBytes: number): Generator<T[]> {
        let batch: T[] = [], bytes = 32;
        for (const item of items) {
            if (item.maximumBytes + 32 > responseBytes) throw new Error('Immutable document exceeds its bounded response pack');
            const next = [...batch, item];
            const requestBytes = Buffer.byteLength(JSON.stringify({index: this.index, ids: next.map(x => x.id), realtime: true, _source: true}));
            if (batch.length && (batch.length >= 256 || bytes + item.maximumBytes > responseBytes || requestBytes > 64 * 1024)) {
                yield batch; batch = []; bytes = 32;
            }
            batch.push(item); bytes += item.maximumBytes;
        }
        if (batch.length) yield batch;
    }

    private async readDocuments(ids: string[], maximumResponseBytes: number, signal?: AbortSignal): Promise<any[]> {
        const scope = currentProofConsumerScope(); scope?.assertActive();
        const response: any = await checkedIo(signal, () => trackProofConsumerOperation(() =>
            ownedBoundedProtocolMget(this.client, this.index, ids, true, maximumResponseBytes, 'Immutable bundle full-source read', signal), scope));
        scope?.assertActive();
        canonical(response, maximumResponseBytes);
        if (!response || Object.keys(response).length !== 1 || !Array.isArray(response.docs) || response.docs.length !== ids.length)
            throw new Error('Incomplete immutable bundle full-source response');
        for (const [offset, doc] of response.docs.entries()) {
            if (doc && Object.hasOwn(doc, 'error')) throw new Error('Failed immutable bundle full-source item', {cause: doc.error});
            if (!doc || doc._index !== this.index || doc._id !== ids[offset] || typeof doc.found !== 'boolean'
                || Object.keys(doc).some(key => !['_index', '_id', 'found', '_version', '_seq_no', '_primary_term', '_source'].includes(key))
                || ['_version', '_seq_no', '_primary_term'].some(key => Object.hasOwn(doc, key)
                    && (!Number.isSafeInteger(doc[key]) || doc[key] < (key === '_seq_no' ? 0 : 1)))
                || (doc.found ? (!doc._source || Array.isArray(doc._source) || typeof doc._source !== 'object'
                    || !Number.isSafeInteger(doc._seq_no) || !Number.isSafeInteger(doc._primary_term)) : Object.hasOwn(doc, '_source')))
                throw new Error('Invalid immutable bundle full-source item');
        }
        return response.docs;
    }

    /** A digest from a fresh PREPARE names the first chunk, so a one-chunk readback needs one request. */
    async read(id: string, signal?:AbortSignal, digest?:string): Promise<unknown> {
        const {manifest,payloads,bytes}=await this.readParts(id,signal,digest);
        signal?.throwIfAborted();
        return this.decodeRecord(id,manifest,payloads,bytes);
    }

    async readCandidateBytes(id:string,signal?:AbortSignal):Promise<Buffer> {
        if(this.kind!=='stateful-candidate-v2'||!/^h45statecandidate2:[0-9a-f]{64}:[0-9a-f]{64}$/.test(id)) throw new Error('Invalid candidate custody bytes');
        const {manifest,payloads,bytes}=await this.readParts(id,signal);
        signal?.throwIfAborted();
        const payload=Buffer.concat(payloads);
        if(bytes!==manifest.byte_length||sha256(payload)!==manifest.digest) throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation bundle integrity mismatch');
        return payload;
    }

    /** Undefined sends the caller to the ordered read, which classifies anything unexpected. */
    private async readPrepared(id:string,digest:string,signal?:AbortSignal):Promise<{manifest:StoredDocument;payloads:Buffer[];bytes:number}|undefined> {
        const chunkId=`${id}:${digest}:0`;
        const [stored,storedChunk]=await this.readDocuments([id,chunkId],this.documentPackBytes(),signal);
        if(!stored!.found||!storedChunk!.found)return undefined;
        const manifest=this.validateManifest(id,stored!._source);
        if(manifest.digest!==digest||manifest.chunk_ids!.length!==1||manifest.chunk_ids![0]!==chunkId)return undefined;
        const payload=this.decodeChunk(id,storedChunk!._source,0);
        return {manifest,payloads:[payload],bytes:payload.length};
    }

    private async readParts(id:string,signal?:AbortSignal,digest?:string):Promise<{manifest:StoredDocument;payloads:Buffer[];bytes:number}> {
        await this.initialize(signal);
        const prepared=digest===undefined?undefined:await this.readPrepared(id,digest,signal);
        if(prepared)return prepared;
        let manifest;
        try {manifest=(await this.get(id,signal))._source;} catch(error) {
            if(this.isMissing(error,id))throw new ImmutableProtocolBundleReadError('missing',id,'Immutable protocol bundle is missing');
            throw error;
        }
        manifest = this.validateManifest(id, manifest);
        const payloads: Buffer[] = [];
        let bytes = 0;
        for (const [index, chunkId] of manifest.chunk_ids.entries()) {
            if (chunkId !== `${id}:${manifest.digest}:${index}`) throw new ImmutableProtocolBundleReadError('invalid',id,'Invalid ABI observation chunk identity');
            let chunk;
            try {chunk=(await this.get(chunkId,signal))._source;} catch(error) {
                if(this.isMissing(error,chunkId))throw new ImmutableProtocolBundleReadError('incomplete',id,'Immutable protocol bundle has a missing chunk');
                throw error;
            }
            const payload = this.decodeChunk(id, chunk, index);
            bytes += payload.length;
            if (bytes > this.bounds.maximumBytes) throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation read exceeds bounded storage budget');
            payloads.push(payload);
        }
        return {manifest,payloads,bytes};
    }
}
