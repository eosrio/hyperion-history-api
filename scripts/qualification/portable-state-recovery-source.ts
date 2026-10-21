/** Synthetic branch controls over separately audited Wire inputs. This is engineering evidence,
 * not a node-authenticated Wire fork. The original corpus and its auditor are never changed. */
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket, WebSocketServer} from 'ws';
import {createWireShipCodec, createWireValueCodec, resolveCodecProfile} from '@eosrio/hyperion-wire-plugin';
import {portableSourceHash, portableWorkerSourceFrame, portableSourceLimits, type PortableWorkerSource} from './portable-state-worker-source.ts';
import {independentWirePrimaryRow, assertPortableWorkerOracle} from './portable-state-worker-oracle.ts';
import type {PortableWorkerPlan} from './portable-state-worker.ts';

export const recoverySourceLimits = Object.freeze({...portableSourceLimits, connections: 16, blocks: 1249,
    common: 1243, firstReplacement: 1244, lastA: 1247, lastB: 1249, finalIrreversible: 1247,
    runMs: 900_000, transmittedBytes: 256 * 1024 * 1024});
export type RecoveryBranch = 'A' | 'B';
export type RecoveryPoint = {blockNum: number; blockId: string};
export interface RecoveryEngineeringRecord extends RecoveryPoint {
    readonly previousBlockId: string | null; readonly branch: 'common' | RecoveryBranch;
    readonly frameSha256: string; readonly frameBytes: number; readonly timestamp: string; readonly producer: string;
    readonly originalFrameSha256: string | null; readonly mutations: readonly RecoveryRowMutation[];
}
export interface RecoveryRowMutation {
    readonly projection: string; readonly key: string; readonly value: Record<string, unknown>; readonly present: boolean;
    readonly rawHex: string; readonly origin: {blockNum: number; frameSha256: string; physicalSha256: string};
}
export interface RecoveryEngineeringSource {
    readonly chainId: string; readonly profileId: string; readonly sourceRevision: string;
    readonly components: readonly unknown[]; readonly schemaJson: string;
    readonly records: readonly RecoveryEngineeringRecord[]; readonly inputHashes: Readonly<Record<string, string>>;
    readonly manifest: Readonly<Record<string, unknown>>;
}
interface PrivateRecoverySource {original: PortableWorkerSource; frames: Map<string, Buffer>;
    ship: ReturnType<typeof createWireShipCodec>; values: ReturnType<typeof createWireValueCodec>;}
const retained = new WeakMap<RecoveryEngineeringSource, PrivateRecoverySource>();
const hex64 = /^[0-9a-f]{64}$/;
const copy = <T>(value: T): T => structuredClone(value);
const recordKey = (branch: RecoveryBranch, block: number) => `${block <= recoverySourceLimits.common ? 'common' : branch}:${block}`;
const point = (record: RecoveryEngineeringRecord) => ({block_num: record.blockNum, block_id: record.blockId});

export function recoveryRecord(source: RecoveryEngineeringSource, branch: RecoveryBranch, block: number): RecoveryEngineeringRecord {
    const found = source.records.find(record => `${record.branch}:${record.blockNum}` === recordKey(branch, block));
    assert.ok(found, `Engineering source has no ${branch}:${block}`); return found;
}
export function recoveryFrame(source: RecoveryEngineeringSource, branch: RecoveryBranch, block: number): Buffer {
    const privateSource = retained.get(source); assert.ok(privateSource);
    const frame = privateSource.frames.get(recordKey(branch, block)); assert.ok(frame); return Buffer.from(frame);
}

/** Values come from independently retained official clio conversions, physical bytes from the
 * original captured rows. The fixed branch mutation program does not consume runtime output. */
export function buildRecoveryEngineeringSource(original: PortableWorkerSource, plan: PortableWorkerPlan, officialOracle: any): RecoveryEngineeringSource {
    assertPortableWorkerOracle(original, plan, officialOracle);
    assert.equal(original.endBlock, 1480); assert.equal(plan.definitions.length, 2);
    assert.deepEqual(plan.barriers.map(barrier => barrier.through), [1244, 1480]);
    const profile = resolveCodecProfile(original.profileId), schema = JSON.parse(original.schemaJson);
    const ship = createWireShipCodec(schema, profile), values = createWireValueCodec(schema, profile);
    const selected = new Map<string, RecoveryRowMutation>();
    const contract = '14389258105242393088';
    for (const record of original.records) for (const row of record.applicationRows) {
        if (row.stream !== 'contract_row_kv') continue;
        const physical = independentWirePrimaryRow(row.rawHex);
        if (physical.contract === contract && physical.tableId === 4978 && record.blockNum <= recoverySourceLimits.common)
            assert.fail('The independently selected unaffected attestations table must have no common-prefix mutations');
        if (physical.contract !== contract || ![1067, 18398].includes(physical.tableId)) continue;
        assert.ok(record.blockNum >= recoverySourceLimits.firstReplacement, 'Common prefix must have no selected table mutations');
        if (!row.present) continue;
        const definition = plan.definitions.find(definition => definition.source.table === (physical.tableId === 1067 ? 'attseq' : 'outenvelopes'));
        assert.ok(definition);
        const key = JSON.stringify(['', `wire-kv-v1:row:${original.chainId}:${contract}:${physical.tableId}:${physical.primaryKeyHex}`]);
        const physicalSha256 = portableSourceHash(Buffer.from(row.rawHex, 'hex'));
        const expected = officialOracle.rows.find((entry: any) => entry.blockNum === record.blockNum
            && entry.physicalSha256 === physicalSha256 && entry.present === true);
        assert.ok(expected);
        const barrier = plan.barriers.find(barrier => barrier.through === record.blockNum); assert.ok(barrier);
        const expectedRow = barrier.rows[definition.id].find(candidate => candidate.key === key); assert.ok(expectedRow);
        for (const field of definition.fields) {
            const decoded = expected.decoded[field.name];
            assert.equal(expectedRow.value[field.name], field.type === 'string' && typeof decoded === 'number' ? String(decoded) : decoded);
        }
        const label = physical.tableId === 1067 ? `attseq-${expectedRow.value.next}` : `out-${expectedRow.value.id}`;
        assert.ok(!selected.has(label), 'Each selected source value must have one independently bound physical occurrence');
        selected.set(label, {projection: definition.id, key, value: copy(expectedRow.value), present: true, rawHex: row.rawHex,
            origin: {blockNum: record.blockNum, frameSha256: record.frameSha256, physicalSha256}});
    }
    assert.deepEqual([...selected.keys()].sort(), ['attseq-5', 'attseq-9', 'out-1', 'out-2', 'out-3', 'out-4']);
    const put = (label: string) => copy(selected.get(label)!);
    const remove = (label: string) => ({...put(label), present: false});
    const program: Record<RecoveryBranch, RecoveryRowMutation[][]> = {
        A: [[put('attseq-5'), put('out-1'), put('out-2')], [put('attseq-9')],
            [remove('out-1'), remove('out-2'), put('out-3'), put('out-4')], []],
        B: [[put('attseq-9'), put('out-3'), put('out-4')], [put('attseq-5')],
            [remove('out-3'), remove('out-4'), put('out-1'), put('out-2')], [], [], []],
    };
    const frames = new Map<string, Buffer>(), records: RecoveryEngineeringRecord[] = [];
    for (let blockNum = 1; blockNum <= recoverySourceLimits.common; blockNum++) {
        const originalRecord = original.records[blockNum - 1], envelope: any = copy(ship.decodeResult(portableWorkerSourceFrame(original, blockNum)));
        const position = {block_num: blockNum, block_id: originalRecord.blockId};
        envelope[1].head = position; envelope[1].last_irreversible = position;
        const frame = Buffer.from(values.encode('result', envelope));
        // Only outer controls changed. The block, traces and deltas remain byte-exact.
        const decoded: any = ship.decodeResult(frame), before: any = ship.decodeResult(portableWorkerSourceFrame(original, blockNum));
        for (const section of ['block', 'traces', 'deltas', 'this_block', 'prev_block']) assert.deepEqual(decoded[1][section], before[1][section]);
        const record = Object.freeze({blockNum, blockId: originalRecord.blockId, previousBlockId: originalRecord.previousBlockId,
            branch: 'common' as const, frameSha256: portableSourceHash(frame), frameBytes: frame.length,
            timestamp: originalRecord.timestamp, producer: originalRecord.producer, originalFrameSha256: originalRecord.frameSha256, mutations: []});
        records.push(record); frames.set(`common:${blockNum}`, frame);
    }
    const common = records.at(-1)!, template: any = ship.decodeBundle(portableWorkerSourceFrame(original, 1244)).block;
    const emptyTraces = Buffer.from(values.encode('transaction_trace[]', [])).toString('hex');
    for (const branch of ['A', 'B'] as const) {
        const branchRecords: {record: RecoveryEngineeringRecord; blockHex: string; deltasHex: string}[] = [];
        let parent = common;
        for (const [offset, mutations] of program[branch].entries()) {
            const blockNum = recoverySourceLimits.firstReplacement + offset;
            const timestamp = new Date(Date.parse(template.timestamp + 'Z') + offset * 500 + (branch === 'B' ? 5000 : 0)).toISOString().slice(0, -1);
            const block = {...copy(template), timestamp, previous: parent.blockId,
                transaction_mroot: portableSourceHash(`synthetic-p246:${branch}:${blockNum}:transactions`),
                finality_mroot: portableSourceHash(`synthetic-p246:${branch}:${blockNum}:finality`),
                qc_claim: {block_num: recoverySourceLimits.common, is_strong_qc: 0},
                new_finalizer_policy_diff: null, new_proposer_policy_diff: null, header_extensions: [],
                producer_signatures: [], transactions: [], qc: null, block_extensions: []};
            const header = Object.fromEntries(schema.structs.find((value: any) => value.name === 'block_header').fields
                .map((field: any) => [field.name, block[field.name]]));
            const id = Buffer.from(portableSourceHash(values.encode('block_header', header)), 'hex'); id.writeUInt32BE(blockNum);
            const blockId = id.toString('hex'), blockHex = Buffer.from(values.encode('signed_block', block)).toString('hex');
            const deltas = mutations.length ? [['table_delta_v0', {name: 'contract_row_kv', rows: mutations.map(mutation => ({present: mutation.present ? 1 : 0, data: mutation.rawHex}))}]] : [];
            const deltasHex = Buffer.from(values.encode('table_delta[]', deltas)).toString('hex');
            const record = {blockNum, blockId, previousBlockId: parent.blockId, branch, frameSha256: '', frameBytes: 0,
                timestamp, producer: block.producer, originalFrameSha256: null, mutations: copy(mutations)};
            branchRecords.push({record, blockHex, deltasHex}); parent = record;
        }
        const tip = branchRecords.at(-1)!.record;
        for (const {record, blockHex, deltasHex} of branchRecords) {
            const irreversibleHeight = branch === 'B' && record.blockNum >= 1248 ? record.blockNum - 2 : recoverySourceLimits.common;
            const irreversible = irreversibleHeight === recoverySourceLimits.common ? common
                : branchRecords.find(value => value.record.blockNum === irreversibleHeight)!.record;
            const frame = Buffer.from(values.encode('result', ['get_blocks_result_v0', {head: point(tip), last_irreversible: point(irreversible),
                this_block: point(record), prev_block: {block_num: record.blockNum - 1, block_id: record.previousBlockId},
                block: blockHex, traces: emptyTraces, deltas: deltasHex}]));
            const decoded: any = ship.decodeBundle(frame); assert.equal(decoded.block.previous, record.previousBlockId);
            assert.equal(decoded.deltaRows.length, record.mutations.length); assert.equal(decoded.traces.length, 0);
            const completed = Object.freeze({...record, frameSha256: portableSourceHash(frame), frameBytes: frame.length});
            records.push(completed); frames.set(recordKey(branch, record.blockNum), frame);
        }
    }
    const source = Object.freeze({chainId: original.chainId, profileId: original.profileId, sourceRevision: original.sourceRevision,
        components: original.components, schemaJson: original.schemaJson, records: Object.freeze(records), inputHashes: original.inputHashes,
        manifest: Object.freeze({schemaVersion: 1, kind: 'synthetic-engineering-fork', nodeAuthenticated: false,
            note: 'Common nested source sections and selected physical row values are original; outer finality controls, suffix headers, empty traces and branch mutation ordering are synthetic. No Wire producer consensus/fork qualification.',
            common: {blockNum: common.blockNum, blockId: common.blockId}, branchRanges: {A: [1244, 1247], B: [1244, 1249]},
            unaffected: {contract: 'sysio.msgch', table: 'attestations', tableId: 4978, expectedRows: []},
            mutationOrigins: [...selected].map(([label, mutation]) => ({label, ...mutation.origin, key: mutation.key})),
            recordsSha256: portableSourceHash(JSON.stringify(records))})});
    retained.set(source, {original, frames, ship, values}); return source;
}

/** A fresh connection obeys the caller's requested interval and known positions; it never
 * manufactures a missing replacement prefix to compensate for a bad start_block_num. */
export class RecoverySourceFlow {
    readonly sent: {blockNum: number; branch: RecoveryBranch}[] = [];
    readonly acknowledged: {blockNum: number; branch: RecoveryBranch}[] = [];
    readonly requests: any[] = [];
    private next = 1; private end = 0; private window = 0; private active = false;
    private inFlight: {blockNum: number; branch: RecoveryBranch}[] = [];
    readonly knownPosition: (position: any, branch: RecoveryBranch) => boolean;
    constructor(knownPosition: (position: any, branch: RecoveryBranch) => boolean) {this.knownPosition = knownPosition;}
    get outstanding() {return this.inFlight.length;}
    receive(request: any, branch: RecoveryBranch, through: number) {
        assert.ok(Array.isArray(request) && request.length === 2 && this.requests.length < recoverySourceLimits.requests);
        this.requests.push(copy(request)); const [type, value] = request;
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        if (type === 'get_status_request_v0') {assert.deepEqual(Object.keys(value), []); return {status: true, blocks: []};}
        if (type === 'get_blocks_request_v0') {
            assert.equal(this.active, false); assert.deepEqual(Object.keys(value).sort(), ['start_block_num', 'end_block_num', 'max_messages_in_flight',
                'have_positions', 'irreversible_only', 'fetch_block', 'fetch_traces', 'fetch_deltas'].sort());
            assert.ok(Number.isSafeInteger(value.start_block_num) && value.start_block_num >= 1 && value.start_block_num <= recoverySourceLimits.lastB + 1);
            assert.ok(Number.isSafeInteger(value.end_block_num) && value.end_block_num > value.start_block_num && value.end_block_num <= 0xffffffff);
            assert.ok(Array.isArray(value.have_positions) && value.have_positions.length <= 64);
            for (const position of value.have_positions) {assert.deepEqual(Object.keys(position).sort(), ['block_id', 'block_num']);
                assert.ok(Number.isSafeInteger(position.block_num) && position.block_num >= 1 && hex64.test(position.block_id)
                    && position.block_num < value.start_block_num && this.knownPosition(position, branch));}
            assert.ok(value.irreversible_only === false || value.irreversible_only === 0, 'The shared live/history reader must retain reversible input in both state modes');
            for (const name of ['fetch_block', 'fetch_traces', 'fetch_deltas']) assert.ok(value[name] === true || value[name] === 1);
            assert.ok(Number.isSafeInteger(value.max_messages_in_flight) && value.max_messages_in_flight > 0);
            this.next = value.start_block_num; this.end = value.end_block_num;
            this.window = Math.min(value.max_messages_in_flight, recoverySourceLimits.window); this.active = true;
        } else {
            assert.equal(type, 'get_blocks_ack_request_v0'); assert.equal(this.active, true); assert.deepEqual(Object.keys(value), ['num_messages']);
            assert.ok(Number.isSafeInteger(value.num_messages) && value.num_messages > 0 && value.num_messages <= this.inFlight.length);
            this.acknowledged.push(...this.inFlight.splice(0, value.num_messages));
        }
        return {status: false, blocks: this.available(branch, through)};
    }
    available(branch: RecoveryBranch, through: number) {
        const blocks: number[] = [];
        while (this.active && this.next <= through && this.next < this.end && this.inFlight.length < this.window) {
            const entry = {blockNum: this.next, branch}; this.sent.push(entry); this.inFlight.push(entry); blocks.push(this.next++);
        }
        return blocks;
    }
}

export async function serveRecoveryEngineeringSource(source: RecoveryEngineeringSource, errors: string[]) {
    const input = retained.get(source); assert.ok(input);
    const server = new WebSocketServer({host: '127.0.0.1', port: 0, maxPayload: recoverySourceLimits.requestBytes}); await once(server, 'listening');
    const sessions: {id: number; socket: WebSocket; flow: RecoverySourceFlow; connectedAt: string; closedAt: string | null; requestedClose: boolean}[] = [];
    const requests: any[] = []; let branch: RecoveryBranch = 'A', through = 0, sentBytes = 0, requestBytes = 0, closed = false;
    let closePromise: Promise<void> | undefined;
    const current = () => recoveryRecord(source, branch, Math.max(1, through));
    const irreversible = () => recoveryRecord(source, branch, branch === 'B' && through >= 1248
        ? through - 2 : Math.max(1, Math.min(through, recoverySourceLimits.common)));
    const status = () => input.values.encode('result', ['get_status_result_v0', {...copy(input.original.originalStatus[1]),
        head: point(current()), last_irreversible: point(irreversible()), trace_begin_block: 2, trace_end_block: Math.max(2, through + 1),
        chain_state_begin_block: 1, chain_state_end_block: Math.max(2, through + 1)}]);
    const send = (session: typeof sessions[number], blocks: number[], sendStatus = false) => {
        for (const frame of sendStatus ? [Buffer.from(status())] : blocks.map(block => recoveryFrame(source, branch, block))) {
            sentBytes += frame.length; assert.ok(sentBytes <= recoverySourceLimits.transmittedBytes);
            assert.ok(session.socket.bufferedAmount + frame.length <= recoverySourceLimits.bufferedBytes);
            session.socket.send(frame, {binary: true}, error => {if (error && !closed && !session.requestedClose) errors.push(String(error));});
        }
    };
    const close = () => closePromise ??= (async () => {closed = true; clearTimeout(timer); for (const session of sessions) session.socket.terminate();
        await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));})();
    const timer = setTimeout(() => {errors.push('Recovery source exceeded its 15-minute bound'); void close();}, recoverySourceLimits.runMs); timer.unref();
    server.on('connection', socket => {
        if (sessions.length >= recoverySourceLimits.connections) {errors.push('Recovery source connection budget exceeded'); socket.terminate(); return;}
        const session = {id: sessions.length, socket, flow: new RecoverySourceFlow((position, selectedBranch) => source.records.some(record => record.blockNum === position.block_num
            && record.blockId === position.block_id && (record.branch === 'common' || record.branch === selectedBranch))),
            connectedAt: new Date().toISOString(), closedAt: null as string | null, requestedClose: false};
        sessions.push(session); socket.send(source.schemaJson, {binary: false});
        socket.on('close', () => {session.closedAt = new Date().toISOString();});
        socket.on('error', error => {if (!closed && !session.requestedClose) errors.push(String(error));});
        socket.on('message', (data, binary) => {try {assert.equal(binary, true); const bytes = Buffer.from(data as Buffer); requestBytes += bytes.length;
            assert.ok(requestBytes <= recoverySourceLimits.requestTotalBytes && requests.length < recoverySourceLimits.requests);
            const request = input.ship.decodeRequest(bytes); requests.push({session: session.id, branch, through, request: copy(request), sha256: portableSourceHash(bytes), bytes: bytes.length});
            const accepted = session.flow.receive(request, branch, through); send(session, accepted.blocks, accepted.status);
        } catch (error) {errors.push(String(error)); socket.close(1008, 'recovery request refused');}});
    });
    server.on('error', error => errors.push(String(error)));
    return {url: `ws://127.0.0.1:${(server.address() as any).port}`, sessions, requests, close,
        release(block: number) {assert.ok(!closed && Number.isSafeInteger(block) && block >= through
            && block <= (branch === 'A' ? recoverySourceLimits.lastA : recoverySourceLimits.lastB)); through = block;
            for (const session of sessions) if (session.socket.readyState === WebSocket.OPEN) send(session, session.flow.available(branch, through));},
        replaceAndDisconnect() {assert.equal(branch, 'A'); assert.equal(through, recoverySourceLimits.lastA);
            assert.ok(sessions.every(session => session.flow.outstanding === 0), 'Every published A block must be acknowledged before the intentional source drop');
            branch = 'B'; through = recoverySourceLimits.common;
            for (const session of sessions) if (session.socket.readyState === WebSocket.OPEN) {session.requestedClose = true; session.socket.terminate();}},
        assertDrained() {assert.deepEqual(errors, []); assert.ok(sessions.every(session => session.flow.outstanding === 0));},
        info() {const head = current(), lib = irreversible(); return {...input.original.startupInfo, head_block_num: head.blockNum, head_block_id: head.blockId,
            head_block_time: head.timestamp, head_block_producer: head.producer, last_irreversible_block_num: lib.blockNum,
            last_irreversible_block_id: lib.blockId, last_irreversible_block_time: lib.timestamp};},
        metrics() {return {branch, through, sentBytes, requestBytes, sessions: sessions.map(({id, flow, connectedAt, closedAt, requestedClose}) =>
            ({id, connectedAt, closedAt, requestedClose, sent: copy(flow.sent), acknowledged: copy(flow.acknowledged), outstanding: flow.outstanding}))};}};
}
