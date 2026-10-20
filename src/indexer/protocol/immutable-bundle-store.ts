import {createHash} from 'node:crypto';
import type {Client} from '@elastic/elasticsearch';
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
    let bytes = 0, nodes = 0;
    const ancestors = new Set<object>();
    const take = (size: number) => {if ((bytes += size) > maximumBytes) throw new Error('ABI observation exceeds bounded JSON byte budget');};
    const string = (value: string) => {
        if (!value.isWellFormed()) throw new Error('ABI observation contains malformed UTF-16');
        take(2);
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code < 32) take([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
            else if (code === 34 || code === 92) take(2);
            else if (code < 128) take(1);
            else if (code < 2048) take(2);
            else if (code >= 0xd800 && code <= 0xdbff) {take(4); index++;}
            else take(3);
        }
        return JSON.stringify(value);
    };
    const visit = (value: unknown, depth: number): string => {
        if (++nodes > 1_000_000 || depth > 64) throw new Error('ABI observation exceeds bounded JSON node/depth budget');
        if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) {
            const result = JSON.stringify(value); take(result.length); return result;
        }
        if (typeof value === 'string') return string(value);
        if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('ABI observation is not portable JSON');
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)
            || Object.getOwnPropertySymbols(value).length) throw new Error('ABI observation contains a native value');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const entries = Object.entries(descriptors).filter(([key]) => !array || key !== 'length');
        if (entries.some(([, descriptor]) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            || (array && (entries.length !== descriptors.length.value
                || entries.some(([key]) => !/^(0|[1-9][0-9]*)$/.test(key))))) throw new Error('ABI observation contains accessors or sparse data');
        ancestors.add(value);take(2 + Math.max(0, entries.length - 1));
        try {
            if (array) return '[' + entries.map(([, descriptor]) => visit(descriptor.value, depth + 1)).join(',') + ']';
            return '{' + entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([key, descriptor]) => {const encodedKey = string(key); take(1); return encodedKey + ':' + visit(descriptor.value, depth + 1);}).join(',') + '}';
        } finally {ancestors.delete(value);}
    };
    return visit(input, 0);
}
const canonical = protocolImmutableJson;

export type ImmutableProtocolBundleReadCode='missing'|'incomplete'|'invalid';
export class ImmutableProtocolBundleReadError extends Error {
    constructor(readonly code:ImmutableProtocolBundleReadCode,readonly recordId:string,message:string) {
        super(message);this.name='ImmutableProtocolBundleReadError';
    }
}
export interface ImmutableProtocolBundleBounds {chunkBytes:number;maximumBytes:number;maximumChunks:number}
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
        if (!this.initialized) this.initialized = (this.options.readOnly?Promise.resolve():this.provision())
            .catch(error => {this.initialized = undefined; throw error;});
        await this.initialized;
        signal?.throwIfAborted();
        await this.validateMapping(signal);
        // Do not retain a stale startup assumption if an operator changes this projection's durability.
        signal?.throwIfAborted();
        const settings = await this.client.indices.getSettings({index: this.index, flat_settings: true, include_defaults: true}, {signal});
        signal?.throwIfAborted();
        const entry = settings[this.index];
        const sourceMode = settingsValue(entry, 'mapping.source.mode');
        if (Object.keys(settings).length !== 1 || !entry || settingsValue(entry, 'translog.durability') !== 'request'
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

    private async provision() {
        try {
            const created = await this.client.indices.create({index: this.index,
                settings: {number_of_shards: 1, number_of_replicas: this.replicas,
                    'translog.durability': 'request', auto_expand_replicas: 'false', default_pipeline: '_none', final_pipeline: '_none'},
                mappings: {_meta: {hyperion_kind: this.kind, schema_version: 1}, dynamic: 'strict',
                    properties: {kind: {type: 'keyword'}, bundle_id: {type: 'keyword'}, digest: {type: 'keyword'},
                        byte_length: {type: 'long'}, chunk_index: {type: 'integer'}, chunk_ids: {type: 'keyword'}, payload: {type: 'binary'}}}});
            if (created.acknowledged !== true || created.shards_acknowledged !== true || created.index !== this.index) {
                throw new Error('ABI observation index creation was not acknowledged');
            }
        } catch (error: any) {
            if (error?.meta?.statusCode !== 400 || error?.meta?.body?.error?.type !== 'resource_already_exists_exception') throw error;
        }
    }

    private async validateMapping(signal?:AbortSignal) {
        signal?.throwIfAborted();
        const mappings = await this.client.indices.getMapping({index: this.index}, {signal});
        signal?.throwIfAborted();
        const mapping = mappings[this.index]?.mappings;
        const expectedFields = {kind: 'keyword', bundle_id: 'keyword', digest: 'keyword', byte_length: 'long',
            chunk_index: 'integer', chunk_ids: 'keyword', payload: 'binary'};
        if (Object.keys(mappings).length !== 1 || mapping?._meta?.hyperion_kind !== this.kind
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
        const response: any = await this.client.get({index: this.index, id, realtime: true, _source: true}, {signal});
        signal?.throwIfAborted();
        if (!response || response._index !== this.index || response._id !== id || response.found !== true
            || !response._source || !Number.isSafeInteger(response._seq_no) || response._seq_no < 0
            || !Number.isSafeInteger(response._primary_term) || response._primary_term < 1) throw new Error('Incomplete ABI observation realtime read');
        return response;
    }

    private async createImmutable(id: string, document: StoredDocument) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const response = await this.client.create({index: this.index, id, document, refresh: false, wait_for_active_shards: 'all', pipeline: '_none'});
                this.assertWrite(response, id, 'created');
                return;
            } catch (error: any) {
                if (error?.meta?.statusCode !== 409 || error?.meta?.body?.error?.type !== 'version_conflict_engine_exception') throw error;
            }
            const existing = await this.get(id);
            if (canonical(existing._source) !== canonical(document)) throw new Error(`Immutable ABI observation conflict: ${id}`);
            // A prior partial/unknown receipt cannot become durable just because GET found it.
            // Reassert identical bytes under CAS and require a fresh complete copy receipt.
            try {
                const response = await this.client.index({index: this.index, id, document, refresh: false, wait_for_active_shards: 'all', pipeline: '_none',
                    if_seq_no: existing._seq_no, if_primary_term: existing._primary_term});
                this.assertWrite(response, id, 'updated');
                return;
            } catch (error: any) {
                if (error?.meta?.statusCode !== 409 || error?.meta?.body?.error?.type !== 'version_conflict_engine_exception') throw error;
            }
        }
        throw new Error('ABI observation CAS retry budget exhausted');
    }

    async prepare(id:string, record:unknown): Promise<{id:string;digest:string}> {
        if(this.options.readOnly)throw new Error('Read-only protocol bundles cannot prepare records');
        const bytes=Buffer.from(canonical(record,this.bounds.maximumBytes));
        const count = Math.ceil(bytes.length / this.bounds.chunkBytes);
        if (bytes.length > this.bounds.maximumBytes || count > this.bounds.maximumChunks) throw new Error('ABI observation exceeds bounded storage budget');
        await this.initialize();
        const digest = sha256(bytes);
        const chunks = Array.from({length: count}, (_, index) => `${id}:${digest}:${index}`);
        const manifest: StoredDocument = {kind: 'manifest', bundle_id: id, digest, byte_length: bytes.length, chunk_ids: chunks};
        try {
            const existing = await this.get(id);
            if (canonical(existing._source) !== canonical(manifest)) throw new Error(`Immutable ABI observation conflict: ${id}`);
        } catch (error: any) {
            const missing = error?.meta?.body;
            if (error?.meta?.statusCode !== 404 || missing?.found !== false || missing?._index !== this.index || missing?._id !== id) throw error;
        }
        for (let index = 0; index < count; index++) {
            const payload = bytes.subarray(index * this.bounds.chunkBytes, (index + 1) * this.bounds.chunkBytes);
            const chunkId = `${id}:${digest}:${index}`;
            await this.createImmutable(chunkId, {kind: 'chunk', bundle_id: id, digest: sha256(payload),
                byte_length: payload.length, chunk_index: index, payload: payload.toString('base64')});
        }
        // The immutable manifest is the sole PREPARE completion marker; partial chunks grant nothing.
        await this.createImmutable(id, manifest);
        return {id, digest};
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
