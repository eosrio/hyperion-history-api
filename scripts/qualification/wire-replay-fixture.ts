/** Source-backed, bounded Wire engineering replay. No worker/core substitutions or ABI seed. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocket, WebSocketServer} from 'ws';

export const wireReplayPins = Object.freeze({
    packageRevision: '8b7d8a39f098bde77fa8d8f22a20a4fffc3e457b',
    profileId: 'wire-sysio-7dede884-engineering-v1', sourceRevision: '7dede884e0150d36fa788e85a119e10653ade8ca',
    chainId: '9f70136446c1a3ea95deefbbe4aaeee4f31f16870eba976fcb7054172fbffacf',
    archiveSha256: '9a0b82e070662be562b2da3d4db61f1f7e143f1b32df47fef7a831b120077026',
    exportSha256: '139206ce71eac98e817cb32fc34442bac9ede94a8ea50156f1ba3d5f9afa105c',
    supplementSha256: '10330576abcef6b2ba4e45c67e479024f18d5ccb3a663cb711b62b51f1663a5d',
    schemaSha256: '94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9',
    genesisSha256: 'af50077d52d2acc33ca30ce63e1cf2f938275fa96093e2412ccc562db3123d4c',
    auditSha256: 'cbd1a5e5035d49adeaba8485ef45a3814de2cd5d22b72da997653a34646bc2fe',
    prepareSha256: 'b3eca60486c9e804c5436ad24843d4356baae0dc2b8f73847521dea2ccf9dea6',
    registrySha256: '249161bb141b5417424916450b95fbf9bfb8696e5926b58d8f0fa44971363faf',
    epochMilliseconds: 1735689600000, slotMilliseconds: 500,
});
export const wireReplayLimits = Object.freeze({connections: 8, activeConnections: 2, requests: 4096,
    requestBytes: 1024 * 1024, totalRequestBytes: 8 * 1024 * 1024, sentBytes: 64 * 1024 * 1024,
    bufferedBytes: 16 * 1024 * 1024, inFlight: 128, durationMs: 300000});
export const wireReplayRpcLimits = Object.freeze({requestBytes: 4096, responseBytes: 4096, requests: 128});
const capturePrefix = 'evidence/capture-application-2-120-final/';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const number = (value: unknown, min: number, max: number, label: string): number => {
    assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, label); return value;
};
const boolean = (value: unknown, label: string): boolean => {
    assert.ok(typeof value === 'boolean' || value === 0 || value === 1, label); return value === true || value === 1;
};
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        assert.ok(!ArrayBuffer.isView(value), 'only JSON data may enter a frozen public view');
        for (const entry of Object.values(value)) freeze(entry);
        Object.freeze(value);
    }
    return value;
}
function parse(bytes: Buffer): any {
    return JSON.parse(bytes.toString('utf8'), (_key, value, context?: {source?: string}) => {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
            assert.ok(typeof context?.source === 'string' && /^-?\d+$/.test(context.source), 'unsafe integer needs its exact source token'); return context.source;
        }
        return value;
    });
}
function safeRelative(file: string) {
    assert.match(file, /^[A-Za-z0-9_./-]+$/); assert.ok(!isAbsolute(file) && !file.includes('\\'));
    assert.ok(file.split('/').every(part => part && part !== '.' && part !== '..')); return file;
}
async function readRegular(root: string, file: string, maximum = 16 * 1024 * 1024) {
    safeRelative(file); const actualRoot = await realpath(root);
    let parent = actualRoot;
    for (const part of file.split('/').slice(0, -1)) {
        parent = join(parent, part); const info = await lstat(parent);
        assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'source parent must be ordinary');
    }
    const path = join(actualRoot, ...file.split('/')); const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'invalid bounded regular source file');
    const bytes = await readFile(path); assert.equal(bytes.length, info.size); return bytes;
}

export interface WireReplayRecord {
    blockNum: number; id: string; previousId: string; previous: {block_num: number; block_id: string};
    frame: Buffer; frameSha256: string; block: any; traces: any[]; deltas: any[];
    deltaRows: {stream: string; present: boolean; rawHex: string; value: any; ordinal: number}[];
    deltaFraming: {declaredCount: number; actualCount: number; compatibility: string | null}; abiObservations: any;
}
export interface AuditedWireReplayFixture {
    readonly packageRoot: string; readonly packageRevision: string; readonly profileId: string; readonly chainId: string;
    readonly replayStart: 2; readonly replayEnd: 120; readonly manifest: any; readonly audit: any;
    readonly independentChecks: readonly any[];
    readonly schema: any; readonly originalStatus: any; readonly lineage: any;
    readonly records: readonly WireReplayRecord[];
    read(file: string): Buffer;
    decodeRequest(bytes: Uint8Array): any;
}
interface Snapshot {files: Map<string, Buffer>; records: WireReplayRecord[]; manifest: any; audit: any; schema: any;
    status: any; lineage: any; checks: readonly any[]; decodeRequest: (bytes: Uint8Array) => any; packageRoot: string;}
const snapshots = new WeakMap<AuditedWireReplayFixture, Snapshot>();
function snapshot(fixture: AuditedWireReplayFixture): Snapshot {
    const value = snapshots.get(fixture); assert.ok(value, 'Wire replay requires an independently audited fixture'); return value;
}

/** Pure transport membership check. It never grants a service capability on its own. */
export function auditWireTransportMembership(files: ReadonlyMap<string, Buffer>, manifest: any) {
    assert.ok(Array.isArray(manifest.transport) && manifest.transport.length <= 8192);
    const incoming: {opcode: number; payload: Buffer}[] = []; const outgoing: Buffer[] = [];
    let fragments: Buffer[] = [], messageOpcode = 0, total = 0;
    for (const entry of manifest.transport) {
        assert.equal(entry.complete, true, 'incomplete original transport frame');
        assert.ok(entry.direction === 'in' || entry.direction === 'out');
        const raw = files.get(capturePrefix + safeRelative(entry.file)); assert.ok(raw);
        assert.equal(raw.length, entry.bytes); assert.equal(hash(raw), entry.sha256); total += raw.length;
        assert.ok(total <= 64 * 1024 * 1024 && raw.length >= 2);
        const first = raw[0], second = raw[1], opcode = first & 15, final = Boolean(first & 128);
        assert.equal(first & 0x70, 0); assert.equal(Boolean(second & 128), entry.direction === 'out');
        assert.equal(entry.opcode, opcode); let size = second & 127, offset = 2;
        if (size === 126) {assert.ok(raw.length >= 4); size = raw.readUInt16BE(2); offset = 4; assert.ok(size >= 126);}
        else if (size === 127) {assert.ok(raw.length >= 10); const wide = raw.readBigUInt64BE(2); assert.ok(wide >= 65536n && wide <= 16n * 1024n * 1024n); size = Number(wide); offset = 10;}
        assert.ok(size <= 16 * 1024 * 1024);
        const masked = Boolean(second & 128); const mask = masked ? raw.subarray(offset, offset + 4) : undefined;
        if (masked) offset += 4;
        assert.equal(raw.length, offset + size, 'transport header/payload membership mismatch');
        const payload = Buffer.from(raw.subarray(offset));
        if (mask) {assert.equal(mask.length, 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];}
        if (opcode >= 8) {assert.ok(final && size <= 125 && [8, 9, 10].includes(opcode)); continue;}
        if (entry.direction === 'out') {assert.ok(final && opcode === 2); outgoing.push(payload); continue;}
        assert.ok(opcode === (messageOpcode ? 0 : 1) || opcode === (messageOpcode ? 0 : 2), 'unexpected source continuation');
        if (!messageOpcode) messageOpcode = opcode;
        fragments.push(payload); assert.ok(fragments.reduce((sum, part) => sum + part.length, 0) <= 16 * 1024 * 1024);
        if (final) {incoming.push({opcode: messageOpcode, payload: Buffer.concat(fragments)}); fragments = []; messageOpcode = 0;}
    }
    assert.equal(messageOpcode, 0); assert.equal(incoming.length, manifest.blocks.length + 2);
    assert.equal(incoming[0].opcode, 1); assert.deepEqual(incoming[0].payload, files.get(capturePrefix + 'schema.bin'));
    assert.equal(incoming[1].opcode, 2); assert.deepEqual(incoming[1].payload, files.get(capturePrefix + 'status.bin'));
    for (const [index, block] of manifest.blocks.entries()) {
        assert.equal(incoming[index + 2].opcode, 2);
        assert.deepEqual(incoming[index + 2].payload, files.get(capturePrefix + block.source.file), 'result bytes differ from original transport');
    }
    assert.equal(outgoing.length, manifest.blocks.length + 2);
    assert.deepEqual(outgoing[0], files.get(capturePrefix + 'requests/status.bin'));
    assert.deepEqual(outgoing[1], files.get(capturePrefix + 'requests/range.bin'));
    for (const ack of outgoing.slice(2)) assert.deepEqual(ack, files.get(capturePrefix + 'requests/ack.bin'));
    return freeze({frames: manifest.transport.length, messages: incoming.length, originalAcknowledgements: outgoing.length - 2, bytes: total});
}

export interface AuditWireReplayOptions {packageRoot?: string; outputDirectory?: string; python?: string;}
export async function auditWireReplayFixture(options: AuditWireReplayOptions = {}): Promise<AuditedWireReplayFixture> {
    const descriptor = fileURLToPath(import.meta.resolve('@eosrio/hyperion-wire-plugin/protocol-provider.json'));
    const packageRoot = await realpath(resolve(dirname(descriptor), '..'));
    if (options.packageRoot !== undefined) assert.equal(await realpath(options.packageRoot), packageRoot, 'fixture must use the installed selected package');
    const {loadChainProtocol} = await import('../../build/indexer/protocol/selection.js');
    const selection = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: wireReplayPins.profileId});
    assert.equal(selection.components?.length, 2);
    for (const component of selection.components!) assert.equal(component.sourceRevision, wireReplayPins.packageRevision);
    const fixtureRoot = join(packageRoot, 'fixtures/codec/application-capture-20261020');
    for (const [file, expected] of [['audit.py', wireReplayPins.auditSha256], ['prepare.py', wireReplayPins.prepareSha256], ['manifest.json', wireReplayPins.registrySha256]])
        assert.equal(hash(await readRegular(fixtureRoot, file!)), expected, `installed fixture helper integrity: ${file}`);
    const registry = parse(await readRegular(fixtureRoot, 'manifest.json'));
    assert.equal(registry.rawCapture.sha256, wireReplayPins.archiveSha256); assert.equal(registry.rawCapture.manifestSha256, wireReplayPins.exportSha256);
    assert.equal(registry.officialRowOracles.sha256, wireReplayPins.supplementSha256);
    for (const entry of [registry.rawCapture, registry.officialRowOracles]) assert.equal(hash(await readRegular(fixtureRoot, entry.file, 8 * 1024 * 1024)), entry.sha256);
    let temporary: string | undefined; let marker: string | undefined;
    if (options.outputDirectory === undefined) {
        const base = await realpath(tmpdir()); temporary = await mkdtemp(join(base, 'hyperion-wire-replay-audit-')); marker = randomUUID();
        await writeFile(join(temporary, '.owner.json'), JSON.stringify({marker}), {flag: 'wx'});
    }
    const output = resolve(options.outputDirectory ?? join(temporary!, 'prepared'));
    try {
        const prepared = spawnSync(options.python ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-B', join(fixtureRoot, 'prepare.py'), output],
            {encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024});
        if (prepared.error) throw prepared.error;
        assert.equal(prepared.status, 0, `independent installed Wire audit failed: ${(prepared.stderr || prepared.stdout).slice(0, 4096)}`);
        const receipt = parse(Buffer.from(prepared.stdout)); assert.equal(receipt.status, 'prepared'); assert.equal(receipt.independentOperations, 1267);
        assert.equal(receipt.officialRows, 627); assert.equal(receipt.officialAbis, 8);
        const rawRoot = join(output, 'raw'); const exportBytes = await readRegular(rawRoot, 'public-export-manifest.json');
        assert.equal(hash(exportBytes), wireReplayPins.exportSha256); const exportManifest = parse(exportBytes);
        assert.equal(exportManifest.fileCount, 3753); assert.equal(exportManifest.totalBytes, 12148075);
        const files = new Map<string, Buffer>([['public-export-manifest.json', exportBytes]]); let bytes = exportBytes.length;
        for (const entry of exportManifest.files) {
            assert.ok(!files.has(entry.path)); const data = await readRegular(rawRoot, entry.path);
            assert.equal(data.length, entry.bytes); assert.equal(hash(data), entry.sha256); bytes += data.length;
            assert.ok(bytes <= 32 * 1024 * 1024); files.set(entry.path, data);
        }
        const read = (file: string) => {const data = files.get(safeRelative(file)); assert.ok(data, `unlisted fixture input: ${file}`); return data;};
        const manifest = parse(read(capturePrefix + 'manifest.json')); const schemaBytes = read(capturePrefix + 'schema.bin');
        assert.equal(hash(schemaBytes), wireReplayPins.schemaSha256); assert.equal(hash(read(capturePrefix + 'genesis.json')), wireReplayPins.genesisSha256);
        assert.equal(manifest.pins.chainId, wireReplayPins.chainId); assert.equal(manifest.profileId, wireReplayPins.profileId);
        assert.equal(manifest.pins.node.sourceRevision, wireReplayPins.sourceRevision);
        assert.deepEqual(manifest.range, {startBlock: 2, endBlockInclusive: 120, complete: true}); assert.equal(manifest.blocks.length, 119);
        assert.equal(manifest.initialAncestry.status, 'unknown-before-range'); assert.equal(manifest.initialAncestry.abiFrontier, 'not-supplied');
        assert.equal(manifest.qualification.sourceAuthority, false); assert.equal(manifest.qualification.selectedTestnet, false);
        const transport = auditWireTransportMembership(files, manifest);
        const auditBytes = await readRegular(join(output, 'derived'), 'audit.json', 2 * 1024 * 1024);
        assert.equal(hash(auditBytes), receipt.files['audit.json'].sha256); const audit = parse(auditBytes);
        const checkBytes = await readRegular(join(output, 'derived'), 'checks.json', 8 * 1024 * 1024);
        assert.equal(hash(checkBytes), receipt.files['checks.json'].sha256); const checks = freeze(parse(checkBytes)); assert.equal(checks.length, 1267);
        assert.equal(audit.blockCount, 119); assert.equal(audit.transactionCount, 155); assert.equal(audit.actionReceiptCount, 160); assert.equal(audit.physicalDeltaRows, 627);
        const api = await import('@eosrio/hyperion-wire-plugin'); const profile = api.resolveCodecProfile(wireReplayPins.profileId);
        assert.equal(profile.upstreamRevision, wireReplayPins.sourceRevision); assert.equal(profile.epochMilliseconds, wireReplayPins.epochMilliseconds);
        assert.equal(profile.slotMilliseconds, wireReplayPins.slotMilliseconds);
        const schema = parse(schemaBytes); const codec = api.createWireShipCodec(schema, profile);
        const status: any = codec.decodeResult(read(capturePrefix + 'status.bin'));
        assert.equal(status[0], 'get_status_result_v0'); assert.equal(status[1].chain_id, wireReplayPins.chainId);
        assert.equal(status[1].head.block_num, 123); assert.equal(status[1].last_irreversible.block_num, 121);
        const records: WireReplayRecord[] = []; let previous = manifest.initialAncestry.firstPreviousPosition[1];
        let actionInputs = 0, deployments = 0, rows = 0;
        for (const [index, entry] of manifest.blocks.entries()) {
            const frame = read(capturePrefix + entry.source.file); assert.equal(hash(frame), entry.source.sha256);
            const bundle: any = codec.decodeBundle(frame); const envelope = bundle.envelope[1];
            assert.equal(entry.blockNum, index + 2); assert.equal(envelope.this_block.block_num, entry.blockNum);
            assert.equal(envelope.this_block.block_id, entry.blockId); assert.equal(envelope.prev_block.block_id, previous);
            assert.equal(envelope.prev_block.block_num, entry.blockNum - 1); assert.equal(bundle.block.previous, previous);
            for (const key of ['block', 'traces', 'deltas']) assert.deepEqual(Buffer.from(envelope[key], 'hex'), read(capturePrefix + entry.payloads[key].file));
            assert.deepEqual(bundle.deltaFraming, audit.blocks[index].deltaFraming);
            assert.deepEqual(bundle.deltas.map((delta: any) => ({name: delta[1].name, rows: delta[1].rows.length})), audit.blocks[index].streams);
            assert.equal(bundle.traces.length, audit.blocks[index].traceTransactions);
            const deltaRows = bundle.deltaRows.map((row: any, ordinal: number) => {
                assert.ok(row.present === 0 || row.present === 1); return {...row, present: row.present === 1, ordinal};
            }); rows += deltaRows.length;
            const observations = selection.provider.observeBlockAbi!({traces: bundle.traces,
                accountRows: deltaRows.filter((row: any) => row.stream === 'account').map((row: any) =>
                    ({ordinal: row.ordinal, present: row.present, raw: Uint8Array.from(Buffer.from(row.rawHex, 'hex')), value: row.value}))},
                {chainId: wireReplayPins.chainId, blockId: entry.blockId, blockNum: entry.blockNum, previousBlockId: previous});
            actionInputs += observations.actionInputs.length; deployments += observations.deployments.length;
            records.push({blockNum: entry.blockNum, id: entry.blockId, previousId: previous, previous: clone(envelope.prev_block),
                frame: Buffer.from(frame), frameSha256: hash(frame), block: bundle.block, traces: bundle.traces, deltas: bundle.deltas,
                deltaRows, deltaFraming: bundle.deltaFraming, abiObservations: observations}); previous = entry.blockId;
        }
        assert.equal(rows, 627); assert.equal(actionInputs, 160); assert.equal(deployments, 8);
        const lineage = freeze({kind: 'audited-installed-wire-application-capture', packageRevision: wireReplayPins.packageRevision,
            sourceArchiveSha256: wireReplayPins.archiveSha256, exportManifestSha256: wireReplayPins.exportSha256,
            supplementArchiveSha256: wireReplayPins.supplementSha256, manifestSha256: hash(read(capturePrefix + 'manifest.json')),
            schemaSha256: hash(schemaBytes), statusSha256: hash(read(capturePrefix + 'status.bin')),
            auditSha256: hash(auditBytes), preparation: receipt, transport, range: {start: 2, end: 120},
            initialAncestry: clone(manifest.initialAncestry), qualification: clone(manifest.qualification),
            limits: ['Original 7d captured application bytes; no invented ABI frontier or canonical source authority.',
                'Original status head123/LIB121 is retained; startup RPC block2 is separate derived fixture control metadata.']});
        const data: Snapshot = {files, records, manifest: freeze(clone(manifest)), audit: freeze(clone(audit)), schema: freeze(clone(schema)),
            status: freeze(clone(status)), lineage, checks, decodeRequest: value => codec.decodeRequest(value), packageRoot};
        const fixture: AuditedWireReplayFixture = Object.freeze({packageRoot, packageRevision: wireReplayPins.packageRevision,
            profileId: wireReplayPins.profileId, chainId: wireReplayPins.chainId, replayStart: 2 as const, replayEnd: 120 as const,
            manifest: data.manifest, audit: data.audit, independentChecks: checks, schema: data.schema, originalStatus: data.status, lineage,
            get records() {return Object.freeze(records.map(record => ({...clone({...record, frame: undefined}), frame: Buffer.from(record.frame)})));},
            read(file: string) {return Buffer.from(read(file));}, decodeRequest(value: Uint8Array) {return clone(codec.decodeRequest(value));}});
        snapshots.set(fixture, data); return fixture;
    } finally {
        if (temporary) {
            const path = await realpath(temporary); const base = await realpath(tmpdir());
            assert.equal(dirname(path), base); assert.ok(basename(path).startsWith('hyperion-wire-replay-audit-'));
            assert.ok(!(await lstat(temporary)).isSymbolicLink());
            assert.equal(parse(await readRegular(path, '.owner.json')).marker, marker);
            await rm(path, {recursive: true, force: false});
        }
    }
}

/** Pure flow controller, independent of source bytes; auditing is required by the service bridge. */
export class WireReplayFlow {
    readonly sentBlocks: number[] = []; readonly acknowledgedBlocks: number[] = [];
    readonly start: number; readonly last: number; readonly maximumWindow: number;
    private next: number; private end: number; private window = 0; private active = false;
    private inFlightBlocks: number[] = []; requests = 0; statusRequests = 0;
    constructor(start: number, last: number, maximumWindow = wireReplayLimits.inFlight) {
        number(start, 1, 0xfffffffe, 'invalid replay start'); number(last, start, start + 511, 'invalid replay end');
        number(maximumWindow, 1, wireReplayLimits.inFlight, 'invalid replay window'); this.start = start; this.last = last; this.maximumWindow = maximumWindow;
        this.next = start; this.end = last + 1;
    }
    get inFlight() {return this.inFlightBlocks.length;}
    get idle() {return this.active && this.next >= this.end;}
    accept(request: any): {status: boolean; blocks: number[]} {
        assert.ok(++this.requests <= wireReplayLimits.requests); assert.ok(Array.isArray(request) && request.length === 2);
        const [type, value] = request; assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        if (type === 'get_status_request_v0') {
            assert.deepEqual(Object.keys(value), []); assert.ok(++this.statusRequests <= 4); return {status: true, blocks: []};
        }
        if (type === 'get_blocks_request_v0') {
            assert.ok(!this.active, 'a connection may select only one source range');
            assert.deepEqual(Object.keys(value).sort(), ['start_block_num', 'end_block_num', 'max_messages_in_flight', 'have_positions',
                'irreversible_only', 'fetch_block', 'fetch_traces', 'fetch_deltas'].sort());
            const start = number(value.start_block_num, this.start, this.last, 'request starts outside captured source');
            const end = number(value.end_block_num, start + 1, 0xffffffff, 'invalid exclusive request end');
            assert.ok(end === this.last + 1 || end === 0xffffffff, 'request must select the captured end or open-ended live prefix');
            assert.deepEqual(value.have_positions, [], 'unqualified resume ancestry refused');
            // The Wire value codec preserves bool's uint8 carrier; the pure controller also accepts JSON booleans.
            boolean(value.irreversible_only, 'invalid irreversible_only bool carrier');
            for (const flag of ['fetch_block', 'fetch_traces', 'fetch_deltas']) assert.equal(boolean(value[flag], `invalid ${flag} bool carrier`), true);
            this.window = number(value.max_messages_in_flight, 1, this.maximumWindow, 'invalid source credit window');
            this.next = start; this.end = this.last + 1; this.active = true;
        } else {
            assert.equal(type, 'get_blocks_ack_request_v0', 'unsupported replay request');
            assert.ok(this.active, 'ACK before source selection'); assert.deepEqual(Object.keys(value), ['num_messages']);
            const count = number(value.num_messages, 1, this.inFlight, 'ACK exceeds outstanding source messages');
            this.acknowledgedBlocks.push(...this.inFlightBlocks.splice(0, count));
        }
        const blocks: number[] = [];
        while (this.inFlight < this.window && this.next < this.end) {
            const block = this.next++; blocks.push(block); this.sentBlocks.push(block); this.inFlightBlocks.push(block);
        }
        return {status: false, blocks};
    }
}

export function createWireReplaySession(fixture: AuditedWireReplayFixture) {
    const source = snapshot(fixture); const flow = new WireReplayFlow(2, 120);
    return {flow, receive(bytes: Uint8Array) {
        assert.ok(bytes.byteLength > 0 && bytes.byteLength <= wireReplayLimits.requestBytes);
        const result = flow.accept(source.decodeRequest(bytes));
        return {status: result.status, messages: result.status ? [Buffer.from(source.files.get(capturePrefix + 'status.bin')!)]
            : result.blocks.map(block => Buffer.from(source.records[block - 2].frame)), blocks: result.blocks};
    }};
}

export async function serveWireReplay(fixture: AuditedWireReplayFixture, errors: string[], limits: {durationMs?: number} = {}) {
    const source = snapshot(fixture); const durationMs = number(limits.durationMs ?? wireReplayLimits.durationMs, 1, wireReplayLimits.durationMs, 'invalid replay deadline');
    const metrics = {connections: 0, totalSentBlocks: 0, totalAcknowledgedBlocks: 0, sentBytes: 0, requestBytes: 0, rejectedRequests: 0,
        sessions: [] as {id: number; sentBlocks: number[]; acknowledgedBlocks: number[]; requests: number; inFlight: number; idle: boolean}[]};
    const requests: any[] = []; const sent: any[] = []; const server = new WebSocketServer({host: '127.0.0.1', port: 0, maxPayload: wireReplayLimits.requestBytes});
    await new Promise<void>((done, reject) => {server.once('listening', done); server.once('error', reject);});
    let closed = false; let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {closed = true; clearTimeout(timer); for (const socket of server.clients) socket.terminate();
        await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));})();
    const timer = setTimeout(() => {errors.push('bounded Wire replay deadline exceeded'); void close().catch(error => errors.push(String(error)));}, durationMs); timer.unref();
    server.on('error', error => errors.push(String(error)));
    server.on('connection', socket => {
        const id = ++metrics.connections;
        if (closed || id > wireReplayLimits.connections || server.clients.size > wireReplayLimits.activeConnections) {
            metrics.rejectedRequests++; errors.push('Wire replay connection bound exceeded'); socket.terminate(); return;
        }
        const session = createWireReplaySession(fixture); const view = {id, sentBlocks: [] as number[], acknowledgedBlocks: [] as number[], requests: 0, inFlight: 0, idle: false};
        metrics.sessions.push(view);
        const send = (bytes: Buffer, binary: boolean) => {
            assert.ok(metrics.sentBytes + bytes.length <= wireReplayLimits.sentBytes && socket.bufferedAmount + bytes.length <= wireReplayLimits.bufferedBytes,
                'Wire replay output byte bound exceeded'); metrics.sentBytes += bytes.length;
            socket.send(bytes, {binary}, error => {if (error && !closed) errors.push(String(error));});
        };
        send(Buffer.from(source.files.get(capturePrefix + 'schema.bin')!), false);
        socket.on('error', error => {if (!closed) errors.push(String(error));});
        socket.on('message', (raw, binary) => {
            try {
                assert.equal(binary, true, 'SHiP requests must be binary'); const bytes = Buffer.from(raw as Buffer);
                metrics.requestBytes += bytes.length; assert.ok(metrics.requestBytes <= wireReplayLimits.totalRequestBytes);
                assert.ok(requests.length < wireReplayLimits.requests); const decoded = source.decodeRequest(bytes);
                requests.push({connection: id, request: clone(decoded), sha256: hash(bytes), bytes: bytes.length, at: Date.now()});
                const beforeAck = session.flow.acknowledgedBlocks.length; const result = session.receive(bytes);
                for (const [index, message] of result.messages.entries()) {
                    send(message, true);
                    if (!result.status) sent.push({connection: id, blockNum: result.blocks[index], sha256: hash(message), bytes: message.length});
                }
                metrics.totalSentBlocks += result.blocks.length;
                metrics.totalAcknowledgedBlocks += session.flow.acknowledgedBlocks.length - beforeAck;
                Object.assign(view, {sentBlocks: [...session.flow.sentBlocks], acknowledgedBlocks: [...session.flow.acknowledgedBlocks],
                    requests: session.flow.requests, inFlight: session.flow.inFlight, idle: session.flow.idle});
            } catch (error) {metrics.rejectedRequests++; errors.push(String(error)); socket.close(1008, 'audited Wire replay request rejected');}
        });
    });
    return {url: `ws://127.0.0.1:${(server.address() as any).port}`, requests, metrics, sent, errors, close};
}

export function assertWireReplayComplete(fixture: AuditedWireReplayFixture, replay: Awaited<ReturnType<typeof serveWireReplay>>) {
    snapshot(fixture); const expected = Array.from({length: 119}, (_value, index) => index + 2);
    assert.deepEqual(replay.errors, [], 'source replay reported an error');
    assert.equal(replay.metrics.rejectedRequests, 0); assert.equal(replay.metrics.totalSentBlocks, 119); assert.equal(replay.metrics.totalAcknowledgedBlocks, 119);
    assert.deepEqual(replay.metrics.sessions.flatMap(session => session.sentBlocks), expected);
    assert.deepEqual(replay.metrics.sessions.flatMap(session => session.acknowledgedBlocks), expected);
    for (const session of replay.metrics.sessions) {assert.equal(session.inFlight, 0); if (session.sentBlocks.length) assert.equal(session.idle, true);}
    for (const entry of replay.sent) assert.equal(entry.sha256, snapshot(fixture).records[entry.blockNum - 2].frameSha256);
}

/** Pure time/control metadata derivation; never a source or ABI authority certificate. */
export function deriveWireStartupControl(input: {blockNum: number; id: string; producer: string; timestamp: string; rawBlock: Uint8Array; originalInfo: any}) {
    assert.equal(input.blockNum, 2); assert.match(input.id, /^00000002[0-9a-f]{56}$/); assert.ok(input.rawBlock.byteLength >= 4);
    const slot = Buffer.from(input.rawBlock).readUInt32LE(0);
    const timestamp = new Date(wireReplayPins.epochMilliseconds + slot * wireReplayPins.slotMilliseconds).toISOString().slice(0, -1);
    assert.equal(input.timestamp, timestamp, 'Wire epoch differs from raw captured block timestamp');
    assert.equal(input.originalInfo.chain_id, wireReplayPins.chainId);
    return freeze({server_version: input.originalInfo.server_version, server_version_string: input.originalInfo.server_version_string,
        server_full_version_string: input.originalInfo.server_full_version_string, chain_id: wireReplayPins.chainId,
        head_block_num: 2, last_irreversible_block_num: 2, head_block_id: input.id, last_irreversible_block_id: input.id,
        head_block_time: timestamp, last_irreversible_block_time: timestamp, head_block_producer: input.producer,
        virtual_block_cpu_limit: input.originalInfo.virtual_block_cpu_limit, virtual_block_net_limit: input.originalInfo.virtual_block_net_limit,
        block_cpu_limit: input.originalInfo.block_cpu_limit, block_net_limit: input.originalInfo.block_net_limit});
}
export function createWireReplayRpc(fixture: AuditedWireReplayFixture) {
    const source = snapshot(fixture); const first = source.records[0]; const infoBytes = source.files.get(capturePrefix + 'node-info-before.json')!;
    const response = deriveWireStartupControl({blockNum: first.blockNum, id: first.id, producer: first.block.producer,
        timestamp: first.block.timestamp, rawBlock: source.files.get(capturePrefix + source.manifest.blocks[0].payloads.block.file)!, originalInfo: parse(infoBytes)});
    const bytes = Buffer.from(JSON.stringify(response)); assert.ok(bytes.length <= wireReplayRpcLimits.responseBytes); let requests = 0;
    const lineage = freeze({kind: 'derived-wire-startup-control-view', chainId: wireReplayPins.chainId, profileId: wireReplayPins.profileId,
        originalStatusSha256: source.lineage.statusSha256, originalStatus: clone(source.status), originalInfoSha256: hash(infoBytes),
        capturedBlockNum: 2, capturedBlockId: first.id, capturedFrameSha256: first.frameSha256, responseSha256: hash(bytes), responseBytes: bytes.length,
        epochMilliseconds: wireReplayPins.epochMilliseconds, slotMilliseconds: wireReplayPins.slotMilliseconds,
        modifiedFields: ['head_block_num', 'last_irreversible_block_num', 'head_block_id', 'last_irreversible_block_id', 'head_block_time', 'last_irreversible_block_time', 'head_block_producer'],
        limits: 'Fixture startup head/LIB2 only; original head123/LIB121 SHiP status is unchanged. No ABI/current-state authority.'});
    return {lineage, reply(method: string | undefined, path: string | undefined, body: unknown) {
        assert.ok(++requests <= wireReplayRpcLimits.requests, 'Wire startup RPC request bound exceeded');
        assert.ok(method === 'GET' || method === 'POST'); assert.equal(path, '/v1/chain/get_info', 'forbidden Wire replay RPC');
        assert.ok(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0, 'get_info body must be empty');
        return parse(bytes);
    }};
}
