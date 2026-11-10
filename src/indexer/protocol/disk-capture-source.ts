import {createHash} from 'node:crypto';
import {open, stat, readFile, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {protocolAbiCaptureDigest} from './abi-observation-store.js';
import type {ProtocolSourcePosition} from './source-bindings.js';
import type {ProtocolSourceCapture} from './source-observation.js';

/** Where a node keeps the logs a disk ABI catalog was scanned from, and the exact SHiP handshake. */
export interface DiskCaptureConfiguration {
    readonly state_history_dir: string;
    readonly blocks_dir: string;
    readonly ship_abi: string;
}

export class DiskCaptureUnavailableError extends Error {
    readonly statusCode = 503;
    constructor(readonly code: string, message: string) {super(message); this.name = 'DiskCaptureUnavailableError';}
}
function unavailable(code: string, message: string): never {throw new DiskCaptureUnavailableError(code, message);}
function invalid(message: string): never {unavailable('disk_capture_invalid', message);}

/** Magic of a version-0, non-pruned state-history log entry: the name `ship`, log version 0. */
const SHIP_MAGIC = 0xc35d500000000000n;
/** Entry header (magic, block id, payload size) and the position trailer after the payload. */
const HEADER = 48n, OVERHEAD = 56n;
/** Inflated bytes of one section; the decoders apply their own, smaller bounds. */
const MAXIMUM_SECTION = 256 * 1024 * 1024;
const hex64 = /^[0-9a-f]{64}$/;
const blockNumOf = (id: Uint8Array) => ((id[0]! << 24) | (id[1]! << 16) | (id[2]! << 8) | id[3]!) >>> 0;

/** An append-only file and its offset index, re-opened when either path is replaced. */
class IndexedLog {
    private handles?: Promise<{log: FileHandle; index: FileHandle; logIdentity: string; indexIdentity: string}>;
    constructor(readonly log: string, readonly index: string) {}
    private static identity(value: {dev: bigint; ino: bigint}) {return `${value.dev}:${value.ino}`;}
    async files() {
        const current = await this.handles?.catch(() => undefined);
        if (current) {
            const [log, index] = await Promise.all([stat(this.log, {bigint: true}), stat(this.index, {bigint: true})])
                .catch(() => unavailable('disk_capture_unavailable', `Log ${this.log} or its index disappeared`));
            if (IndexedLog.identity(log) === current.logIdentity && IndexedLog.identity(index) === current.indexIdentity) return current;
            await this.close();
        }
        this.handles = (async () => {
            const [log, index] = await Promise.all([open(this.log, 'r'), open(this.index, 'r')]);
            const [logStat, indexStat] = await Promise.all([log.stat({bigint: true}), index.stat({bigint: true})]);
            return {log, index, logIdentity: IndexedLog.identity(logStat), indexIdentity: IndexedLog.identity(indexStat)};
        })();
        try {return await this.handles;}
        catch {this.handles = undefined; unavailable('disk_capture_unavailable', `Log ${this.log} or its index cannot be opened`);}
    }
    async close(): Promise<void> {
        const current = await this.handles?.catch(() => undefined);
        this.handles = undefined;
        await Promise.all([current?.log.close(), current?.index.close()].map(value => value?.catch(() => {})));
    }
}

async function readExact(file: FileHandle, position: bigint, length: number, what: string): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_SECTION) invalid(`${what} has an invalid length`);
    const buffer = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
        const {bytesRead} = await file.read(buffer, done, length - done, position + BigInt(done));
        if (bytesRead === 0) invalid(`${what} is truncated`);
        done += bytesRead;
    }
    return buffer;
}

/** One state-history log (`chain_state_history` or `trace_history`), read only through its index. */
class StateHistoryLog {
    private first?: number;
    private readonly file: IndexedLog;
    constructor(directory: string, readonly stem: string) {
        this.file = new IndexedLog(join(directory, stem + '.log'), join(directory, stem + '.index'));
    }
    close() {return this.file.close();}
    async begin(): Promise<number> {
        if (this.first !== undefined) return this.first;
        const {log} = await this.file.files();
        const head = await readExact(log, 0n, Number(HEADER), `${this.stem} first entry`);
        if (head.readBigUInt64LE(0) !== SHIP_MAGIC) invalid(`${this.stem} does not start with a version-0 state-history entry`);
        return this.first = blockNumOf(head.subarray(8, 40));
    }
    /** Block `n`'s inflated payload, from the indexed entry whose header names `blockId`. */
    async entry(n: number, blockId: string): Promise<Buffer | null> {
        const begin = await this.begin();
        if (n < begin) return null;
        const {log, index} = await this.file.files();
        const [logSize, indexSize] = await Promise.all([log.stat({bigint: true}), index.stat({bigint: true})]).then(([a, b]) => [a.size, b.size]);
        const slot = BigInt(n - begin) * 8n;
        if (slot + 8n > indexSize!) unavailable('disk_capture_unavailable', `${this.stem} has no entry for block ${n}`);
        const pos = (await readExact(index, slot, 8, `${this.stem} index slot ${n}`)).readBigUInt64LE(0);
        if (pos + OVERHEAD > logSize!) invalid(`${this.stem} index points block ${n} past the log`);
        const head = await readExact(log, pos, Number(logSize! - pos < 60n ? logSize! - pos : 60n), `${this.stem} entry ${n}`);
        if (head.length < Number(HEADER) + 4 || head.readBigUInt64LE(0) !== SHIP_MAGIC) invalid(`${this.stem} has no entry header for block ${n}`);
        const id = head.subarray(8, 40);
        if (blockNumOf(id) !== n) invalid(`${this.stem} entry at ${pos} is not block ${n}`);
        if (id.toString('hex') !== blockId) invalid(`${this.stem} holds another block ${n} than the catalog`);
        const payload = head.readBigUInt64LE(40), end = pos + OVERHEAD + payload;
        if (payload < 4n || end > logSize!) invalid(`${this.stem} entry ${n} payload is out of bounds`);
        const trailer = (await readExact(log, end - 8n, 8, `${this.stem} trailer ${n}`)).readBigUInt64LE(0);
        if (trailer !== pos) invalid(`${this.stem} entry ${n} has a mismatched position trailer`);
        const field = head.readUInt32LE(48);
        let data: bigint, length: bigint, declared: bigint | undefined;
        if (field === 1) {
            if (payload < 12n || head.length < 60) invalid(`${this.stem} entry ${n} is shorter than its sized preamble`);
            declared = head.readBigUInt64LE(52); data = pos + HEADER + 12n; length = payload - 12n;
        } else {
            if (field !== 0 && BigInt(field) !== payload - 4n) invalid(`${this.stem} entry ${n} has an inconsistent legacy preamble`);
            data = pos + HEADER + 4n; length = payload - 4n;
        }
        if (declared !== undefined && declared > BigInt(MAXIMUM_SECTION)) invalid(`${this.stem} entry ${n} declares an oversized payload`);
        const compressed = await readExact(log, data, Number(length), `${this.stem} payload ${n}`);
        let inflated: Buffer;
        try {inflated = inflateSync(compressed, {maxOutputLength: MAXIMUM_SECTION});}
        catch {invalid(`${this.stem} entry ${n} does not inflate`);}
        if (declared !== undefined && BigInt(inflated.length) !== declared) invalid(`${this.stem} entry ${n} inflates to another size than declared`);
        return inflated;
    }
}

/** A cursor over Wire's packed `block_header`, with the codec's acceptance rules. */
class HeaderCursor {
    pos = 0;
    constructor(private readonly bytes: Buffer) {}
    take(count: number): void {
        if (count < 0 || this.pos + count > this.bytes.length) invalid('Block header is truncated');
        this.pos += count;
    }
    byte(): number {this.take(1); return this.bytes[this.pos - 1]!;}
    varuint(): number {
        let value = 0;
        for (let n = 0; n < 5; n++) {
            const byte = this.byte();
            if (n === 4 && byte > 15) invalid('Block header varuint overflows');
            value += (byte & 127) * 2 ** (7 * n);
            if (byte < 128) {
                if (n > 0 && byte === 0) invalid('Block header varuint is not canonical');
                return value;
            }
        }
        invalid('Block header varuint overflows');
    }
    optional(): boolean {
        const presence = this.byte();
        if (presence > 1) invalid('Block header optional has an invalid presence byte');
        return presence === 1;
    }
    blob(): void {this.take(this.varuint());}
    /** A Wire public key: the codec's crypto variants and frame bound. */
    publicKey(): void {
        const tag = this.varuint(), start = this.pos;
        if (tag === 0 || tag === 1 || tag === 3) this.take(33);
        else if (tag === 2) {this.take(33); this.byte(); const rpid = this.varuint(); if (rpid < 1 || rpid > 4096) invalid('Block header WebAuthn key is invalid'); this.take(rpid);}
        else if (tag === 4) this.take(32);
        else if (tag === 5) {if (this.byte() !== 1) invalid('Block header BLS key pointer is absent'); this.take(96);}
        else invalid('Block header key has an unknown crypto variant');
        if (this.pos - start > 4096) invalid('Block header key exceeds its frame bound');
    }
}

/** Bytes of the packed `block_header` at the start of a Wire `signed_block`. */
export function wireBlockHeaderLength(block: Buffer): number {
    const c = new HeaderCursor(block);
    c.take(4 + 8 + 32 + 32 + 32);      // timestamp, producer, previous, transaction_mroot, finality_mroot
    c.take(4 + 1);                     // qc_claim_t {block_num, is_strong_qc}: the codec reads bool as any byte
    if (c.optional()) {                // new_finalizer_policy_diff
        c.take(4 + 8);                 // generation, threshold
        c.take(2 * c.varuint());       // remove_indexes
        for (let i = c.varuint(); i > 0; i--) {c.take(2); c.blob(); c.take(8); c.blob();} // index, {description, weight, public_key bytes}
    }
    if (c.optional()) {                // new_proposer_policy_diff
        c.take(4 + 4);                 // version, proposal_time
        c.take(2 * c.varuint());       // remove_indexes
        for (let i = c.varuint(); i > 0; i--) {
            c.take(2 + 8);             // index, producer_name
            if (c.varuint() !== 0) invalid('Block header signing authority has an unknown variant');
            c.take(4);                 // threshold
            for (let k = c.varuint(); k > 0; k--) {c.publicKey(); c.take(2);}
        }
    }
    for (let i = c.varuint(); i > 0; i--) {c.take(2); c.blob();} // header_extensions
    return c.pos;
}

/** The id Antelope derives for a header: its digest with the block number in the first four bytes. */
export function wireBlockId(block: Buffer, blockNum: number): string {
    const id = createHash('sha256').update(block.subarray(0, wireBlockHeaderLength(block))).digest();
    id.writeUInt32BE(blockNum >>> 0, 0);
    return id.toString('hex');
}

const expectedHeaderTypes: Readonly<Record<string, readonly [string, string][]>> = {
    block_header: [['timestamp', 'block_timestamp_type'], ['producer', 'name'], ['previous', 'checksum256'],
        ['transaction_mroot', 'checksum256'], ['finality_mroot', 'checksum256'], ['qc_claim', 'qc_claim_t'],
        ['new_finalizer_policy_diff', 'finalizer_policy_diff?'], ['new_proposer_policy_diff', 'proposer_policy_diff?'],
        ['header_extensions', 'extension[]']],
    qc_claim_t: [['block_num', 'uint32'], ['is_strong_qc', 'bool']],
    finalizer_policy_diff: [['generation', 'uint32'], ['threshold', 'uint64'], ['remove_indexes', 'uint16[]'],
        ['insert_indexes', 'insert_finalizer_policy_index_pair[]']],
    insert_finalizer_policy_index_pair: [['index', 'uint16'], ['value', 'finalizer_authority']],
    finalizer_authority: [['description', 'string'], ['weight', 'uint64'], ['public_key', 'bytes']],
    proposer_policy_diff: [['version', 'uint32'], ['proposal_time', 'block_timestamp_type'], ['remove_indexes', 'uint16[]'],
        ['insert_indexes', 'insert_proposer_policy_index_pair[]']],
    insert_proposer_policy_index_pair: [['index', 'uint16'], ['value', 'producer_authority']],
    producer_authority: [['producer_name', 'name'], ['authority', 'block_signing_authority']],
    block_signing_authority_v0: [['threshold', 'uint32'], ['keys', 'key_weight[]']],
    key_weight: [['key', 'public_key'], ['weight', 'uint16']],
    extension: [['type', 'uint16'], ['data', 'bytes']],
};

/** Refuse a handshake whose header layout differs from the one `wireBlockHeaderLength` walks. */
export function assertWireBlockHeaderSchema(schema: any): void {
    const struct = (name: string) => (schema?.structs ?? []).find((value: any) => value?.name === name);
    for (const [name, fields] of Object.entries(expectedHeaderTypes)) {
        const found = struct(name);
        const actual = Array.isArray(found?.fields) ? found.fields.map((field: any) => [field?.name, field?.type]) : undefined;
        if (!found || (found.base ?? '') !== '' || JSON.stringify(actual) !== JSON.stringify(fields))
            throw new Error(`SHiP schema defines ${name} differently than the disk capture header walk`);
    }
    const variant = (schema?.variants ?? []).find((value: any) => value?.name === 'block_signing_authority');
    if (JSON.stringify(variant?.types) !== JSON.stringify(['block_signing_authority_v0']))
        throw new Error('SHiP schema defines block_signing_authority differently than the disk capture header walk');
    const walked = new Set([...Object.keys(expectedHeaderTypes), 'block_signing_authority']);
    if ((schema?.types ?? []).some((value: any) => walked.has(value?.new_type_name)))
        throw new Error('SHiP schema aliases a type the disk capture header walk reads');
}

/** The block log (`blocks.log` with `blocks.index`): signed blocks, each followed by its offset. */
class BlockLog {
    private first?: number;
    private readonly file: IndexedLog;
    constructor(directory: string) {this.file = new IndexedLog(join(directory, 'blocks.log'), join(directory, 'blocks.index'));}
    close() {return this.file.close();}
    async block(n: number, blockId: string, previousBlockId: string | null): Promise<Buffer> {
        const {log, index} = await this.file.files();
        if (this.first === undefined) {
            const head = await readExact(log, 0n, 8, 'block log preamble');
            const version = head.readUInt32LE(0), first = head.readUInt32LE(4);
            if (version !== 3 || first < 1) invalid(`Block log version ${version} is not supported`);
            this.first = first;
        }
        const first = this.first;
        const [logSize, indexSize] = await Promise.all([log.stat({bigint: true}), index.stat({bigint: true})]).then(([a, b]) => [a.size, b.size]);
        const slots = indexSize! / 8n;
        if (n < first || BigInt(n - first) >= slots) unavailable('disk_capture_unavailable', `Block log has no block ${n}`);
        const start = (await readExact(index, BigInt(n - first) * 8n, 8, `block log index ${n}`)).readBigUInt64LE(0);
        const next = BigInt(n - first) + 1n < slots
            ? (await readExact(index, (BigInt(n - first) + 1n) * 8n, 8, `block log index ${n + 1}`)).readBigUInt64LE(0) : logSize!;
        if (next > logSize! || next < start + 8n + 116n) invalid(`Block log entry ${n} is out of bounds`); // 116: the smallest header
        const trailer = (await readExact(log, next - 8n, 8, `block log trailer ${n}`)).readBigUInt64LE(0);
        if (trailer !== start) invalid(`Block log entry ${n} has a mismatched position trailer`);
        const bytes = await readExact(log, start, Number(next - 8n - start), `block log entry ${n}`);
        if (wireBlockId(bytes, n) !== blockId) invalid(`Block log holds another block ${n} than the catalog`);
        if (previousBlockId !== null && bytes.subarray(12, 44).toString('hex') !== previousBlockId)
            invalid(`Block log block ${n} has another parent than the catalog`);
        return bytes;
    }
}

/** Reads a catalog-covered block's exact SHiP sections from the node's logs. Each section is
 * checked against the catalog's pinned block id; the result is the capture SHiP delivered. */
export class DiskCaptureSource {
    private readonly states: StateHistoryLog;
    private readonly traces: StateHistoryLog;
    private readonly blocks: BlockLog;
    private constructor(configuration: DiskCaptureConfiguration, readonly schemaJson: string) {
        this.states = new StateHistoryLog(configuration.state_history_dir, 'chain_state_history');
        this.traces = new StateHistoryLog(configuration.state_history_dir, 'trace_history');
        this.blocks = new BlockLog(configuration.blocks_dir);
    }
    /** `shipAbiSha256` is the catalog's pinned handshake digest; the configured file must match it. */
    static async open(configuration: DiskCaptureConfiguration, shipAbiSha256: string): Promise<DiskCaptureSource> {
        for (const key of ['state_history_dir', 'blocks_dir', 'ship_abi'] as const)
            if (typeof configuration?.[key] !== 'string' || !configuration[key].length) throw new Error(`Disk capture requires ${key}`);
        if (!hex64.test(shipAbiSha256)) throw new Error('Disk capture requires the catalog handshake digest');
        const schemaJson = await readFile(configuration.ship_abi, 'utf8');
        if (createHash('sha256').update(schemaJson).digest('hex') !== shipAbiSha256)
            throw new Error('Disk capture handshake differs from the catalog');
        assertWireBlockHeaderSchema(JSON.parse(schemaJson));
        return new DiskCaptureSource(configuration, schemaJson);
    }
    async close(): Promise<void> {await Promise.all([this.states.close(), this.traces.close(), this.blocks.close()]);}
    async capture(position: ProtocolSourcePosition): Promise<{capture: ProtocolSourceCapture; captureSha256: string}> {
        if (!Number.isSafeInteger(position?.blockNum) || position.blockNum < 1 || !hex64.test(position.blockId)
            || (position.previousBlockId !== null && !hex64.test(position.previousBlockId))) invalid('Invalid disk capture position');
        const n = position.blockNum;
        const [block, traces, deltas] = await Promise.all([this.blocks.block(n, position.blockId, position.previousBlockId),
            this.traces.entry(n, position.blockId), this.states.entry(n, position.blockId)]);
        if (deltas === null) unavailable('disk_capture_unavailable', `Chain-state history has no block ${n}`);
        const capture: ProtocolSourceCapture = {kind: 'unattested-ship-result-sections-v1', schemaJson: this.schemaJson,
            blockHex: block.toString('hex'), tracesHex: traces === null ? null : traces.toString('hex'), deltasHex: deltas.toString('hex')};
        return {capture, captureSha256: protocolAbiCaptureDigest(position, capture)};
    }
}
