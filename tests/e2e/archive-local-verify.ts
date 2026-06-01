#!/usr/bin/env bun
// Verify the local archive (over the converted reproducible log) serves act.data that matches the
// hot action docs action-proto emitted from the same log. No private node — fully reproducible.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8088';
const T = process.env.TEMP || '/tmp';
const hot = readFileSync(join(T, 'wax-fx-actions.ndjson'), 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(d => d.act && d.act.data !== undefined).slice(0, 200);

let pass = 0, fail = 0, exactData = 0;
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

const req = hot.map(d => ({ block_num: d.block_num, global_sequence: d.global_sequence }));
const res = await fetch(`${BASE}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
const out = (await res.json()).actions;

for (let i = 0; i < hot.length; i++) {
  const h = hot[i], r = out[i];
  if (!r || r.found !== true) { fail++; if (fail <= 3) console.log(`  FAIL [${i}] ${h.act.account}::${h.act.name} not found`); continue; }
  if (eq(r.data, h.act.data)) { exactData++; pass++; }
  else { fail++; if (fail <= 5) console.log(`  DIFF [${i}] ${h.act.account}::${h.act.name}\n    archive: ${JSON.stringify(r.data).slice(0,90)}\n    hot:     ${JSON.stringify(h.act.data).slice(0,90)}`); }
}
console.log(`\nArchive over converted log: ${pass}/${hot.length} actions hydrated; data byte-identical to action-proto hot output on ${exactData}.`);
process.exit(fail ? 1 : 0);
