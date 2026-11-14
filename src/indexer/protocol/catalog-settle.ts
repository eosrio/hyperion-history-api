import type {Client} from '@elastic/elasticsearch';
import {protocolImmutableJson} from './immutable-bundle-store.js';

/**
 * Settle: replace the live indexer's block and action documents in an attested catalog range with the documents
 * the range server produces from the node's logs. They differ only in `protocol`: settled actions carry schema-3
 * disk metadata, which the API proves from the logs alone, so no document of a settled range needs the proof stores.
 */
export interface CatalogSettleConfiguration {
    /** Base URL of the range server that seals the catalog chain (for example http://127.0.0.1:7180). */
    range_server: string;
    /** Blocks per settle step. */
    max_blocks?: number;
    /** How often a settle step is attempted. */
    interval_ms?: number;
    /** Ranges this far below the highest indexed block are complete: a live document still missing there is a gap to repair. */
    repair_after_blocks?: number;
}
export interface SettleDocument {readonly kind: 'block' | 'action'; readonly index: string; readonly id: string; readonly source: any}
export interface SettleRange {
    readonly blocks: readonly {readonly block: number; readonly id: string; readonly documents: readonly SettleDocument[]}[];
    readonly manifest: {readonly from: number; readonly to: number; readonly blocks: number; readonly catalogSha: string;
        readonly firstBlockId: string; readonly lastBlockId: string};
}
export interface CatalogSettleIO {
    /** The attested catalog end and the settled checkpoint, from the coordinator's control record. */
    position(): Promise<{attestedEnd: number | null; settled: number | null}>;
    /** The highest block number with a stored block document. */
    highestIndexedBlock(): Promise<number | null>;
    catalogBlockId(blockNum: number): Promise<string | null>;
    isAdoptedSegment(manifestSha256: string): Promise<boolean>;
    fetchRange(from: number, to: number): Promise<SettleRange>;
    liveDocuments(from: number, to: number): Promise<Map<string, {index: string; id: string; source: any}>>;
    /** How many of these targets already hold a document (any block). */
    existing(documents: readonly SettleDocument[]): Promise<number>;
    write(documents: readonly SettleDocument[]): Promise<void>;
    recordSettled(blockNum: number): Promise<void>;
}
export type SettleStep =
    | {status: 'idle'; reason: string}
    | {status: 'waiting'; from: number; to: number; missing: number}
    | {status: 'settled'; from: number; to: number; written: number; unchanged: number; repaired: number}
    | {status: 'refused'; from: number; to: number; message: string};

const key = (index: string, id: string) => index + '/' + id;
const json = (value: unknown) => protocolImmutableJson(value, 64 * 1024 * 1024);
const body = (source: any) => {const {protocol: _protocol, ...rest} = source ?? {}; return json(rest);};
/** A live action stored without decoded data is repaired by its disk document, whatever its body. */
const incomplete = (source: any) => source?.protocol?.status === 'incomplete' || source?.protocol?.error !== undefined;

/** Where each document must live: the indexer's own index names and ids. */
export interface SettleIndexNames {chain: string; indexVersion: string; partitionSize: number}
export class CatalogSettler {
    private readonly maxBlocks: number;
    private readonly repairAfter: number;
    /** Indexing lag margin: live documents near the indexed tip may still be in flight. */
    static readonly tipMargin = 128;
    constructor(private readonly io: CatalogSettleIO, private readonly startBlock: number, private readonly names: SettleIndexNames,
                options: Pick<CatalogSettleConfiguration, 'max_blocks' | 'repair_after_blocks'> = {}) {
        this.maxBlocks = options.max_blocks ?? 512;
        this.repairAfter = options.repair_after_blocks ?? 1024;
        if (!Number.isSafeInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > 100000
            || !Number.isSafeInteger(this.repairAfter) || this.repairAfter < CatalogSettler.tipMargin
            || !Number.isSafeInteger(startBlock) || startBlock < 1
            || !Number.isSafeInteger(names.partitionSize) || names.partitionSize < 1) throw new Error('Invalid catalog settle configuration');
    }
    /** The one place a document of this kind and block may be written, and under which id. */
    private placement(document: SettleDocument, block: number, blockId: string): string | undefined {
        const {chain, indexVersion, partitionSize} = this.names, source = document.source;
        if (source?.block_num !== block) return `a ${document.kind} document of block ${block} names another block`;
        if (document.kind === 'block') {
            if (document.index !== `${chain}-block-${indexVersion}` || document.id !== String(block) || source.block_id !== blockId)
                return `block document of ${block} has another index, id or block id`;
        } else {
            const partition = String(Math.ceil(block / partitionSize)).padStart(6, '0');
            if (document.index !== `${chain}-action-${indexVersion}-${partition}` || typeof source.global_sequence !== 'string'
                || document.id !== source.global_sequence) return `action document ${document.id} of block ${block} has another index or id`;
        }
        return undefined;
    }

    async step(): Promise<SettleStep> {
        const {attestedEnd, settled} = await this.io.position();
        if (attestedEnd === null) return {status: 'idle', reason: 'no attested catalog segment'};
        const indexed = await this.io.highestIndexedBlock();
        if (indexed === null) return {status: 'idle', reason: 'no indexed block'};
        const from = Math.max(this.startBlock, (settled ?? 0) + 1);
        const to = Math.min(attestedEnd, indexed - CatalogSettler.tipMargin, from + this.maxBlocks - 1);
        if (to < from) return {status: 'idle', reason: 'nothing attested and indexed past the settled block'};
        const refuse = (message: string): SettleStep => ({status: 'refused', from, to, message});

        const range = await this.io.fetchRange(from, to);
        const m = range.manifest;
        if (m.from !== from || m.to !== to || m.blocks !== to - from + 1 || range.blocks.length !== m.blocks)
            return refuse('range server returned another range');
        if (!await this.io.isAdoptedSegment(m.catalogSha)) return refuse(`range sealed by ${m.catalogSha}, which is not an adopted segment`);
        for (const [offset, item] of range.blocks.entries()) {
            if (item.block !== from + offset || item.id !== await this.io.catalogBlockId(item.block))
                return refuse(`block ${from + offset} differs from the catalog`);
            for (const document of item.documents) {const misplaced = this.placement(document, item.block, item.id); if (misplaced) return refuse(misplaced);}
        }
        if (m.firstBlockId !== range.blocks[0]!.id || m.lastBlockId !== range.blocks.at(-1)!.id) return refuse('range manifest boundary differs');

        const live = await this.io.liveDocuments(from, to), produced = new Map<string, SettleDocument>();
        for (const item of range.blocks) for (const document of item.documents) {
            const id = key(document.index, document.id);
            if (produced.has(id)) return refuse(`range server produced ${id} twice`);
            produced.set(id, document);
        }
        for (const id of live.keys()) if (!produced.has(id)) return refuse(`live document ${id} has no disk document`);
        const missing = [...produced.keys()].filter(id => !live.has(id));
        if (missing.length && to > indexed - this.repairAfter) return {status: 'waiting', from, to, missing: missing.length};

        const writes: SettleDocument[] = [];let unchanged = 0, repaired = 0;
        for (const [id, document] of produced) {
            const current = live.get(id);
            if (!current) {writes.push(document); repaired++; continue;}
            if (body(current.source) !== body(document.source)) {
                if (!incomplete(current.source)) return refuse(`live document ${id} differs from its disk document beyond protocol metadata`);
                writes.push(document); repaired++; continue;
            }
            if (json(current.source.protocol ?? null) === json(document.source.protocol ?? null)) unchanged++;
            else writes.push(document);
        }
        // A repair writes where no live document of this range was found: no other document may hold that id.
        const repairs = writes.filter(document => !live.has(key(document.index, document.id)));
        if (repairs.length && await this.io.existing(repairs) > 0) return refuse('a repaired document id is already used by a document outside this range');
        if (writes.length) await this.io.write(writes);
        await this.io.recordSettled(to);
        return {status: 'settled', from, to, written: writes.length, unchanged, repaired};
    }
}

/** Parse the range server's framed NDJSON response (see the range-server README). */
export function parseSettleRange(raw: Uint8Array): SettleRange {
    const bytes = Buffer.from(raw), blocks: {block: number; id: string; documents: SettleDocument[]}[] = [];
    let position = 0, manifest: SettleRange['manifest'] | undefined;
    while (position < bytes.length) {
        const end = bytes.indexOf(0x0a, position);
        if (end < 0) throw new Error('Truncated range frame header');
        const header = JSON.parse(bytes.subarray(position, end).toString('utf8'));position = end + 1;
        if (header.frame === 'error') throw new Error('Range server failed: ' + String(header.message).slice(0, 500));
        if (header.frame === 'manifest') {manifest = header; continue;}
        if (header.frame !== 'block') continue;
        if (!Number.isSafeInteger(header.bytes) || header.bytes < 0 || position + header.bytes > bytes.length) throw new Error('Truncated range block frame');
        const payload = bytes.subarray(position, position + header.bytes).toString('utf8');position += header.bytes;
        const lines = payload.split('\n').filter(line => line.length), documents: SettleDocument[] = [];
        if (lines.length % 2) throw new Error('Unpaired bulk line in range block ' + header.block);
        for (let i = 0; i < lines.length; i += 2) {
            const action = JSON.parse(lines[i]!), meta = action.index;
            if (!meta || typeof meta._index !== 'string' || typeof meta._id !== 'string') throw new Error('Range block line is not an index action');
            const kind = meta._index.includes('-block-') ? 'block' : meta._index.includes('-action-') ? 'action' : undefined;
            if (!kind) throw new Error('Range document of an unexpected kind: ' + meta._index);
            documents.push({kind, index: meta._index, id: meta._id, source: JSON.parse(lines[i + 1]!)});
        }
        blocks.push({block: header.block, id: header.id, documents});
    }
    if (!manifest) throw new Error('Range response has no manifest; it is incomplete');
    return {blocks, manifest};
}

/** HTTP and Elasticsearch I/O for a settler; position and checkpoint come from the caller (the coordinator). */
export function elasticSettleIO(options: {
    client: Client; chain: string; indexVersion: string; partitionSize: number; rangeServer: string; profileId: string;
    position: CatalogSettleIO['position']; recordSettled: CatalogSettleIO['recordSettled'];
    catalogBlockId: CatalogSettleIO['catalogBlockId']; isAdoptedSegment: CatalogSettleIO['isAdoptedSegment'];
}): CatalogSettleIO {
    const url = new URL(options.rangeServer);
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)))
        throw new Error('The range server must be on loopback or use https');
    const {client, chain} = options;
    async function all(index: string, from: number, to: number, sort: any[]): Promise<any[]> {
        const hits: any[] = [];let after: any[] | undefined;
        while (true) {
            const response: any = await client.search({index, size: 5000, sort, ...(after ? {search_after: after} : {}),
                query: {range: {block_num: {gte: from, lte: to}}}, track_total_hits: false});
            const page = response.hits.hits;hits.push(...page);
            if (page.length < 5000) return hits;
            after = page.at(-1).sort;
        }
    }
    return {
        position: options.position, recordSettled: options.recordSettled,
        catalogBlockId: options.catalogBlockId, isAdoptedSegment: options.isAdoptedSegment,
        async highestIndexedBlock() {
            const response: any = await client.search({index: chain + '-block-*', size: 0, aggs: {top: {max: {field: 'block_num'}}}});
            const value = response.aggregations?.top?.value;return Number.isSafeInteger(value) ? value : null;
        },
        async fetchRange(from, to) {
            const response = await fetch(new URL('/v1/ranges', url), {method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({from, to, kinds: ['blocks', 'actions'], profile: options.profileId,
                    index: {prefix: chain, version: options.indexVersion, partitionSize: options.partitionSize}}),
                signal: AbortSignal.timeout(120000)});
            if (!response.ok) throw new Error(`Range server answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
            return parseSettleRange(new Uint8Array(await response.arrayBuffer()));
        },
        async liveDocuments(from, to) {
            const documents = new Map<string, {index: string; id: string; source: any}>();
            for (const hit of [...await all(chain + '-block-*', from, to, [{block_num: 'asc'}]),
                ...await all(chain + '-action-*', from, to, [{global_sequence: 'asc'}])])
                documents.set(key(hit._index, hit._id), {index: hit._index, id: hit._id, source: hit._source});
            return documents;
        },
        async existing(documents) {
            const response: any = await client.mget({docs: documents.map(document => ({_index: document.index, _id: document.id})), _source: false});
            return response.docs.filter((item: any) => item.found).length;
        },
        async write(documents) {
            const operations = documents.flatMap(document => [{index: {_index: document.index, _id: document.id}}, document.source]);
            const response: any = await client.bulk({operations, refresh: false});
            const failed = response.items.filter((item: any) => item.index?.status >= 300);
            if (response.errors || failed.length) throw new Error(`Settle write failed for ${failed.length} documents: `
                + JSON.stringify(failed[0]?.index?.error ?? null).slice(0, 300));
        },
    };
}
