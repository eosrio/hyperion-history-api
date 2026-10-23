import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {WireReplayFlow, auditWireTransportMembership, auditWireReplayFixture, createWireReplayRpc, createWireReplaySession,
    deriveWireStartupControl, serveWireReplay, wireReplayPins, type AuditedWireReplayFixture} from '../../scripts/qualification/wire-replay-fixture.ts';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const prefix = 'evidence/capture-application-2-120-final/';
const request = (overrides: any = {}) => ['get_blocks_request_v0', {start_block_num: 2, end_block_num: 0xffffffff,
    max_messages_in_flight: 2, have_positions: [], irreversible_only: false, fetch_block: true, fetch_traces: true, fetch_deltas: true, ...overrides}];
const ack = (count: number) => ['get_blocks_ack_request_v0', {num_messages: count}];

describe('pure bounded Wire replay credit controller', () => {
    test('open-ended live source emits only the captured prefix and idles after exact ACKs', () => {
        const flow = new WireReplayFlow(2, 5);
        expect(flow.accept(['get_status_request_v0', {}])).toEqual({status: true, blocks: []});
        expect(flow.accept(request())).toEqual({status: false, blocks: [2, 3]});
        expect(flow.inFlight).toBe(2); expect(flow.idle).toBe(false);
        expect(flow.accept(ack(1)).blocks).toEqual([4]); expect(flow.accept(ack(2)).blocks).toEqual([5]);
        expect(flow.idle).toBe(true); expect(flow.accept(ack(1)).blocks).toEqual([]); expect(flow.inFlight).toBe(0);
        expect(flow.sentBlocks).toEqual([2, 3, 4, 5]); expect(flow.acknowledgedBlocks).toEqual([2, 3, 4, 5]);
        expect(() => flow.accept(ack(1))).toThrow();
    });
    test('finite captured end and a valid captured resume height retain exact source boundaries', () => {
        const flow = new WireReplayFlow(2, 5);
        expect(flow.accept(request({start_block_num: 4, end_block_num: 6, irreversible_only: true})).blocks).toEqual([4, 5]);
        expect(flow.accept(ack(2)).blocks).toEqual([]); expect(flow.idle).toBe(true);
    });
    test('strict Wire uint8 bool carriers retain the same source selection', () => {
        for (const irreversible_only of [0, 1]) {
            const flow = new WireReplayFlow(2, 5);
            expect(flow.accept(request({irreversible_only, fetch_block: 1, fetch_traces: 1, fetch_deltas: 1})).blocks).toEqual([2, 3]);
        }
        for (const invalid of [2, -1, '1', null, undefined]) {
            expect(() => new WireReplayFlow(2, 5).accept(request({irreversible_only: invalid}))).toThrow();
            expect(() => new WireReplayFlow(2, 5).accept(request({fetch_block: invalid}))).toThrow();
        }
        expect(() => new WireReplayFlow(2, 5).accept(request({fetch_block: 0}))).toThrow();
    });
    test('unqualified ancestry, wrong flags/range/revision and extra fields fail closed', () => {
        for (const override of [{start_block_num: 1}, {start_block_num: 6}, {end_block_num: 7}, {max_messages_in_flight: 0},
            {max_messages_in_flight: 129}, {have_positions: [{block_num: 1, block_id: '0'.repeat(64)}]},
            {fetch_block: false}, {fetch_traces: false}, {fetch_deltas: false}, {irreversible_only: 2}, {unknown: true}]) {
            expect(() => new WireReplayFlow(2, 5).accept(request(override))).toThrow();
        }
        expect(() => new WireReplayFlow(2, 5).accept(['get_blocks_request_v1', request()[1]])).toThrow();
    });
    test('credits cannot precede source selection, over-ACK, duplicate-ACK or replace a selected range', () => {
        expect(() => new WireReplayFlow(2, 5).accept(ack(1))).toThrow();
        for (const value of [0, -1, 0.5, 3, NaN, Infinity]) {
            const flow = new WireReplayFlow(2, 5); flow.accept(request()); expect(() => flow.accept(ack(value))).toThrow();
        }
        const flow = new WireReplayFlow(2, 5); flow.accept(request()); expect(() => flow.accept(request())).toThrow();
    });
    test('status probes are bounded and cannot carry extra fields', () => {
        const flow = new WireReplayFlow(2, 5); expect(() => flow.accept(['get_status_request_v0', {extra: 1}])).toThrow();
        for (let i = 0; i < 4; i++) flow.accept(['get_status_request_v0', {}]);
        expect(() => flow.accept(['get_status_request_v0', {}])).toThrow();
    });
});

// Synthetic transport-only tokens exercise framing. They are not Wire application source/certificates.
function wireFrame(payload: Buffer, opcode: number, direction: 'in' | 'out', final = true) {
    expect(payload.length).toBeLessThan(126); const mask = Buffer.from([1, 2, 3, 4]);
    const header = Buffer.from([(final ? 128 : 0) | opcode, payload.length | (direction === 'out' ? 128 : 0)]);
    if (direction === 'in') return Buffer.concat([header, payload]);
    return Buffer.concat([header, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]);
}
function transportFixture() {
    const values = {'schema.bin': Buffer.from('{}'), 'status.bin': Buffer.from('status'), 'blocks/first.bin': Buffer.from('original'),
        'requests/status.bin': Buffer.from('s'), 'requests/range.bin': Buffer.from('r'), 'requests/ack.bin': Buffer.from('a')};
    const files = new Map(Object.entries(values).map(([file, data]) => [prefix + file, data]));
    const transport: any[] = [];
    const add = (payload: Buffer, opcode: number, direction: 'in' | 'out', final = true) => {
        const raw = wireFrame(payload, opcode, direction, final); const file = `transport/${transport.length}.bin`; files.set(prefix + file, raw);
        transport.push({file, bytes: raw.length, sha256: hash(raw), direction, opcode, complete: true});
    };
    add(values['schema.bin'], 1, 'in'); add(values['requests/status.bin'], 2, 'out'); add(values['status.bin'], 2, 'in');
    add(values['requests/range.bin'], 2, 'out'); add(Buffer.from('ori'), 2, 'in', false); add(Buffer.from('ginal'), 0, 'in');
    add(values['requests/ack.bin'], 2, 'out');
    return {files, manifest: {transport, blocks: [{source: {file: 'blocks/first.bin'}}]}};
}

describe('original Wire transport membership', () => {
    test('joins original fragmentation and unmasks exact original request/ACK bytes', () => {
        const {files, manifest} = transportFixture();
        expect(auditWireTransportMembership(files, manifest)).toMatchObject({messages: 3, originalAcknowledgements: 1, frames: 7});
    });
    test('replaced result bytes, incomplete original frames or tampered frame digests reject', () => {
        const first = transportFixture(); first.files.set(prefix + 'blocks/first.bin', Buffer.from('different'));
        expect(() => auditWireTransportMembership(first.files, first.manifest)).toThrow();
        const second = transportFixture(); second.manifest.transport[4].complete = false;
        expect(() => auditWireTransportMembership(second.files, second.manifest)).toThrow();
        const third = transportFixture(); third.manifest.transport[4].sha256 = '0'.repeat(64);
        expect(() => auditWireTransportMembership(third.files, third.manifest)).toThrow();
    });
    test('mask direction, unfinished continuation and invalid encoded lengths reject', () => {
        for (const change of [
            (entry: any) => {entry.direction = 'out';},
            (entry: any) => {entry.opcode = 3;},
        ]) {
            const value = transportFixture(); change(value.manifest.transport[4]);
            expect(() => auditWireTransportMembership(value.files, value.manifest)).toThrow();
        }
        const value = transportFixture(); const entry = value.manifest.transport[5];
        const raw = Buffer.from([0, 126, 0, 1, 1]); entry.bytes = raw.length; entry.sha256 = hash(raw); value.files.set(prefix + entry.file, raw);
        expect(() => auditWireTransportMembership(value.files, value.manifest)).toThrow();
    });
});

describe('Wire startup control metadata and source capability', () => {
    test('uses the selected Wire epoch and explicitly derives startup block2', () => {
        const rawBlock = Buffer.alloc(4); rawBlock.writeUInt32LE(100);
        const info = {chain_id: wireReplayPins.chainId, head_block_num: 123, last_irreversible_block_num: 121,
            server_version: '7dede884', server_version_string: 'v1.0.0', server_full_version_string: 'v1.0.0-' + wireReplayPins.sourceRevision,
            virtual_block_cpu_limit: 0, virtual_block_net_limit: 0, block_cpu_limit: 0, block_net_limit: 0};
        const input = {blockNum: 2, id: '00000002' + '0'.repeat(56), producer: 'sysio', timestamp: '2025-01-01T00:00:50.000', rawBlock, originalInfo: info};
        expect(deriveWireStartupControl(input)).toMatchObject({head_block_num: 2, last_irreversible_block_num: 2, head_block_time: input.timestamp});
        expect(info.head_block_num).toBe(123); expect(info.last_irreversible_block_num).toBe(121);
        expect(() => deriveWireStartupControl({...input, timestamp: '2000-01-01T00:00:50.000'})).toThrow();
    });
    test('caller declarations cannot create source services, sessions or an RPC authority', async () => {
        const untrusted = {chainId: wireReplayPins.chainId, records: [], manifest: {}} as unknown as AuditedWireReplayFixture;
        expect(() => createWireReplaySession(untrusted)).toThrow('independently audited');
        expect(() => createWireReplayRpc(untrusted)).toThrow('independently audited');
        await expect(serveWireReplay(untrusted, [])).rejects.toThrow('independently audited');
    });
});

test.skipIf(process.env.HYPERION_WIRE_FIXTURE_AUDIT_TEST !== '1')('optional one-shot installed corpus audit detaches source authority from public mutable buffers', async () => {
    const fixture = await auditWireReplayFixture(); expect(fixture.records).toHaveLength(119); expect(fixture.audit.physicalDeltaRows).toBe(627);
    const first = fixture.records[0]; const expected = first.frameSha256; first.frame.fill(0); first.block.timestamp = 'mutated';
    fixture.read(prefix + 'status.bin').fill(0); expect(hash(fixture.records[0].frame)).toBe(expected);
    const api = await import('@eosrio/hyperion-wire-plugin'); const codec = api.createWireShipCodec(fixture.schema, api.resolveCodecProfile(fixture.profileId));
    const session = createWireReplaySession(fixture); const received = session.receive(codec.encodeRequest(request({max_messages_in_flight: 1})));
    expect(hash(received.messages[0])).toBe(expected); received.messages[0].fill(0);
    const second = createWireReplaySession(fixture).receive(codec.encodeRequest(request({max_messages_in_flight: 1})));
    expect(hash(second.messages[0])).toBe(expected);
    const rpc = createWireReplayRpc(fixture); const info = rpc.reply('GET', '/v1/chain/get_info', {}); info.head_block_num = 999;
    expect(rpc.reply('POST', '/v1/chain/get_info', {}).head_block_num).toBe(2);
    expect(() => rpc.reply('POST', '/v1/chain/get_abi', {})).toThrow('forbidden');
    expect(fixture.originalStatus[1].head.block_num).toBe(123); expect(fixture.originalStatus[1].last_irreversible.block_num).toBe(121);
}, 180000);
