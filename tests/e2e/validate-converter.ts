#!/usr/bin/env bun
// Validate the frames->log converter against a REAL nodeos state-history slice: inflate each block's
// trace_history + chain_state_history payload from both, and byte-compare the raw transaction_trace[]
// / table_delta[]. Identical => the SHiP-frame-derived log is byte-faithful to the real on-disk log.
import { openSync, readSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const T = process.env.TEMP || '/tmp';
const realDir = process.argv[2] || join(T, 'wax-real');
const convDir = process.argv[3] || join(T, 'wax-fx');
const START = parseInt(process.argv[4] || '190373745', 10);
const COUNT = parseInt(process.argv[5] || '500', 10);

function blockPayload(dir: string, stem: string, block: number, firstBlock: number): Buffer {
  const log = openSync(join(dir, `${stem}.log`), 'r');
  const idx = openSync(join(dir, `${stem}.index`), 'r');
  const ob = Buffer.alloc(8);
  readSync(idx, ob, 0, 8, (block - firstBlock) * 8);
  const logOff = Number(ob.readBigUInt64LE(0));
  const hdr = Buffer.alloc(48);
  readSync(log, hdr, 0, 48, logOff);
  const size = Number(hdr.readBigUInt64LE(40));
  const payload = Buffer.alloc(size);
  readSync(log, payload, 0, size, logOff + 48);
  const s = payload.readUInt32LE(0);
  const zstart = s === 1 && payload.length >= 12 ? 12 : 4;
  return payload.length > zstart ? inflateSync(payload.subarray(zstart)) : Buffer.alloc(0);
}

for (const stem of ['trace_history', 'chain_state_history']) {
  let match = 0, mismatch = 0, firstBad = -1, realBytes = 0;
  for (let b = START; b < START + COUNT; b++) {
    const real = blockPayload(realDir, stem, b, START);
    const conv = blockPayload(convDir, stem, b, START);
    realBytes += real.length;
    if (real.equals(conv)) match++;
    else { mismatch++; if (firstBad < 0) { firstBad = b; } }
  }
  const status = mismatch === 0 ? 'BYTE-IDENTICAL' : `MISMATCH (first bad block ${firstBad})`;
  console.log(`${stem}: ${match}/${COUNT} blocks inflate to byte-identical payloads — ${status}  (${(realBytes/1e6).toFixed(1)} MB inflated)`);
}
