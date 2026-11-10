import {expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {protocolBytes} from '../../src/indexer/protocol/contract-cache.js';
import {loadChainProtocol} from '../../src/indexer/protocol/selection.js';
import type {DiskAbiHistoryConfiguration} from '../../src/indexer/protocol/disk-abi-history.js';
import type {DiskCaptureConfiguration} from '../../src/indexer/protocol/disk-capture-source.js';
import type {ProtocolSourcePosition} from '../../src/indexer/protocol/source-bindings.js';
import {capture as preflight, schemaJson, frames} from './portable-state-source-fixture.mjs';

export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export {preflight, schemaJson};
const SHIP_MAGIC = 0xc35d500000000000n;
const u32 = (value: number) => {const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;};
const u64 = (value: bigint | number) => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b;};

/** One block's exact SHiP sections, as SHiP delivered them. */
export interface WireBlock {position: ProtocolSourcePosition; block: Buffer; traces: Buffer | null; deltas: Buffer}

/** Real Wire testnet blocks 1-4 from the retained SHiP frames, decoded with the released plugin. */
export async function wireBlocks() {
    const selected = await loadChainProtocol({provider: 'extension', package: '@eosrio/hyperion-wire-plugin', profileId: preflight.profileId} as any);
    const session = selected.provider.createShipSession(JSON.parse(schemaJson));
    try {
        const blocks: WireBlock[] = (frames as Buffer[]).map(frame => {
            const [kind, result] = session.decodeResult(frame) as [string, any];
            expect(kind.startsWith('get_blocks_result')).toBe(true);
            const section = (value: unknown) => value === null || value === undefined ? null : Buffer.from(protocolBytes(value));
            return {position: {chainId: preflight.chainId, blockNum: Number(result.this_block.block_num),
                blockId: String(result.this_block.block_id).toLowerCase(),
                previousBlockId: result.prev_block ? String(result.prev_block.block_id).toLowerCase() : null},
                block: section(result.block)!, traces: section(result.traces), deltas: section(result.deltas)!};
        });
        expect(blocks.map(value => value.position.blockNum)).toEqual([1, 2, 3, 4]);
        return {blocks, selected};
    } finally {session.close?.();}
}

/** A state-history entry: header, sized preamble and zlib stream, then the entry's own offset. */
function entry(pos: number, id: string, payload: Buffer, options: {declared?: number; stream?: Buffer; trailer?: number} = {}): Buffer {
    const stream = options.stream ?? deflateSync(payload, {level: 0});
    const body = Buffer.concat([u32(1), u64(options.declared ?? payload.length), stream]);
    return Buffer.concat([u64(SHIP_MAGIC), Buffer.from(id, 'hex'), u64(body.length), body, u64(options.trailer ?? pos)]);
}
export interface LogEdits {
    /** An abandoned entry written before the canonical one of a block. */
    orphan?: {stem: 'chain_state_history' | 'trace_history'; block: number; id: string};
    entry?: {stem: 'chain_state_history' | 'trace_history'; block: number; declared?: number; stream?: Buffer; trailer?: number};
    block?: {block: number; bytes?: Buffer; trailer?: number};
}
/** Writes a node's log layout for `blocks` (a block log and both state-history logs) and the handshake. */
export async function writeNodeLogs(blocks: readonly WireBlock[], edits: LogEdits = {}, handshake = schemaJson): Promise<DiskCaptureConfiguration> {
    const root = await mkdtemp(join(tmpdir(), 'h45-disk-capture-'));
    const history = join(root, 'state-history'), blocksDir = join(root, 'blocks');
    await mkdir(history); await mkdir(blocksDir);
    for (const stem of ['chain_state_history', 'trace_history'] as const) {
        const parts: Buffer[] = [], index: Buffer[] = [];
        let size = 0;
        for (const value of blocks) {
            const payload = stem === 'trace_history' ? value.traces : value.deltas;
            if (payload === null) continue;
            if (edits.orphan?.stem === stem && edits.orphan.block === value.position.blockNum) {
                const orphan = entry(size, edits.orphan.id, Buffer.from('abandoned fork entry'));
                parts.push(orphan); size += orphan.length;
            }
            const edit = edits.entry?.stem === stem && edits.entry.block === value.position.blockNum ? edits.entry : undefined;
            const bytes = entry(size, value.position.blockId, payload, edit);
            index.push(u64(size)); parts.push(bytes); size += bytes.length;
        }
        await writeFile(join(history, stem + '.log'), Buffer.concat(parts));
        await writeFile(join(history, stem + '.index'), Buffer.concat(index));
    }
    const preamble = Buffer.concat([u32(3), u32(1), Buffer.alloc(40, 7)]);
    const parts: Buffer[] = [preamble], index: Buffer[] = [];
    let size = preamble.length;
    for (const value of blocks) {
        const edit = edits.block?.block === value.position.blockNum ? edits.block : undefined;
        const bytes = Buffer.concat([edit?.bytes ?? value.block, u64(edit?.trailer ?? size)]);
        index.push(u64(size)); parts.push(bytes); size += bytes.length;
    }
    await writeFile(join(blocksDir, 'blocks.log'), Buffer.concat(parts));
    await writeFile(join(blocksDir, 'blocks.index'), Buffer.concat(index));
    const shipAbi = join(root, 'ship.json');
    await writeFile(shipAbi, handshake);
    return {state_history_dir: history, blocks_dir: blocksDir, ship_abi: shipAbi};
}

/** A sealed disk ABI catalog over `ids` (blocks 1..n) with `rows`, pinned to `handshake`. */
export async function writeCatalog(chainId: string, ids: readonly string[], rows: readonly object[], handshake: string,
                                   producerProfileId = 'producer-profile'): Promise<DiskAbiHistoryConfiguration> {
    const directory = await mkdtemp(join(tmpdir(), 'h45-disk-catalog-'));
    const rowBytes = rows.map(row => JSON.stringify(row)).join('\n'), idBytes = Buffer.from(ids.join(''), 'hex');
    await writeFile(join(directory, 'abi.ndjson'), rowBytes); await writeFile(join(directory, 'blocks.bin'), idBytes);
    const manifest = {format: 'hyperion-wire-abi-history-v1', complete: true, chainId, nodeRevision: 'c'.repeat(40), producerProfileId,
        shipAbiSha256: hash(handshake), startBlock: 1, endBlock: ids.length, firstBlockId: ids[0], lastBlockId: ids.at(-1),
        irreversibleBoundary: {blockNum: ids.length, blockId: ids.at(-1)}, lastGlobalSequence: null,
        deployments: {name: 'abi.ndjson', bytes: Buffer.byteLength(rowBytes), sha256: hash(rowBytes), records: rows.length},
        blockIds: {name: 'blocks.bin', bytes: idBytes.length, sha256: hash(idBytes), count: ids.length}};
    const bytes = JSON.stringify(manifest), path = join(directory, 'manifest.json');
    await writeFile(path, bytes);
    return {interface_version: 1, manifest: path, manifest_sha256: hash(bytes), producer_profile_id: producerProfileId,
        node_revision: manifest.nodeRevision, ship_abi_sha256: hash(handshake)};
}
