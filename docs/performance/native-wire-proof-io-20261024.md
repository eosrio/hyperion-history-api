# Native Wire proof and logger measurements, 2026-10-24

The instrumented run repeats the failed block-685 progress wait while exposing
proof-read amplification and qualification-logger cost. It supplies a measured
baseline for [#277](https://github.com/eosrio/hyperion-history-api/issues/277),
[#248](https://github.com/eosrio/hyperion-history-api/issues/248) and
[#196](https://github.com/eosrio/hyperion-history-api/issues/196).

Source `7b2fefc0f4d9a79ee73eb23da5e9b37e811d9389` is the reviewed #301 tree,
also merged as `4ef674ed`. The original Wire source archive remains
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`.
Clean installation, source/qualification checking, build and the nine new native
regressions passed before the fresh owned bare-metal run. Workers used Linux Node
24.19.0; Bun 1.4.4 served its separate checker/tooling role. Preserve the earlier
[CPU capture](native-wire-worker-profile-20261024.md) and its original outcome.

## Original result and evidence

Holds 1/33/122/256/397 passed. The unchanged 60-second durable-cursor wait for 685
**failed**, observing 661. The last fully validated recovery snapshot was 653.
The source was released through 685 but actually sent 661 and ACKed 653, leaving
eight outstanding. Full 1..1480 replay and the later physical-output audits were
not reached. This remains distinct from the older block-1244 ancestry-expiry case.

All 14 primary/fork CPU profiles passed the existing physical census again. All
6,569 proof opens have complete source-bound counters, zero dropped reports and
zero outstanding operations at shutdown; no late-operation rows were recorded.
Original driver/worker and fixture cleanup passed, with incumbent identities
preserved. Parent integration CI at `4ef674ed` passed all nine jobs in
[run 40119057691](https://github.com/eosrio/hyperion-history-api/actions/runs/40119057691).

[Public evidence](evidence/native-wire-io-20261024/README.md) includes all native
I/O records and profile/resource files, 8,045 files in total; 8,012 retain their
exact original bytes. Private raw inventory: 8,077 ordinary files, one manifest
self-file, one bounded log alias and 135,908,854 payload bytes. Raw archive SHA-256:
`54c256368959b6849626a7573c497befe3405788c5e89755f599bcb1480d77ae`.
Public archive SHA-256:
`3d31929770a0acb777c4ed57874c598085000df1f25f5a1367c188534ae1715c`.
Configuration/console data remain private; original/published hashes and explicit
redaction treatments remain auditable. All five generated files reproduce exactly.

## Proof reads actually recorded

These are operations **inside proof opens**. Native authorization after the open,
history reads, adapter operations and other client calls require separate accounting.

| Process | Opens | Immutable GET calls | HTTP GET attempts | UTF-8-reencoded response bytes |
|---|---:|---:|---:|---:|
| API primary | 60 | 240 | 1,080 | 4,174,100 |
| Main deserializer | 2,423 | 3,079 | 19,359 | 79,547,564 |
| Action pool | 1,663 | 71,401 | 224,144 | 889,726,188 |
| Projection | 2,423 | 8,374 | 39,220 | 158,007,132 |
| **Total** | **6,569** | **83,094** | **283,803** | **1,131,454,984** |

The remaining ten processes had no proof opens. Connection returns included 912
non-success responses associated with `certificate_unavailable` opens. Open
outcomes also include 1,315 `source_pending` and 12 `authority_unavailable` polls;
4,330 opens returned successfully. These are recorded wait attempts. No ancestry
expiry was recorded in this capture. All connection attempts returned; compressed
body bytes and unknown/failed partial body counts were zero. UTF-8-reencoded body
sizes retain whitespace and the connection decoder's semantics; they omit headers,
TLS/framing and cannot recover invalid original UTF-8 bytes.

The maximum request-count action-pool open requested source block 605 against
certified head 661: 57 commit-validation calls, 58 bundle reads, 116 immutable GETs
and 354 HTTP GET attempts, with 136,912,752 ns of open elapsed time. It is a concrete
observed walk, not a statement about the slowest open or the allowed 256-block bound.

**Source-derived request breakdown:** the observed totals reconcile exactly with
`immutableGets + 4 * bundleReads + 3 * authorityCalls`. The
[frontier read](https://github.com/eosrio/hyperion-history-api/blob/7b2fefc0f4d9a79ee73eb23da5e9b37e811d9389/src/indexer/protocol/abi-frontier-store.ts#L201)
and [bundle initialization](https://github.com/eosrio/hyperion-history-api/blob/7b2fefc0f4d9a79ee73eb23da5e9b37e811d9389/src/indexer/protocol/immutable-bundle-store.ts#L75)
each perform physical mapping/settings checks; an
[authority read](https://github.com/eosrio/hyperion-history-api/blob/7b2fefc0f4d9a79ee73eb23da5e9b37e811d9389/src/indexer/protocol/abi-frontier-store.ts#L133)
also reads control. This code model yields 189,810 mapping/settings requests and
10,899 control reads alongside the 83,094 immutable reads. It is an inference
reconciled with measured totals; endpoint categories were not directly recorded.

## Logger calls and process resources

The snapshot excludes its own summary and following exit writes. Call/byte counts
reconcile with every preceding original native record. Write and sync elapsed
distributions retain exact decimal nanosecond totals and bounded histogram buckets.

| Process | Native logger sync calls | Sync elapsed (s) | Write elapsed (s) | Process CPU (s) | Peak RSS (MiB) |
|---|---:|---:|---:|---:|---:|
| API primary | 61 | 0.423 | 0.001 | 5.837 | 268.09 |
| Main deserializer | 8,015 | 68.863 | 0.143 | 103.931 | 444.27 |
| Action pool | 5,106 | 39.196 | 0.089 | 124.767 | 467.90 |
| Projection | 2,424 | 22.550 | 0.050 | 137.663 | 401.11 |

Resource intervals span approximately 702–705 seconds. Every sampled fsync leaf
in these processes belongs to native observer logging: respectively 41, 6,303,
3,705 and 2,020 samples. Sync elapsed includes blocking/scheduling; process CPU
comes from independent user/system deltas. Function sample counts cannot be
converted into CPU seconds or exclusive waits. Nested spans and overlapping
process intervals must not be added to claim pipeline cost.

## Decisions supported and work still required

Read amplification and synchronous diagnostic logging deserve controlled component
experiments. Neither is established as the sole stall cause, and this one run does
not measure the instrumentation's incremental overhead or rank runtimes. Keep the
current source, oracle, logger durability, queue budgets, deadlines and 256-block
window while isolating costs. Evaluate changes against the same correctness checks.

Separately implement/prove #277's prospective count/byte coordination so ordinary
lag cannot expire valid queued inputs; a speed improvement alone cannot close it.
Complete original 1..1480 replay, live canonical recovery and later physical audits.
The engineering genesis workload and shutdown heap samples leave #248's dense
concurrent-view, cancellation/fork and post-request retained-memory matrix open.
Job-boundary host CPU/memory/disk snapshots are archived; backend native profiles,
per-process/host I/O time series, exclusive parsing/hash/wait attribution, queue
residence and at least five paired/repeated controls remain required by the program.

Recompute both the new I/O summary and existing CPU census with the commands in
the evidence README. Offline counterexamples cover false completion, histogram
corruption, source/authority changes, incomplete bodies, late I/O, snapshot byte
boundaries, omitted cleanup and fixture credentials. Verification starts no services
and preserves the failed replay result.
