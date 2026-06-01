#!/usr/bin/env bun
// slice-log raw-copies state-history entries, so each entry's trailing 8-byte position suffix still
// holds its ORIGINAL absolute offset in the full log. Sequential readers (action-proto/delta-proto)
// use suffix==pos to stay aligned, so stale suffixes derail them. The index is already rebased
// correctly, so we just rewrite each entry's suffix in place to its slice-local offset.
import { openSync, readSync, writeSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || join(process.env.TEMP || '/tmp', 'wax-real');
const START = parseInt(process.argv[3] || '190373745', 10);
const COUNT = parseInt(process.argv[4] || '500', 10);

for (const stem of ['trace_history', 'chain_state_history']) {
  const log = openSync(join(dir, `${stem}.log`), 'r+');
  const idx = openSync(join(dir, `${stem}.index`), 'r');
  const ob = Buffer.alloc(8), hdr = Buffer.alloc(48), suf = Buffer.alloc(8);
  let fixed = 0, firstOrig = -1n;
  for (let i = 0; i < COUNT; i++) {
    readSync(idx, ob, 0, 8, i * 8);
    const entryOff = ob.readBigUInt64LE(0);
    readSync(log, hdr, 0, 48, Number(entryOff));
    const payloadSize = hdr.readBigUInt64LE(40);
    const sufPos = entryOff + 48n + payloadSize;
    readSync(log, suf, 0, 8, Number(sufPos));
    if (i === 0) firstOrig = suf.readBigUInt64LE(0);
    if (suf.readBigUInt64LE(0) !== entryOff) {
      const fix = Buffer.alloc(8); fix.writeBigUInt64LE(entryOff, 0);
      writeSync(log, fix, 0, 8, Number(sufPos));
      fixed++;
    }
  }
  console.log(`${stem}: first entry's original suffix = ${firstOrig} (slice offset 0) -> rewrote ${fixed}/${COUNT} suffixes to slice-local`);
}
