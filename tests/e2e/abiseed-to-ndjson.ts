#!/usr/bin/env bun
// Convert a fixture's abi-seed.json into the abi-index NDJSON the readers/archive load.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = process.argv[2] || 'wax-dense-190m';
const outPath = process.argv[3] || join(process.env.TEMP || '/tmp', `${fixture}-abi.ndjson`);
const seed = JSON.parse(readFileSync(join(import.meta.dir, '.fixtures', fixture, 'abi-seed.json'), 'utf8'));
const lines: string[] = [];
let n = 0;
for (const x of seed.docs) {
  if (x.account && x.abi_hex) { lines.push(JSON.stringify({ account: x.account, block: x.block, abi_hex: x.abi_hex })); n++; }
}
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`wrote ${n} abi-index docs (seedBlock ${seed.seedBlock}) -> ${outPath}`);
