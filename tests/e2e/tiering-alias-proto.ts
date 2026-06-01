#!/usr/bin/env bun
// Prototype: payload-tiering cutover via per-type READ ALIAS + composable templates.
//
// Proves the two load-bearing claims of the alias blue-green design against a real ES:
//   CLAIM 1  block_hint exact-index reads convert to (read-alias + block_num range) with NO
//            loss of shard pruning — non-matching partitions are skipped at the can_match phase.
//   CLAIM 2  the hot->cold cutover (reindex-to-payload-stripped-twin -> atomic updateAliases
//            -> drop whole hot index) is zero-downtime: a concurrent reader of the alias never
//            sees 0 hits (gap) or 2 hits (duplicate) for a partition mid-cutover.
//   CLAIM 3  dual-read floor: a flag-OFF reader on the plain wildcard still sees every partition
//            exactly once after a cutover (cold twin matches the wildcard; hot index is gone).
//
// Mirrors production: composable templates (component template for mappings/settings shared by a
// HOT index template that carries the read-alias, and a COLD index template that does NOT), the
// real action mappings (act.data enabled:false, index.sort on global_sequence, block_num long),
// 4 shards/partition so shard-skip is observable, 10M-block partitions (ceil(block/size)).
//
// Run:  ES=http://localhost:9200  bun tests/e2e/tiering-alias-proto.ts
//       (compose stack ES is on :19200 — ES=http://localhost:19200 bun ...)
// Idempotent: cleans its `proto-action*` namespace on start and end. Touches nothing else.

const ES = process.env.ES || "http://localhost:9200";
const PSIZE = 10_000_000; // index_partition_size
const SHARDS = 4; // actionSettings: shards*2
const HOT_READ = "proto-action-read"; // the per-type read alias
const COLD_TAG = "proto-action-cold"; // membership registry of cold partitions

let PASS = 0,
  FAIL = 0;
function check(name: string, ok: boolean, detail = "") {
  (ok ? PASS++ : FAIL++);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
}

async function es(method: string, path: string, body?: any): Promise<any> {
  const r = await fetch(`${ES}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  const json = txt ? JSON.parse(txt) : {};
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${txt.slice(0, 400)}`);
  return json;
}
const part = (block: number) => Math.ceil(block / PSIZE).toString().padStart(6, "0");
const hotIndex = (p: string) => `proto-action-v1-${p}`;
const coldIndex = (p: string) => `proto-action-cold-v1-${p}`;

async function cleanup() {
  // delete proto indices, both templates, the component template — ignore missing.
  await fetch(`${ES}/proto-action-*,proto-action-cold-*`, { method: "DELETE" }).catch(() => {});
  for (const t of ["proto-action-hot", "proto-action-cold"])
    await fetch(`${ES}/_index_template/${t}`, { method: "DELETE" }).catch(() => {});
  await fetch(`${ES}/_component_template/proto-action-shared`, { method: "DELETE" }).catch(() => {});
}

async function setupTemplates() {
  // Component template — the shared mappings/settings (the real action shape, trimmed).
  await es("PUT", "/_component_template/proto-action-shared", {
    template: {
      settings: {
        index: {
          number_of_shards: SHARDS,
          number_of_replicas: 0,
          refresh_interval: "1s",
          codec: "best_compression",
          sort: { field: "global_sequence", order: "desc" },
        },
      },
      mappings: {
        properties: {
          "@timestamp": { type: "date" },
          global_sequence: { type: "long" },
          block_num: { type: "long" },
          trx_id: { type: "keyword" },
          "act.account": { type: "keyword" },
          "act.name": { type: "keyword" },
          "act.data": { enabled: false }, // payload: stored, not indexed — the thing we tier
        },
      },
    },
  });
  // HOT index template: matches the versioned hot partitions, carries the read alias (auto-join).
  await es("PUT", "/_index_template/proto-action-hot", {
    index_patterns: ["proto-action-v*-*"],
    composed_of: ["proto-action-shared"],
    priority: 200,
    template: { aliases: { [HOT_READ]: {} } }, // every new hot partition auto-joins the read alias
  });
  // COLD index template: cold twins get identical mappings (so can_match/range still works) but
  // NO read-alias auto-join. They still match the dual-read wildcard `proto-action-*`.
  await es("PUT", "/_index_template/proto-action-cold", {
    index_patterns: ["proto-action-cold-*"],
    composed_of: ["proto-action-shared"],
    priority: 200,
  });
}

let gseq = 1;
async function bulkSeed() {
  // Build one bulk for all three partitions; rely on the HOT template to auto-create + auto-alias.
  let body = "";
  for (let k = 1; k <= 3; k++) {
    const base = (k - 1) * PSIZE;
    const idx = hotIndex(part(base + 1));
    for (let i = 0; i < 50; i++) {
      const block_num = base + (i + 1) * 1000;
      body += JSON.stringify({ index: { _index: idx, _id: `${gseq}` } }) + "\n";
      body += JSON.stringify({
        "@timestamp": "2020-01-01T00:00:00.000Z",
        global_sequence: gseq++,
        block_num,
        trx_id: `trx-${k}-${i}`,
        act: { account: "eosio.token", name: "transfer", data: { from: "a", to: "b", q: `${i} TOK` } },
      }) + "\n";
    }
  }
  const r = await fetch(`${ES}/_bulk`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body,
  });
  const j = await r.json();
  if (j.errors) throw new Error("bulk errors: " + JSON.stringify(j.items?.find((x: any) => x.index?.error)));
  await es("POST", "/proto-action-v1-*/_refresh");
}

async function search(index: string, query: any, opts: Record<string, string> = {}) {
  const qs = new URLSearchParams(opts).toString();
  return es("POST", `/${index}/_search${qs ? "?" + qs : ""}`, query);
}
// block_hint read: target the partition's hot+cold physical indices directly (one exists),
// `ignore_unavailable` swallows the missing twin. Deterministic pruning, no can_match dependency.
async function blockHint(block: number, query: any) {
  const p = part(block);
  return es("POST", `/${hotIndex(p)},${coldIndex(p)}/_search?ignore_unavailable=true`, query);
}

async function main() {
  console.log(`\n== tiering-alias prototype against ${ES} ==\n`);
  await cleanup();
  await setupTemplates();
  await bulkSeed();

  // Sanity: all 3 hot partitions auto-joined the read alias via the template.
  const aliasMembers = Object.keys(await es("GET", `/_alias/${HOT_READ}`));
  check(
    "template auto-join: 3 hot partitions in read alias",
    aliasMembers.length === 3,
    aliasMembers.sort().join(", ")
  );

  // ---- CLAIM 1: block_hint pruning (the can_match-by-range idea is empirically rejected) ----
  console.log("\nCLAIM 1 — block_hint pruning\n");
  const p2lo = PSIZE + 1,
    p2hi = 2 * PSIZE;
  // NEGATIVE FINDING: can_match does NOT skip shards for a numeric block_num range, even forced
  // (ES only registers date/sort fields for coordinator shard-skip). So "alias + range" is OUT.
  const aliasRange = await search(
    HOT_READ,
    {
      query: { bool: { must: [{ term: { trx_id: "trx-2-25" } }, { range: { block_num: { gte: p2lo, lte: p2hi } } }] } },
    },
    { pre_filter_shard_size: "1" }
  );
  console.log(
    `    FINDING: alias + block_num range skipped ${aliasRange._shards.skipped}/${aliasRange._shards.total} shards ` +
      `→ can_match does NOT prune numeric ranges. The "alias+range" mechanic is rejected.`
  );

  // MECHANIC: block_hint -> the partition's hot+cold physical indices directly (ignore_unavailable).
  const exact = await search(hotIndex("000002"), { query: { term: { trx_id: "trx-2-25" } } });
  const hint = await blockHint(10_026_000, { query: { term: { trx_id: "trx-2-25" } } }); // hot here (pre-cutover)
  const aliasFull = await search(HOT_READ, { query: { match_all: {} }, size: 0 });
  check("exact-name baseline returns the trx", exact.hits.total.value === 1);
  check("block_hint (dual-physical) returns the same trx", hint.hits.total.value === 1, `from ${hint.hits.hits[0]?._index}`);
  check(
    `block_hint prunes to ONE partition (${SHARDS} shards) vs full alias (${aliasFull._shards.total})`,
    hint._shards.total === SHARDS,
    `hint=${hint._shards.total} shards, alias-full=${aliasFull._shards.total}`
  );

  // ---- CLAIM 2: atomic zero-downtime cutover of partition 000002 ----
  console.log("\nCLAIM 2 — atomic cutover: reindex-twin -> updateAliases(add cold, remove hot) -> drop hot\n");
  const H = hotIndex("000002");
  const C = coldIndex("000002");

  // Reindex hot -> cold twin, EXCLUDING the payload from _source (the whole-index, no-in-place-delete path).
  await es("POST", "/_reindex?wait_for_completion=true&refresh=true", {
    source: { index: H, _source: { excludes: ["act.data"] } },
    dest: { index: C, op_type: "create" },
  });
  const coldDoc = (await search(C, { query: { term: { trx_id: "trx-2-25" } }, _source: true })).hits.hits[0];
  check("cold twin has the doc", !!coldDoc);
  check(
    "cold twin DROPPED the payload (act.data absent in _source -> triggers hydration)",
    coldDoc && coldDoc._source.act?.data === undefined,
    "act.data " + (coldDoc?._source.act?.data === undefined ? "absent" : "PRESENT")
  );

  // Concurrent reader: poll the alias for a p2 trx throughout the swap+drop; record hit counts.
  const counts: number[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      try {
        const r = await search(HOT_READ, { query: { term: { trx_id: "trx-2-25" } }, track_total_hits: true });
        counts.push(r.hits.total.value);
      } catch {
        counts.push(-1); // a thrown error mid-swap would itself be a failure
      }
    }
  })();

  await new Promise((r) => setTimeout(r, 120)); // let the poller establish a baseline
  // THE ATOMIC SWAP: add cold to read-alias + cold-tag, remove hot from read-alias — one call.
  await es("POST", "/_aliases", {
    actions: [
      { add: { index: C, alias: HOT_READ } },
      { add: { index: C, alias: COLD_TAG } },
      { remove: { index: H, alias: HOT_READ } },
    ],
  });
  await new Promise((r) => setTimeout(r, 60));
  await es("DELETE", `/${H}`); // drop the WHOLE hot index (the only delete; never in-index)
  await new Promise((r) => setTimeout(r, 120));
  polling = false;
  await poller;

  const sawGap = counts.some((c) => c === 0);
  const sawDup = counts.some((c) => c > 1);
  const sawErr = counts.some((c) => c === -1);
  check(
    `concurrent reader saw exactly 1 hit across ${counts.length} polls through the cutover`,
    !sawGap && !sawDup && !sawErr,
    `min=${Math.min(...counts)} max=${Math.max(...counts)} gap=${sawGap} dup=${sawDup} err=${sawErr}`
  );
  check("hot index 000002 is gone", !(await fetch(`${ES}/${H}`).then((r) => r.ok)));
  const coldTagged = Object.keys(await es("GET", `/_alias/${COLD_TAG}`));
  check("cold partition is registered in the cold-tag alias", coldTagged.includes(C), coldTagged.join(", "));

  // ---- CLAIM 3: dual-read floor (flag-OFF wildcard) sees every partition once, post-cutover ----
  console.log("\nCLAIM 3 — dual-read floor: plain wildcard still resolves each partition exactly once\n");
  // flag-ON reader: the alias.   flag-OFF reader: the wildcard `proto-action-*` (matches hot + cold twins).
  const viaAlias = await search(HOT_READ, { query: { match_all: {} }, size: 0 }, {});
  const viaWild = await search("proto-action-*", { query: { match_all: {} }, size: 0 }, {});
  check(
    "alias (flag-ON) total == wildcard (flag-OFF) total == 150 (no dup, no gap)",
    viaAlias.hits.total.value === 150 && viaWild.hits.total.value === 150,
    `alias=${viaAlias.hits.total.value} wildcard=${viaWild.hits.total.value}`
  );
  const p2viaAlias = await search(HOT_READ, { query: { term: { trx_id: "trx-2-10" } } });
  check(
    "post-cutover, p2 reads resolve to the cold twin via the alias (payload absent)",
    p2viaAlias.hits.total.value === 1 && p2viaAlias.hits.hits[0]._source.act?.data === undefined
  );
  // block_hint on the now-COLD partition: dual-physical still prunes to one partition, hits the twin.
  const hintCold = await blockHint(10_011_000, { query: { term: { trx_id: "trx-2-10" } } });
  check(
    `block_hint on a cut-over partition prunes to ${SHARDS} shards and resolves the cold twin (payload absent)`,
    hintCold.hits.total.value === 1 &&
      hintCold.hits.hits[0]._index === coldIndex("000002") &&
      hintCold.hits.hits[0]._source.act?.data === undefined &&
      hintCold._shards.total === SHARDS,
    `index=${hintCold.hits.hits[0]?._index} shards=${hintCold._shards.total}`
  );

  console.log(`\n== ${PASS} passed, ${FAIL} failed ==`);
  if (process.env.KEEP !== "1") await cleanup();
  else console.log("(KEEP=1 — left proto-action* indices/templates for inspection)");
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(2);
});
