# Bounded native worker stage timing

[#362](https://github.com/eosrio/hyperion-history-api/issues/362) adds private,
observation-only timing for the original Wire/MongoDB replay. Ordinary execution
and the native qualifier without the new flag install no stage wrappers.
Public admission, queues, credits, resources, dependencies, proof limits,
timeouts, source bytes and output assertions are unchanged.

The original BDB run at `bdbd9dd84bcf6c04d4a589abfa8896c96d064282` passed the
1244 prefix but failed cursor target 1308: source and healthy MongoDB reached
1292, and the paused reader's DS queue drained 90 to 50 without reaching resume
8. The pool kept ACKing original work. Its existing batch, trace and canonical
opening timers overlap; this does not establish a stationary deadlock, a CPU
bottleneck or an optimization benefit. The unchanged full 1480 oracle remains
required. The separate original Windows lifecycle-child timeout remains open;
these focused controls do not dismiss it or extend its 30-second deadline.

## Explicit activation

Only the existing guarded native source-bounded RPC case accepts the flag:

```sh
node --experimental-strip-types scripts/qualification/portable-state-worker.ts STATE PLAN NEW_OUTPUT --native --authority-rpc ORIGIN --stage-timing
node --experimental-strip-types scripts/qualification/portable-state-worker.ts STATE PLAN NEW_OUTPUT --native --authority-rpc ORIGIN --profile --stage-timing
```

It cannot combine with an added worker/master/reader/broker recovery case.
The original block-1244 Mongo fault and invalid projection remain part of this
unchanged replay. Ambient qualification variables are sanitized; only the
explicit option supplies `HYPERION_PORTABLE_NATIVE_STAGE_TIMING=1` to the guarded
native preload. `report.stageTiming` identifies the selected observation mode.
Root owns server execution and comparison with matching plain/profile runs.

## What is observed

The preload wraps a fixed inventory of existing emitted methods. Production
source is unchanged. `observer_metrics.stageTimings` in each `native-<pid>.jsonl`
contains completed/failed/cancelled/active counts, nanosecond wall-time
histograms, active operations and the bounded tail of settled records.

| Stages | Original operations |
|---|---|
| Attempt admission, run, root, drain, bind, fresh-write observation, end | Actual accepted registration promise, root promise, bounded physical drainage and original managed IPC requests |
| Native opening, retained inventory, issued revalidation | Existing paired or standalone open, whole-source verification and original retained selection reads; the input records whether the opening is paired |
| Canonical opening and opening recheck | Original canonical walk and the final paired opening revalidation, retaining the eight-opening and 256 ancestry guards |
| Action admission and trace | Original source/producer/target admission and trace processing, including its existing confirm-and-drain wait |
| Seal, native/ownership revalidation, Redis flush | Existing finalization operations in their original order |
| Confirmed handoff/disposition preparation and persistence | Actual original store calls, without asserting durability or completion from a timing label |

Records identify original attempt ID, role, managed/local mode, physical receipt,
payload/header hashes, channels/queue, available source binding and trace ordinal.
Opening inputs remain explicitly labeled inputs; they do not become certified
source binding. Missing identity is `null` or explicitly unavailable. Labels,
descriptions, timing outcomes and copied records grant no processing, ACK, drain,
source, capacity or completion authority.

All stage histograms are **nested awaited wall times**. They overlap and cannot
be added as CPU time or subtracted as a proven exclusive breakdown. Histograms
use fixed logarithmic buckets, not exact percentiles. Runtime PID, executable,
Node version, role, process CPU counters and memory are sampled with the summary.
The existing per-process observer time series, CPU profiles when selected, and
write/fsync overhead accounting remain separate evidence.

## Bounds and original semantics

Per process: 250,000 starts, 128 active records, 64 settled tail records, 2 KiB
per identity record and 512 KiB per snapshot. The stage inventory and 64-bucket
histograms are fixed. Counters saturate safely. Exhaustion omits observations,
increments explicit omission counts and continues the original operation;
missing/unsettled work cannot silently become a completed measurement.

Each wrapper returns the exact original promise, opaque result or thrown error.
It adds a side reaction to native promises; it does not await a replacement,
resolve an opaque value again, inspect a `then` getter, race cancellation, retry,
release a held callback or change arguments. Cancellation counts require an
actual error owned by that attempt's scope. Ordinary/foreign failures remain
failed even if the scope is aborted; codes are labels only. A normal drain's
scope fence does not turn a returned operation into cancellation.

An observed method can reject while its underlying owned I/O remains pending.
Its timing settlement is therefore distinct from the original physical drain
and accepted end. Active drain records and the existing proof late-I/O evidence
retain that distinction. Snapshot/identity failures remain explicit diagnostics;
the guarded qualifier rejects failed observer accounting.

## Focused controls

```sh
bun check -p tsconfig.json
bun check -p scripts/qualification/tsconfig.json
npm run build
node --test tests/native/portable-worker-proof-metrics.test.mjs tests/native/portable-native-stage-timing.test.mjs
```

Run the final command on actual Node 24 and 26 executables. The new controls use
emitted original Wire MainDS/DS callbacks and managed IPC with controlled storage
and broker transport. They independently hold confirm, drain, handoff write,
retained operation, end and cancelled-open gates, require no premature ACK/end,
and release only the original callbacks. They also check opaque result and exact
error preservation, disabled installation and observation saturation. The actual
guarded preload is checked both with and without the new flag.

These checks establish instrumentation behavior. They do not qualify the full
worker replay, live broker/storage behavior, Windows lifecycle timeout, capacity,
fork recovery or the Hyperion 4.5 release.
