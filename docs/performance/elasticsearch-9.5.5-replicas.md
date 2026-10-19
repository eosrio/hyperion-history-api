# Elasticsearch 9.5.5: replicas, bulk pressure and durable acknowledgments

Measured 2026-10-19 for [#198](https://github.com/eosrio/hyperion-history-api/issues/198).
Three final runs passed: Node 24.19 with explicit HTTP, Node with its default client
connection, and Bun 1.4.3 with automatic HTTP selection. Each run verified **1,523
persisted documents** across four owned indices, for **4,569** across the final runs.
Earlier development reports are retained separately and excluded from these totals.

This slice combines a real multi-node Elasticsearch fixture, native indexing-pressure
rejections and the built Hyperion `ElasticRoutes` class using real RabbitMQ deliveries.
It also reproduces the distinction between active-copy admission, a two-copy write
receipt, and a successful write acknowledged by only one remaining copy.

## Reproducible scope

- Elasticsearch **9.5.5**, build `48acba663b09e70b115dd879329141506c377890`, Lucene
  **10.5.1**. Image:
  `docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`.
- Two data/master/ingest nodes, each limited to **2 CPUs, 3 GiB memory and 1 GiB JVM
  heap**, plus a master-only witness limited to **1 CPU, 1.5 GiB memory and 512 MiB
  heap**. All three nodes are master-eligible. The witness is an ordinary eligible
  master, not a voting-only node. This retains an election majority when either data
  node is killed. [Elastic's small-cluster guidance](https://www.elastic.co/docs/deploy-manage/production-guidance/availability-and-resilience/resilience-in-small-clusters)
  explains why two eligible nodes alone would not provide that failure tolerance.
- Dedicated RabbitMQ **4.3.4**, Erlang/OTP **27.3.4.15**, limited to **1 CPU and 1 GiB
  memory**. Image:
  `rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef`.
  The queues are durable classic queues; messages use persistent delivery mode and
  publisher confirms. Broker restart and broker storage durability are not exercised.
- Loopback ephemeral HTTP/AMQP ports, dedicated labelled containers, volumes and network,
  Elasticsearch security disabled, and test-only low/high/flood disk watermarks of
  **20/10/5 GiB**. Disk checks remain enabled. Other host workloads were not controlled.
- JavaScript client **8.19.1**, transport **8.10.1** and AMQP client **2.0.1** remain pinned. Bun's reported
  Node compatibility version is not a separate Node execution. No dependency upgrade
  or live cluster setting change is part of this experiment.
- Every index has one primary, refresh disabled during writes and **explicit
  `index.translog.durability=request`**. Three indices have one replica; the separate
  translog-replay index has zero replicas and is pinned to the node that will crash.
  The synthetic mapping contains long sequence/block fields and an unindexed payload.
  It does not load production history or plugin templates.

The harnesses are [es955-replicas.ts](../../scripts/qualification/es955-replicas.ts),
[es955-pressure.ts](../../scripts/qualification/es955-pressure.ts),
[es955-broker.ts](../../scripts/qualification/es955-broker.ts) and the
[owned fixture lifecycle](../../scripts/qualification/es955-replica-fixture.ps1).
The qualification code was prepared at commit
`1a122d84a8b3bc1f05f5450ab940bbd117d9d228`, on runtime correction
`3bd95443e56fe2056938561b534e7e52bbc0baa4`; follow-up runtime commit
`361213c023774dea96e8016863f565a0ee6a2bea` adds settlement-channel failure recovery.
Qualification commit `0116466a583951eac5bf7d2cf08e6dbdd7205bba` records the final
physical-copy checks and cleanup/error-preservation corrections. Exact measured
source/build bytes are archived and checked against every final report's `sourceHashes`;
Git line-ending normalization means these byte hashes are not asserted to equal
normalized Git blobs. The final fixture was created with the hardened lifecycle helper.
The earlier fixture's original creation helper and evidence bundle are retained
separately as excluded development evidence.

## Native bulk pressure and exact replay

Each run sends **640 documents** in a **2,058,240-byte** bulk to an otherwise idle,
owned index. The fixture sets the static node pressure budget to **1,048,576 bytes**.
All three final initial requests returned a native coordinating-stage **429** with
`es_rejected_execution_exception`, the configured limit and accounted operation bytes
in the reason. Matching native counters increased; this is distinguished from a generic
429, a write-thread-pool rejection or a circuit-breaker trip.

Rejected documents are retried with the **same IDs and identical source documents** in
eight-document chunks. All 640 obtain aligned, error-free receipts with two successful
shard copies and no failed copy. Realtime reads and refreshed exact-source/count checks
verify the final data. Each run used **81 bulk requests** and **4,116,480 submitted
NDJSON bytes** in this direct pressure module. The configured bounds are 3 MiB per
request, 8 MiB total, one concurrent request and two bounded attempts per retry chunk.

Three consecutive recovery samples must show pressure reservations and write-pool work
back at baseline within a 15-second gate; incomplete node statistics and samples that
finish after the deadline cannot pass. In these runs the gate completed in roughly
**0.79–0.80 seconds**, including polling. These are recovery-observation times, not a
throughput comparison between runtimes.

The [pressure documentation](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/indexing-pressure-settings)
describes separate coordinating, primary and replica accounting. The
[exact admission implementation](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/index/IndexingPressure.java#L238)
rejects an over-budget reservation and reverses its charge. The deliberately small
budget makes this native path reproducible with a few megabytes; it is not a production
setting, sustained saturation result or test of large heap-pressure recovery.

## Physical-copy verification after pressure and recovery

Before the process crash and again after green recovery, the harness checks the complete
pressure and broker datasets independently on **both physical data-node copies**.
Each search uses `_only_nodes:<node-id>`, requires exactly one successful shard and no
failed shard, and compares every document ID, full source and exact count. Thus both
nodes must contain all 640 pressure documents and all 642 valid broker documents at
both checkpoints: **eight physical-copy dataset checks per run**, or **24** across
the final runs. These repeated observations do not increase the persisted-document
totals above.

The [pinned server routing implementation](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/cluster/routing/IndexShardRoutingTable.java#L405-L429)
builds this iterator exclusively from the selected nodes and throws if none can serve
the shard. It provides no fallback to an unselected node, so the two successful
node-specific observations cannot both be satisfied by one healthy copy.

This closes a concrete verification gap in an earlier control: a default-routed search
plus successful two-copy receipts did not independently inspect each physical copy of
the pressure/broker datasets. Three earlier passing runs with that weaker data
verification are preserved as controls and excluded from the final aggregate.

[Elastic #158235](https://github.com/elastic/elasticsearch/pull/158235) describes a
different native failure path: rejection while accounting for a translated update's
expanded bytes during the primary item loop could abort replication of earlier work.
The current fixture forces **coordinating-stage admission rejection**, not that
mid-primary-loop update expansion failure. The physical-copy checks establish the
replication invariant for this measured corpus; they do not constitute a direct
regression of every path addressed by #158235.

## Actual Hyperion route and broker settlement

The broker module instantiates the **built `ElasticRoutes` implementation**, uses real
AMQP delivery tags from manual-ack `basic.get`, and forwards each bulk to the actual
Elasticsearch client. A recording wrapper retains the original network response; it
does not synthesize backend outcomes. Each run confirms **646 persistent messages**,
including three unrelated held sentinels and one deliberately malformed document.

| Case | Measured outcome per run |
| --- | --- |
| Healthy action with another delivery held on the same channel | One two-copy action receipt; after channel close, only the sentinel is redelivered |
| Two-item bulk with a malformed long field | Valid item receives a two-copy receipt and is acknowledged; the real `document_parsing_exception` item is **400** and remains pending; held sentinel is preserved |
| Whole-request native pressure rejection | A second roughly 2 MiB bulk is rejected with native **429**; only its 640 deliveries are requeued, while the unrelated sentinel remains held |
| Bounded replay through the same actual route | All 640 original payload byte hashes are unchanged; eight-document chunks obtain two-copy receipts and individual acknowledgments; after closing the original channel, only its sentinel returns |

The action index contains exactly **642 valid documents**. The malformed original
document is never corrected or counted as a successful durable write. It remains
requeued until explicit deletion of the owned test queue; that deletion is fixture
cleanup, not an acknowledgment. All three queues are deleted per run, with their
remaining counts and deletion receipts preserved. No channel errors were recorded.

The scoped runtime correction in [#204](https://github.com/eosrio/hyperion-history-api/pull/204)
settles only the deliveries belonging to the completed batch and validates complete,
ordered bulk item receipts. The real sentinel observations exercise the failure modes
of channel-wide `ackAll`/`nackAll`. A follow-up failure hook requests a worker exit when
settlement has failed on its current delivery channel, so the supervisor can replace
it; a stale channel cannot terminate its replacement. Focused route regressions and a
child-process exit check cover that hook. The live fixture does not launch the full
worker/master or observe a complete supervised respawn. These results do not establish
behavior of the full worker,
reader, master, queue-budget or live-priority scheduling path. The qualification oracle
requires two copies for designated healthy receipts; this does not imply that every
configured runtime write universally waits for every replica.

## Replica promotion and translog recovery

Each run first acknowledges **120 seed documents on both copies** of a replicated
index. It then acknowledges a separate 120-document index with zero replicas on that
same primary node. Immediately before SIGKILL, the latter has **120 uncommitted
translog operations**, **75,198 uncommitted bytes** and an unchanged Lucene flush count
of **0 → 0**.

After the primary process is killed, the surviving data node promotes its replica and
serves the exact 120 replicated seeds. While its partner is absent:

- `wait_for_active_shards=all` rejects a unique write with item status **503** and
  `unavailable_shards_exception`; that ID is verified absent.
- `wait_for_active_shards=1` acknowledges a different write with
  `_shards={total:2, successful:1, failed:0}`. The two-copy acceptance oracle explicitly
  rejects that receipt. The write remains a valid **single-copy acknowledgment**.

These observations match the [active-shard contract](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-index):
the availability check runs before execution, so response copy counts still matter.
They also exercise the master/in-sync-copy behavior described in
[Elastic's replication model](https://www.elastic.co/docs/deploy-manage/distributed-architecture/reading-and-writing-documents).

The same crashed container is restarted with its original volume. The zero-replica
index recovers on its original node with **`EXISTING_STORE`, `DONE` and exactly 120
replayed translog operations**. Exact sources/counts pass. The cluster becomes green,
and both data-node copies independently serve the 120 seeds plus the degraded write.
The [recovery API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-indices-recovery)
exposes the store type and replay counters; this separates actual local replay from
merely reading another surviving replica.

The [translog contract](https://www.elastic.co/docs/reference/elasticsearch/index-settings/translog)
states that request durability waits for fsync/commit on primary and allocated replicas,
whereas async durability permits loss since the last sync. This experiment explicitly
uses request durability and measures process-crash recovery. Docker's
[SIGKILL behavior](https://docs.docker.com/reference/cli/docker/container/kill/) does not
simulate host power loss, an operating-system crash, storage-controller failure or a
disk that lies about fsync. No async-loss claim is made.

## Final evidence and limits

| Runtime / client connection | Direct pressure documents | Valid broker documents | Replicated seeds + degraded write | Local translog replay | Verified persisted total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 24.19 / explicit HTTP | 640 | 642 | 121 | 120 | 1,523 |
| Node 24.19 / default connection | 640 | 642 | 121 | 120 | 1,523 |
| Bun 1.4.3 / automatic HTTP | 640 | 642 | 121 | 120 | 1,523 |

[Summary](evidence/es955-replicas-20261019/summary.json),
[manifest](evidence/es955-replicas-20261019/manifest.json),
[raw reports and exact measured sources](evidence/es955-replicas-20261019/raw-evidence.tar.gz)
and [checksums](evidence/es955-replicas-20261019/SHA256SUMS) preserve all final runs,
development attempts and fixture cleanup. All **69 archived members** were read back
and byte/hash-verified against the manifest. The compressed archive is **4,076,188
bytes** and retains the superseded pre-physical-copy bundle as excluded provenance.
Exact source/build snapshots cover all **11** independently hashed files in each final
report.

The first development run failed a single-sample queue-ready assertion after a real
mapping failure. Its outer report omitted the inner broker receipts; that evidence gap
is retained explicitly. The corrected probe records inner component evidence on errors
and requires two consecutive exact queue counts within five seconds, with immediate
failure on excess deliveries. Final samples show the expected requeue count arriving
after the first observation. A passing pilot predating the ephemeral-port restart fix
is also retained and excluded from final totals, as are three passing runs predating
the cleanup/error-path audit, another Node HTTP control predating the final worker
failure hook, and three controls predating physical-copy verification of the pressure
and broker datasets. The original precommit main-runner byte snapshots for
the first failed run and pilot were not saved; those reports preserve their recorded
hashes, with this limitation explicit in the manifest. No reconstructed source is
represented as the measured version. The initial setup failed before external Docker
creation: its PowerShell wrapper was named `Docker` and invoked `docker`, resolving
back to itself until call-depth failure. A bounded command-lookup control independently
reproduces that recursion with zero external Docker calls. The first intent manifest
and zero-resource cleanup receipt are preserved; the original failed command transcript
was not saved. An earlier report incorrectly attributed this failure to JSON depth.
The retained creation helper instead uses the supported `ConvertTo-Json -Depth 20`.

The cleanup audit added intent journaling before resource/index creation, idempotent
removal that checks exact labels and volume consumers, and independent client-close
error handling so raw reports remain writable. Four isolated failure scenarios cover
Docker creation failure, port discovery failure, interrupted removal and repeated
cleanup, with **zero real Docker calls**. Their script and both reviewer/owner results
are archived separately from live qualification. The complete branch unit run passed
**211 tests / 1,824 assertions**; runner and whole-application typechecks and the TS7
build also passed. These local checks are separate from CI acceptance.

The owner postflight found **zero owned indices, tasks, queues and broker connections**,
with no current pressure reservations or query/write work. Exact-label cleanup then
removed **four containers, four volumes and the dedicated network**, leaving zero
labelled resources. The separately preserved failed initial setup also has a zero-residue
cleanup receipt.

Keep #198 open for retained-history creation/upgrade compatibility, complete production
templates and API/plugin mappings, full worker/master backpressure and acknowledgment
integration, translated-update primary-expansion rejections, sustained
throughput/heap/circuit-breaker workloads, and controlled mixed
live/write/query profiling. This result neither qualifies a production server-major
migration nor establishes full Bun support. Existing history remains subject to the
separate compatibility gate; this slice introduces no requirement to reindex it.
