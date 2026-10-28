import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
import {boundedCanonicalJson} from '../helpers/bounded-json.js';
import {currentProofConsumerScope, type ProofConsumerScope} from './proof-consumer-scope.js';
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

export type ImmutableProtocolBundleReadCode='missing'|'incomplete'|'invalid';
export class ImmutableProtocolBundleReadError extends Error {
    constructor(readonly code:ImmutableProtocolBundleReadCode,readonly recordId:string,message:string) {
        super(message);this.name='ImmutableProtocolBundleReadError';
    }
}
export interface ImmutableProtocolBundleBounds {chunkBytes:number;maximumBytes:number;maximumChunks:number}
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

    constructor(private readonly client:Client,chain:string,private readonly replicas:number,
                private readonly kind:string,suffix:string,
                bounds:ImmutableProtocolBundleBounds={chunkBytes:512*1024,maximumBytes:128*1024*1024,maximumChunks:256},
                private readonly options:{readOnly?:boolean}={}) {
        if(!/^[a-z0-9][a-z0-9_.-]{0,120}$/.test(chain)||!/^[a-z0-9-]{1,80}$/.test(suffix)||!/^[a-z0-9-]{1,80}$/.test(kind)
            ||!Number.isSafeInteger(replicas)||replicas<0
            ||!Number.isSafeInteger(bounds.chunkBytes)||bounds.chunkBytes<1||bounds.chunkBytes>1024*1024
            ||!Number.isSafeInteger(bounds.maximumBytes)||bounds.maximumBytes<1||bounds.maximumBytes>128*1024*1024
            ||!Number.isSafeInteger(bounds.maximumChunks)||bounds.maximumChunks<1||bounds.maximumChunks>256) {
            throw new Error('Invalid ABI observation storage bounds');
        }
        this.index=chain+'-'+suffix;this.bounds={...bounds};
    }

    private isMissing(error:any,id:string):boolean {
        return error?.meta?.statusCode===404&&error?.meta?.body?.found===false
            &&error?.meta?.body?._index===this.index&&error?.meta?.body?._id===id;
    }
    private async initialize(signal?:AbortSignal) {
        signal?.throwIfAborted();
        if (!this.initialized) this.initialized = (this.options.readOnly?Promise.resolve():this.provision(signal))
            .catch(error => {this.initialized = undefined; throw error;});
        await this.initialized;
        signal?.throwIfAborted();
        const metadata = await checkedIo(signal, () => this.client.indices.get({index: this.index,
            features: ['mappings', 'settings'], flat_settings: true, include_defaults: true}, {signal}));
        this.validateMapping(metadata);
        // Do not retain a stale startup assumption if an operator changes this projection's durability.
        signal?.throwIfAborted();
        const entry = metadata[this.index];
        const sourceMode = settingsValue(entry, 'mapping.source.mode');
        if (!entry || settingsValue(entry, 'translog.durability') !== 'request'
            || Number(settingsValue(entry, 'number_of_shards')) !== 1
            || Number(settingsValue(entry, 'number_of_replicas')) !== this.replicas
            || !['false', false].includes(settingsValue(entry, 'auto_expand_replicas'))
            || (sourceMode !== undefined && String(sourceMode).toLowerCase() !== 'stored')
            || [settingsValue(entry, 'default_pipeline'), settingsValue(entry, 'final_pipeline')]
                .some(pipeline => pipeline !== undefined && pipeline !== '_none')) {
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
            try {
                const response = await checkedIo(signal, () => this.client.index({index: this.index, id, document, refresh: false,
                    wait_for_active_shards: 'all', pipeline: '_none', if_seq_no: existing._seq_no, if_primary_term: existing._primary_term}, {signal}));
                this.assertWrite(response, id, 'updated');
                return;
            } catch (error: any) {
                signal?.throwIfAborted();
                if (error?.meta?.statusCode !== 409 || error?.meta?.body?.error?.type !== 'version_conflict_engine_exception') throw error;
            }
        }
        throw new Error('ABI observation CAS retry budget exhausted');
    }

    async prepare(id:string, record:unknown, signal?: AbortSignal): Promise<FreshBundlePrepare> {
        const scope=currentProofConsumerScope();
        signal?.throwIfAborted();
        if(this.options.readOnly)throw new Error('Read-only protocol bundles cannot prepare records');
        const bytes=Buffer.from(canonical(record,this.bounds.maximumBytes));
        const count = Math.ceil(bytes.length / this.bounds.chunkBytes);
        if (bytes.length > this.bounds.maximumBytes || count > this.bounds.maximumChunks) throw new Error('ABI observation exceeds bounded storage budget');
        await this.initialize(signal);
        const digest = sha256(bytes);
        const chunks = Array.from({length: count}, (_, index) => `${id}:${digest}:${index}`);
        const manifest: StoredDocument = {kind: 'manifest', bundle_id: id, digest, byte_length: bytes.length, chunk_ids: chunks};
        try {
            const existing = await this.get(id, signal);
            if (canonical(existing._source) !== canonical(manifest)) throw new Error(`Immutable ABI observation conflict: ${id}`);
        } catch (error: any) {
            signal?.throwIfAborted();
            const missing = error?.meta?.body;
            if (error?.meta?.statusCode !== 404 || missing?.found !== false || missing?._index !== this.index || missing?._id !== id) throw error;
        }
        for (let index = 0; index < count; index++) {
            const payload = bytes.subarray(index * this.bounds.chunkBytes, (index + 1) * this.bounds.chunkBytes);
            const chunkId = `${id}:${digest}:${index}`;
            await this.createImmutable(chunkId, {kind: 'chunk', bundle_id: id, digest: sha256(payload),
                byte_length: payload.length, chunk_index: index, payload: payload.toString('base64')}, signal);
        }
        // The immutable manifest is the sole PREPARE completion marker; partial chunks grant nothing.
        await this.createImmutable(id, manifest, signal);
        const result=Object.freeze({id,digest}) as FreshBundlePrepare;
        scope?.assertActive();freshPrepares.set(result,{store:this,id,digest,scope});return result;
    }

    /** Realtime existence hint only: presence grants no integrity, durability or canonical authority. */
    async missingManifestHint(input: readonly string[], signal?: AbortSignal): Promise<string | null> {
        signal?.throwIfAborted();
        const scope = currentProofConsumerScope(); scope?.assertActive();
        if (!Array.isArray(input) || input.length < 1 || input.length > protocolBundleMembershipHintBounds.maximumItems)
            throw new Error('Immutable bundle membership hint exceeds its item bound');
        const ids = [...input];
        if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)) || new Set(ids).size !== ids.length)
            throw new Error('Invalid immutable bundle membership hint IDs');
        canonical({ids}, protocolBundleMembershipHintBounds.maximumRequestBytes);
        await this.initialize(signal); scope?.assertActive();
        const response: any = await checkedIo(signal, () => this.client.mget({index: this.index, ids,
            realtime: true, _source: false}, {signal, maxResponseSize: protocolBundleMembershipHintBounds.maximumResponseBytes}));
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

    async read(id: string, signal?:AbortSignal): Promise<unknown> {
        await this.initialize(signal);
        let manifest;
        try {manifest=(await this.get(id,signal))._source;} catch(error) {
            if(this.isMissing(error,id))throw new ImmutableProtocolBundleReadError('missing',id,'Immutable protocol bundle is missing');
            throw error;
        }
        if (manifest.kind !== 'manifest' || manifest.bundle_id !== id || !hex64.test(manifest.digest)
            || !Number.isSafeInteger(manifest.byte_length) || manifest.byte_length < 1 || manifest.byte_length > this.bounds.maximumBytes
            || !Array.isArray(manifest.chunk_ids) || !manifest.chunk_ids.length || manifest.chunk_ids.length > this.bounds.maximumChunks
            || new Set(manifest.chunk_ids).size !== manifest.chunk_ids.length) throw new ImmutableProtocolBundleReadError('invalid',id,'Invalid ABI observation manifest');
        const payloads: Buffer[] = [];
        let bytes = 0;
        for (const [index, chunkId] of manifest.chunk_ids.entries()) {
            if (chunkId !== `${id}:${manifest.digest}:${index}`) throw new ImmutableProtocolBundleReadError('invalid',id,'Invalid ABI observation chunk identity');
            let chunk;
            try {chunk=(await this.get(chunkId,signal))._source;} catch(error) {
                if(this.isMissing(error,chunkId))throw new ImmutableProtocolBundleReadError('incomplete',id,'Immutable protocol bundle has a missing chunk');
                throw error;
            }
            if (chunk.kind !== 'chunk' || chunk.bundle_id !== id || chunk.chunk_index !== index || typeof chunk.payload !== 'string'
                || chunk.payload.length > Math.ceil(this.bounds.chunkBytes / 3) * 4
                || !Number.isSafeInteger(chunk.byte_length) || chunk.byte_length < 1 || chunk.byte_length > this.bounds.chunkBytes) {
                throw new ImmutableProtocolBundleReadError('invalid',id,'Invalid ABI observation chunk');
            }
            const payload = Buffer.from(chunk.payload, 'base64');
            if (payload.toString('base64') !== chunk.payload || payload.length !== chunk.byte_length || sha256(payload) !== chunk.digest) {
                throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation chunk integrity mismatch');
            }
            bytes += payload.length;
            if (bytes > this.bounds.maximumBytes) throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation read exceeds bounded storage budget');
            payloads.push(payload);
        }
        const payload = Buffer.concat(payloads);
        if (bytes !== manifest.byte_length || sha256(payload) !== manifest.digest) throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation bundle integrity mismatch');
        try {
            const record=JSON.parse(payload.toString('utf8'));
            if(!Buffer.from(canonical(record)).equals(payload))throw new Error('Noncanonical bundle');
            return record;
        } catch {throw new ImmutableProtocolBundleReadError('invalid',id,'ABI observation source identity mismatch');}
    }
}
