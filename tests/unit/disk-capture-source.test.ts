import {test, expect, beforeAll, afterAll} from 'bun:test';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiskCaptureSource, DiskCaptureUnavailableError, assertWireBlockHeaderSchema, wireBlockHeaderLength, wireBlockId}
    from '../../src/indexer/protocol/disk-capture-source.js';
import {protocolAbiCaptureDigest} from '../../src/indexer/protocol/abi-observation-store.js';
import {hash, preflight, schemaJson, wireBlocks, writeNodeLogs, type LogEdits, type WireBlock} from './disk-capture-fixture.js';

let blocks: WireBlock[] = [];
const sources: DiskCaptureSource[] = [];
afterAll(async () => {await Promise.all(sources.map(source => source.close()));});
beforeAll(async () => {blocks = (await wireBlocks()).blocks;});

async function logs(edits: LogEdits = {}) {
    const source = await DiskCaptureSource.open(await writeNodeLogs(blocks, edits), hash(schemaJson));
    sources.push(source);
    return source;
}
const expected = (value: WireBlock) => ({kind: 'unattested-ship-result-sections-v1', schemaJson,
    blockHex: value.block.toString('hex'), tracesHex: value.traces === null ? null : value.traces.toString('hex'),
    deltasHex: value.deltas.toString('hex')});
async function refusal(promise: Promise<unknown>): Promise<DiskCaptureUnavailableError> {
    try {await promise;} catch (error) {expect(error).toBeInstanceOf(DiskCaptureUnavailableError); return error as DiskCaptureUnavailableError;}
    throw new Error('Expected a disk capture refusal');
}

test('the logs reproduce the exact SHiP sections and capture digest of real Wire blocks', async () => {
    const source = await logs();
    for (const value of blocks) {
        const {capture, captureSha256} = await source.capture(value.position);
        expect(capture).toEqual(expected(value));
        expect(captureSha256).toBe(protocolAbiCaptureDigest(value.position, expected(value) as any));
    }
    // Genesis has no trace entry, exactly as SHiP omits its traces section.
    expect((await source.capture(blocks[0]!.position)).capture.tracesHex).toBeNull();
});

test('a Wire block id is the digest of its packed header with the block number first', () => {
    for (const value of blocks) expect(wireBlockId(value.block, value.position.blockNum)).toBe(value.position.blockId);
    for (const value of blocks.slice(1)) expect(value.block.subarray(12, 44).toString('hex')).toBe(value.position.previousBlockId!);
});

test('reads follow the index past abandoned fork entries, and refuse an entry of another block', async () => {
    const abandoned = '00000003' + 'ab'.repeat(28);
    const source = await logs({orphan: {stem: 'chain_state_history', block: 3, id: abandoned}});
    expect((await source.capture(blocks[2]!.position)).capture).toEqual(expected(blocks[2]!));
    const wrong = {...blocks[2]!.position, blockId: abandoned};
    expect((await refusal(source.capture(wrong))).code).toBe('disk_capture_invalid');
});

test('damaged entries never become captures', async () => {
    const damaged: LogEdits[] = [
        {entry: {stem: 'chain_state_history', block: 2, trailer: 12345}},
        {entry: {stem: 'trace_history', block: 3, declared: blocks[2]!.traces!.length + 1}},
        {entry: {stem: 'chain_state_history', block: 4, stream: Buffer.from('not a zlib stream')}},
        {block: {block: 2, trailer: 99}},
        {block: {block: 3, bytes: blocks[2]!.block.subarray(0, 100)}},
    ];
    for (const edits of damaged) {
        const source = await logs(edits);
        const n = edits.entry?.block ?? edits.block!.block;
        expect((await refusal(source.capture(blocks[n - 1]!.position))).code).toBe('disk_capture_invalid');
        // Undamaged blocks of the same logs still read.
        const other = blocks[n === 2 ? 2 : 1]!;
        expect((await source.capture(other.position)).capture).toEqual(expected(other));
    }
});

test('block bytes must hash to the catalog id and link to its parent', async () => {
    const tampered = Buffer.from(blocks[1]!.block);
    tampered[50]! ^= 1; // inside transaction_mroot
    const source = await logs({block: {block: 2, bytes: tampered}});
    expect((await refusal(source.capture(blocks[1]!.position))).message).toContain('another block 2');
    const intact = await logs();
    const orphaned = {...blocks[2]!.position, previousBlockId: 'cd'.repeat(32)};
    expect((await refusal(intact.capture(orphaned))).message).toContain('another parent');
});

test('blocks outside the logs are unavailable, not invalid', async () => {
    const source = await logs();
    const later = {chainId: preflight.chainId, blockNum: 5, blockId: '00000005' + '11'.repeat(28), previousBlockId: blocks[3]!.position.blockId};
    expect((await refusal(source.capture(later))).code).toBe('disk_capture_unavailable');
});

test('the capture handshake must be the catalog one and keep the walked header layout', async () => {
    const directory = join(tmpdir(), 'h45-disk-capture-handshake-' + process.pid);
    await mkdir(directory, {recursive: true});
    const other = join(directory, 'ship.json');
    await writeFile(other, schemaJson + ' ');
    await expect(DiskCaptureSource.open({state_history_dir: directory, blocks_dir: directory, ship_abi: other}, hash(schemaJson)))
        .rejects.toThrow('handshake differs');
    expect((await logs()).schemaJson).toBe(schemaJson);
    const schema = JSON.parse(schemaJson);
    expect(() => assertWireBlockHeaderSchema(schema)).not.toThrow();
    const changed = structuredClone(schema);
    changed.structs.find((value: any) => value.name === 'qc_claim_t').fields[1].type = 'uint8';
    expect(() => assertWireBlockHeaderSchema(changed)).toThrow('qc_claim_t');
    const aliased = structuredClone(schema);
    aliased.types = [...(aliased.types ?? []), {new_type_name: 'key_weight', type: 'bytes'}];
    expect(() => assertWireBlockHeaderSchema(aliased)).toThrow('aliases');
});

test('the header walk covers policy diffs, every key variant and extensions', () => {
    const varuint = (value: number) => {const out: number[] = []; do {let b = value & 127; value >>>= 7; if (value) b |= 128; out.push(b);} while (value); return Buffer.from(out);};
    const blob = (bytes: Buffer) => Buffer.concat([varuint(bytes.length), bytes]);
    const u16 = (value: number) => {const b = Buffer.alloc(2); b.writeUInt16LE(value); return b;};
    const u32 = (value: number) => {const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;};
    const u64 = (value: number) => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b;};
    const keys = [Buffer.concat([varuint(0), Buffer.alloc(33, 1)]), Buffer.concat([varuint(1), Buffer.alloc(33, 2)]),
        Buffer.concat([varuint(2), Buffer.alloc(33, 3), Buffer.from([1]), blob(Buffer.from('wire.example'))]),
        Buffer.concat([varuint(3), Buffer.alloc(33, 4)]), Buffer.concat([varuint(4), Buffer.alloc(32, 5)]),
        Buffer.concat([varuint(5), Buffer.from([1]), Buffer.alloc(96, 6)])];
    const header = Buffer.concat([
        Buffer.alloc(4 + 8 + 32 * 3, 9), u32(7), Buffer.from([2]),          // fixed fields; qc_claim with a non-0/1 bool byte
        Buffer.from([1]), u32(3), u64(10), varuint(2), u16(1), u16(4),        // finalizer diff: generation, threshold, removes
        varuint(1), u16(0), blob(Buffer.from('finalizer')), u64(1), blob(Buffer.alloc(96, 8)),
        Buffer.from([1]), u32(4), u32(5), varuint(0), varuint(1), u16(2), u64(11), // proposer diff and one producer
        varuint(0), u32(1), varuint(keys.length), ...keys.flatMap(key => [key, u16(1)]),
        varuint(2), u16(0), blob(Buffer.from('ext')), u16(1), blob(Buffer.alloc(0)),
    ]);
    const signedBlock = Buffer.concat([header, varuint(1), Buffer.from([0]), Buffer.alloc(65, 1), varuint(0), Buffer.from([0]), varuint(0)]);
    expect(wireBlockHeaderLength(signedBlock)).toBe(header.length);
    expect(wireBlockHeaderLength(header)).toBe(header.length);
    expect(() => wireBlockHeaderLength(header.subarray(0, header.length - 1))).toThrow();
    const unknownKey = Buffer.from(header);
    unknownKey[header.indexOf(keys[0]!)]! = 9;
    expect(() => wireBlockHeaderLength(unknownKey)).toThrow('unknown crypto variant');
});
