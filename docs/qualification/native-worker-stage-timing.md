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
| Attempt admission, root, drain, bind, fresh-write observation, end | Actual accepted registration promise, root promise, bounded physical drainage and original managed IPC requests; generic `attempt.run` settlement is explicitly unobservable |
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

The probe uses only the finite policies audited below. It does not inspect a
`then` getter on an opaque result, race cancellation, retry, release a held
callback or change arguments. Cancellation counts require an
actual error owned by that attempt's scope. Ordinary/foreign failures remain
failed even if the scope is aborted; codes are labels only. A normal drain's
scope fence does not turn a returned operation into cancellation.

An observed method can reject while its underlying owned I/O remains pending.
Its timing settlement is therefore distinct from the original physical drain
and accepted end. Active drain records and the existing proof late-I/O evidence
retain that distinction. Snapshot/identity failures remain explicit diagnostics;
the guarded qualifier rejects failed observer accounting.

### Finite promise and return audit

The original `7ded9d47` probe returned original promises after attaching a
fulfilling error reaction. That reaction suppressed otherwise unhandled
rejections. Its artifacts remain rejected evidence; a timing label cannot
excuse a worker fatal error. There are three distinct policies:

| Original boundary | Observation policy and source evidence |
|---|---|
| `WorkerAttemptClient.capture` admission | `worker-attempt-client.ts` attaches `void record.accepted.catch(() => {})` before returning its handle. Observe that already-handled shared promise with a nonthrowing side reaction; neither replace it nor create a detached rejected promise. |
| `ProofConsumerScope.run` root | `proof-consumer-scope.ts` stores the root and attaches `void root.catch(() => {})` before invoking the operation. Keep that exact shared promise and its existing handling, including arbitrary opaque values. |
| `WorkerAttemptClient.run` | The generic root result is arbitrary caller data. Return the original promise without a reaction. Record one `unobservable` boundary with `elapsedNs: null`, remove its diagnostic active slot, and add no completed/failed/cancelled/wall sample. A child's `settledAfterParent` is `null` when its parent settlement is unobservable. Root, physical drain and managed end remain separate observations. |
| `boundedDrain`, `bind`, `observeFreshActionWrite`, end `request` | Original callers await or return these results; none uses promise identity as a key, ownership token or equality guard. Returns are void/boolean or the validated JSON end response. Return a diagnostic reaction promise, forwarding the identical value or throwing the identical error. |
| Native `openSelected`, `revalidateIssued`; canonical `open`, `revalidateOpening`; retained `readSelection` | Their original callers await/return the result, including the existing scope-operation and cancellation race. Issued views retain object identity; returns are void, issued empty/fixed-field views or validated fixed-field readback records. No caller depends on the method's promise identity. |
| Pool `beginActionAdmission`, `processTraces`, `revalidateProtocolDeliveryNativeOutputs`, `assertActionHandoffCurrent`, `assertActionAttemptCurrent`, `flushRedisBatch` | All original call sites await them; each returns void. The original operation, parser, broker confirm/drain, cache writes and current-owner checks remain inside the same call. |
| Admission `trySeal`, `recordConfirmedHandoff`, `prepareContractAttemptDisposition`, `prepareRawIncompleteAttemptDisposition`, `recordAttemptDisposition` | Callers await boolean, privately issued empty evidence, or fixed-field `{id, outcome}` / `{id, observation}` records. Fresh-write and evidence authority is keyed by the returned object, which is forwarded unchanged, never by the promise. |

The twenty typed boundaries use a returned reaction promise with a success
handler that records and returns the original value, and a failure handler
that records and throws the original error. An ignored returned promise still
exposes the original unhandled rejection/fatal path; a handled call does not
leave an orphan rejection. This adds a promise reaction and microtask overhead;
it is private qualification instrumentation, not a public API or performance
optimization. These audited returns cannot contain an executable `then` getter
at their top level. Arbitrary data is deliberately excluded at the generic
root/result boundaries. No process rejection handler is installed by the probe.

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

The native-child controls compare the actual emitted `WorkerAttemptClient.run`
and `bind` methods with the probe off/on. They independently check immediate
handling, `unhandledRejection`, native fatal exit under
`--unhandled-rejections=throw`, and later handling with `rejectionHandled`.
The fatal child installs only `uncaughtExceptionMonitor`, which cannot handle
the failure. Exact error identity and the caller-visible rejected promise are
checked. Separate ignored shared-root/admission controls reject false detached
failures; the opaque-result and pending-root controls verify unchanged getter
reads, honest unknown parent settlement and bounded active records.
