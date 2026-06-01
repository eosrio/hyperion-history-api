#!/usr/bin/env bun
// Apply Hyperion action/delta index templates to the local bench ES and bulk-load the cold
// (metadata-only) docs with the real Hyperion _id/_index rules. Local/loopback ES only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ES = process.env.ES || 'http://localhost:9200';
const CHAIN = 'wax';
const T = process.env.TEMP || '/tmp';
const PART = 10_000_000;
const tplDir = 'P:/eosrio/abi-scanner/bench/templates';

const part = (block: number) => String(Math.max(1, Math.ceil(block / PART))).padStart(6, '0');

async function applyTemplate(kind: 'action' | 'delta') {
  const tpl = readFileSync(join(tplDir, `${kind}.json`), 'utf8').replaceAll('{{CHAIN}}', CHAIN);
  const r = await fetch(`${ES}/_index_template/${CHAIN}-${kind}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: tpl,
  });
  console.log(`template ${CHAIN}-${kind}: ${r.status} ${r.ok ? 'ok' : await r.text()}`);
}

async function bulkLoad(file: string, kind: 'action' | 'delta') {
  const lines = readFileSync(join(T, file), 'utf8').split('\n').filter(Boolean);
  let body = '', n = 0, sent = 0;
  const flush = async () => {
    if (!body) return;
    const r = await fetch(`${ES}/_bulk`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body });
    const j: any = await r.json();
    if (j.errors) { console.error(`  bulk errors in ${kind}:`, JSON.stringify(j.items.find((i: any) => i.index?.error)?.index?.error).slice(0, 200)); }
    sent += n; body = ''; n = 0;
  };
  for (const line of lines) {
    const d = JSON.parse(line);
    const idx = `${CHAIN}-${kind}-v1-${part(d.block_num)}`;
    const id = kind === 'action' ? String(d.global_sequence)
      : `${d.block_num}-${d.code}-${d.scope}-${d.table}-${d.primary_key}`;
    body += JSON.stringify({ index: { _index: idx, _id: id } }) + '\n' + line + '\n';
    n++;
    if (n >= 4000) await flush();
  }
  await flush();
  console.log(`loaded ${sent} ${kind} docs`);
}

await applyTemplate('action');
await applyTemplate('delta');
await bulkLoad('cold-actions.ndjson', 'action');
await bulkLoad('cold-deltas.ndjson', 'delta');
await fetch(`${ES}/${CHAIN}-action-*,${CHAIN}-delta-*/_refresh`, { method: 'POST' });
for (const k of ['action', 'delta']) {
  const c: any = await (await fetch(`${ES}/${CHAIN}-${k}-*/_count`)).json();
  console.log(`${CHAIN}-${k}-* count: ${c.count}`);
}
