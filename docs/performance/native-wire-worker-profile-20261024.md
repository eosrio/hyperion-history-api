# Native Wire worker capture: failed replay, complete profiles

The frozen `3febe95e9faf52067f96350b9f9df0dd2e2a2678` run retained CPU profiles for all
14 observed Node processes. Its original 1..1480 replay **failed** the unchanged
progress wait for block 685. This is diagnostic evidence for [#297](https://github.com/eosrio/hyperion-history-api/issues/297),
not completed Wire, fork/recovery, throughput or release qualification.

The [published evidence](evidence/native-wire-profile-20261024/README.md) contains the
process profiles, resource samples and original native/prefix/bulk observations.
The [summary](evidence/native-wire-profile-20261024/summary.json),
[CSV](evidence/native-wire-profile-20261024/resources.csv) and reproducible verifier retain
units, source/runtime pins and the distinction between replay failure and profile completeness.

## Workload and result

- Captured engineering chain `9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d`;
  Wire source revision `6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`, with the installed coordinated
  Node/Rust package at `7167659e9c043cb3351074fcacb40200cc57f3a3`. These remain engineering pins.
- Native Linux Node **24.19.0**, executable SHA-256
  `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
  Bun 1.4.4 runs tooling; this capture executes Node workers. The provenance retains npm,
  build/package hashes and configured/actual Docker image identities for owned services.
- The original source archive remains
  `42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`.
  Holds **1, 33, 122, 256 and 397** passed with the original oracles and output checks.
- The driver released input through 685, but actual source sessions sent **661** blocks and
  received **653** SHIP acknowledgments. Eight remained outstanding. A released bound is not
  proof that those blocks were transmitted or completed. The failing projection poll saw 661.
- The DS queue peaked at **81** messages and its final sample was **15**, above the configured
  resume trigger of 8. The master observed pauses at 391.798 s and 631.838 s, with one resume
  at 451.810 s. The first observed pause/resume interval was 60.012 s. These are master-local
  observation times; the pause threshold of 64 is not a hard queue-cap assertion.
- All nine driver/worker cleanup entries passed, and original owned-service cleanup passed.
  The failed capture and earlier wrapper failure remain in the private raw archive. This run
  does not demonstrate an ancestry-expiry failure or complete the separate #277 coverage gate.

## Process measurements

CPU below is the sum of recorded user/system CPU deltas; elapsed spans include startup,
work, instrumentation and shutdown. RSS peaks are per-process samples, not simultaneous fleet
memory or retained-heap measurements. Full per-PID data is in the CSV.

| Process | PID | Observed CPU seconds | Resource interval seconds | Peak RSS MiB | Peak heap-used MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| API primary (observer role `master`) | 746003 | 5.806 | 703.069 | 260.07 | 109.23 |
| Master | 746002 | 60.445 | 703.260 | 385.63 | 158.00 |
| Continuous reader | 746104 | 9.969 | 699.580 | 220.41 | 79.43 |
| Main deserializer | 746105 | 92.210 | 699.604 | 432.53 | 210.54 |
| Second deserializer | 746106 | 2.741 | 699.591 | 144.06 | 54.31 |
| Action pool | 746149 | 142.320 | 699.642 | 452.59 | 228.10 |
| Projection | 746155 | 139.569 | 699.658 | 375.80 | 147.37 |

The seven ingestors each recorded 2.657–3.959 CPU seconds. Their profiles are included,
although this workload leaves them mostly idle. Backend service CPU/native I/O profiles and
capture-time host CPU topology were not collected in this archive. The dataset does not rank
hosts, runtimes, maximum capacity or full API-domain workloads.

[Node's CPU counters](https://nodejs.org/download/release/v24.19.0/docs/api/process.html#processcpuusagepreviousvalue)
measure user/system CPU in microseconds across the process. The V8 profile's
[sample IDs and time deltas](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/js_protocol.json)
are a different measurement. Sampled stack locations, including synchronous native calls,
do not establish exclusive CPU or storage-wait durations. We do not multiply a frame's sample
share by process CPU to invent per-function CPU seconds.

## Stack attribution and next measurement

Every `fsync` leaf sample in the main deserializer (**4,348**) and action pool (**2,450**)
has the qualification native observer's `record` function in its ancestor chain. That
[observer](https://github.com/eosrio/hyperion-history-api/blob/3febe95e9faf52067f96350b9f9df0dd2e2a2678/scripts/qualification/portable-state-worker-native-observer.mjs#L25)
writes and synchronizes each observation. These samples therefore identify instrumentation
on the observed path; they do not justify changing production durability or claiming that
production journal `fsync` caused the failed barrier. Direct observer write/sync latency and
overhead remain unmeasured.

The action pool records **5,528 inclusive samples** at `boundedCanonicalJson`, with 2,751
self samples at its `visit` location and 1,674 at `string`. The corresponding main-deserializer
inclusive count is 2,636. Projection samples also include canonical JSON, transport JSON
parsing, and adapter `load`. Source locations remain separate even when function names match;
recursive appearances count once per inclusive sampled stack. These observations identify
work worth attributing, not a measured benefit from caching or weaker validation.

The next slice should measure, without changing current behavior:

1. Observer record/write/sync call counts and bounded latency distributions, with the existing
   observation durability and complete retained-byte checks preserved.
2. Per-proof-open ancestry depth, actual immutable-store GET count/response bytes, request wait,
   parsing/hash/validation work and retained memory, correlated with the exact action/source and
   cancellation/fork generation. The 3,981 captured bulk pairs are write evidence, not GET counts.
3. Queue residence and durable source/ACK boundaries alongside those measurements, followed by
   the unchanged full replay. Keep the 256-block ancestry, held prefixes, queue policy, original
   output assertions and all deadlines.

That separates observer cost from production work before an optimization is selected under
[#248](https://github.com/eosrio/hyperion-history-api/issues/248) and
[#277](https://github.com/eosrio/hyperion-history-api/issues/277). One capture and the earlier
sequential control do not quantify profiler overhead or support a runtime comparison. A last
heap sample during shutdown does not establish post-request recovery or leak freedom.
