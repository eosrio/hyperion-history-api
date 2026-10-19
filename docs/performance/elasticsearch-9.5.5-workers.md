# Elasticsearch 9.5.5: sustained load and full-worker backpressure

Measured 2026-10-19 for [#198](https://github.com/eosrio/hyperion-history-api/issues/198).
Two fresh Node executions passed the finite qualification below: **95,960 logical
actions**, every ID/source checked separately on both data nodes, **six** controlled
backpressure waves and **13** complete CPU profiles. Broader release acceptance remains open.

## Executed path and limits

The production launcher starts the actual master and **12 cluster workers**: one
historical reader, one continuous reader, two deserializers, seven ingestors and one
deserialization-pool worker. A dedicated Spring chain produces real known-genesis
blocks. Readers request SHIP block headers and deserializers decode them through the
native codec. Traces and deltas are disabled. MongoDB is a real startup dependency,
even with state indexing disabled; no state projection or plugin acceptance follows.

A separate publisher sends dense synthetic actions into the real durable action
queue in persistent 20-message chunks with publisher confirms. Actual ingestors,
cargo, prefetch, bulk routes and manual broker settlement process those actions.
Their fixed sequence/ID and exact source provide the output oracle. This action load
does not measure SHIP action decoding, ABI lookup or contract execution throughput.
Sorted queries go directly to Elasticsearch; the HTTP API server is not started.

The fixture uses production action mappings: **four primaries, one replica,
`global_sequence desc` index sort, `best_compression`, 1 s refresh**. Full effective
mapping/settings responses are retained. Queries require complete successful shards,
strict sequence ordering, matching IDs and exact sources. The read-only phase starts
after the publisher quiesces, the queue drains, refresh completes and the full count is
visible; it additionally requires the exact descending top 50 IDs. Mixed reads require
at least the known-visible baseline, rather than accepting empty pages.

## Versions and owned resources

The measured preparation commit is
`caa8fdb08367cffbdfc02de6c04dbc26e745c395`. Every run archives its exact runner,
observer, selected production source/build files and lockfile, with independent byte
hashes. The two final runs must have identical measured source hashes. Normalized Git
blobs can have different line endings from the archived measured files.

- **Node 24.19.0**, Windows x64; JavaScript client **8.19.1**, transport **8.10.1**,
  amqplib **2.0.1**, automatic **UndiciConnection**, with no HTTP override. The qualification
  proxy forwards bulk HTTP bytes to the owned receiving Elasticsearch node. Direct query
  client retries are disabled, with a 15 s request timeout. Exact runtime binary hashes,
  OS, CPU and Docker limits are in the evidence.
- Elasticsearch **9.5.5**, build `48acba663b09e70b115dd879329141506c377890`,
  Lucene **10.5.1**. Immutable image
  `docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`.
  Two data/master/ingest nodes each have **2 CPUs, 3 GiB memory, 1 GiB heap**;
  a master-only witness has **1 CPU, 1.5 GiB memory, 512 MiB heap**.
- RabbitMQ **4.3.4 management**, **1 CPU/1 GiB**;
  `rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef`.
- Redis **1 CPU/512 MiB**, AOF, 384 MiB/noeviction;
  `redis@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241`.
- MongoDB **1 CPU/1 GiB**, 256 MiB WiredTiger cache;
  `mongo@sha256:4968f22d0c6c10ef29952f3e807f62872ba22b3312f25803564fbfc08255efc2`.
- Spring **1.2.2**, **2 CPUs/2 GiB**;
  `igorls/spring-nodeos@sha256:13130dbeeaf519209d8aec8b79edfa14ee3e1de958f461506b63569a91714c5a`.
  The tracked genesis and node configuration are hashed. No contracts are deployed.

Each fresh fixture owns seven labelled containers, seven volumes and one network.
All service URLs must match the inspected containers' exact ephemeral loopback port
bindings before writes. Cleanup verifies labels, images, mounts, network endpoints and
volume consumers before removing the exact resources. Eleven offline failure/lifecycle
cases exercise its refusal and interrupted-setup paths with no Docker/network fallback.

Disposable ES disk watermarks are **20/10/5 GiB**, and its inherited static pressure
budget is **1 MiB**. Spring's test resource threshold is **98%** on this host filesystem.
These are recorded fixture choices, not production tuning recommendations. Other host
workloads, Docker storage/caches and observer/proxy overhead are uncontrolled.

## Workload and recovery oracle

Each final execution has 10 s warmup, then **100 s write, 100 s read and 100 s mixed**
windows, followed by three fault/recovery waves and final verification. Action publishing
targets **200 documents/s**; the query loop pauses 100 ms after each response. Every
steady window must contain useful successful work in at least 80% of its one-second
buckets, and write/mixed publication must reach 70% of the offered-rate target. These
gates establish activity under this bounded fixture, not a production capacity rating.

The production queue monitor polls every **500 ms**, pauses historical readers at a
**64-message** queue budget and resumes only when monitored queues are below **16**.
The current eight-block SHIP range may finish while paused; the next range must wait.
The continuous reader retains the production live-priority exemption.

Before each wave the fixture must drain and the historical reader must be resumed.
An owned proxy then **gates forwarding of real bulk requests before Elasticsearch
dispatch**. It does not synthesize an ES error or hold a response after ES has admitted
the write. The ordinary production path accumulates unacknowledged/queued work. Each
wave requires actual master-to-reader pause IPC, an actual next-range instruction while
paused, no reader method request for that new range before release, continuing live
`read_block` observations, actual resume IPC after release, and dispatch of that exact
pending range. Requests and responses otherwise pass through unchanged.
Range observations record the actual `requestBlockRange` method invocation; they
are not a packet capture or a per-range source-completion audit.

The independent synthetic action publisher continues during each stall, bypassing the
historical reader gate. Its queue can therefore exceed 64; these counts cannot establish
a hard production queue cap or measure reader-only overshoot. This tests delayed sink
completion and shared-reader backpressure, separately from the preceding native
[indexing-pressure rejection experiment](elasticsearch-9.5.5-replicas.md).

After publishing stops, all confirmed actions must be visible with an empty action
queue. Each data node is independently selected with `_only_nodes`; ascending
`search_after` pagination requires all four successful shards, every expected ID and
source, the exact total and matching source digests across both copies. Publisher
confirms, per-item ES shard receipts and final copy verification are distinct evidence.
Some warmup receipts may have only one successful copy during replica allocation.
This run does not test broker restart, reader failure, power loss or source replay.

Three complete idle-accounting observations require zero pressure reservations, search
contexts/current work and write/coordination active/queued work. Every process must
then flush after recovery and exit; forced or missing child exits fail the run. An
independent postflight verifies observed PIDs are gone, no broker connections or queued/
unacknowledged messages remain, and ES tasks/accounting are idle before fixture cleanup.
Empty durable queues are recorded, then removed with their owned broker volume.

## Results and profiles

| Observation | Control | Profile |
| --- | ---: | ---: |
| Exact logical action documents on each data node | 48,260 | 47,700 |
| Successful query responses, including fault/recovery intervals | 2,687 | 2,622 |
| Bulk responses, including real block traffic | 5,441 | 4,983 |
| Write-window publisher confirms/s | 187.24 | 187.39 |
| Mixed-window publisher confirms/s | 188.04 | 188.01 |
| Read-window query p95 / p99 wall time, ms | 9.91 / 12.62 | 10.54 / 13.14 |
| Mixed-window query p95 / p99 wall time, ms | 7.12 / 10.17 | 7.93 / 13.19 |
| Verified pause/resume waves | 3 | 3 |
| Complete process observations / saved CPU profiles | 13 / 0 | 13 / 13 |

Actual steady windows lasted 100.61–100.92 s each. Total startup-through-shutdown time
was about **423 s** for control and **418 s** for profiling. Postflight passed separately
for both: 13 observed processes gone, three idle samples, zero broker connections,
messages, unacked deliveries and ES tasks. Each retained ten empty durable queues until
guarded cleanup removed all seven containers, seven volumes and the network.

The three control gates lasted **16.29/13.39/15.31 s**, with release-to-resume
observations **13.74/16.71/14.18 s**. Profile gates lasted **14.75/12.30/14.91 s**, with
release-to-resume **15.19/12.58/14.86 s**. All six observed positive live progress and
zero next-range method requests before release; the exact pending range was invoked
within 1 ms of each recorded resume. These values include polling, cached broker statistics,
the existing monitor policy and observer scheduling; they are not ES service-time estimates.

Receipt histograms are retained separately. Control had **290** successful action
receipts with one successful copy and **47,970** with two; final copy verification
covered all **48,260** sources on each node. Final copy equality must not be represented
as a two-copy receipt for every original write.

| Role | Processes | Control CPU seconds | Profile CPU seconds | Largest profile process RSS, MiB |
| --- | ---: | ---: | ---: | ---: |
| Master | 1 | 8.515 | 11.985 | 168.3 |
| Historical reader | 1 | 2.344 | 4.562 | 116.7 |
| Continuous reader | 1 | 1.796 | 4.438 | 112.1 |
| Deserializers | 2 | 4.345 | 9.735 | 115.3 |
| Ingestors | 7 | 16.861 | 32.344 | 126.7 |
| Deserialization pool | 1 | 1.625 | 3.766 | 119.5 |

CPU is summed user+system time across processes in that role, including startup and
observation work. RSS is the largest individual sampled process peak, not concurrent
role memory. Several ingestors are idle because their domains are disabled. Idle/runtime
frames dominate these fixed-rate profiles; this is not evidence that dense production
decoding or every domain is inexpensive.

Across both runs, native pressure rejections, write-pool rejections, breaker trips and
merge throttling remained **zero**. Peak sampled indexing-pressure charge was only
**78,625 bytes**, below the fixture's 1 MiB budget. Data-node JVM heap peaked around
**697–701 MiB** and ended around **369–521 MiB**; the idle-accounting gate does not
require heap occupancy to return to its initial value. GC, refresh, merge, flush and
storage observations remain in the raw reports and per-node summary. No native ES
saturation, large-memory recovery or production bottleneck was established.

The [summary](evidence/es955-workers-20261019/summary.json),
[manifest](evidence/es955-workers-20261019/manifest.json),
[raw reports/profiles and measured bytes](evidence/es955-workers-20261019/raw-evidence.tar.gz)
and [checksums](evidence/es955-workers-20261019/SHA256SUMS) retain both final runs,
source snapshots, all excluded controls, independent audit helpers and cleanup receipts.
Owned production log symlinks are represented as bounded JSON metadata; the archive
contains regular files and no extractable links.

The observer collects one-second per-PID CPU, RSS/heap/resource and event-loop-delay
samples, exact forwarded queue/IPC/range observations, and optional **10 ms CPU sampling**.
The profile run requires a saved CPU profile for the master and every worker, covering
startup through post-recovery flush. Automatic early flush, missing data, observer errors,
unclean shutdown and incomplete statistics fail qualification. CI independently exercises
real profile/shutdown paths with **302 assertions**, including abnormal child exits
and readiness arriving before a delayed queue response.

The unprofiled control still runs the observer and forwarding proxy. One sequential
control/profile pair cannot establish collector overhead, a runtime ranking, production
headroom, a heap leak or a bottleneck. CPU samples and backend counters identify follow-up
hypotheses; read/write wall time includes the declared fixture and observation effects.
Server `took` retains its cached-clock semantics documented in the
[clock control](elasticsearch-9.5.5-clock.md); it is not subtracted from client wall time
to estimate network cost.

## Prerequisite corrections and excluded controls

[Reader correction #206](https://github.com/eosrio/hyperion-history-api/pull/206)
waits for the actual confirm publisher's drain, guards stale channel closes and resumes
only the unsent cargo continuation after replacement. Six actual-method/lifecycle tests
cover repeated pressure, confirmed final-message closure, closure before confirm and late
old-channel events. Negative/unknown confirms, channel-only replacement scheduling and
active historical/repair range replay remain separate reliability work under
[#208](https://github.com/eosrio/hyperion-history-api/issues/208) and
[#187](https://github.com/eosrio/hyperion-history-api/issues/187), with integration/profile
oracles in [#195](https://github.com/eosrio/hyperion-history-api/issues/195) and
[#196](https://github.com/eosrio/hyperion-history-api/issues/196).

Windows production startup also required filesystem imports via `pathToFileURL` and
colon-free error log filenames. Two Node child-process regressions exercise actual
parser/action/plugin loading, including spaces, `#` and `%`. Failed startup pilots are
retained alongside the corrected real-worker launches.

Bun **1.4.3** loads the pinned node-abieos native codec here, but the pinned uWebSockets
module fails with `napi_register_module_v1` missing. Node 24 loads both. Exact probe
sources/output/runtime hashes are retained; there is no Bun full-worker performance
comparison or support expansion in this slice.

Failed setup attempts, six development pilots, review counterexamples and cleanup
receipts remain separate from final totals. A failed development pilot left confirmed
actions queued in its owned fixture; its failed postflight remains recorded before
guarded fixture removal. An initial postflight array-decoding bug also remains as an
excluded audit control; the corrected flat-array decoder has zero/one/multiple and
malformed-response regressions.

## Review corrections and bounded follow-up

[Review 5570640946](https://github.com/eosrio/hyperion-history-api/pull/207#pullrequestreview-5570640946)
identified four qualification defects, corrected in
`d2353930a5037404bbb3e5da9f665546cccb0954`:

- Track every child from fork time, including children that die before shutdown.
  Require actual master and child exit code zero with no terminating signal;
  a completed flush alone is insufficient.
- Subscribe to checker readiness before asynchronous module/queue initialization.
  A delayed queue-response case deterministically exercises the former race.
- Reject profile runs above **600 steady seconds** before reading inputs or creating
  resources, reserving 300 seconds below the 900-second observer cap. Control runs
  still allow 900 steady seconds. This headroom does not guarantee completion under
  every cumulative deadline; explicit post-recovery flush coverage remains required.
- Observe AMQP connection/channel errors immediately on acquisition and through
  cleanup, producing a failed report through the existing cleanup path. Negative
  probes use the installed AMQP models and exact acquisition statements; they do
  not constitute a real broker-handshake fault qualification.

Validation passed **226 unit tests**, project/runner typechecks, TS7 build and the
**302** real child-process observation assertions. Independent Spec and Standards
reviews found no remaining issues in the correction range.

A fresh full-worker profile then passed **60 steady seconds**, three sink-stall
waves, **17,440 exact action sources on each data node**, and **13** CPU profiles
covering final post-recovery flush. The runner recorded the master's actual OS exit
as code zero/no signal and all 12 child exits likewise. Independent postflight found
all 13 observed processes gone and three complete idle samples; guarded cleanup
removed seven containers, seven volumes and the network with no owned residue.
This shorter follow-up is **excluded** from the original two five-minute totals.

The original archive remains byte-for-byte unchanged. An independent audit found
all 13 own exit records code zero and all 12 parent-observed child exits code zero/no
signal in each original run; all original shutdowns were successful and unforced.
The original 13 profiles ended through explicit final flush, with the longest
**416.684 seconds**, below the cap. Those reports did not capture the parent's
observation of the master's OS exit; the fresh follow-up adds that evidence.

The supplemental [summary](evidence/es955-worker-review-20261019/summary.json),
[manifest](evidence/es955-worker-review-20261019/manifest.json),
[raw follow-up and regression evidence](evidence/es955-worker-review-20261019/raw-evidence.tar.gz)
and [checksums](evidence/es955-worker-review-20261019/SHA256SUMS) preserve the fresh
measured bytes, the original-evidence audit, negative controls and cleanup receipts.

## Reproduction and remaining acceptance

Build the pinned dependencies with TS7 and use Node 24 for direct TypeScript execution.
Create a new fixture and a new output directory for every run:

```powershell
$stateFile = Join-Path ([IO.Path]::GetTempPath()) ('hyperion-workers-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    ./scripts/qualification/es955-worker-fixture.ps1 -Action create -StateFile $stateFile
    node scripts/qualification/es955-workers.ts $stateFile ($stateFile + '.control') 300 200 control
    if ($LASTEXITCODE -ne 0) { throw 'Qualification failed; preserve the output' }
} finally {
    if (Test-Path -LiteralPath $stateFile) {
        ./scripts/qualification/es955-worker-fixture.ps1 -Action cleanup -StateFile $stateFile
    }
}
```

Use `profile` instead of `control` on another fresh fixture for the profiling case.
The guarded cleanup does not require a passing run; retain all reports, logs, source
snapshots, profile files and cleanup receipts before deleting any evidence.

Keep #198 open for representative historical/contract data, full API/plugin paths,
longer replicated load/overhead controls, large memory pressure, broker/worker-loss
replay, distributed late-result ordering and retained-index creation/upgrade evidence.
The existing-history/no mandatory full history reindex requirement remains in force.
No dependency pin, live cluster setting or deployment changes follow from this experiment.
