#!/usr/bin/env bun
/**
 * frames-to-log — convert a captured SHIP fixture (see ship-record.ts) into the on-disk
 * nodeos state-history LOG format that the direct-from-disk tools read
 * (action-proto / delta-proto / archive-server).
 *
 * This is the bridge that makes the tiered-storage end-to-end proof fully reproducible WITHOUT
 * a private node: the fixture was captured from a PUBLIC SHIP endpoint over an irreversible WAX
 * range, so anyone can re-capture it; this tool turns it into the `trace_history.{log,index}` +
 * `chain_state_history.{log,index}` pair an operator's frozen node would have on disk.
 *
 * A SHIP `get_blocks_result_v0` carries `traces` (transaction_trace[]) and `deltas`
 * (table_delta[]) as raw `optional<bytes>`. The state-history log stores those SAME bytes,
 * zlib-compressed and framed. So we just walk the result envelope (no ABI needed), extract the
 * two byte ranges, and re-frame them as log entries.
 *
 * Log entry layout (per Leap log.hpp; confirmed against abi-scanner/src/disk.rs):
 *   [magic u64 LE = 0xC35D500000000000][block_id 32B: block_num BE in [0..4], rest 0]
 *   [payload_size u64 LE][payload][position suffix u64 LE = this entry's start offset]
 *   payload = [u32 LE zlib_len][zlib(content)]   (decode_payload inflates from offset 4)
 * .index = one u64 LE per block = that entry's byte offset in the .log.
 *
 * Usage:
 *   bun run tests/e2e/frames-to-log.ts --fixture wax-dense-190m --start 190373745 --count 500 \
 *     --out /tmp/wax-fixture-sh
 */

import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createGunzip, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const SHIP_MAGIC = 0xc35d500000000000n;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// ---- get_blocks_result_v0 envelope walk (extract traces + deltas, no ABI) ----
class Cur {
  constructor(public buf: Buffer, public off = 0) {}
  u8() { return this.buf[this.off++]; }
  u32() { const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  varuint(): number { let v = 0, s = 0, b: number; do { b = this.buf[this.off++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; }
  skipPos() { this.off += 36; } // block_position = uint32 block_num + checksum256 block_id
  optPos() { if (this.u8() === 1) this.skipPos(); }
  optBytes(): Buffer | null { // optional<bytes>
    if (this.u8() !== 1) return null;
    const len = this.varuint();
    const b = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return b;
  }
}

/** Returns {block_num, traces, deltas} from a raw get_blocks_result frame (with or without the
 *  result-variant tag prefix — auto-detected against the record's blockNum). */
function parseResult(frame: Buffer, expectBlock: number): { traces: Buffer | null; deltas: Buffer | null } {
  // The ws frame is the serialized `result` variant: [varuint tag=1][get_blocks_result_v0].
  // Detect the tag by checking whether head.block_num lines up at offset 1 vs 0.
  let start = 0;
  if (frame[0] === 0x01 && frame.readUInt32LE(1) === expectBlock) start = 1;
  else if (frame.readUInt32LE(0) === expectBlock) start = 0;
  else if (frame[0] === 0x01) start = 1; // tag present, head block differs (still fine)
  const c = new Cur(frame, start);
  c.skipPos();      // head
  c.skipPos();      // last_irreversible
  c.optPos();       // this_block
  c.optPos();       // prev_block
  c.optBytes();     // block (signed_block) — not needed for the archive
  const traces = c.optBytes();
  const deltas = c.optBytes();
  return { traces, deltas };
}

// ---- log writer ----
class LogWriter {
  buf: Buffer[] = [];
  idx: Buffer[] = [];
  offset = 0;
  add(blockNum: number, content: Buffer | null) {
    const startOff = this.offset;
    this.idx.push(Buffer.from(new BigUint64Array([BigInt(startOff)]).buffer));
    // header
    const hdr = Buffer.alloc(48);
    hdr.writeBigUInt64LE(SHIP_MAGIC, 0);
    hdr.writeUInt32BE(blockNum, 8); // block_num = BE in first 4 bytes of block_id ([8..12])
    // payload = [u32 zlib_len][zlib(content)]; empty content -> a 4-byte payload that inflates to nothing
    let payload: Buffer;
    if (content && content.length > 0) {
      const z = deflateSync(content); // zlib (deflate + zlib header) — matches flate2 ZlibDecoder
      const pre = Buffer.alloc(4); pre.writeUInt32LE(z.length, 0);
      payload = Buffer.concat([pre, z]);
    } else {
      payload = Buffer.alloc(4); // s=0, no zlib -> decode_payload returns empty
    }
    hdr.writeBigUInt64LE(BigInt(payload.length), 40);
    const suffix = Buffer.alloc(8); suffix.writeBigUInt64LE(BigInt(startOff), 0);
    const entry = Buffer.concat([hdr, payload, suffix]);
    this.buf.push(entry);
    this.offset += entry.length;
  }
  async write(logPath: string, idxPath: string) {
    const lf = await open(logPath, 'w'); await lf.writeFile(Buffer.concat(this.buf)); await lf.close();
    const xf = await open(idxPath, 'w'); await xf.writeFile(Buffer.concat(this.idx)); await xf.close();
  }
}

// ---- iterate fixture shard records ----
async function* records(shardPath: string): AsyncGenerator<{ block: number; frame: Buffer }> {
  const gz = createReadStream(shardPath).pipe(createGunzip());
  let acc: Buffer = Buffer.alloc(0);
  for await (const chunk of gz) {
    acc = acc.length ? Buffer.concat([acc, chunk]) : (chunk as Buffer);
    while (acc.length >= 8) {
      const frameLen = acc.readUInt32LE(0);
      const block = acc.readUInt32LE(4);
      if (acc.length < 8 + frameLen) break;
      const frame = acc.subarray(8, 8 + frameLen);
      yield { block, frame };
      acc = acc.subarray(8 + frameLen);
    }
  }
}

async function main() {
  const fixture = arg('fixture', 'wax-dense-190m')!;
  const start = parseInt(arg('start')!, 10);
  const count = parseInt(arg('count', '500')!, 10);
  const out = arg('out', `/tmp/${fixture}-sh`)!;
  const fixDir = join(import.meta.dir, '.fixtures', fixture);
  const manifest = JSON.parse(readFileSync(join(fixDir, 'manifest.json'), 'utf8'));
  const end = start + count - 1;

  const traceLog = new LogWriter();
  const deltaLog = new LogWriter();
  let written = 0, withTraces = 0, withDeltas = 0;
  let expect = start;

  outer:
  for (const sh of manifest.shards) {
    if (sh.last < start || sh.first > end) continue;
    for await (const { block, frame } of records(join(fixDir, 'shards', sh.file))) {
      if (block < start) continue;
      if (block > end) break outer;
      if (block !== expect) throw new Error(`non-contiguous: expected ${expect}, got ${block}`);
      const { traces, deltas } = parseResult(frame, block);
      traceLog.add(block, traces);
      deltaLog.add(block, deltas);
      if (traces && traces.length) withTraces++;
      if (deltas && deltas.length) withDeltas++;
      expect++; written++;
    }
  }

  await mkdir(out, { recursive: true });
  await traceLog.write(join(out, 'trace_history.log'), join(out, 'trace_history.index'));
  await deltaLog.write(join(out, 'chain_state_history.log'), join(out, 'chain_state_history.index'));
  console.log(`[frames-to-log] wrote ${written} blocks [${start}..${expect - 1}] -> ${out}`);
  console.log(`  trace_history: ${written} entries (${withTraces} with traces)`);
  console.log(`  chain_state_history: ${written} entries (${withDeltas} with deltas)`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
