# Hyperion Indexer — Performance Profile (E2E Suite)

**Date:** 2026-05-20
**Version:** Hyperion 4.0.7 (commit `5d2ca86`, dev branch w/ profiling instrumentation)
**Chain:** Spring (Antelope) v1.2.2 — test chain via `tests/e2e/docker-compose.yml`
**Profiling toggle:** `settings.ds_profiling = true`
**Goal:** Identify where time is spent across the deserialization → indexing pipeline.

---

## 1. Test environment

| Component        | Version / Setting                                           |
| ---------------- | ----------------------------------------------------------- |
| Host             | Windows 11 Pro 10.0.29576, Docker Desktop 29.4.0            |
| Indexer image    | Ubuntu 24.04, Node.js 24.15.0 (`tests/e2e/Dockerfile.hyperion`) |
| nodeos (Spring)  | v1.2.2                                                      |
| Elasticsearch    | 9.3.1 (single node, `ES_JAVA_OPTS=-Xms2g -Xmx2g`)           |
| RabbitMQ         | 4.x (management edition)                                    |
| MongoDB          | 8                                                           |
| Redis            | 8                                                           |
| Workers          | 1 master, 1 reader, 1 deserializer, 1 ds_pool, 10 ingestors |
| Scaling          | `readers:1`, `ds_queues:1`, `ds_threads:1`, `ds_pool_size:1`, `indexing_queues:1`, `batch_size:5000` |
| Prefetch         | `read:50`, `block:100`, `index:500`                         |
| Indexer heap cap | `--max-old-space-size=4096`                                 |
| Memory (RSS)     | 1.164 GiB during steady-state                               |

### Workload

The chain was bootstrapped via `bun run tests/e2e/hyp-test.ts deploy -t 100 -c 50`, which produced **173 application transactions**:

- 101 token transfers (`eosio.token::transfer`)
- 50 `hyp.test::storedata` actions
- 20 `hyp.test::increment` actions
- 1 nested inline action (depth 3)
- 1 big-payload action (512 B)
- ~1 duplicate-action transaction

Total chain head at indexing time: **block 2,399** (system contract activation, account creation, ABI uploads, token issuance + the 173 user txs).

---

## 2. Method

Profiling is opt-in via `settings.ds_profiling: true`. When enabled, every worker process measures specific code paths using `process.hrtime.bigint()` via [`src/indexer/helpers/profiler.ts`](../../src/indexer/helpers/profiler.ts). Each worker reports accumulated metrics to the master process via IPC every 5 seconds; the master aggregates them and exposes a snapshot via the existing controller WebSocket on `get_profiling`.

The snapshot was fetched while the indexer container was still running, using:

```
docker exec hyp-test-indexer node /hyperion/build/cli/hyp-control.js stats get-profiling hyp-test
```

Two passes were profiled:

1. **`abi_scan` pass** — `indexer.abi_scan_mode = true`, `auto_mode_switch = true`. Indexer only writes `account` deltas (ABI rows) to ES. DS Pool workers are inactive.
2. **`full` pass** — `abi_scan_mode = false`, ABIs already in ES from pass 1. Full pipeline runs: traces, deltas, actions, blocks all flow through.

### Why metrics nest

```
DS Master   : process_messages_batch ⊃ process_block ⊃ process_deltas
DS Pool     : process_messages_batch ⊃ process_traces ⊃ parse_action ⊃ deserialize_action_data
              deserialize_action_data ⊃ abieos_deserialization (or antelope_deserialization)
              fetch_abi_es  (called from inside verifyLocalType, inside deserialize_action_data)
Ingestor    : db_indexing
```

Child totals are included in parent totals — they're **not additive**. The instrumentation lets us see both the wide envelope (where wall-clock time goes) and the narrow hotspots (which sub-operation is hot).

---

## 3. Headline numbers

| Pass     | Blocks    | Actions | Deltas (ES) | Wall time | Effective rate |
| -------- | --------- | ------- | ----------- | --------- | -------------- |
| abi_scan | 2,247     | 0       | 0 (5 ABIs)  | ~20 s     | ~112 blocks/s  |
| **full** | **2,397** | **2,741** | **11,960** | **20.0 s** | **119.85 blocks/s** |

Indexer self-reported summary (full pass):

```
| Range:        2 >> 2399
| Total time:   19.999 seconds
| Blocks:       2397
| Actions:      2741
| Deltas:       14287   (12% filtered out before ES; 11,960 stored)
| ABIs:         5
```

Container resource snapshot at end of full pass: **CPU 0.85% (sampled idle), RSS 1.16 GiB**.

---

## 4. Full-pipeline pass — raw profile

```
Worker             Metric                       Count   Total ms      Avg
deserializer:2     deserialize_result           2,397    109.54     0.0457
deserializer:2     deserialize_block            2,397     59.14     0.0247
deserializer:2     deserialize_traces           2,397     70.90     0.0296
deserializer:2     deserialize_deltas           2,397    110.75     0.0462
deserializer:2     process_block                2,397    700.96     0.2924
deserializer:2     process_deltas               2,397    577.86     0.2411
deserializer:2     process_messages_batch          98  1,148.07    11.7150

ds_pool_worker:14  parse_action                 3,039    165.34     0.0544
ds_pool_worker:14  deserialize_action_data      3,039    137.57     0.0453
ds_pool_worker:14  abieos_deserialization       3,019     49.06     0.0162
ds_pool_worker:14  fetch_abi_es                     3     29.33     9.7758
ds_pool_worker:14  process_traces               2,627  1,234.26     0.4698
ds_pool_worker:14  process_messages_batch          28  1,335.94    47.7122

ingestor:3 (actions)       db_indexing            7  1,361.66   194.5225
ingestor:4 (blocks)        db_indexing           46  1,043.21    22.6784
ingestor:5 (deltas)        db_indexing           25  1,524.26    60.9705
ingestor:6 (abis)          db_indexing            3     92.60    30.8657
ingestor:8 (state)         db_indexing            5     29.81     5.9621
ingestor:10 (tbl_accounts) db_indexing            3     41.53    13.8419
ingestor:11 (tbl_voters)   db_indexing            2     25.24    12.6189
```

The raw text dump lives at [`reports/profiling-full.txt`](profiling-full.txt). The ABI-scan dump is at [`reports/profiling-abi.txt`](profiling-abi.txt).

---

## 5. Where the time goes

### DS Master (single deserializer worker)

`process_messages_batch` totalled **1,148 ms** across 98 AMQP cargo batches — ~6 % of the 20 s wall clock. Per-block breakdown:

| Step (per block)        | Time (μs) | Share of `process_messages_batch` |
| ----------------------- | --------- | ----------------------------------- |
| deserialize_result      | 45.7      | 9.5 %                               |
| deserialize_block       | 24.7      | 5.1 %                               |
| deserialize_traces      | 29.6      | 6.2 %                               |
| deserialize_deltas      | 46.2      | 9.6 %                               |
| process_block (body)    | 292.4     | 61.1 % ⬅ dominant                   |
| └ of which process_deltas | 241.1   | (50 % of `process_messages_batch`)  |
| Per-batch overhead (residual) | ~78 / batch | — |

**Takeaways:**

- **Delta handling (`process_deltas`) is the single biggest cost on the master** — it eats half of every batch's time. That's expected at this scale because ES 9.x's table-row deltas are the densest payload (11,960 stored vs 2,397 blocks → ~5 deltas/block).
- Pure deserialization (raw native + JS decodes) is cheap: ~146 μs/block, ~30 % of `process_messages_batch`.
- The native `deserialize_block` and `deserialize_traces` paths (via `@eosrio/node-abieos`) are the fastest decoders. The JS `Serializer.decode` paths (`deserialize_result`, `deserialize_deltas`) are ~2× slower per call but still sub-50 μs.

### DS Pool worker (action processing)

`process_messages_batch` totalled **1,336 ms** across 28 AMQP cargo batches — 6.7 % of wall. Per-trace breakdown:

| Step (per trace, 2,627 traces) | Time (μs) | Share of `process_messages_batch` |
| ------------------------------ | --------- | ----------------------------------- |
| parse_action (×1.16 actions/trace) | 63    | 12.4 %                              |
| process_traces (residual)      | 407       | 80.1 % ⬅ dominant                   |
| Per-batch overhead             | ~80 / batch | —                                |

**Takeaways:**

- **Action *deserialization* is not the bottleneck inside the DS Pool.** `parse_action` (which includes filtering, `deserialize_action_data`, extras attachment) costs ~54 μs/action — fast. `abieos_deserialization` itself is only 16 μs/action, confirming that the native path stays cheap as long as ABIs are pre-loaded.
- **The non-decode portion of `process_traces` dominates DS Pool CPU.** Inside `process_traces` (`src/indexer/workers/ds-pool.ts:445`) the work outside `parse_action` is: `cleanActionTrace`, `flatstr(JSON.stringify(...))` per unique action, Redis `hset+expire` per trace, and AMQP publish via `pushToActionsQueue`. Combined: **~407 μs/trace, ~85 % of `process_traces` time**.
- `fetch_abi_es` fired only 3× (×9.8 ms) — ABI hits stayed in the local `abieos` cache after warm-up. Confirms the previously-suspected ES round-trip is a cold-start cost, not a steady-state one.
- The `antelope_deserialization` (JS fallback) probe never fired during this run — `abieos` covered everything.

### Ingestors (Elasticsearch / MongoDB writes)

Total CPU time across all ingestor workers: **4,118 ms** (each in its own process, so they parallelise against the wall clock). The three hot ingestors are:

| Ingestor           | Calls | Total ms | Per-call ms (avg batch size) |
| ------------------ | ----- | -------- | ---------------------------- |
| ingestor:5 deltas  |    25 |    1,524 | 61.0 (≈478 docs/batch)       |
| ingestor:3 actions |     7 |    1,362 | 194.5 (≈391 docs/batch)      |
| ingestor:4 blocks  |    46 |    1,043 |  22.7 (≈52 docs/batch)       |

**Takeaways:**

- The biggest single ES write cost is `ingestor:3` (actions index) at **194 ms per bulk request**. Actions are the largest documents — full trace JSON with hex/JSON params, console output, etc. Reducing per-action payload (already done via `cleanActionTrace`) or raising the cargo size to amortise the round-trip more would help.
- `ingestor:5` (deltas) gets the most documents but the smallest per-call ms because deltas are small flat JSON.
- `ingestor:4` (blocks) fires 46 times because of how the block cargo cycles — high count, low cost.
- The "lightweight" ingestors (ABIs, state, voters, table_accounts) are basically free.

### Summary table — wall-time share

```
process_messages_batch (DS Master, single):    1,148 ms   5.7 %  of 20 s
process_messages_batch (DS Pool, single):      1,336 ms   6.7 %
db_indexing (sum across 7 ingestors):          4,118 ms (parallel, but the longest single one ~1,524 ms = 7.6 %)
─────────────────────────────────────────────────────────
Critical path estimate:                        ~8 s of 20 s wall (rest is reader wait + AMQP transit + cargo flush windows)
```

---

## 6. Bottleneck assessment

1. **No CPU stage is saturated at this load.** Each tier (master, ds_pool, ingestor) consumes <8 % of wall-clock time. The system is sitting idle for >50 % of the run, which is consistent with the **reader→AMQP→deserializer fan-in being single-threaded with batch=5000**: the reader does its full range in one burst, then the cargo back-pressure dictates pacing.

2. **The dominant per-block CPU cost is `process_deltas` at the master.** It accounts for ~82 % of `process_block` and ~50 % of the master's total batch time. This is the work in [`src/indexer/workers/deserializer.ts:1640`](../../src/indexer/workers/deserializer.ts#L1640) — iterating delta rows, native-decoding each one, and routing to per-table handlers. The cost grows linearly with `deltas/block`. At larger scale (mainnet-equivalent: ~50–100 deltas/block), this stage will be the first to bottleneck a single deserializer.

3. **The dominant per-trace CPU cost is the non-decode portion of `process_traces`.** Concretely: `flatstr(JSON.stringify(uniqueAction))` per emitted action + Redis tx-cache write per trace + AMQP publish. Each contributes meaningfully:
   - `JSON.stringify` over the full action trace (including args, return value, receipts) is allocation-heavy.
   - Redis `hset+expire` is two round-trips per trace.
   - `pushToActionsQueue` enqueues into ioredis's send buffer.

4. **Actions index writes are the heaviest ES round-trip.** 194 ms per bulk at ~391 docs/batch = ~497 μs/doc. The action docs are large (signatures, raw data, decoded args).

5. **ABI lookups are warm-cache cheap.** Only 3 `fetch_abi_es` calls in the whole run. The instrumentation will catch any future regression where ABI cache misses go up.

6. **The `process_traces` parent envelope is currently ~80 % "other" code, not deserialization.** This is the highest-leverage area to optimise on the DS Pool side — every 100 μs shaved per trace saves 0.5 % of the wall clock at this load and scales 1:1 with action volume.

---

## 7. Findings the new instrumentation enabled

The probes added in this branch (vs the previous agent's pass) gave us:

- **`process_messages_batch` (both workers)** — top-of-stack envelope. Reveals the gap between deserialization CPU and wall time (where backpressure / idle lives).
- **`parse_action`** — distinguishes per-action wrapper cost from raw decode. Showed that the *wrapper* is tiny (54 μs) vs the *inner native decode* (16 μs) — most of `parse_action`'s 54 μs is the filter checks + setting fields + `extendFirstAction`.
- **`deserialize_action_data`** — captures the full data-decoding subtree (native + retries + extras). Showed that the retry path was cold (no retries triggered here), so all 137 ms came from the happy path.
- **`fetch_abi_es`** — separates IO from CPU. Confirms the previously-suspected ES lookup is *not* in the steady-state hot path.

Without `process_messages_batch` we'd have only seen the inner stages and missed that, even though each stage looks fast individually, the master pipeline is bound by its single thread + batch cadence, not by raw decode CPU.

---

## 8. Caveats

- **Single-block-worker scaling.** All numbers above are from a 1-reader / 1-deserializer / 1-ds_pool topology. At production scaling with `ds_threads > 1` and `ds_pool_size > 1`, the per-worker CPU breakdown stays the same but the wall-time share of each tier will change (parallel workers reduce the master's effective wall-time share, but `process_traces` "other" cost still grows linearly with action count).
- **Small chain, small payloads.** 2,397 blocks averaging ~5 deltas and ~1.1 actions per block is well below mainnet density. Mainnet WAX/EOS chains see ~50–100 deltas and 5–20 actions per block. Expect `process_deltas` and `process_traces` to dominate even more there.
- **Windows host + Docker Desktop.** Some IO behaviour (bind-mount perf, network) differs from a Linux production host. Don't read absolute numbers as production targets — read the **relative breakdown between stages** as the actionable signal.
- **The `tests/e2e/` deploy/load scripts needed a Windows shell-escape fix** (`bash -lc` wrapper around cleos) to even produce the workload. Documented in [`tests/e2e/lib/contract-deployer.ts`](../lib/contract-deployer.ts) and [`tests/e2e/lib/load-generator.ts`](../lib/load-generator.ts).
- **The collector script** [`tests/e2e/profile-collect.ts`](../profile-collect.ts) drives the two-phase profiling pass. It is run-twice-by-design: first with `abi_scan_mode=true` to seed ABIs, then `false` for the full pipeline.

---

## 9. Suggested next experiments (not in scope here)

These were noted but not run:

- **Scale up `ds_threads` and `ds_pool_size`** and re-run profiling — the new probes will show whether the DS Pool's "other" trace work parallelises cleanly or hits Redis/AMQP contention.
- **Disable `tx_cache` in `api.disable_tx_cache`** for one run — measures Redis cost. If `process_traces` drops by 200–400 ms, Redis tx caching is a meaningful share.
- **Replace `flatstr(JSON.stringify(action))` with a direct `JSON.stringify`** — `flatstr` was added to pre-flatten ropes for V8; on Node 24 with current V8 this may no longer be useful and the wrapper costs a function call per action.
- **Run with a real mainnet block range** (e.g. WAX blocks 50M+) — confirm `process_deltas` becomes the headline cost as predicted.

---

## 10. Reproducing the profile

```bash
# Pre-reqs: Docker Desktop, Bun, Node, project built (`npm run build`).

# 1. Bring up infra
cd tests/e2e
docker compose up -d

# 2. Deploy contracts + generate load
cd ../..
bun run tests/e2e/hyp-test.ts deploy -t 100 -c 50

# 3. Profile ABI scan pass (seeds ABIs)
bun run tests/e2e/profile-collect.ts abi
#    → reports/profiling-abi.{txt,json,log}

# 4. Profile full pipeline pass
bun run tests/e2e/profile-collect.ts full
#    → reports/profiling-full.{txt,json,log}
```

The text dump can also be regenerated at any time the indexer is alive via:

```bash
docker exec hyp-test-indexer node /hyperion/build/cli/hyp-control.js stats get-profiling hyp-test
```

(set `MSYS_NO_PATHCONV=1` if running from a Windows Git Bash shell so `/hyperion/...` isn't path-translated).

---

## Appendix A — Files added/changed for this run

Profiling instrumentation:
- [`src/indexer/helpers/profiler.ts`](../../src/indexer/helpers/profiler.ts) — `WorkerProfiler` class (IPC reporter + `start()`/`profile()` API)
- Probe insertions across:
  - [`src/indexer/modules/parsers/3.2-parser.ts`](../../src/indexer/modules/parsers/3.2-parser.ts) — `deserialize_*`, `process_block`, `parse_action`
  - [`src/indexer/modules/parsers/base-parser.ts`](../../src/indexer/modules/parsers/base-parser.ts) — `deserialize_action_data`
  - [`src/indexer/workers/deserializer.ts`](../../src/indexer/workers/deserializer.ts) — `process_messages_batch`, `process_deltas`
  - [`src/indexer/workers/ds-pool.ts`](../../src/indexer/workers/ds-pool.ts) — `process_messages_batch`, `process_traces`, `abieos_deserialization`, `antelope_deserialization`, `fetch_abi_es`
  - [`src/indexer/workers/indexer.ts`](../../src/indexer/workers/indexer.ts) — `db_indexing`
- IPC plumbing: [`src/indexer/modules/master.ts`](../../src/indexer/modules/master.ts), [`src/indexer/modules/controller.ts`](../../src/indexer/modules/controller.ts)
- Controller client + CLI: [`src/cli/controller-client/controller.client.ts`](../../src/cli/controller-client/controller.client.ts), [`src/cli/stats.control.ts`](../../src/cli/stats.control.ts), [`src/cli/hyp-control.ts`](../../src/cli/hyp-control.ts)

E2E suite fixes:
- [`tests/e2e/lib/contract-deployer.ts`](../lib/contract-deployer.ts) — `cleos()` wrapped in `bash -lc` so Linux sh parses single-quoted JSON args (Windows cmd.exe was stripping them, causing `Error 3100010: Unexpected char '39'`).
- [`tests/e2e/lib/load-generator.ts`](../lib/load-generator.ts) — same `bash -lc` fix.
- [`tests/e2e/lib/indexer-runner.ts`](../lib/indexer-runner.ts) — flipped `ds_profiling` to `true` so the generated config enables profiling.
- [`tests/e2e/profile-collect.ts`](../profile-collect.ts) (new) — drives the two-phase profiling pass and snapshots the report.
