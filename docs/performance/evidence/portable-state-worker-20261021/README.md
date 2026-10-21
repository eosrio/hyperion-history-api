# Portable MongoDB state through production workers — 2026-10-21

Code: `ad590df3fc820cbf9723c5d6530b5e88c4b967e4`,
[History API PR #242](https://github.com/eosrio/hyperion-history-api/pull/242),
for [#191](https://github.com/eosrio/hyperion-history-api/issues/191).
Reproduction: [portable state worker tracer](../../../qualification/portable-state-worker.md).
The [summary](summary.json) and [manifest](manifest.json) identify the exact runs and
[raw evidence](raw-evidence.tar.gz). Verify [SHA256SUMS](SHA256SUMS) before extracting.

## Verified result

| Native Linux runtime | Original Wire blocks | Held CRUD checkpoints | Bulk requests / successful items | Result |
| --- | ---: | --- | ---: | --- |
| Node 24.19.0 | 1–1,480 | 1,244 and 1,480 | 10,345 / 11,098 | Passed |
| Node 22.23.3 | 1–1,480 | 1,244 and 1,480 | 10,371 / 11,098 | Passed |

Both runs use the existing launcher, reader, deserializer, ingestors, a supervised
projection worker and a separate real Fastify API host. Actual RabbitMQ delivery,
the durable canonical source journal, the shared projection runtime and the native
MongoDB adapter feed `/v2/state/query`. The API never initializes a projection or
grants readiness from configuration.

The two healthy definitions select `sysio.msgch` primary KV tables and the ABI
deployed at block 222, SHA256
`5adef7ede21018b2891598858d2bb57cc9e06a5761ee7b794f15cf8b532db28b`.
Original physical rows and pinned official `clio` conversion receipts provide the
independent expectations. At 1,244, `attseq` ID 0 has `next:"5"` and outenvelope IDs
1/2 exist. At 1,480, `next` is `"9"`, IDs 1/2 are absent and IDs 3/4 exist. Actual
HTTP rows, equality filters, keyset pages, bounded counts and completeness headers
match those expectations.

Each run injects an actual owned-Mongo `failCommand` update/error2 fault after
completed block 1,243; six server entries are observed. Healthy projections retain
exact pending block 1,244 intents, expose retryable HTTP 503, then recover from the
same source after the fault is removed. A third invalid required-field mapping of
the same contract remains at checkpoint 1,243/pending 1,244 with HTTP 503, including
while the write fault is active. Healthy state and the existing block-history API
continue; source blocks are checked on both physical Elasticsearch data nodes.

SHiP sends/ACKs, reader and deserializer observations each cover 1–1,480 once.
The live RabbitMQ queue records 1,480 deliveries/ACKs and zero redelivery; all final
queues drain. These ACKs cover the source/history path. Mongo effects are verified
separately through durable recovery views and public HTTP results. State adds no
cross-store history acknowledgment barrier.

## Failures corrected during qualification

The initial one-MiB pressure fixture rejected the original 2,132,724-byte source
journal publication at block 13. This tracer explicitly uses a 64-MiB fixture;
the shared pressure fixture's one-MiB default is unchanged. A later diagnostic run
exceeded the old 10,000-request observation cap. This tracer now reserves 20,000;
the 256-MiB total byte and 16-MiB per-message caps remain unchanged.

[#243](https://github.com/eosrio/hyperion-history-api/issues/243) fixes original Wire
producer `is_active` values 0/1 reaching an existing Elasticsearch boolean mapping.
Conversion occurs at the built-in host handler; original source bytes, provider
values and retained Elasticsearch mappings remain intact.

Independent fault-path review also reproduced a stale-ready response when a
mapping failed and writing its failure marker was rejected. Production now
durably admits the exact certified block before contract-dependent source decoding
or mapping. Rejected diagnostic writes cannot erase that fence; successful
exact-source application clears it. Ordinary unadmitted lag and default runtime
duplicate replay retain their accepted behavior. Component regressions cover
mapping/decode errors, lost admission receipts, CAS misses, immutable inputs and
exact retry. They do not establish actual process-crash recovery.

## Versions, observations and limits

The host is Hyperion-3, Ubuntu 24.04 on a Ryzen 9 5950X/128-GiB machine. Native
workers run inside an exclusively owned LXD fixture limited to six logical CPUs,
12 GiB memory and 45 GiB disk; its pinned database/broker services run in Docker.
This is finite replay qualification, not an uncontained bare-metal benchmark or an
unbounded live-tail run. Inputs are original irreversible testnet captures, paced
in windows of at most 32. No transaction was sent to the live chain.

The locks pin SDK `414e7c2771d55f730a316310ff0d0ed54492d9e2`, Wire package
`e8c7162437a0d0f4e2211979b959f2d002bf3552`, MongoDB driver 7.2.0 and Elasticsearch
JavaScript client 8.19.1. Services use Elasticsearch 9.5.5, MongoDB 8.0.34 in a
one-member replica set, RabbitMQ and Redis with exact image digests retained in
the evidence. The Wire upstream revision is
`6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`; this is the named engineering profile.

Both runs have zero bulk response/item errors, but each retains **five one-copy
and 11,093 two-copy item acknowledgments**. The five are genesis block 1, three
initial ABI records and one delta. Later reads from both replicas do not strengthen
those original acknowledgment guarantees. This work does not qualify universal
two-copy acknowledgments or a retained-history upgrade.

| Process | Node 24 CPU seconds / peak RSS MiB | Node 22 CPU seconds / peak RSS MiB |
| --- | ---: | ---: |
| Projection owner | 223.986 / 385.199 | 224.638 / 337.016 |
| Active deserializer | 114.288 / 395.445 | 124.464 / 298.535 |
| Master | 78.671 / 341.930 | 81.585 / 208.062 |
| Reader | 11.850 / 224.465 | 13.145 / 167.430 |
| API host | 4.609 / 196.914 | 5.196 / 176.125 |

CPU is cumulative user+system process time; peak RSS is Linux `maxRSS`. These
samples include startup, pacing, waits and intentional faults. They identify
processes for further profiling; they do not attribute exclusive stage costs,
prove memory recovery, compare runtime throughput or justify an optimization.

All 14 observed processes per run exit zero, with parent-confirmed exits for all
12 children and no forced/unresolved/failed children. Mongo cleanup and subsequent
ES/Rabbit/Redis cleanup report zero residue. The owned LXD container is removed.
Postflight verifies the original Wire PID/binary/listeners and advancing head,
plus the original MongoDB, Elasticsearch and `tibs` services.

The complete unit suite passes 930 tests/6,683 assertions. Native adapter tests
pass 13/13 on each Node version. All nine CI checks pass at the code commit.
Independent final Spec and Standards reviews each report zero actionable findings;
a separate archive audit verifies the run evidence.

Original `sysio::onblock` action diagnostics remain explicit under
[Wire #15](https://github.com/eosrio/hyperion-wire-plugin/issues/15). State success
does not certify all action decoding. M2 auto-map, live mapping reload, actual
process-crash/fork recovery, required Rust paths, Bun runtime qualification,
secondary projections, full Wire support, AtomicAssets/AtomicMarket parity,
WormDB, stream-client #231 and complete release acceptance remain separate gates.

## Evidence interpretation

Bulk bytes, held-prefix snapshots, observer records and selected logs are retained
unchanged. `report.public.json` files explicitly project the original reports,
omitting connection/configuration/container-environment dumps and identifying
their original hashes. Public postflight/resource receipts likewise declare their
omissions. The manifest links every published member to its origin. Complete
original run archives were independently hash-verified before fixture removal;
their hashes remain in the manifest. This archive contains no dependency or
runtime binaries; source revisions, emitted-code hashes and binary hashes identify
those inputs.
