# Elasticsearch 9.5.5: first compatibility and profiling slice

Measured 2026-10-18 for [#198](https://github.com/eosrio/hyperion-history-api/issues/198).
All five finite synthetic executions passed their data oracle and cleanup. This establishes
compatibility for the requests exercised below, not complete Hyperion or retained-history
upgrade qualification. The E2E and Tools benchmark defaults now select 9.5.5 in
[API #200](https://github.com/eosrio/hyperion-history-api/pull/200) and
[Tools #31](https://github.com/eosrio/hyperion-tools/pull/31).

## Reproducible scope

- Runner/source revision: `90bc36e05b6f83d504c5c98f3bcb8c2e7a434925`.
  [Manifest](evidence/es955-20261018/manifest.json) pins source/generated helper hashes,
  executable hashes, arguments, host, effective settings and every raw artifact hash.
- ES **9.5.5**, build `48acba663b09e70b115dd879329141506c377890`, Lucene **10.5.1**;
  Linux/amd64 image `docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`.
- Dedicated local Docker fixture: four CPUs, 3 GiB memory limit, 1 GiB JVM heap, fresh
  owned volume, security disabled, no external Hyperion services, loopback ephemeral port.
  Client host: Windows x64; Docker 29.8.2, overlayfs, 32 CPUs and approximately 47 GiB
  available to its VM. Other host workloads were not controlled.
- Installed client **8.19.1**, transport **8.10.1**; request headers retain
  `compatible-with=8`. No JavaScript dependency changed. Node **24.19.0** and Bun **1.4.3**
  are recorded separately. Bun's application selector chose `HttpConnection` automatically.
- Three exact indices, each four primaries and zero replicas: two populated and one empty.
  `global_sequence desc` index sort, one-second refresh, `best_compression`; bounded action
  mappings and actual built `get_actions` filter/sort/pagination helpers. This does not load
  the entire production template or exercise the HTTP route's full response pipeline.
- Each execution seeds 2,000 known actions, warms queries, runs five read-only and five
  mixed windows, then verifies all 2,500 acknowledged documents. Concurrent writes add 100
  actions per mixed window; reads use the prior stable sequence ceiling. Each run checks
  674 search requests and nine bulks, including warmup/final checks. Count, complete page
  order, IDs and every new-document bulk acknowledgement must match independent predicates.

The [runner guide](../es955-qualification.md) describes invocation and mutation guards.
Provision a fresh, uniquely owned fixture with the manifest's image/resources/settings,
obtain its actual cluster name/UUID, and use new prefixes and output paths for every run.
The original shared-name E2E stack was not started or purged for this experiment.

## Results and evidence

All five runs acknowledged **2,500 documents**, had **zero failed measured requests or bulk
items**, and removed all three owned indices. The three unprofiled cases below used the
same workload sequentially on one warmed server. Values are pooled request wall times,
not independent runtime trials or end-to-end indexing throughput.

| Client / selected connection | Read-only search p50 / p95 / p99, ms (265 requests) | Mixed search p95, ms (291 requests) | Mixed bulk median / maximum, ms (5 requests) |
| --- | --- | --- | --- |
| Node 24 / default UndiciConnection | 4.93 / 8.59 / 9.97 | 7.45 | 55.91 / 65.52 |
| Node 24 / explicit HttpConnection | 4.91 / 6.40 / 28.74 | 5.68 | 57.92 / 94.06 |
| Bun 1.4.3 / automatic HttpConnection | 4.71 / 7.27 / 11.93 | 5.87 | 62.17 / 72.94 |

The five mixed bulks per case cannot establish tail latency. The small ordered runs do not
support a runtime speed ranking. Each before/after server sample observed 2,500 indexing
operations, 80–88 refreshes, and zero merges, breaker trips or thread-pool rejections. This
means merge/pressure/rejection behavior was **not exercised**, rather than qualified.

Two additional executions captured client CPU and heap artifacts while preserving the same
data oracle. CPU sampling requested 1,000 microseconds; the Node profile has 3,706 samples
and Bun's has 85. Collection semantics differ; these short profiles do not support comparing
CPU percentages across runtimes. Node's heap artifact is a sampled-allocation profile
(512 KiB interval); Bun's is a JavaScriptCore heap snapshot, not equivalent sampled allocation
evidence. The later profiled runs were faster than the earlier controls, so this sequence
does not estimate collector overhead independently of warmup, ordering and host noise.

An ES hot-thread sample during the profiled Node run contains `TranslogWriter.syncUpTo`
and `FileChannel.force`. One write thread reports 3.5% CPU and 64.5% other time in that
200 ms interval. This is evidence of a sampled persistence wait, not an aggregate disk
bottleneck or a reason to weaken durability.

Raw reports, profiles, hot threads, the manifest and two failed development attempts are
preserved in [raw-evidence.tar.gz](evidence/es955-20261018/raw-evidence.tar.gz).
[Summary JSON](evidence/es955-20261018/summary.json) retains distributions and warnings;
[SHA256SUMS](evidence/es955-20261018/SHA256SUMS) covers the archive and public JSON files.
Every archived artifact was read back and checked against its manifest digest.

## Findings requiring follow-through

1. **Fixture allocation:** two draft-runner attempts timed out while creating their first
   index. Allocation explain showed `disk_threshold: NO`: the Docker filesystem had about
   96 GiB free, below the default high watermark's required 100.6 GiB. After verifying the
   container labels and cluster UUID, this disposable cluster received explicit absolute
   low/high/flood-stage thresholds of **20/10/5 GiB**. It became green. Both failed reports,
   ownership-checked cleanup and the allocation explanation remain preserved. This was a
   fixture failure, not a client compatibility failure. Disk checks remain enabled; no
   other cluster or host filesystem was changed.
2. **Timing consistency:** all five runs contain anomalous bulk samples. For example, Node
   default mixed window 1 reports server `took=200 ms` with client wall **55.66 ms**; Bun's
   default mixed window 2 reports **200 ms** versus **62.17 ms**. Values are retained and
   flagged in `timing_warnings`; they are not corrected or subtracted to infer network wait.
   The cause is unresolved. Reproduce with independent client/server clock observations on
   a controlled Linux host before using bulk `took` for attribution. No ES regression or
   VM-clock cause is established by this observation.

## Remaining #198 acceptance

Keep #198 open. Next slices must cover actual full templates/API/plugin mappings, timed-out
and failed/late shards, cancellation and post-failure heap/breaker recovery, multi-node
replication and pressure/partial-bulk durability, PIT if applicable, retained index creation
versions and the 8.19 upgrade bridge, and sustained controlled live/write/query profiling.
Full indexing, ABI correctness, fork recovery and the Bun uWebSockets runtime gap are not
covered by this client-level probe. Evaluate a 9.x client separately; these results do not
authorize a server-major migration or require a full Hyperion history reindex.
