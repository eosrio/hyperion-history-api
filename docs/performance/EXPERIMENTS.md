# Hyperion Indexer — Optimization Experiments

**Date:** 2026-05-20
**Goal:** push the indexer toward DB-bound state without touching the deserializer (rs-abieos rewrite is a future phase) and without breaking on-disk data formats.

## Workload (same for every experiment)

- 2,398 blocks (range 2 → 2,400)
- 2,742 actions
- 14,293 deltas (11,965 stored after filtering)
- 5 ABIs
- Single-worker topology: 1 reader / 1 deserializer / 1 ds_pool / 7+ ingestors
- `prefetch.block=100`, `batch_size=5000`, `prefetch.index=500`
- Local Docker Desktop / Windows

## Baseline (current main code)

| Metric | Count | Total ms | Avg ms/call |
|---|---|---|---|
| DS Pool `process_messages_batch` | 28-34 | **1,221 - 1,460** | 35-52 |
| DS Pool `process_traces` | 2,628 | **1,126 - 1,340** | 0.43 - 0.51 |
| DS Pool `parse_action` | 3,040 | 115 - 149 | 0.04 - 0.05 |
| DS Master `process_messages_batch` | 82-92 | 1,100 - 1,304 | 12-14 |
| DS Master `process_block` | 2,398 | 655 - 773 | 0.27 - 0.32 |
| ingestor:3 (actions) `db_indexing` | 7-20 | 1,361 - 1,417 | 71-235 |

Two baseline runs showed ~20% run-to-run variance, driven mostly by cargo-batch sizing at the AMQP layer.

---

## Experiments

Conducted in order. Each builds on the previous (no reverts).

### Experiment 1 — Per-trace Redis pipeline ✅

[ds-pool.ts:549](../../src/indexer/workers/ds-pool.ts#L549) was doing two awaited Redis round-trips per transaction:

```ts
await this.ioRedisClient.hset('trx_' + trx_data.trx_id, redisPayload);
await this.ioRedisClient.expire('trx_' + trx_data.trx_id, this.txCacheExpiration);
```

Combined into one pipeline:

```ts
await this.ioRedisClient.pipeline()
    .hset('trx_' + trx_data.trx_id, redisPayload)
    .expire('trx_' + trx_data.trx_id, this.txCacheExpiration)
    .exec();
```

**Result (2 runs):**

| Metric | Baseline | Per-trace pipeline | Δ |
|---|---|---|---|
| `process_traces` | 1,126 - 1,340 ms | **598 - 754 ms** | **−45 %** |
| `process_messages_batch` (DS Pool) | 1,221 - 1,460 ms | 659 - 827 ms | −44 % |

Halving the network round-trips halved the DS Pool's CPU envelope. Zero on-disk format change — same Redis key, same `redisPayload` value, same TTL.

### Experiment 2 — Batch-level Redis pipeline ✅ ⭐

Instead of one pipeline per trace, accumulate all `hset+expire` operations across an entire AMQP cargo batch and `.exec()` them once at the end of `processMessages`.

Code:
- Added two class fields `redisBatchPipeline` and `redisBatchHasOps` on `DSPoolWorker`.
- `processMessages` allocates a fresh `ioRedisClient.pipeline()` at the start of every batch and flushes it after the message loop.
- `processTraces` now appends operations onto the batch pipeline instead of doing its own round-trip.
- New profiler probe `redis_batch_exec` measures the single flush.

```ts
this.redisBatchPipeline
    .hset('trx_' + trx_data.trx_id, redisPayload)
    .expire('trx_' + trx_data.trx_id, this.txCacheExpiration);
```

…then in `processMessages`, once after the for-loop:

```ts
if (this.redisBatchPipeline && this.redisBatchHasOps) {
    await this.redisBatchPipeline.exec();
}
```

**Result (4 runs incl. final-1, final-2, redis-batch-1, redis-batch-2):**

| Metric | Baseline | Batch pipeline | Δ |
|---|---|---|---|
| `process_traces` | 1,126 - 1,340 ms | **114 - 137 ms** | **−90 %** |
| `process_traces` avg/call | 0.43 - 0.51 ms | **0.04 - 0.05 ms** | **−90 %** |
| `process_messages_batch` (DS Pool) | 1,221 - 1,460 ms | 241 - 333 ms | **−79 %** |
| `redis_batch_exec` | n/a | 67 - 116 ms (52-173 calls) | new |
| Knock-on: `parse_action` | 115 - 149 ms | 77 - 89 ms | −38 % |
| Knock-on: `abieos_deserialization` | 44 - 49 ms | 18 - 23 ms | −53 % |
| Knock-on: `deserialize_action_data` | 124 - 138 ms | 71 - 79 ms | −43 % |
| Knock-on: ingestor:3 `db_indexing` | 1,361 - 1,417 ms | 480 - 533 ms | −63 % |
| Knock-on: ingestor:5 `db_indexing` | 1,443 - 1,555 ms | 703 - 1,113 ms | −37 % |
| Knock-on: DS Master `process_block` | 655 - 773 ms | 567 - 642 ms | −18 % |

The DS Pool's CPU envelope shrinks **5–6×**. Everything downstream (and surprisingly upstream — the master deserializer) speeds up too: less awaited-Redis blocking → tighter inner loop → fewer context switches → smoother cargo cadence → ingestors get more uniform batch sizes → faster ES writes.

**Format / contract impact:** None.
- Redis key/value format unchanged (same `trx_<id>` hash with `global_sequence → action_buffer` entries, same TTL).
- The only behavioural change is *when* writes hit Redis: previously immediately per-trace, now once per cargo batch (worst case ~prefetch.block transactions delayed, typically <300 ms).
- If the worker dies mid-batch, the tx-cache entries for that batch are lost (previously they were lost from the in-flight trace onward — same direction, slightly wider window).  Tx cache is best-effort and the API falls back to ES on cache miss, so no behavioural regression visible to consumers.

### Experiment 3 — Drop `flatstr` wrapper ✅ (cleanup)

`flatstr` was historically used to coerce V8 cons-strings into flat strings before passing them to `Buffer.from`. On Node 24 (V8 ≥ 12), `JSON.stringify` already produces a flat string. Removing the call:

[ds-pool.ts:561](../../src/indexer/workers/ds-pool.ts#L561):
```ts
// before
const payload = Buffer.from(flatstr(JSON.stringify(uniqueAction)));
// after
const payload = Buffer.from(JSON.stringify(uniqueAction));
```

[deserializer.ts:51-58](../../src/indexer/workers/deserializer.ts#L51) — kept the `bufferFromJson` signature for API compatibility but ignored the `_useFlatstr` parameter. Removed the `import flatstr from 'flatstr'` line in both files.

**Result:** Within noise (±10 ms on `process_traces`). The dep is now unreferenced — a future cleanup can drop it from `package.json`. Kept the change because it removes a no-op wrapper, not because it's a measurable perf win at this scale.

### Experiment 4 — DS Pool ABI pre-warm — DEFERRED

At our test scale `fetch_abi_es` fired 3 times across the whole run (~25 ms total). Pre-warming would save those 25 ms — irrelevant at 1 ds_pool worker with 5 ABIs.

Real value on mainnet: with thousands of contracts and `ds_pool_size > 1`, every new worker pays the synchronous ES lookup on first encounter with each contract. Pre-loading all known ABIs from `<chain>-abi-v1` at worker startup eliminates the cold-start stall class entirely.

Skipped because the benefit is invisible at our test scale; revisit once we re-profile against a denser chain or scale out `ds_pool_size`.

---

## Combined result vs baseline

Picking the median of stable runs:

| Stage | Baseline median | After Exp 1+2+3 | Δ |
|---|---|---|---|
| DS Pool `process_messages_batch` | ~1,340 ms (6.7 % of wall) | ~290 ms (1.5 % of wall) | **−78 %** |
| DS Pool `process_traces` | ~1,233 ms | ~125 ms | **−90 %** |
| DS Master `process_messages_batch` | ~1,200 ms | ~1,000 ms | **−17 %** |
| Sum `db_indexing` | ~4,100 ms | ~3,000 ms | **−27 %** |
| Wall time (indexer-reported, 5 s ticks) | 20–25 s | 15–20 s | indicative only |

## Where the new bottleneck is

After these changes the DS Pool envelope is ~290 ms vs 20 s of wall — DS Pool is no longer on the critical path. Master + db_indexing now share that space:

- DS Master `process_messages_batch`: ~1,000 ms ≈ 5 % of wall
- Sum of `db_indexing` (parallel): ~3,000 ms; longest single ingestor ≈ 1,100 ms ≈ 5 % of wall
- **Still ~85 % of the wall is idle / queueing / cargo flush**

So the next-largest opportunities are still pipeline/feed-rate fixes (covered in the previous performance report's section "Logical-path wins"):

1. **Reader-side pacing** so blocks arrive continuously rather than in bursts (`prefetch.block` tuning, reader read-ahead bound by queue depth, not by `batch_size`).
2. **Coalesce per-action AMQP publishes** in the DS Pool (the inner `pushToActionsQueue` is per-action — we can buffer per cargo batch). The new `redis_batch_exec` shape is a model for this.
3. **Ingestor fan-out** (`indexing_queues > 1`) once the master feeds them fast enough to saturate.

These three together should be the next experiment batch; with #1 done we expect to start brushing against the **actual** ES bulk-write limits (= DB-bound, per the goal).

---

## Files changed

- [src/indexer/workers/ds-pool.ts](../../src/indexer/workers/ds-pool.ts) — batch-level Redis pipeline; removed `flatstr` import + call
- [src/indexer/workers/deserializer.ts](../../src/indexer/workers/deserializer.ts) — `bufferFromJson` no longer calls `flatstr`; removed import
- [src/indexer/helpers/profiler.ts](../../src/indexer/helpers/profiler.ts) — flush interval 5 s → 1 s for finer measurement during bench runs (no functional change; opt-in via `ds_profiling`)
- [tests/e2e/bench.ts](../bench.ts) — driver for the experiments above
- [tests/e2e/lib/indexer-runner.ts](../lib/indexer-runner.ts) — `ds_profiling: true` by default in e2e configs

## Reproducing

```bash
cd hyperion-history-api
npm run build
bun run tests/e2e/bench.ts <label>
# → reports/bench-<label>.{txt,json,log}
```

Configs `tests/e2e/.run/config/chains/hyp-test.config.json` are patched per-run by the driver (`start_on=2`, `stop_on=2400`, `abi_scan_mode=false`). The hyp-test-abi-v1 ES index must be pre-seeded (run `bun run tests/e2e/profile-collect.ts abi` once if dropped).

## Safety / compatibility audit

| Change | On-disk format change? | API/contract change? |
|---|---|---|
| Per-trace Redis pipeline | No | No |
| Batch-level Redis pipeline | No (same key/value/TTL) | Tx cache visibility delayed by up to one cargo batch in batch-indexing mode (`auto`/`batch`). `sync` mode preserves per-trace visibility. |
| `flatstr` removal | No (output bytes identical) | No |
| Profiler interval 5 s → 1 s | No | No — profiling is opt-in via `ds_profiling: true`; production stays default-off |

None of the changes touch ES mappings, MongoDB documents, public API responses, or AMQP message envelopes that the API layer consumes.

---

## Dual-mode operation: batch indexing vs live indexing

Hyperion has two operational modes with different cache-visibility needs, and the tx-cache flush strategy now adapts to both automatically:

| Mode | What's running | Priority | Optimal flush strategy |
|---|---|---|---|
| Batch indexing | Parallel reader catching up from a historical block | Throughput | Batch flush at end of cargo |
| Live indexing | Continuous reader at the chain head; API serving live `get_transaction(id)` calls | Latency | Per-trace flush so cache hits don't miss for transactions submitted moments earlier |

The master already tags each AMQP trace message with `live = 'true' | 'false'` based on which reader produced it. The DS Pool reads that flag and picks the right strategy per-trace — no mode switch needed at runtime.

### `api.tx_cache_mode` knob

For operators who want explicit control:

```jsonc
{
  "api": {
    "tx_cache_mode": "auto"   // default — per-trace flush for live, batch for historical
    //  | "sync"               // always per-trace; lowest cache latency, safest on failure
    //  | "batch"              // always end-of-cargo; highest throughput
  }
}
```

### Resilience comparison

| Failure | `auto`/`batch` mode (during batch indexing) | `auto`/`sync` mode (during live indexing) |
|---|---|---|
| Redis flap | Up to one cargo's cache entries lost | Up to 1 trace's cache entry lost |
| Worker crash | Up to one cargo's cache entries lost (acked AMQP but unflushed pipeline) | Up to 1 trace's cache entry lost |
| processTraces throws | **Mitigated** by defensive `try/finally`: completed traces in the partial batch still flush | Same — completed traces already flushed |

The defensive `try/finally` around the inner for-loop ensures that even when a later trace in the cargo fails to deserialize, the previously-completed traces' cache writes still attempt to flush. Worst case the flush itself errors; we log it and the API falls back to ES for those transactions.

### Measured impact of each mode

| Mode | `process_traces` total | `process_traces` avg/call | `redis_*_flush` count | Notes |
|---|---|---|---|---|
| baseline (no opt) | 1,233 ms | 0.47 ms | n/a | original code |
| `sync` (forced) | 838 ms | 0.32 ms | 2,628 per-trace flushes | safest; **30 % faster than baseline** thanks to merging HSET+EXPIRE into a single round-trip |
| `auto` during batch indexing | 200–213 ms | 0.08 ms | 0 live flushes, ~56 batch flushes | what runs by default when catching up |
| `batch` (forced) | 200 ms | 0.08 ms | 56 batch flushes | identical to `auto` here because the test workload has no live traces |
| `auto` during live indexing | — | — | per-trace flush for live + end-of-batch for any historical mixed in | not measured in this bench (live workload not generated) |

So the spread between the safest (`sync`, 838 ms) and most aggressive (`batch`, 200 ms) is **~4×** on `process_traces`. `auto` gives you the safer of the two whenever it matters and the faster one whenever it doesn't, automatically.

### How to verify

```bash
# Default (auto-detect by live flag):
bun run tests/e2e/bench.ts auto-1

# Force per-trace flush (live-indexing semantics):
TX_CACHE_MODE=sync bun run tests/e2e/bench.ts sync-1

# Force end-of-cargo flush (max throughput):
TX_CACHE_MODE=batch bun run tests/e2e/bench.ts batch-1
```

`bench.ts` reads `process.env.TX_CACHE_MODE` and patches it into the generated `chains/hyp-test.config.json` for the run.
