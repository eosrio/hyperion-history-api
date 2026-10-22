# Portable state prefix profiling — 2026-10-22

The native Node 24 diagnostic and its separate CPU-off control both complete
original source blocks 1–288 through the production workers, MongoDB adapter and
HTTP API. The profile identifies retained rollback-metadata validation as a
measured investigation target. **Complete fork/crash/restart/finality qualification
has not passed:** the preceding complete-scenario attempt exhausted its 900-second
budget during common-prefix catch-up, before the fork.

Code: `03dd3e9758473bc563bf8d7cbbbc0557232f17dc`,
[PR #251](https://github.com/eosrio/hyperion-history-api/pull/251), stacked on
[production recovery PR #249](https://github.com/eosrio/hyperion-history-api/pull/249).
This is evidence for [#250](https://github.com/eosrio/hyperion-history-api/issues/250),
[#246](https://github.com/eosrio/hyperion-history-api/issues/246) and
[#198](https://github.com/eosrio/hyperion-history-api/issues/198).
Follow the [experiment instructions](../../portable-state-prefix-profiling.md).

## Workload and verified boundary

The same audited original Wire prefix runs through the actual launcher, reader,
deserializer, ingestors, RabbitMQ, projection owner and separate Fastify host.
The fixture advances in windows of 32. All three projection checkpoints reach
288; their physical rows, counts, revisions and HTTP rows/headers/finality agree.
The paired API revision equals the physical MongoDB revision. Each projection
retains 256 undo descriptors with floor 32. All source blocks are accounted for
and acknowledged, broker work drains, and the full original input inventory is
audited again before successful shutdown.

The selected `attseq`, `outenvelopes` and `attestations` tables are empty throughout
this prefix. The workload exercises source and ABI proofs, durable admission,
empty state progress and undo retention. It does not measure target-table CRUD,
fork replacement, process-crash recovery, launcher restart, uncovered history,
irreversible-only behavior or a busy-chain workload. The complete fixture retains
its original source, stages and deadlines. No acceptance criterion was relaxed to
obtain a successful diagnostic.

Both runs report `profiled-prefix`, `profileOnly=true`, completed diagnostic
evidence, no driver errors and successful cleanup. They do not report the full
qualifier's `passed` result. CPU capture is verified enabled for the first run and
verified disabled for the second. All 14 process logs complete; the enabled run
also preserves all 14 bounded CPU profiles. Parent-confirmed exits account for
all 12 children, with no forced, unresolved or failed children. Mongo cleanup and
subsequent owned Elasticsearch/RabbitMQ/Redis cleanup verify zero residue.

## Observations

These are two sequential observations on a shared host, one per capture mode.
The control retains the existing observers and source/bulk proxies.

| Observation | CPU capture on | CPU capture off |
| --- | ---: | ---: |
| Source first release to stable prefix | 365.553 s | 364.505 s |
| Projection PID | 1993201 | 2010163 |
| Projection observer sample records | 376 | 375 |
| First-to-last observed projection CPU | 319.981016 s | 307.510643 s |
| Corresponding process monotonic elapsed | 376.529396 s | 375.212510 s |
| Projection Linux `maxRSS` high water | 545.402344 MiB | 540.890625 MiB |
| Projection interval-sampled RSS range | 129.953125–504.902344 MiB | 119.125000–514.460938 MiB |

CPU is the difference in cumulative user+system process time between the first
and last observer samples, rather than CPU since process creation. Those bounds
include startup, drain and shutdown. The projection's prefix-bracketed CPU is
309.416250 s over 363.910103 process-monotonic seconds with capture enabled, and
297.214400 s over 362.276805 seconds with capture disabled. Those brackets start
1.616/1.522 seconds after first release and end 0.027/0.706 seconds before stable
prefix respectively. The [independent observer arithmetic](observer-independent-crosscheck.json)
retains every PID and the actual endpoint margins. `maxRSS` is the Linux high-water
value; interval RSS samples can miss that peak.

One pair cannot quantify profiler overhead, an optimization benefit, runtime
ranking or production capacity. Use repeated controlled comparisons, at least
five runs with alternating controls where feasible, before making such claims.
Neither sampled RSS nor successful process cleanup proves engine memory recovery
or absence of a leak.

### Projection CPU samples

The exact projection profile has 37,254 samples and 5,862 nodes; SHA-256
`333ea38acc136aceeb11944e1f6b8ab3326dc4c25bc9cbc8977a6027c0afbe33`.
Its V8 elapsed interval is 377.725713 seconds. The preceding sample-interval
weights sum to 377.725508 seconds, with a 205-microsecond unsampled tail. These
weights describe elapsed sampling intervals; **they are not process CPU seconds**.
They cannot be aligned to the driver's wall clock by equating unrelated monotonic
epochs.

| Function / emitted component | Attribution | Samples | Share of all samples |
| --- | --- | ---: | ---: |
| `validateRollbackState`, MongoDB adapter | Inclusive | 11,988 | 32.1791% |
| `validateRollbackMetadata`, MongoDB adapter | Inclusive | 10,368 | 27.8306% |
| `snapshot`, adapter's SDK copy | Inclusive | 7,802 | 20.9427% |
| `encode`, Node internal encoding | Self | 4,438 | 11.9128% |
| `snapshot`, adapter's SDK copy | Self | 2,549 | 6.8422% |
| `visit`, bounded JSON | Self | 2,089 | 5.6075% |
| `_parse`, secure-json-parse | Self | 1,472 | 3.9513% |
| Garbage collector | Self | 439 | 1.1784% |

Function grouping uses function name, script identity, URL, line and column, and
counts recursive occurrences once per sampled stack. Inclusive rows overlap and
must not be added. Idle accounts for 10,447 samples (28.0426%). Samples cover
startup, catch-up and drain/shutdown, including proof/JSON work outside the
adapter. The [independent CPU aggregation](cpu-independent-crosscheck.json)
records the raw and interval-weighted self/inclusive calculations.

The pinned adapter validates the retained undo list on durable metadata loads and
before storing candidate state. For each undo descriptor, its validator calls SDK
`validateProjectionApply`, which validates and snapshots the definition and
request. This source path explains a substantial sampled subtree. It does not
measure calls per block, exclusive synchronous validation time, Mongo wait or
source-proof wait. Those measurements must precede a selected optimization.
Ordinary progress does not advance the binding or rollback revision; that
revision alone is not a safe cache key for checkpoint/pending/undo contents.

[Issue #252](https://github.com/eosrio/hyperion-history-api/issues/252) scopes the
next unoptimized call-count/span experiment: a bounded validator kernel matrix
and opt-in counts through the unchanged actual-worker fixture, including a held
head and repeated controls. The [source/context investigation](validation-investigation.md)
records the predicted repeated loads separately from measured samples. No
optimization has been selected or implemented.

The [complete attribution report](analysis-report.md) also groups the two
byte-identical SDK copies without double-counting a stack: their `snapshot` union
has 8,085 inclusive samples (21.7024%), distinct from the nested-only row above.
[Public reproduction instructions](reproduce/README.md) use the unchanged analyzer
gates and the published raw archive. Separately hashed analysis-input reports
restore only a runtime path proven by every public start receipt and the original
serialization order of unchanged emission inventory values. Original public
reports remain unchanged. [Equality/resource evidence](analysis-equality-resources.json)
records identical complete per-process results for both 14-process inventories.

The [analysis archive](analysis-evidence.tar.gz) preserves all 25 frozen helper,
test, recipe, report and result files, plus their original inventory. Its
[receipt](analysis-bundle-receipt.json) and [file inventory](analysis-publication-files.json)
identify exact bytes and direct-file aliases. Full results are compressed to
preserve the complete graphs without duplicating their large JSON files in the
checkout. The independent [publication audit](publication-audit.md) covers the
exact raw six-case and separate emission archives.

The separate [interpretation/reproduction review](interpretation-review.md)
independently reproduces both complete 14-process results and every aggregated
function/module array. All 44 offline controls pass on each native Windows
Node 22/24, and all five Python path controls pass. These offline parser checks
do not add a Linux worker/runtime qualification.

## Earlier attempts remain failed

| Attempt | Code prefix | Preserved outcome |
| --- | --- | --- |
| `pilot24-reversible` | `732d6b1` | Before worker startup, the default 20-GiB disk watermark prevented replica allocation. The master cleanup error remains explicit. |
| `native24-reversible` | `478844e` | Stopped at offered block 32 on an unrecognized RPC request shape; this was not exhaustion of the 512-request budget. |
| `native24-reversible-v2` | `fde6917` | Captured an empty `GET /v2/health` discovery request at offered block 32. Its caller PID was not captured. |
| `native24-reversible-v3` | `4ae3485` | Timed out awaiting prefix 672 after 900 seconds; physical checkpoints were 651/660/652. No fork, crash or full stable stage completed. |

The later fixture uses the explicit existing 8/4/2-GiB disk profile, checks
effective values and available headroom, and treats only the exact bounded empty
health-discovery request separately from the strict chain-RPC surface. All prior
reports and original cleanup outcomes remain in the evidence. Neither the failed
complete attempt nor these diagnostic runs establishes complete recovery support.

## Environment and retained evidence

Hyperion-1 runs Ubuntu 24.04.4/kernel 6.8.0-136 on a Ryzen 9 5950X with 128 GiB.
Native fixture processes are inside an owned systemd scope with aggregate
`CPUQuota=600%`, `MemoryMax=8G` and `TasksMax=512`; the CPU quota is not an affinity
restriction. Fresh owned Docker services are separate from incumbent
services. The ES fixture uses 64 MiB indexing pressure and the explicit disk
profile; these are test settings. Incumbent services were not reconfigured or
restarted. Postflight confirms the seven expected incumbent PIDs/listeners and no
remaining Docker containers. This is a bounded fixture on shared bare metal,
rather than an isolated production-capacity benchmark.

Native Node is 24.19.0, binary SHA-256
`bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
Build/typecheck uses TypeScript 7.0.2 and Bun 1.4.3; Bun is not the worker runtime.
Locks pin SDK `ae1f670016d6f4a63b42eb08563ee9d544867915`, Wire package
`e8c7162437a0d0f4e2211979b959f2d002bf3552`, MongoDB driver 7.2.0,
Elasticsearch client 8.19.1 and transport 8.10.1. Services use Elasticsearch 9.5.5
and MongoDB 8.0.34 with one replica-set member. Service identities and effective
settings remain in the public evidence; complete image/inspection receipts are
retained in the original private archives, with omissions identified by the
public manifest. Pinned image references also remain in the committed service
fixture. Wire source revision
`6508c9e8f4044df8d5acb082a7af3be6a80cd9a0` is an engineering pin, not a launch pin.

[Raw evidence](raw-evidence.tar.gz), [manifest](manifest.json) and
[summary](summary.json) retain four failed attempts and the two diagnostics.
Verify [SHA256SUMS](SHA256SUMS) before extracting. Raw bulk records, profiles,
observer JSONL, stages and selected logs preserve exact bytes. Public
report/invocation/runtime derivations omit only the declared connection,
configuration, environment and executable-path fields; every named omission has
original provenance, size/hash and presence information. Original log symlinks
become regular metadata and are never followed. Temporary fixture paths, owned
container addresses and public software banners remain in selected logs; this is
not complete anonymization. The manifest identifies omitted private bytes rather
than claiming they were published.

The separate [exact emission archive](verified-emission.tar.gz) contains all 602
pre-run pinned files (4,171,166 bytes), plus the original pin receipt. Its
[receipt](verified-emission-receipt.json) explicitly records post-run capture and
verification against every pre-run hash. It is not the complete dependency tree
or runtime distribution. The public filename is a byte-identical alias; the
receipt retains its original archive name. The report also pins the source
commit's root/backend TypeScript configurations and `.bun-version`, which are
outside this 602-member archive. [Dependency code pins](dependency-code-pins.json), read
after capture, establish that the SDK copy appearing in adapter stacks is
byte-identical to the already pinned root SDK emission. Original archives and
runtime inputs remain retained privately; original bytes are never overwritten by
public derivations.

The driver also samples its native cgroup and five owned core containers using
actual sample timestamps. Docker collection adds variable delay to its requested
cadence. This does not include a MongoDB engine CPU/allocator/lock profile, native
stack attribution, allocation/retention analysis or complete storage/network
instrumentation. Those coverage gaps remain open.

Local and native validation include 47 focused harness tests/272 assertions,
whole-project and qualification Bun checks, native emission, six Python ownership
guards and 353 observer/shutdown assertions on each Node 22 and 24. Independent
review reproduced missing child evidence and unpaired API/physical revisions;
both regressions are fixed, with zero remaining Spec/Standards findings. All nine
CI checks pass at the profiled code commit. This does not substitute for the
uncompleted Node 22/24 reversible/irreversible recovery matrix.

Authentic Wire consensus/forks, Rust/rs_abieos, AtomicAssets/AtomicMarket parity,
WormDB, Bun worker qualification, retained-history upgrades, stream-client #231
and full release support remain separate gates. Existing Elasticsearch history
remains usable without a full reindex.
