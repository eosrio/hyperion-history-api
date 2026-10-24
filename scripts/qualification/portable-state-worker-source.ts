/** Actual-source audit and bounded replay for #191; no source or ABI frontier is manufactured.
 * Credit/barrier mechanics follow PR239 wire-replay-fixture.ts, without its 7d corpus/pins.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, parse, resolve} from 'node:path';
import {once} from 'node:events';
import {WebSocket, WebSocketServer} from 'ws';
import {createWireShipCodec, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';

export const portableSourceLimits = Object.freeze({blocks: 4096, bytes: 128 * 1024 * 1024,
    receiptBytes: 8 * 1024 * 1024, frameBytes: 8 * 1024 * 1024, window: 32,
    requests: 16384, requestBytes: 4096, requestTotalBytes: 8 * 1024 * 1024,
    connections: 8, sessions: 32, bufferedBytes: 16 * 1024 * 1024, runMs: 900_000});
export const portableSourceHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const jsonCopy = <T>(value: T): T => structuredClone(value);
const hex64 = /^[0-9a-f]{64}$/;
const zero = '0'.repeat(64);

export interface PortableSourceFile {readonly path: string; readonly bytes: number; readonly sha256: string}
export type PortableSourceProfile = 'wire-sysio-6508c9e8-engineering-v1' | 'wire-sysio-6508c9e8-native-engineering-v1';
export interface PortableSourceInput {
    readonly directory: string; readonly receiptSha256: string; readonly endBlock: number;
    readonly status: PortableSourceFile; readonly getInfo: PortableSourceFile;
}
export interface PortableSourceBlock {
    readonly blockNum: number; readonly blockId: string; readonly previousBlockId: string | null;
    /** Original decoded header predecessor; genesis header-zero is distinct from absent SHiP prev_block. */
    readonly headerPreviousBlockId: string;
    readonly frameSha256: string; readonly frameBytes: number; readonly timestamp: string;
    readonly producer: string; readonly applicationRows: readonly {ordinal: number; stream: string; present: number; rawHex: string; value: unknown}[];
}
export interface PortableWorkerSource {
    readonly chainId: string; readonly profileId: string; readonly sourceRevision: string;
    readonly components: readonly any[]; readonly endBlock: number; readonly schemaJson: string;
    readonly records: readonly PortableSourceBlock[]; readonly inputHashes: Readonly<Record<string, string>>;
    /** Original SHIP status/frame LIB observations, keyed by their block number. */
    readonly irreversibleAnchors: Readonly<Record<string, string>>;
    readonly originalStatus: any; readonly startupInfo: any;
}
interface PrivateSource {frames: Buffer[]; status: Buffer; schema: Buffer; codec: ReturnType<typeof createWireShipCodec>;}
const sealed = new WeakMap<PortableWorkerSource, PrivateSource>();

/** Detached original input for independent oracle joins; callers cannot alter replay authority. */
export function portableWorkerSourceFrame(source: PortableWorkerSource, blockNum: number): Buffer {
    const retained = sealed.get(source); assert.ok(retained);
    assert.ok(Number.isSafeInteger(blockNum) && blockNum >= 1 && blockNum <= source.endBlock);
    return Buffer.from(retained.frames[blockNum - 1]);
}

export async function ordinaryPortablePath(input: string, directory = false): Promise<string> {
    const path = resolve(input), parents: string[] = [];
    for (let current = path;; current = dirname(current)) {parents.unshift(current); if (current === parse(current).root) break;}
    for (const parent of parents) {
        const info = await lstat(parent); assert.ok(!info.isSymbolicLink(), 'source/output reparse points are refused');
        assert.ok(parent === path ? directory ? info.isDirectory() : info.isFile() : info.isDirectory(), 'ordinary source/output path required');
    }
    return path;
}
export async function boundedPortableFile(path: string, maximum: number): Promise<Buffer> {
    await ordinaryPortablePath(path); const before = await lstat(path);
    assert.ok(before.size > 0 && before.size <= maximum, 'input size is outside the qualification bound');
    const bytes = await readFile(path); const after = await lstat(path);
    assert.ok(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs, 'qualification input changed while reading');
    return bytes;
}
async function pinnedFile(root: string, file: PortableSourceFile, maximum: number): Promise<Buffer> {
    assert.ok(file && typeof file.path === 'string' && file.path.length > 0 && hex64.test(file.sha256));
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= maximum);
    const bytes = await boundedPortableFile(isAbsolute(file.path) ? file.path : resolve(root, file.path), maximum);
    assert.equal(bytes.length, file.bytes); assert.equal(portableSourceHash(bytes), file.sha256); return bytes;
}

/** Only unchanged original frames are admitted. Capture investigation/application summaries are ignored. */
export async function auditPortableWorkerSource(input: PortableSourceInput,
    profileId: PortableSourceProfile = 'wire-sysio-6508c9e8-engineering-v1'): Promise<PortableWorkerSource> {
    assert.ok(['wire-sysio-6508c9e8-engineering-v1', 'wire-sysio-6508c9e8-native-engineering-v1'].includes(profileId));
    const root = await ordinaryPortablePath(input.directory, true);
    assert.ok(hex64.test(input.receiptSha256));
    assert.ok(Number.isSafeInteger(input.endBlock) && input.endBlock >= 1 && input.endBlock <= portableSourceLimits.blocks);
    const receiptBytes = await boundedPortableFile(join(root, 'receipt.json'), portableSourceLimits.receiptBytes);
    assert.equal(portableSourceHash(receiptBytes), input.receiptSha256);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.complete, true); assert.equal(receipt.start, 1);
    assert.ok(hex64.test(receipt.chainId)); assert.ok(Array.isArray(receipt.frames) && receipt.frames.length <= portableSourceLimits.blocks);
    assert.ok(receipt.endExclusive > input.endBlock && receipt.frames.length === receipt.endExclusive - 1);
    const schema = await pinnedFile(root, {path: 'schema.json', ...receipt.schema}, 65536);
    const status = await pinnedFile(root, input.status, 65536), infoBytes = await pinnedFile(root, input.getInfo, 65536);
    const profile = resolveCodecProfile(profileId);
    const selection = await import(new URL('../../build/indexer/protocol/selection.js', import.meta.url).href);
    const selected = await selection.loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId});
    assert.equal(typeof selected.provider.verifyNativeGenesis, 'function');
    assert.equal(selected.provider.nativeActions?.interfaceVersion,
        profileId === 'wire-sysio-6508c9e8-native-engineering-v1' ? 1 : undefined);
    const schemaJson = schema.toString('utf8'), codec = createWireShipCodec(JSON.parse(schemaJson), profile);
    const decodedStatus: any = codec.decodeResult(status);
    assert.equal(decodedStatus[0], 'get_status_result_v0'); assert.equal(decodedStatus[1].chain_id, receipt.chainId);
    assert.equal(Number(decodedStatus[1].chain_state_begin_block), 1); assert.equal(Number(decodedStatus[1].trace_begin_block), 2);
    for (const name of ['chain_state_end_block', 'trace_end_block']) assert.ok(Number(decodedStatus[1][name]) > input.endBlock, 'source retention does not cover requested prefix');
    const originalInfo = JSON.parse(infoBytes.toString('utf8')); assert.equal(originalInfo.chain_id, receipt.chainId);
    const frames: Buffer[] = [], records: PortableSourceBlock[] = [], irreversibleAnchors: Record<string, string> = {};
    const retainAnchor = (value: {block_num: number | string; block_id: string}) => {
        const blockNum = Number(value.block_num), blockId = value.block_id;
        assert.ok(Number.isSafeInteger(blockNum) && blockNum >= 1 && blockNum <= 0xffffffff && hex64.test(blockId));
        const key = String(blockNum);
        assert.ok(irreversibleAnchors[key] === undefined || irreversibleAnchors[key] === blockId,
            'original SHIP irreversible anchor changed for the same block');
        irreversibleAnchors[key] = blockId;
    };
    retainAnchor(decodedStatus[1].last_irreversible);
    const inputHashes: Record<string, string> = {'receipt.json': input.receiptSha256, 'schema.json': portableSourceHash(schema),
        [input.status.path]: input.status.sha256, [input.getInfo.path]: input.getInfo.sha256};
    let totalBytes = schema.length + status.length + infoBytes.length, parent: string | null = null;
    for (let index = 0; index < input.endBlock; index++) {
        const entry = receipt.frames[index]; assert.equal(entry.blockNum, index + 1);
        assert.equal(entry.file, `block-${String(entry.blockNum).padStart(6, '0')}.bin`);
        const frame = await pinnedFile(root, {path: entry.file, bytes: entry.bytes, sha256: entry.sha256}, portableSourceLimits.frameBytes);
        totalBytes += frame.length; assert.ok(totalBytes <= portableSourceLimits.bytes, 'source aggregate byte bound exceeded');
        const bundle: any = codec.decodeBundle(frame), result = bundle.envelope[1];
        assert.equal(bundle.envelope[0], 'get_blocks_result_v0'); assert.equal(Number(result.this_block.block_num), index + 1);
        retainAnchor(result.last_irreversible);
        assert.equal(result.this_block.block_id, entry.blockId); assert.ok(hex64.test(entry.blockId));
        assert.equal(result.prev_block?.block_id ?? null, parent, 'original source is not contiguous');
        assert.ok(Number(result.last_irreversible.block_num) >= index + 1, 'input was not captured irreversible');
        assert.ok(result.block !== null && result.deltas !== null && bundle.block && Array.isArray(bundle.deltaRows));
        if (index === 0) {
            assert.equal(result.traces, null); assert.equal(bundle.block.previous, zero);
            selected.provider.verifyNativeGenesis({schemaJson, block: Buffer.from(result.block, 'hex'), traces: null,
                deltas: Buffer.from(result.deltas, 'hex')}, {chainId: receipt.chainId, blockNum: 1, blockId: entry.blockId, previousBlockId: null});
        } else {assert.ok(result.traces !== null && Array.isArray(bundle.traces), 'later traces must be present even with no header transactions'); assert.equal(bundle.block.previous, parent);}
        const applicationRows = bundle.deltaRows.flatMap((row: any, ordinal: number) =>
            ['contract_row', 'contract_row_kv', 'contract_index_kv'].includes(row.stream) ? [{ordinal, ...jsonCopy(row)}] : []);
        records.push(Object.freeze({blockNum: index + 1, blockId: entry.blockId, previousBlockId: parent, headerPreviousBlockId: bundle.block.previous,
            frameSha256: entry.sha256, frameBytes: frame.length, timestamp: bundle.block.timestamp, producer: bundle.block.producer,
            applicationRows: Object.freeze(applicationRows)}));
        frames.push(frame); inputHashes[entry.file] = entry.sha256; parent = entry.blockId;
    }
    const first = records[0];
    const startupInfo = {...originalInfo, head_block_num: 1, last_irreversible_block_num: 1, head_block_id: first.blockId,
        last_irreversible_block_id: first.blockId, head_block_time: first.timestamp, last_irreversible_block_time: first.timestamp,
        head_block_producer: first.producer};
    const source = Object.freeze({chainId: receipt.chainId, profileId, sourceRevision: profile.upstreamRevision,
        components: Object.freeze(jsonCopy(selected.components)), endBlock: input.endBlock, schemaJson,
        records: Object.freeze(records), inputHashes: Object.freeze(inputHashes),
        irreversibleAnchors: Object.freeze(irreversibleAnchors), originalStatus: jsonCopy(decodedStatus), startupInfo: Object.freeze(startupInfo)});
    sealed.set(source, {frames, status, schema, codec}); return source;
}

export class PortableSourceFlow {
    readonly sent: number[] = []; readonly acknowledged: number[] = [];
    private next: number; private through = 0; private window = 0; private active = false; private inFlight: number[] = [];
    requests = 0; private statusRequests = 0;
    readonly last: number; readonly first: number;
    constructor(last: number, first = 1) {
        assert.ok(Number.isSafeInteger(last) && last >= 1 && last <= portableSourceLimits.blocks);
        assert.ok(Number.isSafeInteger(first) && first >= 1 && first <= last);
        this.last = last; this.first = first; this.next = first;
    }
    get outstanding() {return this.inFlight.length;}
    get started() {return this.active;}
    releaseThrough(block: number) {assert.ok(Number.isSafeInteger(block) && block >= this.through && block <= this.last); this.through = block; return this.available();}
    private available() {const result: number[] = []; while (this.active && this.next <= this.through && this.inFlight.length < this.window) {
        result.push(this.next); this.sent.push(this.next); this.inFlight.push(this.next++);
    } return result;}
    receive(request: any): {status: boolean; blocks: number[]} {
        assert.ok(++this.requests <= portableSourceLimits.requests && Array.isArray(request) && request.length === 2);
        const [type, value] = request; assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        if (type === 'get_status_request_v0') {assert.deepEqual(Object.keys(value), []); assert.ok(++this.statusRequests <= 4); return {status: true, blocks: []};}
        if (type === 'get_blocks_request_v0') {
            assert.deepEqual(Object.keys(value).sort(), ['start_block_num', 'end_block_num', 'max_messages_in_flight', 'have_positions',
                'irreversible_only', 'fetch_block', 'fetch_traces', 'fetch_deltas'].sort());
            assert.equal(this.active, false); assert.equal(value.start_block_num, this.first); assert.deepEqual(value.have_positions, []);
            assert.ok(value.end_block_num === this.last + 1 || value.end_block_num === 0xffffffff);
            for (const key of ['fetch_block', 'fetch_traces', 'fetch_deltas']) assert.ok(value[key] === true || value[key] === 1);
            assert.ok([true, false, 0, 1].includes(value.irreversible_only));
            assert.ok(Number.isSafeInteger(value.max_messages_in_flight) && value.max_messages_in_flight > 0);
            this.window = Math.min(value.max_messages_in_flight, portableSourceLimits.window); this.active = true;
        } else {
            assert.equal(type, 'get_blocks_ack_request_v0'); assert.ok(this.active); assert.deepEqual(Object.keys(value), ['num_messages']);
            assert.ok(Number.isSafeInteger(value.num_messages) && value.num_messages > 0 && value.num_messages <= this.inFlight.length);
            this.acknowledged.push(...this.inFlight.splice(0, value.num_messages));
        }
        return {status: false, blocks: this.available()};
    }
}

export async function servePortableWorkerSource(source: PortableWorkerSource, errors: string[]) {
    const retained = sealed.get(source); assert.ok(retained, 'source must be the sealed audit result');
    const server = new WebSocketServer({host: '127.0.0.1', port: 0, maxPayload: portableSourceLimits.requestBytes});
    await once(server, 'listening');
    const sessions: {flow: PortableSourceFlow; socket: WebSocket; epoch: number}[] = [], requests: any[] = [];
    const activeSessions = new Set<typeof sessions[number]>();
    let through = 0, sentBytes = 0, requestBytes = 0, peakActiveConnections = 0, closed = false, closing: Promise<void> | undefined;
    let restart: {blockNum: number; oldMasterPid: number} | undefined;
    const close = () => closing ??= (async () => {closed = true; clearTimeout(timer); for (const {socket} of sessions) socket.terminate();
        await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));})();
    const timer = setTimeout(() => {errors.push('portable source deadline exceeded'); void close().catch(error => errors.push(String(error)));}, portableSourceLimits.runMs); timer.unref();
    const send = (session: typeof sessions[number], blocks: number[], status = false) => {
        const frames = status ? [retained.status] : blocks.map(block => retained.frames[block - 1]);
        for (const frame of frames) {sentBytes += frame.length; assert.ok(sentBytes <= portableSourceLimits.bytes * 2);
            assert.ok(session.socket.bufferedAmount + frame.length <= portableSourceLimits.bufferedBytes);
            session.socket.send(frame, {binary: true}, error => {if (error && !closed) errors.push(String(error));});}
    };
    server.on('connection', socket => {
        // Normal API health checks open and close a status socket once their cache expires.
        // Keep physical concurrency and retained audit history separately bounded.
        if (sessions.length >= portableSourceLimits.sessions) {errors.push('portable source session history bound'); socket.terminate(); return;}
        if (activeSessions.size >= portableSourceLimits.connections) {errors.push('portable source concurrent connection bound'); socket.terminate(); return;}
        const session = {flow: new PortableSourceFlow(source.endBlock, restart?.blockNum ?? 1), socket, epoch: restart ? 1 : 0};
        sessions.push(session); session.flow.releaseThrough(through);
        activeSessions.add(session); peakActiveConnections = Math.max(peakActiveConnections, activeSessions.size);
        socket.once('close', () => activeSessions.delete(session));
        socket.send(retained.schema, {binary: false}); socket.on('error', error => {if (!closed) errors.push(String(error));});
        socket.on('message', (bytes, binary) => {try {assert.equal(binary, true); const frame = Buffer.from(bytes as Buffer); requestBytes += frame.length;
            assert.ok(requestBytes <= portableSourceLimits.requestTotalBytes); const request = retained.codec.decodeRequest(frame);
            assert.ok(requests.length < portableSourceLimits.requests);
            requests.push({session: sessions.indexOf(session), request: jsonCopy(request), sha256: portableSourceHash(frame), bytes: frame.length});
            const accepted = session.flow.receive(request);
            if (restart) assert.ok(sessions.filter(value => value.epoch === session.epoch && value.flow.started).length <= 1,
                'multiple block streams in the resumed source epoch');
            send(session, accepted.blocks, accepted.status);
        } catch (error) {errors.push(String(error)); socket.close(1008, 'source request refused');}});
    });
    server.on('error', error => errors.push(String(error)));
    return {url: `ws://127.0.0.1:${(server.address() as any).port}`, requests, sessions, close,
        async allowMasterRestart(receipt: unknown) {
            const {describeWireMasterCrash} = await import('./portable-state-master-recovery.mjs');
            const {control, fence} = describeWireMasterCrash(receipt);
            assert.equal(restart, undefined, 'only one original master restart is permitted');
            assert.equal(through, 33); assert.equal(control.blockNum, through);
            assert.equal(control.chainId, source.chainId); assert.equal(control.profileId, source.profileId);
            assert.equal(control.blockId, source.records[32].blockId);
            assert.equal(control.frameSha256, portableSourceHash(retained.frames[32]));
            assert.equal(fence.directory, control.output);
            const flows = sessions.filter(value => value.flow.started);
            assert.equal(flows.length, 1); assert.equal(flows[0].socket.readyState, WebSocket.CLOSED);
            const expected = Array.from({length: through}, (_, index) => index + 1);
            assert.deepEqual(flows[0].flow.sent, expected); assert.deepEqual(flows[0].flow.acknowledged, expected);
            assert.equal(flows[0].flow.outstanding, 0); assert.deepEqual(errors, []);
            restart = {blockNum: through, oldMasterPid: fence.root.pid};
        },
        releaseThrough(block: number) {assert.ok(!closed && block >= through && block <= source.endBlock); through = block;
            for (const session of sessions) if (session.socket.readyState === WebSocket.OPEN) send(session, session.flow.releaseThrough(block));},
        assertThrough(block: number) {const expected = restart
            ? [...Array.from({length: restart.blockNum}, (_, index) => index + 1),
                ...Array.from({length: block - restart.blockNum + 1}, (_, index) => restart!.blockNum + index)]
            : Array.from({length: block}, (_, index) => index + 1);
            assert.deepEqual(errors, []); assert.deepEqual(sessions.flatMap(session => session.flow.sent), expected);
            assert.deepEqual(sessions.flatMap(session => session.flow.acknowledged), expected);
            assert.ok(sessions.every(session => session.flow.outstanding === 0));},
        metrics() {return {through, sentBytes, requestBytes, connections: sessions.length,
            activeConnections: activeSessions.size, peakActiveConnections,
            ...(restart ? {restart: {...restart}} : {}),
            sessions: sessions.map(session => ({sent: [...session.flow.sent], acknowledged: [...session.flow.acknowledged], outstanding: session.flow.outstanding,
                ...(restart ? {epoch: session.epoch, firstBlock: session.flow.first} : {})}))};}};
}
