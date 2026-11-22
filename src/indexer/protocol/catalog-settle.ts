import type {Client} from '@elastic/elasticsearch';
import {protocolImmutableJson} from './immutable-bundle-store.js';
import {protocolDiskSelectionId} from './disk-source-evidence.js';
import type {ProtocolSourcePosition} from './source-bindings.js';

/**
 * Settle: replace the live indexer's block and action documents in an attested catalog range with the documents
 * the range server produces from the node's logs. They differ only in `protocol`: settled actions carry schema-3
 * disk metadata, which the API proves from the logs alone, so no document of a settled range needs the proof stores.
 *
 * A settled action document can still be written again afterwards: by index work that was queued before its block
 * settled, by a repair or bulk reader, by a tool. The settler therefore never assumes a settled range stays
 * settled. Every step first reads which action documents at or below the settled block changed since it last
 * looked, by shard sequence number, and settles again every block where one of them is not disk-backed.
 * `verify` reports whether everything at or below the settled block is known to be disk-backed right now, which
 * is what dropping a proof store generation depends on.
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
/** One shard of an action index, and the sequence number through which every write to it has completed. */
export interface SettleShard {readonly index: string; /** The index's id: a recreated index is another one. */ readonly uuid: string;
    readonly shard: number; readonly checkpoint: number}
/** The audit positions as stored: a sequence number per shard, valid for the blocks through `through`. */
export interface SettleAudit {readonly through: number; readonly shards: Record<string, number>}
export interface SettleChangedAction {readonly seqNo: number; readonly block: number; readonly diskBacked: boolean}
export interface CatalogSettleIO {
    /** The attested catalog end and the settled checkpoint, from the coordinator's control record. */
    position(): Promise<{attestedEnd: number | null; settled: number | null}>;
    /** The highest block number with a stored block document. */
    highestIndexedBlock(): Promise<number | null>;
    /** The catalog's position of a covered block; null outside its coverage. */
    catalogSource(blockNum: number): Promise<ProtocolSourcePosition | null>;
    isAdoptedSegment(manifestSha256: string): Promise<boolean>;
    fetchRange(from: number, to: number): Promise<SettleRange>;
    liveDocuments(from: number, to: number): Promise<Map<string, {index: string; id: string; source: any}>>;
    /** How many of these targets already hold a document (any block). */
    existing(documents: readonly SettleDocument[]): Promise<number>;
    /** Replace `rewrites`; create `repairs`, failing if any of them exists by now. */
    write(rewrites: readonly SettleDocument[], repairs: readonly SettleDocument[]): Promise<void>;
    recordSettled(blockNum: number): Promise<void>;
    /** Every shard of every action index. Read before any document the same step reads. */
    actionShards(): Promise<SettleShard[]>;
    /** Make every completed write to these indices visible to `changedActions`. */
    refresh(indices: readonly string[]): Promise<void>;
    /** Action documents of blocks through `through` that the shard wrote after `after` and up to its checkpoint, oldest first. */
    changedActions(shard: SettleShard, after: number, through: number, limit: number): Promise<SettleChangedAction[]>;
    /** The audit positions as last written; null before the first. */
    readAudit(): Promise<SettleAudit | null>;
    writeAudit(value: SettleAudit): Promise<void>;
    /** The store selections that action documents of blocks above `after` name; null when there are too many documents to list. */
    storeSelections(after: number): Promise<string[] | null>;
}
export type SettleStep =
    | {status: 'idle'; reason: string}
    | {status: 'waiting'; from: number; to: number; missing: number}
    | {status: 'settled'; from: number; to: number; written: number; unchanged: number; repaired: number}
    /** Blocks at or below the settled block held documents that were written again and are disk-backed again. */
    | {status: 'resettled'; from: number; to: number; written: number; blocks: number}
    | {status: 'refused'; from: number; to: number; message: string};

const key = (index: string, id: string) => index + '/' + id;
const shardKey = (shard: SettleShard) => shard.index + '#' + shard.uuid + '#' + shard.shard;
const json = (value: unknown) => protocolImmutableJson(value, 64 * 1024 * 1024);
const body = (source: any) => {const {protocol: _protocol, ...rest} = source ?? {}; return json(rest);};
/** A live action stored without decoded data is repaired by its disk document, whatever its body. */
const incomplete = (source: any) => source?.protocol?.status === 'incomplete' || source?.protocol?.error !== undefined;
/** Whether an action document's proof metadata needs no proof store. */
export const settledActionProtocol = (protocol: any): boolean => protocol?.schemaVersion === 3;

/** Where each document must live: the indexer's own index names and ids. */
export interface SettleIndexNames {chain: string; indexVersion: string; partitionSize: number}
export class CatalogSettler {
    private readonly maxBlocks: number;
    private readonly repairAfter: number;
    /** Indexing lag margin: live documents near the indexed tip may still be in flight. */
    static readonly tipMargin = 128;
    /** Changed documents read per audit pass and per request. */
    static readonly auditDocuments = 50000;
    static readonly auditPage = 5000;
    /** Sequence numbers one request spans, so its cost does not grow with what the shard still has to be read for. */
    static readonly auditWindow = 40000;
    private lane: Promise<unknown> = Promise.resolve();
    private audited?: Map<string, number>;
    /** The block the audit positions stand for; null before anything was stored. */
    private covered: number | null = null;
    private stored = 'null';
    private auditBehind = true;
    private auditedAt = -Infinity;
    private readonly auditInterval: number;
    constructor(private readonly io: CatalogSettleIO, private readonly startBlock: number, private readonly names: SettleIndexNames,
                options: Pick<CatalogSettleConfiguration, 'max_blocks' | 'repair_after_blocks' | 'interval_ms'> = {}) {
        this.maxBlocks = options.max_blocks ?? 512;
        this.repairAfter = options.repair_after_blocks ?? 1024;
        // Steps run back to back while there is a backlog; the audit refreshes indices, so it keeps the configured pace.
        this.auditInterval = options.interval_ms ?? 5000;
        if (!Number.isSafeInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > 100000
            || !Number.isSafeInteger(this.repairAfter) || this.repairAfter < CatalogSettler.tipMargin
            || !Number.isSafeInteger(startBlock) || startBlock < 1
            || !Number.isSafeInteger(names.partitionSize) || names.partitionSize < 1) throw new Error('Invalid catalog settle configuration');
    }
    /** Whether the last audit pass left changed documents unread, so another step should follow soon. */
    get auditPending(): boolean {return this.auditBehind;}
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const result = this.lane.then(work, work);
        this.lane = result.then(() => undefined, () => undefined);
        return result;
    }
    /** The one place a document of this kind and block may be written, and under which id. */
    private placement(document: SettleDocument, position: ProtocolSourcePosition): string | undefined {
        const {chain, indexVersion, partitionSize} = this.names, source = document.source, block = position.blockNum;
        if (source?.block_num !== block) return `a ${document.kind} document of block ${block} names another block`;
        if (document.kind === 'block') {
            if (document.index !== `${chain}-block-${indexVersion}` || document.id !== String(block) || source.block_id !== position.blockId)
                return `block document of ${block} has another index, id or block id`;
        } else {
            const partition = String(Math.ceil(block / partitionSize)).padStart(6, '0');
            if (document.index !== `${chain}-action-${indexVersion}-${partition}` || typeof source.global_sequence !== 'string'
                || document.id !== source.global_sequence) return `action document ${document.id} of block ${block} has another index or id`;
            // Settling a range is the claim that its actions need no proof store: each must name its own disk position.
            if (!settledActionProtocol(source.protocol) || source.protocol.selectionId !== protocolDiskSelectionId(position))
                return `action document ${document.id} of block ${block} is not bound to its disk position`;
        }
        return undefined;
    }

    /**
     * Read the action documents at or below `through` that changed since the last pass, within a bounded budget.
     * `next` is the audit position once the blocks in `blocks` are settled again.
     */
    private async changed(shards: readonly SettleShard[], through: number): Promise<{blocks: number[]; next: Map<string, number>; complete: boolean}> {
        await this.load();
        // The positions stand for the blocks through `covered`. If the settled block is anything else, some block
        // at or below it was neither settled by this settler since nor read by an audit: start over.
        if (this.covered !== through) {this.audited = new Map(); this.covered = through;}
        // Shards of indices that no longer exist drop out; a recreated index has another id and starts over, as
        // does a shard whose sequence numbers went back.
        const next = new Map<string, number>(), blocks = new Set<number>();
        for (const shard of shards) {const known = this.audited!.get(shardKey(shard)) ?? -1; next.set(shardKey(shard), known > shard.checkpoint ? -1 : known);}
        const behind = shards.filter(shard => next.get(shardKey(shard))! < shard.checkpoint);
        // A write below a shard's checkpoint has completed, and a refresh after that makes it searchable.
        if (behind.length) await this.io.refresh([...new Set(behind.map(shard => shard.index))]);
        let budget = CatalogSettler.auditDocuments, complete = true;
        for (const shard of behind) {
            let after = next.get(shardKey(shard))!;
            while (after < shard.checkpoint) {
                if (budget <= 0) {complete = false; break;}
                const limit = Math.min(budget, CatalogSettler.auditPage), upTo = Math.min(shard.checkpoint, after + CatalogSettler.auditWindow);
                const page = await this.io.changedActions({...shard, checkpoint: upTo}, after, through, limit);
                let last = after;
                for (const document of page) {
                    if (!Number.isSafeInteger(document.seqNo) || document.seqNo <= last || document.seqNo > upTo
                        || !Number.isSafeInteger(document.block) || document.block > through) throw new Error('Changed action listing is out of order or range');
                    last = document.seqNo;
                    if (!document.diskBacked) blocks.add(document.block);
                }
                // A request costs as much as a tenth of a page whatever it returns, which bounds the requests of a pass.
                budget -= Math.max(page.length, Math.ceil(CatalogSettler.auditPage / 10));
                after = page.length < limit ? upTo : last;
            }
            next.set(shardKey(shard), after);
        }
        return {blocks: [...blocks].sort((left, right) => left - right), next, complete};
    }
    private async load(): Promise<void> {
        if (this.audited) return;
        const stored = await this.io.readAudit();
        if (stored !== null && (!Number.isSafeInteger(stored.through) || !stored.shards || typeof stored.shards !== 'object'
            || Object.values(stored.shards).some(seqNo => !Number.isSafeInteger(seqNo)))) throw new Error('Invalid stored settle audit positions');
        this.audited = new Map(Object.entries(stored?.shards ?? {}));this.covered = stored?.through ?? null;this.stored = JSON.stringify(stored);
    }
    private async remember(next: Map<string, number> = this.audited!): Promise<void> {
        const value = {through: this.covered!, shards: Object.fromEntries(next)}, text = JSON.stringify(value);
        if (text !== this.stored) {await this.io.writeAudit(value); this.stored = text;}
        this.audited = next;
    }

    /**
     * Whether every action document at or below the settled block is disk-backed as of this call: that block, and
     * the store selections the action documents above it name. Nothing while changed documents are still unread,
     * a block needs settling again (`step` works on both), or the unsettled tail is too long to list.
     */
    async verify(): Promise<{through: number; selections: string[]} | null> {return this.serial(async () => {
        for (let pass = 0; pass < 64; pass++) {
            const {settled} = await this.io.position();
            if (settled === null) return null;
            const found = await this.changed(await this.io.actionShards(), settled);
            if (found.blocks.length) {this.auditBehind = true; return null;}
            await this.remember(found.next);
            this.auditBehind = !found.complete;
            if (found.complete) {const selections = await this.io.storeSelections(settled); return selections && {through: settled, selections};}
        }
        return null;
    });}

    async step(): Promise<SettleStep> {return this.serial(async () => {
        const {attestedEnd, settled} = await this.io.position();
        if (attestedEnd === null) return {status: 'idle', reason: 'no attested catalog segment'};
        // An audit pass reads the shard positions before any document of its step. Whatever is written to a block
        // this step settles after that point has a higher sequence number, and a later pass reads it. A step that
        // skips the pass leaves the audit position where it was, which only widens what the next pass reads.
        if (settled !== null && (this.auditBehind || performance.now() - this.auditedAt >= this.auditInterval)) {
            const found = await this.changed(await this.io.actionShards(), settled);
            this.auditedAt = performance.now();
            if (found.blocks.length) {
                // The audit position stays where it was until these blocks are disk-backed again.
                this.auditBehind = true;
                const from = found.blocks[0]!, limit = from + this.maxBlocks - 1;
                const dirty = found.blocks.filter(block => block <= limit), to = dirty.at(-1)!;
                const outcome = await this.settleRange(from, to, null);
                if (outcome.status !== 'settled') return outcome;
                return {status: 'resettled', from, to, written: outcome.written, blocks: dirty.length};
            }
            await this.remember(found.next);
            this.auditBehind = !found.complete;
        }
        const indexed = await this.io.highestIndexedBlock();
        if (indexed === null) return {status: 'idle', reason: 'no indexed block'};
        const from = Math.max(this.startBlock, (settled ?? 0) + 1);
        const to = Math.min(attestedEnd, indexed - CatalogSettler.tipMargin, from + this.maxBlocks - 1);
        if (to < from) return {status: 'idle', reason: 'nothing attested and indexed past the settled block'};
        const outcome = await this.settleRange(from, to, indexed);
        if (outcome.status === 'settled') {
            await this.io.recordSettled(to);
            // The audit positions now stand for the blocks through `to`, if this range continues what they stood
            // for. A range that starts further on (a new pinned catalog, a reset checkpoint) leaves blocks between
            // that nothing read: the positions start over, and the next pass reads everything at or below `to`.
            await this.load();
            if (this.covered === null || from !== this.covered + 1) this.audited = new Map();
            if (from !== (this.covered ?? 0) + 1) this.auditBehind = true;
            this.covered = to;
            await this.remember();
        }
        return outcome;
    });}

    /** Make one range disk-backed. `indexed` is null for a range that settled before: nothing of it is still in flight. */
    private async settleRange(from: number, to: number, indexed: number | null): Promise<Extract<SettleStep, {status: 'waiting' | 'settled' | 'refused'}>> {
        const refuse = (message: string) => ({status: 'refused' as const, from, to, message});
        const range = await this.io.fetchRange(from, to);
        const m = range.manifest;
        if (m.from !== from || m.to !== to || m.blocks !== to - from + 1 || range.blocks.length !== m.blocks)
            return refuse('range server returned another range');
        if (!await this.io.isAdoptedSegment(m.catalogSha)) return refuse(`range sealed by ${m.catalogSha}, which is not an adopted segment`);
        for (const [offset, item] of range.blocks.entries()) {
            const position = await this.io.catalogSource(from + offset);
            if (!position || position.blockNum !== from + offset || item.block !== position.blockNum || item.id !== position.blockId)
                return refuse(`block ${from + offset} differs from the catalog`);
            // Every block has exactly one block document; a frame without it would settle a block nothing was read for.
            if (item.documents.filter(document => document.kind === 'block').length !== 1)
                return refuse(`block ${item.block} does not come with exactly one block document`);
            for (const document of item.documents) {const misplaced = this.placement(document, position); if (misplaced) return refuse(misplaced);}
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
        if (missing.length && indexed !== null && to > indexed - this.repairAfter) return {status: 'waiting', from, to, missing: missing.length};

        const rewrites: SettleDocument[] = [], repairs: SettleDocument[] = [];let unchanged = 0, repaired = 0;
        for (const [id, document] of produced) {
            const current = live.get(id);
            if (!current) {repairs.push(document); repaired++; continue;}
            if (body(current.source) !== body(document.source)) {
                if (!incomplete(current.source)) return refuse(`live document ${id} differs from its disk document beyond protocol metadata`);
                rewrites.push(document); repaired++; continue;
            }
            if (json(current.source.protocol ?? null) === json(document.source.protocol ?? null)) unchanged++;
            else rewrites.push(document);
        }
        // A repair writes where no live document of this range was found: no other document may hold that id.
        // The write then creates it, so a document that appears in between fails the step instead of being replaced.
        if (repairs.length && await this.io.existing(repairs) > 0) return refuse('a repaired document id is already used by a document outside this range');
        if (rewrites.length || repairs.length) await this.io.write(rewrites, repairs);
        return {status: 'settled', from, to, written: rewrites.length + repairs.length, unchanged, repaired};
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

/** HTTP and Elasticsearch I/O for a settler; everything the coordinator owns comes from the caller. */
export function elasticSettleIO(options: {
    client: Client; chain: string; indexVersion: string; partitionSize: number; rangeServer: string; profileId: string;
    position: CatalogSettleIO['position']; recordSettled: CatalogSettleIO['recordSettled'];
    catalogSource: CatalogSettleIO['catalogSource']; isAdoptedSegment: CatalogSettleIO['isAdoptedSegment'];
    readAudit: CatalogSettleIO['readAudit']; writeAudit: CatalogSettleIO['writeAudit'];
}): CatalogSettleIO {
    const url = new URL(options.rangeServer);
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)))
        throw new Error('The range server must be on loopback or use https');
    const {client, chain} = options, pageSize = 5000, requestDocuments = 1000, requestBytes = 16 * 1024 * 1024;
    const actions = chain + '-action-*';
    /** A search answers for every shard it asked, or it is not an answer. */
    const searched = (response: any, what: string): any[] => {
        if (!response || response.timed_out !== false || !response._shards || response._shards.failed !== 0
            || response._shards.successful !== response._shards.total || !Array.isArray(response.hits?.hits))
            throw new Error('Incomplete search of ' + what);
        return response.hits.hits;
    };
    /** Every document of the block range, in pages. `cursor` reads a hit's own sort value without loss of precision. */
    async function all(index: string, from: number, to: number, field: string, cursor: (hit: any) => string | number): Promise<any[]> {
        const hits: any[] = [];let after: string | number | undefined;
        while (true) {
            const page = searched(await client.search({index, size: pageSize, sort: [{[field]: 'asc'}], ...(after !== undefined ? {search_after: [after]} : {}),
                query: {range: {block_num: {gte: from, lte: to}}}, track_total_hits: false, ignore_unavailable: true} as any), index);
            hits.push(...page);
            if (page.length < pageSize) return hits;
            const next = cursor(page.at(-1));
            if (after !== undefined && String(next) === String(after)) throw new Error('Search of ' + index + ' does not advance');
            after = next;
        }
    }
    /** Requests of bounded size, in order. */
    function* batches<T>(items: readonly T[], bytes: (item: T) => number): Generator<T[]> {
        let batch: T[] = [], size = 0;
        for (const item of items) {
            const length = bytes(item);
            if (batch.length && (batch.length >= requestDocuments || size + length > requestBytes)) {yield batch; batch = []; size = 0;}
            batch.push(item); size += length;
        }
        if (batch.length) yield batch;
    }
    return {
        position: options.position, recordSettled: options.recordSettled,
        catalogSource: options.catalogSource, isAdoptedSegment: options.isAdoptedSegment,
        readAudit: options.readAudit, writeAudit: options.writeAudit,
        async highestIndexedBlock() {
            const response: any = await client.search({index: chain + '-block-*', size: 0, aggs: {top: {max: {field: 'block_num'}}}});
            searched(response, 'the block index');
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
            // An action's global sequence is its id and may exceed what a JSON number holds: page by the stored decimal.
            const sequence = (hit: any) => {
                const value = hit._source?.global_sequence;
                if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('Action document without a decimal global sequence');
                return value;
            };
            for (const hit of [...await all(chain + '-block-*', from, to, 'block_num', hit => hit._source.block_num),
                ...await all(actions, from, to, 'global_sequence', sequence)]) {
                const id = key(hit._index, hit._id);
                if (documents.has(id)) throw new Error('Search returned ' + id + ' twice');
                documents.set(id, {index: hit._index, id: hit._id, source: hit._source});
            }
            return documents;
        },
        async existing(documents) {
            let found = 0;
            for (const batch of batches(documents, () => 256)) {
                const response: any = await client.mget({docs: batch.map(document => ({_index: document.index, _id: document.id})), _source: false});
                if (!Array.isArray(response?.docs) || response.docs.length !== batch.length) throw new Error('Incomplete existence check');
                for (const item of response.docs) {
                    // An index that does not exist holds no document; any other failure is not an answer.
                    if (item.error && item.error.type !== 'index_not_found_exception')
                        throw new Error('Existence check failed: ' + JSON.stringify(item.error).slice(0, 300));
                    if (item.found === true) found++;
                }
            }
            return found;
        },
        async write(rewrites, repairs) {
            const operations = [...rewrites.map(document => ({verb: 'index' as const, document})),
                ...repairs.map(document => ({verb: 'create' as const, document}))].map(({verb, document}) =>
                ({verb, meta: {[verb]: {_index: document.index, _id: document.id}}, source: document.source,
                    bytes: Buffer.byteLength(JSON.stringify(document.source)) + 256}));
            for (const batch of batches(operations, operation => operation.bytes)) {
                const response: any = await client.bulk({operations: batch.flatMap(operation => [operation.meta, operation.source]), refresh: false});
                if (!Array.isArray(response?.items) || response.items.length !== batch.length) throw new Error('Incomplete settle write receipt');
                const failed = response.items.map((item: any, at: number) => item[batch[at]!.verb]).filter((item: any) => !item || !(item.status >= 200 && item.status < 300));
                if (response.errors || failed.length) throw new Error(`Settle write failed for ${failed.length} documents: `
                    + JSON.stringify(failed[0]?.error ?? null).slice(0, 300));
            }
        },
        async actionShards() {
            // Statistics leave out a shard without an assigned copy and do not count it as failed, so the answer
            // is complete only if it has every shard the index is made of.
            const settings: any = await client.indices.getSettings({index: actions, name: 'index.number_of_shards', flat_settings: true, ignore_unavailable: true} as any);
            const response: any = await client.indices.stats({index: actions, level: 'shards', metric: 'docs', ignore_unavailable: true} as any);
            if (!response?._shards || response._shards.failed !== 0) throw new Error('Incomplete action index statistics');
            const shards: SettleShard[] = [];
            for (const [index, setting] of Object.entries<any>(settings ?? {})) {
                const count = Number(setting?.settings?.['index.number_of_shards']), entry = response.indices?.[index];
                if (!Number.isSafeInteger(count) || count < 1 || typeof entry?.uuid !== 'string' || !entry.uuid)
                    throw new Error(`Action index ${index} has no shard statistics`);
                for (let shard = 0; shard < count; shard++) {
                    // The primary's global checkpoint: every write through it has completed on every in-sync copy.
                    const primary = (entry.shards?.[shard] as any[] | undefined)?.find(copy => copy.routing?.primary === true && copy.routing.state === 'STARTED');
                    const checkpoint = primary?.seq_no?.global_checkpoint;
                    if (!Number.isSafeInteger(checkpoint) || checkpoint < -1) throw new Error(`Action index ${index} shard ${shard} has no started primary`);
                    shards.push({index, uuid: entry.uuid, shard, checkpoint});
                }
            }
            return shards.sort((left, right) => left.index < right.index ? -1 : left.index > right.index ? 1 : left.shard - right.shard);
        },
        async storeSelections(after) {
            const selections = new Set<string>();let cursor: string | undefined;
            for (let page = 0; ; page++) {
                // The unsettled tail is short when this is asked; a long one means it is not the time to ask.
                if (page >= 200) return null;
                const hits = searched(await client.search({index: actions, size: pageSize, sort: [{global_sequence: 'asc'}],
                    ...(cursor !== undefined ? {search_after: [cursor]} : {}), track_total_hits: false, ignore_unavailable: true,
                    _source: ['global_sequence', 'protocol.schemaVersion', 'protocol.selectionId'],
                    query: {range: {block_num: {gt: after}}}} as any), actions);
                for (const hit of hits) {
                    const protocol = hit._source?.protocol;
                    if (!settledActionProtocol(protocol) && typeof protocol?.selectionId === 'string' && /^h45srcsel1:[0-9a-f]{64}$/.test(protocol.selectionId))
                        selections.add(protocol.selectionId);
                }
                if (hits.length < pageSize) return [...selections];
                const next = hits.at(-1)._source?.global_sequence;
                if (typeof next !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(next) || next === cursor) throw new Error('Action document without a decimal global sequence');
                cursor = next;
            }
        },
        async refresh(indices) {
            const response: any = await client.indices.refresh({index: [...indices]});
            if (!response?._shards || response._shards.failed !== 0) throw new Error('Incomplete action index refresh');
        },
        async changedActions(shard, after, through, limit) {
            const hits = searched(await client.search({index: shard.index, preference: '_shards:' + shard.shard, size: limit,
                sort: [{_seq_no: 'asc'}], _source: ['block_num', 'protocol.schemaVersion'], track_total_hits: false,
                query: {bool: {filter: [{range: {_seq_no: {gt: after, lte: shard.checkpoint}}}, {range: {block_num: {lte: through}}}]}}} as any),
                shard.index + ' shard ' + shard.shard);
            return hits.map(hit => ({seqNo: hit.sort?.[0], block: hit._source?.block_num, diskBacked: settledActionProtocol(hit._source?.protocol)}));
        },
    };
}
