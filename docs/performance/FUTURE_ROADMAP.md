# Future of Hyperion — Performance & Architecture Roadmap

> Status: research roadmap (Phase 3+). Supersedes nothing; builds on
> `docs/performance/PERFORMANCE_REPORT.md` (Phase 0 baseline + Phase 2 feed-rate experiments)
> and `docs/performance/EXPERIMENTS.md` (Phase 1 Redis-pipeline + dual-mode flush).
> Branch: `experimental/performance`. Last synthesis: 2026-05-29.

## 0. Executive summary

The two authoritative reports establish one dominant fact that governs every decision below:

> **At the only scale we have measured (small local chain, ~5 deltas/block, ~1.1 actions/block,
> 698–2,397 blocks), ~85% of wall-clock is IDLE. The system is FEED-RATE bound, not CPU-bound.
> No CPU stage exceeds ~8% of wall.**

This has three consequences that shape the whole roadmap:

1. **Almost every "make the indexer faster" proposal is currently unmeasurable.** `process_deltas`
   (0.87 ms/block, the biggest master CPU cost) is ~2–3% of wall. The actions ES bulk (~194 ms/bulk)
   is parallel and off the critical path. A win there moves nothing today and is inside the
   documented ~20% run-to-run cargo-sizing variance.

2. **The density-driven bets (`process_deltas` batching, multi-worker scaling, rs-abieos, ABI
   pre-warm, ES bulk tuning, ClickHouse) cannot be validated, accepted, or even safely measured
   until a denser/mainnet workload exists.** That makes the **dense benchmark harness + ms-resolution
   wall instrumentation the single hard prerequisite gate** for the entire mid-term and research tier.

3. **The agenda over-indexes on the write path and under-indexes on the read/serve path,
   operability, and the live-streaming latency path** — which is where measurable, user-visible wins
   and the worst production failure modes actually live. This roadmap re-balances toward those.

We also correct three factual errors the original proposals carried, confirmed against source on this branch:

- **`delta-batch` sub-change (1) (per-row await elision) is largely infeasible:** all eight
  `deltaStructHandlers` are `async` and await `preIndexingQueue` (concurrency-1), which *is* the AMQP
  backpressure. You cannot elide those awaits without breaking a hard constraint. Confirmed at
  `deserializer.ts:1690`.
- **`delta-batch` sub-change (3a) (retry-condition "fix") targets a non-bug:** both decode success
  paths already `delete row.value`, so the retry already only fires on genuine failure.
- **`storage-backend` / `action-doc-slimming` synthetic `_source` is format-breaking, not additive:**
  the action mapping sets `act.data`/`signatures`/`act.authorization.permission` to `enabled:false`,
  and the API reads those straight from `_source`. Synthetic source would silently drop payload from
  API responses.

The honest through-line: **build the measurement apparatus first; harvest the cheap, format-safe,
TODAY-measurable wins (read-path, ES settings, observability) in parallel; gate all density bets
behind the harness; and treat correctness (ABI-version-at-block, crash recovery) as a first-class
research direction, not a per-proposal footnote.**

---

## Phase 3 — Quick wins & the prerequisite gate (build the ruler, harvest the safe wins)

These are low-risk, format-safe, and either measurable today or are the gate for everything else.
Nothing here is blocked on a denser chain.

### 3.1 — Dense / mainnet benchmark harness (THE GATE) — `mainnet-bench`

- **Problem.** Every forward-looking claim is a linear extrapolation from ~5 deltas/block. The whole
  bottleneck thesis ("`process_deltas` dominates at 50–100 deltas/block") is unvalidated and
  *unfalsifiable* with the current workload. The load generator pushes one tx per serial
  `docker exec ... cleos push action` (hundreds of ms each), structurally incapable of mainnet block
  density. `bench.ts` records zero density metrics.
- **Approach.** Three tiers, cheapest first:
  - **Tier 1 (synthetic density):** add a `storebatch(owner, count)` action to `hyp.test.cpp` that
    loops `store.emplace` N times (one action → N deltas, decoupling density from the 0.5 s block
    cadence), plus a multi-action `push transaction` submitter built on `@wharfkit/antelope` (already
    a dependency) posting directly to `/v1/chain/push_transaction` — eliminating the per-tx
    docker-exec bottleneck. Add a `DensityProfile { deltasPerBlock, actionsPerBlock, targetBlocks,
    tableCardinality }`. **Heterogeneity is mandatory** (multiple contracts/tables), not optional, so
    the curve speaks to cold-ABI/decode variance, not just a monotone warm-cache best case. Requires
    a Docker image rebuild with CDT (`hyp.test.wasm/.abi` is compiled in the Docker build; no prebuilt
    artifact is committed) — this is the real cost and dominates the estimate.
  - **Tier 2 (instrumentation in bench):** parse `process_deltas` / `process_traces` /
    ingestor `db_indexing` from the profiling snapshot; compute and persist `deltasPerBlock`,
    `actionsPerBlock`, `msPerBlock_master`, `usPerDelta`, `usPerTrace`, and a per-axis **saturation
    classification** (`bound_by: master | es | feed`) into `bench-<label>.json`. Without the
    `bound_by` field the dense curve cannot distinguish "master-bound" (the signal) from "ES-bound"
    (a local-infra artifact at `-Xmx2g`). Parameterize `ES_JAVA_OPTS`.
  - **Tier 3 (real mainnet SHIP replay, gated/optional):** point `connections.json` at an external
    archive SHIP over a known-dense historical range. Reader supports this config-only. Operationally
    hard (deep archive SHIP rarely served), so last.
- **Expected impact (metric).** Produces the `deltas/block → master-ms/block` curve and the
  `bound_by` classification. This is the **go/no-go evidence** for §4.1, §4.2, §5.1, §5.3, §5.4 —
  not a perf delta itself.
- **Effort.** L (Tier 1+2). Tier 3 is a separate environment-gated effort.
- **Risk.** Medium-low. Primary risk is synthetic-density *fidelity* — a monotone single-table
  chain understates cold-ABI cost; mitigated by the heterogeneity knob and the Tier-3 oracle.
- **Format-compat.** SAFE. Test tooling only; dense synthetic chain writes the same doc shapes through
  the same ingestors at higher volume. Tier-3 writes real docs to a throwaway ES cluster (hard guard:
  refuse unless ES host is loopback or `BENCH_ALLOW_EXTERNAL_ES=1`).
- **Dependencies.** None to start. **Hard gate for the entire density tier.** Land first.

### 3.2 — ms-resolution wall-time instrumentation in the master — `wall-instrumentation`

- **Problem.** Every wall number derives from a single 5 s monitor tick (`indexerMonitor.ts:33`,
  `log_interval=5000`). The "20 s wall / 119.85 blocks/s" headline folds in container startup, SHIP
  handshake grace (~5–10 s), up to one 5 s tail-detection tick, reader burst, and AMQP transit. The
  reports' `§10.7` "<10 s of 25 s is real processing" hypothesis is currently unprovable, and the
  noise floor (~5 s) exceeds several measured effects (e.g. the `§10.5` tx_cache 25→20 s delta).
- **Approach.** Two pieces, the first authoritative:
  - **Master block-span (single-process, authoritative):** in the `consumed_block` batch branch
    (`master.ts`, guarded `msg.live === 'false'`), record `firstBlockHrTime`/`lastBlockHrTime`
    (`process.hrtime.bigint()`), `firstBlockNum`/`lastBlockNum`, `processedBlockSpanCount`. Reset in
    `startFullIndexing` so the abi_scan→full transition starts a clean span. Derive
    `blocksPerSec = (lastBlockNum - firstBlockNum + 1) / spanMs`.
  - **Profiler busy-span (per-stage duty cycle):** in `profiler.ts`, forward the existing
    `startHrTime`/`endHrTime` (already in the `start()` closure — no new syscalls) into `record()` as
    `firstTsNs ??= start; lastTsNs = end`. Master reduces per-worker `min(first)/max(last)`.
    `duty_cycle = totalTimeMs / busy_span_ms`. **Cross-process epochs are not comparable** — only ever
    subtract within one process.
- **Critical implementation note (confirmed hazard).** `controller.ts` does
  `JSON.stringify({data: getProfilingReport()})`, and `JSON.stringify` throws on `BigInt`. **Number
  conversion at the `getProfilingReport()` boundary is mandatory, not optional** (a run span fits in
  2^53 ns ≈ 104 days). Keep `bigint` private; emit Numbers (ns or ms). Add a CI smoke assertion that
  `JSON.stringify(getProfilingReport())` does not throw with `ds_profiling` on.
- **Compat caveat (corrected).** A top-level sibling `blockSpan` key is NOT silently ignored by the
  CLI: `stats.control.ts` treats every top-level key as a worker. Update the renderer to skip the
  reserved key in the same change (additive *inner* metric fields ARE safely ignored). Also: the full
  pass resets `reference_time` at the mode switch, so the existing `ttime` is less startup-contaminated
  than the original proposal implied — the block-span is still the right fix for tail-tick + transit
  contamination.
- **Expected impact (metric).** Creates `steady-state blocks/s` and `per-stage duty cycle`; shrinks
  the measurement noise floor from ~5 s to sub-ms. Lets us re-qualify the flagged `§10.5`/`§10.2`
  results on a trustworthy clock.
- **Effort.** S.
- **Risk.** Low (measurement-only; gated behind `ds_profiling`, zero prod cost).
- **Format-compat.** SAFE (internal controller channel + IPC; not the public API or AMQP envelopes).
- **Dependencies.** None. **Land before any density bench so every future run has a real denominator.**
  This is the cheapest, most broadly useful item in the roadmap — ship it first, standalone.

### 3.3 — Read-path performance (the unaddressed half) — `read-path` (NEW)

- **Problem.** All 12 proposals target the write path; **the entire query/serve path is unprofiled and
  unproposed**, yet it is what end-users experience and — unlike write-path work — it is **measurable
  TODAY** against the existing chain with synthetic query load. Concrete issues in
  `src/api/routes/v2-history/get_actions/`: `from`/`size` deep pagination (`get_actions.ts:59-60`) is
  O(from+size) on the coordinating node and breaks past `index.max_result_window` (10k) with no
  `search_after`/PIT path; queries fan across all `-action-*` partitions, so cost grows with chain age;
  `track_total_hits` forces expensive exact counts; the `CacheManager` is an unbounded per-process
  in-memory Map with a 5 s sweep, no size cap (memory-leak risk under high-cardinality traffic, no
  cross-worker sharing).
- **Approach.** (a) Add a `search_after`+PIT pagination path for deep scans / `export_actions`,
  keeping `from`/`size` for shallow pages. (b) Make `track_total_hits` opt-in/bounded. (c) Cap the
  `CacheManager` (LRU + max entries/bytes); consider a shared Redis L2 for cross-worker reuse.
  (d) Profile cross-partition fan-out and add a query-side bench harness analogous to `bench.ts`.
- **Expected impact (metric).** p95/p99 query latency for `get_actions`/`get_deltas` at depth, and
  API-worker RSS under sustained high-cardinality load. Measurable now.
- **Effort.** M.
- **Risk.** Medium. `search_after` changes pagination semantics — must be additive (new param) to
  preserve the public API contract; `track_total_hits` changes the `total` field, so gate behind a
  param/default that preserves current responses.
- **Format-compat.** SAFE if additive. No on-disk/AMQP change; response shape preserved by defaulting
  to current behavior and exposing new paths via new params.
- **Dependencies.** None. Highest-ROI user-visible work that needs no dense chain.

### 3.4 — ES write-path settings tuning (refresh / replicas / codec) — `es-bulk-tuning` (Layer A + codec)

- **Problem.** `refresh_interval` is hardcoded `"1s"` for every index (`index-templates.ts:4`),
  including hot action/delta indices. During historical catch-up a 1 s refresh forces ES to cut/merge
  segments ~once/second under firehose load — the textbook #1 bulk-indexing throttle, left at the
  query-latency default. The actions bulk (~194 ms, ~497 µs/doc) is the heaviest single ES write, and
  Phase 2 already proved bigger/smoother bulks help (−72% on `ingestor:3`).
- **Approach.** Mirror the proven dual-mode pattern: during the **batch/catch-up reader only**,
  `PUT {index}/_settings {refresh_interval: -1 (or 30s)}` on action/delta/block, then restore `"1s"`
  + an explicit `_refresh` at the head/live transition. Set `number_of_replicas: 0` during initial
  historical load (Elastic's own guidance). Adopt `zstd_no_dict` codec on **new** time-based
  indices/rollovers (≈30% smaller, neutral-to-positive write throughput; pure storage-layer setting).
- **Critical scoping constraint (confirmed).** With `live_reader: true`, the continuous reader runs
  **concurrently** with historical backfill and writes the same partition family; partition routing is
  block-number-based. So `refresh_interval=-1` on `{chain}-action-*` would silently make fresh LIVE
  blocks unsearchable. **Layer A must be gated to `live_reader=false` (closed historical range) OR
  must never touch the live-head partition.** Boot self-heal must `PUT _settings {refresh_interval:"1s"}`
  across existing concrete partitions *before* launching workers (template changes only affect new
  indices), so a crash with `-1` left over is corrected.
- **Drop from scope.** Synthetic `_source` (format-breaking — see §0) and index sorting (40–50% write
  penalty — directly worsens the metric we want to improve). `Layer B` (decouple bulk size from
  prefetch) is mostly a no-op as written: cargo size and `ch.prefetch` are both `prefetch.index` and
  the happy path acks via `ackAll()`, so raising `es_bulk_size` above prefetch does nothing without
  also raising prefetch (which changes backpressure) — keep only an `es_bulk_max_bytes` early-flush cap.
- **Expected impact (metric).** `ingestor:3/:5 db_indexing` ms/bulk and on-disk store size, on a
  **historical catch-up**. ~1.5–3× bulk throughput on catch-up is the textbook expectation; ≈0
  wall-clock change at current feed-rate-bound test scale.
- **Effort.** M (refresh dual-mode + boot self-heal); codec is S.
- **Risk.** Concentrated in Layer A live-visibility (mitigated by `live_reader=false` gate + boot
  self-heal). Codec is low risk (new segments only).
- **Format-compat.** SAFE. `refresh_interval`/codec are settings only; never touch `_source` bytes,
  mappings, doc shape, or API/AMQP. Codec applies to new indices (no reindex). Behind opt-in flags
  defaulting to current behavior.
- **Dependencies.** Best *validated* on a dense catch-up (§3.1), but refresh/codec are safe to ship
  default-OFF now; only the recommended-default flip is gated on the bench.

### 3.5 — Production observability: scrapeable metrics + alerting — `observability` (NEW)

- **Problem.** Confirmed: **zero** Prometheus/OpenTelemetry/StatsD/`/metrics` anywhere in `src`. The
  only observability is the opt-in dev-only `ds_profiling` IPC (consumed by the `hyp-control` CLI) and
  a single on-demand `v2/health` endpoint. Several proposals add *more* ad-hoc probes through the same
  dev-only path. You cannot tune or react to `ds_threads`/`ds_pool`/fan-out/pruning in production
  without a continuous, always-on metrics feed — and the reports admit the 5 s tick hides the signal.
- **Approach.** Add an always-on, low-overhead `/metrics` (Prometheus exposition) endpoint exporting:
  per-queue depth (already cheaply available via `manager.checkQueueSize`), per-stage throughput
  (blocks/s, traces/s, deltas/s), ES bulk latency EWMA per index, indexing lag (`head_offset`,
  `missing_blocks`), ABI cache hit-rate, and per-worker RSS. Add alerting rules (indexing stall,
  `head_offset` blowout, queue saturation, RSS approaching `--max-old-space-size`).
- **Expected impact (metric).** Operability (MTTR, ability to detect stalls/OOM-approach), and it is
  the substrate that makes every adaptive proposal (§4.3, §5.x) tunable and safe in production. This is
  arguably the single most valuable *missing* capability for a mainnet operator.
- **Effort.** M.
- **Risk.** Low. Always-on metric collection adds a small cost; keep it cheap (counters/gauges, no
  per-message work) and distinct from the dev-only profiler.
- **Format-compat.** SAFE (new read-only endpoint; no on-disk/API-response/AMQP change).
- **Dependencies.** None. Complements §3.2 (dev wall-instrumentation) but is a different, production-grade artifact.

---

## Phase 4 — Mid-term (gated on §3.1 + §3.2; format-safe internal refactors)

Everything here is **gated on the dense benchmark + ms instrumentation**. At test scale these move
nothing and could be misread as regressions inside the ~20% variance band.

### 4.1 — `process_deltas` decode-then-route restructure + per-block type memoization — `delta-batch` (re-scoped)

- **Problem.** `processDeltas` (`deserializer.ts:1646`) is the biggest master CPU cost (0.87 ms/block,
  ~50% of `process_messages_batch`), a sequential per-row loop that native-decodes then `await`s a
  per-table handler for every row. It scales linearly with deltas/block and is the projected first
  bottleneck of a single deserializer at mainnet density.
- **Approach (corrected — drop two of the three original sub-changes).**
  - **DROP sub-change 1 (per-row await elision):** infeasible. All handlers are `async` and the awaits
    drive `preIndexingQueue` (concurrency-1) backpressure — eliding them breaks a hard constraint.
  - **DROP sub-change 3a (retry-condition "fix"):** non-bug. Success paths already `delete row.value`,
    so the `:1335` retry already fires only on genuine failure.
  - **KEEP, as the headline:** per-block, per-`(code,table)` memoization of
    `verifyLocalType`/`getAbiDataType` (an uncached NAPI `get_type_for_table` crossing fired per
    `contract_row` on the warm path). At mainnet density many rows share `code:table`
    (e.g. `eosio.token:accounts`), collapsing repeated NAPI crossings. **Allocate the Map at the top of
    `processDeltas`, populate it lazily inside the `contract_row` pass AFTER the `account` group runs,
    discard at function end** — so an in-block ABI deploy is honored and no stale type is cached.
  - **OPTIONALLY KEEP:** split the loop into a tight synchronous decode pass over a key group, then a
    route pass — the i-cache/decode-all-then-route benefit, **without touching backpressure**, and
    **preserving original row order** so `delta_emit_idx` round-robin assignment stays byte-identical.
  - Extend the same memo to the **DS Pool** `verifyLocalType` (action path is denser than deltas at
    mainnet) — a strictly larger, equally safe instance of the lever.
- **Hard invariant.** `account` deltas (ABI uploads) MUST be processed before `contract_row` of the
  same block. Make the group order **explicit** (process `account` first by name), do not rely on
  object key insertion order. Add a regression fixture: a block with an ABI upload + a `contract_row`
  of the new type in the same block, asserting it deserializes (not auto-blacklisted) and the emitted
  delta doc is byte-identical to pre-refactor.
- **Expected impact (metric).** `process_deltas` ms/block at ≥50 deltas/block on the dense bench.
  Target: 10–20% reduction from memoization on the `contract_row`-heavy path at mainnet density;
  **explicitly ≈ noise at current ~5 deltas/block**. Add `delta_decode`/`delta_route` sub-probes
  *first* to attribute decode vs route vs handler before claiming the win.
- **Effort.** Code change S; the real cost is the gated prerequisites (§3.1, §3.2) and the
  contract-deploy fixture.
- **Risk.** Medium. Worst case is the stale-type-across-in-block-ABI-update hazard (silent
  contract_row data loss on deploy blocks) — fully mitigated by the lazy-after-account population +
  per-block discard + the fixture.
- **Format-compat.** SAFE as a pure internal refactor *iff* row order is preserved on emit and the
  `account`-before-`contract_row` ordering is explicit. Add a golden-output AMQP/`_id` byte-diff test
  for a fixed block range as the format gate.
- **Dependencies.** §3.1 (dense workload), §3.2 (sub-probes + ms wall). Hard-gate acceptance on the bench.

### 4.2 — Multi-worker scaling: measure, then auto-tune (deserializer only) — `multi-worker` (re-scoped)

- **Problem.** `ds_threads>1`, `ds_queues>1`, `ds_pool_size>1` are deferred everywhere and entirely
  unmeasured. The three axes have different mechanics (sharded queues vs competing consumers vs
  private-queue routing) that the docs conflate. The core bottleneck thesis can only be falsified by
  exercising the parallel topology on a dense chain.
- **Approach (sequenced; descope the auto-tuner).**
  - **Phase A (characterization, the deliverable):** with the dense workload, sweep `ds_threads {1,2,4}`,
    `ds_queues {1,2,4}`, `ds_pool_size {1,2,4}` under both routing modes. Produce a scaling-efficiency
    table + contention map + per-pool-worker `process_traces` coefficient-of-variation + `fetch_abi_es`
    cold-start count per worker. **Recommend `ds_queues` (sharded, per-shard FIFO) as the default scale
    axis**; treat `ds_threads>1` as measurement-mostly. **Crucially: measure the ingestor/ES envelope
    in the same matrix** — if ES binds before the master, the whole master-parallelism thesis is moot
    and effort redirects to §3.3/§3.4.
  - **Phase B (auto-tuner, gated on Phase A proving a CPU-bound regime exists):** generalize the
    existing ingestor autoscaler to a **deserializer competing-consumer** scaler only (reuse the proven
    `addWorker`+`launchWorkers` path), gated on `!readingPaused` and `live_mode:'false'`, with
    hysteresis. **Defer `ds_pool` scale-out** — it requires making `ds_pool_size` dynamic across two
    process tiers (`updateWorkerAssignments` iterates a fixed `pool_size`; `routeToPool`'s round-robin
    wrap bound is read per-deserializer) — a materially harder two-tier change.
- **Ordering/correctness caveats (confirmed).** The **live path** also runs `ds_threads` competing
  consumers on `:live_blocks`, so `ds_threads>1` reorders the live path too (fork bookkeeping,
  `lastProducedBlockNum+1` producer-handoff, `included_trx`→Redis API feed, async ABI hot-swap
  rebroadcast = a stale-ABI mis-decode race). Phase A must exercise the **live** reader, not just batch
  replay, and assert byte-identical docs + no divergence in missed-block/tx-cache status vs a
  `ds_threads=1` ground truth. The out-of-order defense for state tables is the `updateByBlock` painless
  guard — name it as a protected invariant and assert no new bare-index path bypasses it.
- **Expected impact (metric).** The scaling-efficiency curve itself (validates/kills the
  `process_deltas`-dominates projection); Phase B target is `:blocks:i` depth held in band by adding
  consumers, only in a regime Phase A proves exists.
- **Effort.** XL (Phase A is L given existing `bench.ts` knobs + per-worker profiling; Phase B adds
  drain/relaunch-suppression surface).
- **Risk.** Engineering medium-high (live ordering, ABI race); strategic high (premature without the
  dense chain). Hard-gate Phase B behind Phase A evidence + ABI pre-warm (§4.4).
- **Format-compat.** SAFE on-disk/API/AMQP (worker count/routing only selects *which* process emits a
  byte-identical doc / *which* internal queue carries it). New config defaults OFF. Not a migration.
- **Dependencies.** §3.1, §3.2, §3.5; §4.4 (ABI pre-warm) is a hard prerequisite for `ds_pool_size>1`.

### 4.3 — Reader-local pacing bound by downstream queue depth — `reader-pacing` (re-scoped)

- **Problem.** The reader fires a 5,000-block range; SHIP delivers in a 50-deep burst the reader acks
  as fast as it can publish; the deserializer queue spikes then idles until the next cargo/10 s monitor
  tick. The only downstream-aware backpressure is the master's coarse 10 s pause/resume, which gates
  *new range requests*, not the in-flight SHIP ack cadence — the structural origin of the idle wall.
  The ack-per-WS-cargo (`state-reader.ts`) IS the true SHIP flow valve.
- **Approach (land Part A only first; drop Part B).**
  - **Part A:** a reader-local governor (revive the dead `startQueueWatcher`) that polls its own
    downstream queue depth via `manager.checkQueueSize` and converts the binary pause/resume into
    proportional ack pacing: below low-water → full speed; in-band → micro-delay before `ackBlockRange`;
    above high-water → defer the ack (hold SHIP, lossless/ordering-preserving). Drive it from a
    standalone `setInterval` (not block-arrival events) with a `max_hold_ms` force-flush — otherwise a
    reader that stops acking stops receiving and can deadlock.
  - **DROP Part B (sliding-window range reassignment)** for now: with `batch_size=5000` and a small
    workload a single reader gets one range spanning the whole run, so reassignment never fires
    mid-run — it solves a problem not present in any measured run and carries the most IPC/teardown risk.
- **Corrected watermark derivation.** Default `low=resume_trigger=5000`/`high=block_queue_limit=10000`
  are sized for the *emergency* backstop and **the queue physically never reaches them** (SHIP window
  is 50; deserializer drains at `prefetch.block`). Derive watermarks from `prefetch.block` and observed
  steady-state depth instead, or the governor is inert.
- **Fail-closed requirement (confirmed hazard).** `checkQueueSize` returns **0 on error**
  (fail-OPEN → would flood downstream when the broker is unhealthy). Hold last-known depth on error and
  escalate toward "treat as high"; never treat an error 0 as empty. Consider changing `checkQueueSize`
  to return `null`/throw so a real 0 is distinguishable.
- **Live reader.** Make it a hard no-op (early-return unless explicitly opted in) — added ack delay at
  the chain head is a direct live-latency regression.
- **Demote the master monitor** to emergency-only (`max_queue_limit`) so the two controllers don't
  oscillate; document that `allowRequests` (range-request gate) and `deferAck` (SHIP stream gate) are
  different levers.
- **Honest measurability flag.** The reports identify reader-side pacing as the #1 logical-path win,
  but at current scale the idle is dominated by startup grace + tick granularity + burst, and the win is
  within tick jitter. **Validate on a dense chain** (or set `batch_size` small to force repeated range
  cycling on the existing small chain). Reframe the success metric away from "close the 85% idle wall"
  toward "reduce the wall gap between consecutive `process_block` timestamps" measured via §3.2.
- **Expected impact (metric).** Wall-clock idle fraction / sustained blocks/s (via §3.2 probe), and
  `process_messages_batch` per-batch fill ↑ / batch count ↓.
- **Effort.** Part A: M.
- **Risk.** Medium. Deadlock via deferred-ack (mitigated: standalone timer + `max_hold_ms`); fail-open
  flood (mitigated: hold-last-depth); two-controller oscillation (mitigated: monitor demotion).
- **Format-compat.** SAFE. Changes only *when* the reader acks SHIP and *when* the master hands the
  next chunk; doc bytes, AMQP envelopes, ordering all preserved. New config defaults OFF.
- **Dependencies.** §3.2 (to even observe the effect). Complements §4.2.

### 4.4 — DS Pool ABI pre-warm at worker startup — `abi-prewarm` (re-scoped + correctness expanded)

- **Problem.** On mainnet (thousands of contracts, `ds_pool_size>1`), each worker starts consuming
  before any contract ABI is warm; the first cargo hits dozens–hundreds of distinct contracts, each
  first-touch serializing a ~9.8 ms `fetch_abi_es` ES round-trip inside the hot `process_traces` loop,
  multiplied across workers and clustered at startup/restart/post-rebalance. Invisible at test scale
  (fired 3×).
- **Approach.** Pre-load the likely-needed ABIs into the abieos context **before** the consumer is
  allowed to dispatch (a gate at the top of `processMessages` that holds messages unacked — preserving
  backpressure/ordering — until pre-warm resolves OR a watchdog timeout fires so a slow/empty ES never
  deadlocks ingestion). Targeting: in `heatmap` mode and on single-worker respawn, use the master's
  populated `globalUsageMap` per `local_id`; on a **full restart** (map empty) or in `round_robin`
  (the default — routing ignores contract code, so no per-worker subset exists), fall back to a single
  **shared, eagerly-memoized** top-K `terms` aggregation over `{chain}-abi-*` (avoid N-way thundering
  herd). Chunk the synchronous `loadAbiHex` loop with `setImmediate` yields; wrap each per-row load in
  its own try/catch; skip contracts already in `getLoadedAbis()`.
- **Corrected claims.** `update_abi` is NOT delivered to ds_pool workers (only deserializer-role), so
  runtime ABI refresh for ds_pool is solely the lazy `verifyLocalType` miss — pre-warm seeds initial
  state only. Default `abi_prewarm_limit` low (e.g. 256) given K × `ds_pool_size` native-heap
  multiplication; log the RSS delta after warm.
- **Expected impact (metric).** `fetch_abi_es` count/latency during the **first N cargo batches** after
  a (re)spawned worker, vs status quo, on the dense bench with `ds_pool_size>1`. Steady-state ≈ unchanged.
- **Effort.** M.
- **Risk.** Medium-low (gate watchdog prevents ingestion hang; targeting cap bounds heap). **The deeper
  risk is correctness — see §5.5; pre-warm at `head` is unsafe for historical reindex.** Pre-warm at the
  worker's **range-start block**, not head.
- **Format-compat.** SAFE. Read-only `{chain}-abi-*`; new IPC is cluster-internal; decoded output
  byte-identical (same `loadAbiHex` path). Default-off.
- **Dependencies.** §3.1, §5.5 (block-accurate ABI resolution). Hard prerequisite for `ds_pool_size>1`
  measurements in §4.2 (otherwise cold-start contaminates the scaling curve).

---

## Phase 5 — Research-heavy / longer-horizon bets (gated; high uncertainty)

### 5.1 — rs-abieos via napi-rs binding — `rs-abieos` (re-framed)

- **Problem & correction.** A *ground-up* Rust serializer rewrite yields ~0% decode-throughput gain
  (abieos is already optimized native; the in-house **rs-abieos** pure-Rust backend is fuzz+parity
  tested and even ~1.3× faster on per-message ops, 3.55× on `abi_bin_to_json`). But the decode layer is
  **<8% of wall and off the critical path**; a 1.3× decode speedup moves ~nothing. The real (and only)
  defensible lever is the **NAPI boundary + double-JSON tax**: every `bin_to_json` returns a C++ JSON
  *string* that JS `JSON.parse`s, then downstream re-`JSON.stringify`s for AMQP/Redis/ES.
- **Approach (two tiers; rename — "rs-abieos" is misleading).**
  - **Tier 1 (no Rust, evidence-gated):** add a profiler probe isolating `JSON.parse` time inside
    `process_deltas`/`abieos_deserialization` first. Only if it exceeds ~10% of the parent on a dense
    chain, add a decode-to-bytes passthrough for rows emitted *unmodified*. **Reality check:** the
    densest tables (`eosio.token:accounts`, all system tables) hit `tableHandlers`/plugin hooks that
    mutate `.data`, so the passthrough only fires on the long-tail generic `index_all_deltas` path —
    measure the real hit-rate before scaling effort. Requires a byte-equality harness (asset precision,
    float, uint64-as-string) as a hard gate, with permanent parse-fallback.
  - **Tier 2 (Rust, only if Tier 1 proves the tax):** prefer **upstreaming `bin_to_buffer` /
    `bin_to_json_batch` into `@eosrio/node-abieos`** (same org) over forking a Rust toolchain — identical
    value, no second native toolchain in the CI matrix. If a Rust core is still wanted, build a
    `napi-rs` binding around the existing rs-abieos crate that is API-compatible with node-abieos
    (`loadAbi/binToJson/hexToJson/jsonToHex/...`), shipped first as a 1:1 drop-in to retire the C++
    toolchain dependency (MSVC-free Windows builds), behind a `deserializer_backend` flag defaulting to
    `node-abieos`.
- **Expected impact (metric).** The `JSON.parse` slice of `process_deltas` (a fraction of the ~30%
  decode portion) on a dense chain. Single-digit-% of `process_deltas` at best for Tier 1; ≈0 at test
  scale. Tier 2's throughput value is the boundary/batch amortization, not the algorithm.
- **Effort.** XL (and mostly toolchain/integration, not algorithm).
- **Risk.** High risk/value if pursued as a rewrite; low-medium for the upstream-feature-request +
  optional passthrough framing. Memory: retaining JSON strings changes GC profile — heap-soak required.
- **Format-compat.** SAFE iff output bytes stay identical (abieos remains decode source of truth);
  passthrough must produce byte-equal `_source`. Numeric representation is the only true hazard.
- **Dependencies.** §3.1, §3.2, the `JSON.parse` probe, and reader-pacing (§4.3) landing first since
  the system must have a steady-state window to measure at all.

### 5.2 — Inter-process transport rethink (worker_threads / SAB) — `transport-rethink`

- **Verdict: DEFER (risky).** The reader→deserializer edge does cross the RabbitMQ broker per block
  (the largest payload), but the reports show the link is **feed-rate bound**; the dominant idle is
  reader burst + cargo flush, which a transport swap does NOT fix. `structuredClone`/`postMessage` is
  provably cheap (<10 KiB risk-free) for Hyperion's small JSON. **CONFIRMED BLOCKER:**
  `@eosrio/node-abieos` is a process-global, unsynchronized C++ singleton — co-locating `ds_threads>1`
  deserializers as worker_threads in one process is a data race inside the native dependency. SPMC
  zero-copy fan-in is also fundamentally SPSC-only (ringbuf.js).
- **If ever pursued:** restrict to SPSC (reader + exactly one deserializer thread), or evaluate a
  cheaper intermediate — swap only the internal reader↔deserializer↔ds_pool hops for native
  unix-socket/pipe IPC with V8 'advanced' serialization (no broker framing, no SAB MPSC complexity),
  strictly as a **major-version migration** that leaves the API-facing `chain:stream`/actions/deltas
  AMQP queues untouched. The durability shift (broker redelivery → SHIP range re-request) is safe in
  principle (idempotent writes) but changes crash failure modes and needs §5.6.
- **Effort.** XL. **Risk.** High. **Format-compat.** API-facing AMQP envelopes must be preserved;
  internal-only is the boundary. **Dependencies.** §3.1, §5.6, and rs-abieos thread-safety (§5.1) is a
  hard prerequisite for any multi-thread variant.

### 5.3 — Adaptive ingestor fan-out keyed by ES saturation — `ingestor-adaptive-fanout`

- **Verdict: DEFER (inert at all measured scales).** Static fan-out REGRESSED (`§10.4`, 25→35 s) by
  splitting bulks; ES is not saturated; the proposed latency gate never crosses at the queue depths the
  system runs at. The control loop ships L-effort stateful machinery whose only honest near-term
  deliverable is read-only telemetry.
- **If pursued:** ship ONLY the always-on `db_indexing` µs/doc EWMA emitter (folds into §3.5) as
  telemetry; make any scale-up an *additive* gate above the existing depth trigger (never a
  replacement); HARD-EXCLUDE scripted-upsert state tables from saturation scale-up (concurrent
  scripted-upserts to shared non-content `_id`s are only safe via the `updateByBlock` guard); use the
  graceful `pauseIndexer` drain (not `kill_worker`) for scale-down; bump `retry_on_conflict` with live
  consumer count. Implement the decision as a pure unit-testable function.
- **Effort.** L. **Risk.** Medium. **Format-compat.** SAFE (reuses the existing competing-consumer
  autoscale topology; `updateByBlock` makes reorder non-corrupting). **Dependencies.** §3.1 must first
  demonstrate a saturation regime exists; §3.5 for the metric.

### 5.4 — Action document slimming — `action-doc-slimming`

- **Verdict: LOW near-term value; the real win is format-breaking.** The doc is already index-lean
  (`act.data`/`signatures`/`auth.permission` are `enabled:false`). Sub-change (1) (trim empties) is
  ~0 (parser + `cleanActionTrace` already strip them). Sub-change (2) is 0-at-rest by default (console
  deleted unless `contract_console=true`) — ship `console:{enabled:false}` + `dynamic:"runtime"` (NOT
  `dynamic:false`) as pure mapping **hardening** (caps worst-case field cost) with no perf claim. The
  real bytes live in `act.data` decoded args — a hex-only/projection representation that requires a
  read-side reconstruction path and an `index_version` migration; **deferred as a major-version effort.**
- **Critical correction.** `dynamic:false` would silently zero-match `@voteproducer.*` and other
  built-in/plugin `extendedActions` query fields that rely on dynamic mapping on new partitions — a
  user-visible API regression. Use `dynamic:"runtime"`.
- **Effort.** S (hardening + an `action_doc_bytes` value-metric probe — note: needs a new
  `recordValue` profiler API, not the duration probe). **Risk.** Low for hardening; high for the
  `_source` change. **Format-compat.** Hardening SAFE (new indices only); synthetic/hex `_source` is a
  reindex + read-path migration. **Dependencies.** §3.1 to confirm the actions tier approaches ES
  saturation before any slimming-for-speed work.

### 5.5 — Block-accurate ABI version resolution on the decode path — `abi-version-correctness` (NEW — correctness, not speed)

- **Problem (the one place the roadmap risks silent on-disk corruption).** abieos holds exactly ONE
  ABI version per contract (`loadAbiHex` overwrites), and `verifyLocalType` (`ds-pool.ts:242`) returns
  the resident type **without checking it matches the action/delta's actual `block_num`**. On
  parallel/historical reindex, a worker warmed at head (or pre-warmed at the wrong block — see §4.4)
  will decode OLDER actions with a NEWER ABI whenever the type name still resolves, silently producing
  wrong `act.data`/delta values with no error. Contract-deploy blocks (account-delta-before-contract_row)
  are the acute case.
- **Approach.** Either (a) re-validate the resident ABI's block range in `verifyLocalType` against the
  message's `block_num` and refetch the block-correct ABI on mismatch (not just on type-absent), or
  (b) gate any head/range pre-warm so cross-version decode is refused for historical ranges and only
  the lazy block-accurate path is used. Add a contract-revision regression fixture: a contract that
  revised an action's struct while keeping the action name, indexed across the revision boundary,
  asserting old blocks decode under the old struct.
- **Expected impact (metric).** Correctness — `0` mis-decoded actions across an ABI-revision reindex
  (verified by the fixture). No throughput metric; this is a data-integrity guarantee.
- **Effort.** M. **Risk.** Medium (touches the hot decode path; must not regress steady-state).
- **Format-compat.** SAFE (produces *more correct* bytes; the contract is "decoded output matches the
  on-chain ABI at that block"). **Dependencies.** Should land *with* or *before* §4.4 and §4.2
  (`ds_pool_size>1` / pre-warm both widen the mis-decode window).

### 5.6 — Crash/fork recovery & end-to-end correctness harness — `recovery-correctness` (NEW)

- **Problem.** Multiple proposals individually *weaken* crash semantics (transport-rethink replaces
  durable AMQP redelivery; batch tx-cache widens the lose-on-crash window; reader-pacing changes ack
  timing; ingestor scale-down can drop unacked cargo). The whole optimization roadmap rests on "SHIP is
  durable + writes are idempotent + `updateByBlock` guards state tables + repair tooling backfills
  gaps", but **none of that is validated under crash/restart at load**, and repair/reindex throughput
  (`repair.ts`, `snapshot.manager.ts`) is unprofiled — yet it gates every "major-version migration"
  escape hatch the proposals lean on.
- **Approach.** Build a chaos/crash-injection harness (extend `bench.ts`): kill master/worker mid-range,
  then assert (a) ES action/block/delta counts and final state-table rows are byte-identical to a clean
  run, (b) the `updateByBlock` stale-write rejection is never bypassed by replayed equal-`block_num`
  rows, (c) `missing_blocks == 0` after repair, (d) recovery time and data-completeness are bounded.
  Separately profile repair/reindex throughput at mainnet doc volume and add a resumability story.
- **Expected impact (metric).** Recovery time, post-crash data-completeness (count + state convergence),
  and repair/reindex throughput (docs/s). The safety net the risky bets assume exists.
- **Effort.** L. **Risk.** Low (test/validation tooling). **Format-compat.** SAFE.
- **Dependencies.** §3.1 (dense workload to exercise meaningful recovery). Prerequisite for accepting
  §4.3, §5.2, §5.3 scale-down, and any `index_version` migration.

### 5.7 — Streaming ws-router scaling & live-path latency — `streaming-scaling` (NEW)

- **Problem.** `socketManager.ts` (774 lines) maintains five nested in-memory subscription maps and,
  on every live block, matches every indexed action/delta against them — an O(subscribers × filters)
  hot loop on the live critical path, with a socket.io Redis adapter for multi-instance fan-out. This
  is the latency-priority half of the dual-mode design, it is the only place indexer latency is
  directly user-visible (real-time subscriptions), it is a memory-growth risk, and **no proposal touches
  it.** Several reader/transport proposals must *exclude* the live path precisely because it is fragile.
- **Approach.** Profile the per-live-block match loop and subscription-map memory under N subscribers;
  index the maps for O(filters) instead of O(subscribers × filters); add per-client subscription caps;
  measure the Redis-adapter fan-out cost across instances.
- **Expected impact (metric).** Live-block push latency (p95) vs subscriber count, and ws-router RSS vs
  subscriber count. **Effort.** M. **Risk.** Medium (touches the live critical path — needs §5.6-style
  correctness checks). **Format-compat.** SAFE (no on-disk/API-response change; subscription protocol
  preserved). **Dependencies.** §3.5 (metrics), §3.1 (live density).

### 5.8 — Memory / RSS / GC behavior under load — `memory-profile` (NEW, cross-cutting)

- **Problem.** RSS is fixed at 1.16 GiB on a 2.4k-block chain; **no proposal studies memory at mainnet
  density or under sustained backpressure**, yet concrete unbounded-growth surfaces exist
  (`revBlockArray`/`reversibleBlockMap`, the ws-router maps, `redisBatchPipeline` accumulator, AMQP
  send-buffer growth under slow ES, `prefetch.block` cargo buffering, the unbounded `CacheManager` Map).
  Several proposals would *worsen* this (SAB ring, larger bulks, per-worker abieos ABI heaps ×
  `ds_pool_size`, pre-warm loading thousands of ABIs per worker). OOM-under-load is a first-order
  production failure mode with zero coverage.
- **Approach.** A heap-soak methodology (RSS vs density vs duration) under sustained backpressure; model
  the K × `ds_pool_size` native-heap cost of pre-warm; bound the obvious unbounded maps (`CacheManager`,
  subscription maps).
- **Expected impact (metric).** Steady-state and peak RSS vs density; OOM headroom.
- **Effort.** M. **Risk.** Low. **Format-compat.** SAFE. **Dependencies.** §3.1, §3.5.

### 5.9 — ClickHouse as a complementary analytics/cold-storage backend — `storage-backend` (DEMOTED)

- **Verdict: DEFER (premature; partially-incorrect as proposed).** XL effort whose own impact section
  admits it "moves no current metric"; the only near-term lever (synthetic `_source`) is format-breaking;
  it misdescribes the ingestor topology (one backend per worker; Mongo never handles actions/deltas);
  it conflates `process_deltas` (master CPU, untouchable by a storage tier) with the ES write tier; and
  `§10.4` already shows ES is not saturated. No proven ClickHouse schema for Antelope action+delta
  history exists — it is greenfield (schema, ordering/backpressure-preserving ingestor, dual-write
  consistency).
- **If pursued:** ONLY as an optional **parallel** ingestor on a **separate** queue/channel that
  best-effort mirrors the AMQP action/delta stream into a `ReplacingMergeTree` keyed on the same
  deterministic identity ES uses (so it never gates the ES ack, and AMQP redelivery doesn't duplicate
  rows), leaving ES authoritative for the public API. Gate the spike on real mainnet profiling proving
  ES storage/aggregation is the actual ceiling.
- **Effort.** XL. **Risk.** High (operational service, dual-write consistency). **Format-compat.** Safe
  only as an additive mirror; ES mappings/API/AMQP untouched. **Dependencies.** §3.1 + a proven
  ES-storage ceiling.

### 5.10 — API/streaming security & resource protection — `api-security` (NEW)

- **Problem.** Performance and security are coupled here: the cheapest way to take down a node is an
  expensive-query or subscription-amplification attack. `get_actions` deep pagination and unbounded
  `export_actions` let an unauthenticated caller force expensive coordinating-node work; the ws-router
  accepts arbitrary filter subscriptions that expand the O(subscribers × filters) live loop with no
  per-client cap; `v1-chain` proxy routes relay to nodeos. No rate-limiting/quota/cost-accounting exists.
- **Approach.** Per-client query cost accounting + rate limits; cap `export_actions` ranges; per-client
  subscription ceilings in the ws-router; adversarial validation of `api.limits.*`.
- **Expected impact (metric).** Node survivability under adversarial query/subscription load.
- **Effort.** M. **Risk.** Low-medium. **Format-compat.** SAFE (additive limits; preserve legitimate
  responses). **Dependencies.** §3.3 (read-path), §5.7 (streaming).

---

## Recommended next experiment batch (do these, in this order)

These are the immediately actionable, low-risk, high-leverage items. The first three unblock everything
else; the next three are measurable TODAY without a dense chain.

1. **`wall-instrumentation` (§3.2) — ship standalone, FIRST.** Master block-span + profiler busy-span,
   `BigInt→Number` at the serialize boundary, CLI renderer skips the reserved key, CI assertion that
   `JSON.stringify(getProfilingReport())` doesn't throw. **S effort, zero prod cost, unblocks all
   future benches.** Then re-tabulate the flagged `§10.5`/`§10.2` results on the new clock.
2. **`mainnet-bench` Tier 1+2 (§3.1) — the gate.** Fan-out contract action + CDT Docker rebuild +
   wharfkit direct-submit generator + bench density/`bound_by` metrics. **L effort.** Nothing in
   Phase 4/5 density tier is acceptable until this exists. Add a Phase-1 assertion: measured deltas/block
   ≥ target before recording any scaling curve.
3. **`observability` (§3.5) — always-on `/metrics` + alerts.** Queue depth, throughput, ES bulk EWMA,
   indexing lag, ABI hit-rate, RSS. **M effort.** The substrate for tuning anything in production.
4. **`read-path` (§3.3) — `search_after`/PIT + bounded `track_total_hits` + capped CacheManager.**
   Measurable now with synthetic query load; the most user-visible win in the roadmap.
5. **`es-bulk-tuning` Layer A + codec (§3.4) — refresh dual-mode (live_reader=false gated) + boot
   self-heal + `zstd_no_dict` on new indices.** Validate the catch-up throughput delta on (2).
6. **`delta_decode`/`delta_route` + `JSON.parse` sub-probes (prereq for §4.1 and §5.1).** Cheap (~1 h
   with §3.2 in place); confirm whether decode or the handler loop or the parse dominates BEFORE
   committing to the memoization or passthrough work. If decode already dominates, the honest call is
   "defer to rs-abieos / ds_threads".

Then, gated on (2): run the §4.2 Phase-A characterization matrix (single-variable sweeps with the
`bound_by` classifier, including the **live** reader for `ds_threads>1`), and only afterward decide
whether §4.1, §4.3, §4.4, §5.1 are worth their effort against measured (not projected) curves.

---

## Instrumentation / observability gaps

The reports and the agenda repeatedly self-gate on the same two missing capabilities. These are the
true blockers; closing them is more valuable than any single optimization.

| Gap | Why it blocks progress | Addressed by |
|---|---|---|
| **ms-resolution master wall time** | Every wall number is 5 s-tick-granular; noise floor (~5 s) exceeds measured effects; "<10 s of 25 s is real" is unprovable | §3.2 (ship first) |
| **Dense/mainnet workload + density metrics** | Linear-scaling projections (`process_deltas` dominates, multi-worker scales, rs-abieos pays off) are unfalsifiable at ~5 deltas/block | §3.1 (the gate) |
| **Per-stage `bound_by` classification** | Can't tell master-bound (signal) from ES-bound (local-infra artifact at `-Xmx2g`); risk of attributing the ceiling wrong | §3.1 Tier 2 |
| **Always-on production metrics + alerting** | No `/metrics` anywhere; can't tune `ds_threads`/`ds_pool`/fan-out/pruning or detect stall/OOM in production | §3.5 |
| **`JSON.parse` isolation inside decode** | rs-abieos/passthrough impact is asserted, never measured; need to know if the boundary tax is >10% of `process_deltas` | §5.1 Tier 1 probe |
| **Read-path latency profiling** | Entire query/serve path unprofiled; deep-pagination/cross-partition fan-out/cache cost unknown | §3.3 |
| **Live-path push-latency + ws-router memory** | The only user-visible latency path is unmeasured; subscription maps are an O(subs×filters) loop + growth risk | §5.7 |
| **Crash/recovery + repair throughput** | The "SHIP durable + idempotent + repair backfills" assumption underpinning every risky bet is unvalidated | §5.6 |
| **RSS vs density / GC under backpressure** | OOM-under-load is a first-order failure mode with zero coverage; several proposals worsen it | §5.8 |
| **ABI-version-at-block decode correctness** | Silent data corruption on historical reindex; widened by pre-warm and multi-worker | §5.5 (correctness probe + fixture) |

### Honest uncertainty statement

- The **direction** of the density bets (`process_deltas` linear scaling, master-vs-ES ceiling) is a
  single-point extrapolation. §3.1 exists precisely to confirm or **falsify** it. It is entirely
  possible the dense bench shows ES binds first, in which case §4.1/§4.2/§5.1 are deprioritized in
  favor of §3.3/§3.4 — and that would be a *successful* outcome of the gate, not a failure.
- The **synthetic** dense chain is a monotone/heterogeneous approximation, not mainnet. Tier-3 SHIP
  replay is the fidelity oracle; until it runs, dense-bench conclusions are "scaling-shape", not
  absolute numbers (the reports' own Windows/Docker caveat applies).
- Several "wins" in the original proposals are **noise at test scale by their authors' own admission.**
  This roadmap deliberately refuses to claim a measured win for any density bet until the gate is in
  place; the only items claimed to move a metric *today* are §3.2 (instrumentation), §3.3 (read-path),
  §3.4 codec/refresh-on-catch-up, and §3.5 (operability).

---

## Appendix — Deterministic benchmark data tooling (added 2026-05-29)

This roadmap names the **dense / mainnet benchmark harness (§3.1)** as the hard prerequisite gate. Part of that gate is now built — a deterministic capture-and-replay path for **real WAX mainnet** SHIP data, a stronger oracle than the synthetic Tier-1 generator and more practical than live Tier-3 replay:

- `tests/e2e/ship-record.ts` — captures a fixed, irreversible SHIP block range into a sharded, gzip-compressed, resumable fixture. Gentle on production nodes (small in-flight window, `--delay-ms` throttle, `--status-only` read-only probe).
- `tests/e2e/mock-ship.ts` — replays a fixture as a local SHIP endpoint (full ABI handshake + `max_messages_in_flight`/ack flow control). **Validated byte-faithful**: re-recording through it reproduces identical block count and block/traces/deltas byte totals.
- `tests/e2e/ship-scout.ts` — adaptive (coarse → zoom → fine) density search that finds dense ranges without scanning the chain; HTTP-only and gentle by default, optional SHIP `--refine`.
- `tests/e2e/lib/ship-replay.ts` — shared codec/manifest. Fixtures live in `tests/e2e/.fixtures/` (gitignored).

**Why this matters for §3.1:** replaying a frozen real-WAX range gives true mainnet density (measured ~40 KB traces/block + ~24 KB deltas/block, vs the test chain's ~5 tiny deltas/block) with full determinism — point `connections.json` at the local mock and the whole pipeline indexes identical bytes every run. The synthetic Tier-1 generator remains valuable as a *controllable* density knob; the WAX replay is the *fidelity* oracle. Use both.

**Minimum meaningful benchmark:** capture **100k–250k** dense blocks; benchmark on **≥50k-block / ≥5-min steady-state slices** after discarding warmup. Size runs by steady-state *duration* (≥5 min) once warm throughput is known — which is exactly why §3.2 wall-instrumentation ships first.

**Initial scout finding:** the densest WAX eras are **historical** (~block 218M and ~194M, ~200 tx/block, ~3× denser than recent traffic), not the last day — confirming a naive "recent range" grab would understate density.

**Status:** capture of the real fixture is pending operator go; the target range will be chosen from `ship-scout` output (optionally `--refine`d with small SHIP probes for exact deltas density).

## Direct-from-disk indexing — the SHIP-bypass direction (prototyped 2026-05-31)

The performance investigation's central finding is that nodeos serializes SHIP on a **single `ship-0` thread** (~5,900 dense blk/s, flat regardless of connections). Every Hyperion indexer is funneled through it. The most radical lever is to **delete that bottleneck**: read the append-only `chain_state_history` / `trace_history` logs **directly off disk, in parallel**, and feed the index — no nodeos, no SHIP, deterministic, resumable. For **batch / backfill / re-index / repair** (not live, where 2 blk/s is trivial), this decouples indexing throughput from `ship-0` entirely.

### What's built
- **[`abi-scanner`](https://github.com/eosrio/abi-scanner)** — the read engine, shipped. Parallel work-stealing chunked reader of the state-history log, checkpoint/resume (stop & continue from any block), streaming early-exit for huge entries, snapshot-init-delta handling, pure-Rust `rs_abieos` decode. It extracts every contract ABI (`setabi`) into the Hyperion `<chain>-abi-v1` shape — i.e. it walks the `account` table, **table 0 of ~19**.
- **`delta-proto`** (prototype, branch `proto/delta-indexer`) — the same engine pointed at the `contract_row` table: decodes each row's `value` against the contract ABI **active at that block** and emits Hyperion `<chain>-delta-v1`-shaped docs. Each `(account, valid_from)` ABI version is parsed once into a standalone `rs_abieos` **`AbiHandle`** (0.6+) and range-queried per row, so the hot path is pure-Rust `decode_table_row_into` into a reused buffer — **zero FFI, no abieos-context `set_abi`/`delete_contract` churn**. (The rs_abieos ergonomics for exactly this task — `AbiHandle`, `decode_table_row_native`, the `*_into` buffer-reuse forms — were added in 0.6.0 and validated against the C++ backend differential.)

### Benchmark — `wax-dense-190m` range (blocks 190,373,745–190,376,745; 3,001 blocks; 1.47M `contract_row` deltas; ~470/block)

| delta-proto (Rust, direct-disk) | Throughput | Peak RSS | Decoded |
|---|---|---|---|
| 1 thread, cold | 421 blk/s | 145 MB | 99.85% |
| 8 threads, cold | 1,228 blk/s | 204 MB | 99.85% |
| 8 threads, warm (decode-bound ceiling) | **~18,600 blk/s** | 218 MB | 99.85% |

> The warm ceiling rose from **13,150 → ~18,600 blk/s (~1.4×)** when the per-row decode moved from the
> abieos-context path (per-row `name_to_string` + `bin_to_json` FFI + `set_abi`/`delete_contract` on
> version change) to the parse-once `rs_abieos` 0.6 `AbiHandle` path (zero FFI). Output is
> **byte-identical** across the two paths (`cmp`: IDENTICAL; 1,469,591 docs). The cold rows are I/O-bound
> on the contended production pool and are unchanged by the decode speedup.

vs **Hyperion baseline, same range:** ~10 blk/s (1 worker) → ~54 blk/s (4 workers), `process_deltas` ≈ 94% of the master batch, Node heap cap **4 GiB**.

**Headline wins (the defensible ones):**
- **Memory: ~145–218 MB, flat regardless of delta volume**, vs Hyperion's GB-scale buffering / 4 GiB cap → **~20–28× less**. This is the win for batch indexing and the "massive-delta" episodes — bounded memory is structural (streaming), not tuned.
- **Decode correctness: 99.85%** using **version-correct** per-block ABIs — *more* correct than the bench's seed-current-ABIs path (which suffered ~9.5k historical-mismatch failures).
- **Throughput:** decode-bound ceiling ~18.6k blk/s (8 threads, `rs_abieos` 0.6 `AbiHandle`); cold-disk on the *contended production* pool is I/O-limited to ~1.2k blk/s at 8 threads — still ~20× the 4-worker SHIP baseline.

**Honest caveats:**
- `delta-proto` decodes **only `contract_row` deltas** — no traces/actions/blocks, no ES `_bulk`, no RabbitMQ/SHIP. Hyperion's numbers are the *full* pipeline, so the throughput comparison is the delta-decode *slice* (which is ~94% of the master cost), not a total-system replacement.
- It's **I/O-bound on cold reads from contended/large storage** (see the WAX node: 3.4 TB log, `recordsize=128K`, shared with production → ~40 MB/s). The 13k decode ceiling needs dedicated/fast storage. Direct-disk removes the `ship-0` ceiling, then you hit decode + ES + storage.
- One thing gets *easier*: the on-disk log is irreversible/canonical → **no fork handling** on backfill.

### Path forward
1. **`trace_history` → actions** (`<chain>-action-v1`) — the biggest, most-queried index; same log framing, but `action_trace` deserialization (needs the SHIP ABI for trace types). Proves the actions slice.
2. **ES `_bulk` sink** — replace NDJSON with batched ES writes; measure the *real* end-to-end ceiling (likely ES-bound, as Hyperion often is).
3. **Productionize** the prototype into the engine (the abi-scanner read core is already shared) behind a backfill mode; bench full-pipeline (deltas+actions+ES) vs Hyperion over the same range, peak-RSS head-to-head (the number this roadmap flagged as never measured).

**Bottom line:** direct-from-disk batch indexing is **structurally memory-bounded** and **decode-throughput-bound rather than SHIP-bound** — exactly the profile you want for re-index/backfill on a chain whose live indexing was never the problem.
