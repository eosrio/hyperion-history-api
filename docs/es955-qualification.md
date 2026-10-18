# Elasticsearch 9.5.5 first compatibility and profiling slice

`scripts/qualification/es955.ts` runs a finite synthetic workload against an
explicitly isolated, single-node Elasticsearch **9.5.5** target. It uses the
installed **8.19.1 JavaScript client / 8.10.1 transport**, the application's
`esConnectionOptions`, and the built `get_actions` query helpers. Run the normal
build first so those helpers match the checkout. No client upgrade is involved.

The runner creates three exact, uniquely named indices: two populated and one
empty. Each has four primary shards, zero replicas, a one-second refresh
interval, `best_compression`, and descending `global_sequence` index sorting.
These settings and the mapped query fields follow the action template. The
mapping is a bounded projection of that template; the full plugin/template
surface is not qualified by this test.

The default workload seeds 2,000 deterministic synthetic actions, warms the query
paths, then executes five read-only windows and five mixed read/write windows.
Each mixed window adds 100 unique actions while reading the prior stable range.
All windows check complete ascending/descending offset pagination, account,
contract/action, timestamp, and generic term filtering through real helpers.
Every returned ID, order, exact count, acknowledged bulk item and new-document
result must match the independent synthetic oracle. A final check includes all
2,500 acknowledged documents. Refresh is explicit at verification boundaries;
unrefreshed new documents are excluded using the stable sequence ceiling.

The JSON report records runtime/client/transport/server identity, observable
request and response headers, source hashes, effective settings/mappings,
individual request wall times and server `took`, nearest-rank p50/p95/p99,
per-window wall time, process CPU and memory, failed work, and raw before/after
node/index statistics. These include refresh, merges, breakers, indexing
pressure, JVM and thread pools. Byte counts are UTF-8 JSON payload estimates,
not compressed HTTP wire bytes. Guard calls and correctness assertions contribute
to process/window costs but are excluded from measured bulk/search request time.
Per-sample `request_ok` means the client completed the request; only the overall
`status: passed` establishes that all oracle checks and cleanup completed.
Reported `took` values are preserved unchanged. `timing_warnings` flags any value
exceeding client wall time by more than five milliseconds, requiring investigation
before interpreting performance even if data compatibility checks pass.

Install from the canonical npm lock, then build and run:

```powershell
npm ci --ignore-scripts --allow-git=root
npm run build
bun check -p scripts/qualification/tsconfig.json
bun test tests/unit/es955-qualification.test.ts
node scripts/qualification/es955.ts --url http://127.0.0.1:56199 --cluster-name hyperion-es198-<run> --cluster-uuid <exact-uuid> --prefix hyp-es955-<unique-lowercase-token> --output <new-report.json> --transport default
```

Node 24 runs the erasable TypeScript directly. Use the pinned Bun 1.4.3 executable
for the same command to exercise Bun. For a transport-controlled comparison,
pass `--transport http` to both runtimes. With `--transport default`, the real
application selector chooses HttpConnection on Bun and UndiciConnection on Node,
subject to `ES_HTTP_CONNECTION`; that environment value is recorded. Each run
must use a **new prefix and a new output file**. The runner never replaces a
previous report. The optional `--documents` is bounded to 1,000–9,000, leaving
space for all mixed writes and a full last page below the route's 10,000 window.

Only numeric loopback HTTP URLs on an explicit non-default port and cluster names
beginning `hyperion-es955-` or `hyperion-es198-` are accepted. Supply the exact
cluster UUID obtained from the dedicated fixture. The runner verifies identity
and version before mutation, refuses pre-existing indices, stamps a random owner
token in mapping metadata, and rechecks identity/ownership before writes,
refreshes and each exact-index cleanup. It never uses wildcard deletion. Cleanup
failure makes the report fail and names the residue; it never removes another
owner's index. Individual requests have a 15-second timeout and no client retries;
index creation alone allows 45 seconds for cold allocation on a fresh node.
searches use the route's 10-second server timeout. The workload is bounded by its
fixed request count, not an open-ended load loop.

This is a **single-node compatibility and timing sample**, not full Hyperion
acceptance, chain replay, stress, throughput, or production sizing evidence.
It does not exercise PIT/search_after, timed-out or failed shard reduction,
replicas, rolling upgrades, old index compatibility, pressure/breaker exhaustion,
fork recovery, historical ABI correctness, or the full API/plugin surface.
Small runs may produce no merges or pressure events. Compare repeated controlled
runs and their raw evidence before making optimization claims. Broader release
qualification remains tracked in [#198](https://github.com/eosrio/hyperion-history-api/issues/198).
