# Portable state prefix CPU experiment

[Issue #250](https://github.com/eosrio/hyperion-history-api/issues/250) profiles the
actual projection worker before selecting a performance change. The experiment is
part of [#198](https://github.com/eosrio/hyperion-history-api/issues/198) and follows
the [component profiling program](https://github.com/eosrio/hyperion-tools/blob/main/docs/performance/hyperion-4.5-profiling.md).
This document defines the reproducible experiment. The
[2026-10-22 native result and evidence](evidence/portable-state-prefix-20261022/README.md)
record one successful diagnostic/control pair and the preceding failed attempts;
complete recovery qualification remains open. Busy-chain ancestry memory remains
a separate [#248](https://github.com/eosrio/hyperion-history-api/issues/248) concern.

## Workload and correctness boundary

The explicit `--profile-prefix 288` option uses the same audited original Wire
inputs and synthetic head/LIB controls as the
[complete recovery fixture](../../tests/fixtures/portable-state-recovery/README.md).
It runs original nested inputs 1–288, without a skipped prefix, through the actual
launcher, reader, workers, RabbitMQ, MongoDB adapter and Fastify HTTP host. The source
releases 32 blocks at a time and waits for physical progress. The exact contract ABI
deployment identifiers come from the original audited plan; they are not replaced
with head ABIs or edited for the experiment.

At block 288, all three projections must independently have the expected physical
rows, checkpoint, revision, and public HTTP rows/count/headers/finality. The API
view revision must equal its paired physical MongoDB metadata revision. The default
256-block undo retention must be full, with coverage floor at original block 32.
Source credits must be acknowledged, all owned queues drained, and source blocks
1–288 accounted for. The complete original input inventory is audited again before
shutdown. Both state finality modes can use this common prefix.

The selected `attseq`, `outenvelopes` and `attestations` tables are empty throughout
this prefix. Its cost includes actual source/ABI proofs, empty projection progress,
metadata and undo retention. It does not measure target-table insert/update/delete
cost, fork replacement, crash recovery, launcher restart, bounded-gap recovery,
busy-chain capacity, Rust/rs_abieos or full Wire release support. Those remain in
the complete qualification and their owning issues.

## Reproduce on owned native Linux services

Use a committed isolated checkout, native Node 22/24, pinned Bun 1.4.3, Docker,
Python and PowerShell 7. Follow the
[original service and ownership prerequisites](../qualification/portable-state-worker.md).
Select the exact intended Node binary on `PATH`, record its version and hash, and
preserve the checkout commit and dirty-diff evidence. Use committed npm lockfiles
and native TypeScript emission; a Bun typecheck is not a production runtime test.

```sh
node --version
git rev-parse HEAD
git status --short
npm ci --allow-git=all
npm ci --prefix packages/backend-mongodb --allow-git=all
npm run typecheck
npm run build
bun check -p scripts/qualification/tsconfig.json
mkdir -p out
python tests/fixtures/portable-state-worker/prepare.py out/p250-source
python tests/fixtures/portable-state-worker/services.py create out/p250-profile-services --disk-watermark-profile 8-4-2gb
node --experimental-transform-types scripts/qualification/portable-state-recovery.ts out/p250-profile-services/worker-state.json out/p250-source/plan.json out/p250-profile reversible --profile-prefix 288
python tests/fixtures/portable-state-worker/services.py cleanup out/p250-profile-services
```

The helper creates the declared 64 MiB Elasticsearch pressure fixture. Disk
profiles are the existing explicit allowlist; the driver still verifies effective
settings and headroom after its pinned MongoDB image starts. Do not use production
services. Every attempt needs fresh owned services and a new output directory;
preserve failed/timed-out output before cleanup. The original 900-second run bound
plus 90-second cleanup bound remain unchanged.

CPU capture defaults to on only when `--profile-prefix 288` is present. An explicit
`--cpu-profile on` is equivalent. To obtain a matching observer-only control, create
another fresh service fixture and run the same source, mode and prefix:

```sh
python tests/fixtures/portable-state-worker/services.py create out/p250-control-services --disk-watermark-profile 8-4-2gb
node --experimental-transform-types scripts/qualification/portable-state-recovery.ts out/p250-control-services/worker-state.json out/p250-source/plan.json out/p250-control reversible --profile-prefix 288 --cpu-profile off
python tests/fixtures/portable-state-worker/services.py cleanup out/p250-control-services
```

Repeat with a separately selected Node 22/24 binary or `irreversible` as a declared
experiment axis. Ordinary invocation without either profiling flag continues the
complete fork/crash/restart/gap scenario with its existing criteria and timeout.
`--cpu-profile` is accepted only with the explicit prefix option.

## Evidence and result interpretation

Successful prefix observation returns exit 0 with `report.status="profiled-prefix"`
and `profileOnly=true`; it never returns the full qualifier's `passed` status or
sets its recovery qualification flags. Requested CPU capture, observed completion
and enabled/disabled state are recorded separately. A stable prefix followed by a
profile or cleanup failure remains a failed run.

The report retains original input/oracle/plan/manifest hashes, exact source and
component pins, the checkout commit and tracked-diff digest, the runtime binary
version/hash/flags, service identities/settings, and an inventory of actual emitted
build files, adapter emission, lockfiles and collectors. Keep that inventory with
the actual archived source/emission artifacts; a digest alone is not a backup.
`stages/profile-prefix-288.json` records independent physical and HTTP evidence.
Observer JSONL records retain per-PID CPU/RSS/heap/event-loop samples and IPC/queue
observations; `profiling.firstReleaseAt` and `stableAt` bound common-prefix catch-up.

CPU mode uses the existing native inspector observer at a 10,000 microsecond
sampling interval, capped at 900 seconds, 32 MiB per profile and 24 MiB per observer
log. The owned parent, fork, actual child exit and shutdown inventories must agree
exactly with observed process starts and actual log/profile filenames. Each actual
process must save and flush its profile after the stable prefix, with no dropped
records/errors, and exit cleanly. Saved file
identity, size, hash, sample/node membership and duration are checked independently.
Missing, oversized, malformed, prematurely flushed or incomplete profiles fail.
Signed integer sample deltas remain in their original order and are not rejected
solely for stepping backwards. Each profile records timing quality separately:
backward or out-of-window sample instants, and absent positive sampled coverage,
make interval weights explicitly unavailable. The raw file, sample multiplicity
and signed timestamps remain unchanged; no sorting, clamping or sample removal
occurs. This does not validate a graph for attribution or turn elapsed weights
into process CPU. See the [pinned producer/consumer research](v8-profile-timestamps.md).
Aggregate capture receipts identify affected PIDs; disabled capture reports no
interval-weight availability. Earlier failed attempts retain their failed labels.
The disabled control must instead report disabled capture and clean complete
observer shutdown. All normal asynchronous error and service/process cleanup gates
still apply.

Profiles include startup and prefix catch-up, with an empty target-table workload.
CPU sampling and existing observations add overhead. A first diagnostic profile may
identify a hot path; it cannot quantify the profiler's overhead or establish a
throughput improvement. Compare repeated, alternating prefix controls and captures
with the same pins and host observations before attributing a difference. Keep
server execution time, client wall time, CPU samples and awaited spans distinct.
Any selected optimization requires its own scope, invalidation/correctness checks,
and the complete Node 22/24 recovery/finality qualification afterward.
