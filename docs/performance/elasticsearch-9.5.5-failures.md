# Elasticsearch 9.5.5: timeout, shard failure, cancellation and recovery

Measured 2026-10-19 for [#198](https://github.com/eosrio/hyperion-history-api/issues/198).
This slice combines real Elasticsearch fault injection, actual Hyperion route contract
tests with controlled dependencies, and an offline check of the server's production
result-consumer classes. Each has a different acceptance boundary.

All three final runs passed **87 trials each**, for **261 final trials**. The earlier
development reports are retained separately from these totals. The owning runtime lane
verified that no probe index, key or search task remained, then removed the labelled
disposable container and its sole-use volume.

## Reproducible scope

- Server **9.5.5**, build `48acba663b09e70b115dd879329141506c377890`, Lucene **10.5.1**.
  Image: `docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`.
- Dedicated disposable Docker node: four CPUs, 3 GiB memory limit, 1 GiB JVM heap,
  loopback ephemeral port, owned volume, security disabled. The test-only disk watermarks
  are low/high/flood-stage **20/10/5 GiB**; disk checks remain enabled. No live cluster
  was changed. Other Windows and Docker host workloads were not controlled.
- Installed JavaScript client **8.19.1**, transport **8.10.1**. Node **24.19.0** uses
  both its default `UndiciConnection` and explicit `HttpConnection`; Bun **1.4.3** uses
  the application's automatic `HttpConnection` selection. No dependency upgrade occurs.
- Four exact synthetic indices, one primary each, zero replicas, refresh disabled during
  seeding, `global_sequence desc` index sort. They contain 400 healthy, 400 slow and
  200 failure-target documents; the fourth index is empty. Every run acknowledges
  **1,000 documents**, verifies sorted IDs and sort values, and removes its four indices.
- The actual built `get_actions` filter/sort helpers construct the queries. This does
  not load the complete production template, plugin mappings, ABI processing or HTTP
  response pipeline into the real Elasticsearch fixture.
- A small native plugin, compiled against the exact image with bundled Java 27, injects
  bounded delays, ordinary shard exceptions and a precollection rewrite timeout.
  Its jar SHA256 is `b4b5dc18a313d2d1ed409843ec88b2e0f130fd6d99dda3ce8afaacbaac7622d1`.
  This fixture is not installed or loaded by the application/runtime; use it only on a
  disposable node. Its [README](../../scripts/qualification/fixture/README.md) describes
  construction and observation. The main harness is
  [es955-failures.ts](../../scripts/qualification/es955-failures.ts).

The measured runner was an uncommitted source snapshot on API commit
`de8b19053486a820e51d690e1653d9684ccc2de1`; its exact SHA256 is
`cfaacacbd00388df176ff46d2dcda32f6ba9d5338e55c3c11094e9bfbf94bd6c`.
Raw reports independently record that hash, the plugin source hash, built helper hashes,
runtime versions, cluster identity, requests, responses, effective settings, samples and
cleanup. The manifest records source snapshots rather than claiming that an earlier
commit already contained this experiment.

## Fault and recovery oracle

Each final run performs five waves, with **87 trials** in total:

| Case | Trials per run | Required outcome |
| --- | ---: | --- |
| Healthy sorted controls | 12 | All 1,000 IDs and sort values in both directions, no timeout or failed shard |
| Timeout before collection | 20 | `timed_out=true`, no ordinary failed shard, exact 600 unaffected hits; both sort directions and both requested index orders |
| Strict timeout before collection | 10 | Explicit server error **429** when partial results are disabled |
| Collection-time deadline | 10 | Actual timeout during a cooperative bounded delay, exact unaffected sorted hits |
| Ordinary partial shard failure | 10 | Exactly one failed shard, `timed_out=false`, exact 800 unaffected sorted hits |
| Strict ordinary shard failure | 10 | Explicit failure when partial results are disabled |
| HTTP abort | 5 | Abort after the delay has entered; observe server cancellation and bounded resource recovery |
| Explicit task cancellation | 5 | Cancel only the tagged coordinating task; observe server cancellation and bounded recovery |
| Bounded script completion after abort | 5 | Client aborts, the deliberately noncooperative delay finishes, and owned server work drains |

The early-timeout query mirrors the exact-build upstream
[rewrite-timeout test](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/internalClusterTest/java/org/elasticsearch/search/SearchTimeoutIT.java#L684).
It exercises the sorted-result shape addressed by
[Elasticsearch #160132](https://github.com/elastic/elasticsearch/pull/160132).
All nodes here are 9.5.5; this does not exercise malformed responses from older versions
in a mixed-version cluster. Reversing the requested index list does not guarantee a
particular shard-response arrival order.

Cancellation is synchronized on an actual active delay, with `X-Opaque-Id` tags used to
locate the coordinating task. A client-side abort error alone is insufficient. The
harness also requires native cancellation evidence and disappearance of the tagged
server tasks. After cancellation, after each wave and at the end, three consecutive
samples must show baseline open search contexts, current query/fetch work and request
breaker bytes, unchanged breaker-trip count, and no owned task or active fixture delay.
The recovery gate is **15 seconds** and checks its deadline after observation completes,
so a slow sample cannot produce a late passing result. A failed run may finish recording
an individually bounded request after that gate has expired.

## Measured results

| Runtime / connection | Final trials | Longest per-case recovery gate, ms | Sampled JVM heap range, MiB | Warm baseline / final JVM heap, MiB |
| --- | ---: | ---: | ---: | ---: |
| Node 24 / explicit HTTP | 87 passed | 1,831.04 | 201.70–597.70 | 201.70 / 597.70 |
| Node 24 / default Undici | 87 passed | 1,823.14 | 200.99–645.70 | 645.70 / 552.99 |
| Bun 1.4.3 / automatic HTTP | 87 passed | 1,743.74 | 162.74–664.99 | 664.99 / 510.74 |

These times measure the post-outcome polling gates, including deliberately late bounded
script completion and the required three samples; they are not query latency or runtime
performance comparisons. The cases ran sequentially on the same warmed server. Each
final run had 12 healthy controls, removed all four owned indices, and finished with zero
owned search tasks, open contexts, current query/fetch work and request-breaker bytes.

The peak sampled request-breaker charge was only **2,104 bytes** per run, with **zero
breaker trips**. Search context/query work was observed above zero during active faults
and returned to baseline. This exercises cleanup with a small exposed charge; it does
not qualify recovery from large aggregation memory pressure, circuit-breaker rejection,
out-of-memory conditions or a heavily loaded server.

An earlier 77-trial control predates the ten strict precollection timeout cases. A later
87-trial preaudit control predates review hardening of the recovery oracle. Both are
preserved and excluded from final totals. Review reproduced and fixed acceptance of
incomplete node statistics and a possible passing sample completed after the recovery
deadline; the six guard regressions passed **37 assertions** before the final runs.

Heap and garbage-collection samples are recorded separately from the resource-release
oracle. An exact return to the initial JVM heap value is neither required nor implied:
caches, JIT compilation, pools and GC affect it. Request-breaker/context/task recovery
provides measured exposed-accounting recovery for these finite cases; it does not prove
absence of every retained reference, pooled-buffer leak or long-duration memory problem.

## Successful results delivered after consumer close

The deliberately late script above completes after the HTTP client aborts. That alone
does **not** establish that a successful shard response reached an already closed
coordinating result consumer, the path addressed by
[Elasticsearch #160439](https://github.com/elastic/elasticsearch/pull/160439).

Several development attempts tried to hold a successful response while causing an
aggregation reduction failure. They did not establish the required ordering. The
[exact-build callback](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/action/search/TransportSearchAction.java#L2199-L2206)
cancels the task rather than immediately failing and closing that consumer. The original
source-review note and failed draft reports remain in the archive with an explicit
superseded status. They must not be counted as a successful REST regression test.

The separate [offline check](../../scripts/qualification/fixture/HyperionLateResultCheck.java)
executes the real `ArraySearchPhaseResults` and `QueryPhaseResultConsumer` classes from
the image's production jar, with Java assertions enabled. It covers close before late
consume, a close in the reference/store gap, close after an explicitly supplied phase
failure, and 200 concurrent close/consume rounds for each class, with eight shard results
per round. It checks references, continuation callbacks, discarded aggregations and
breaker accounting. Its author run and the owner's independent rerun each passed
**5,429 checks**, with a measured early aggregation charge of **23 bytes** released to
zero. These bounded internal assertions are distinct from Hyperion HTTP
integration, a complete upstream test suite or distributed transport-ordering coverage.

## Hyperion action-query contract

An actual Fastify v1 POST/v2 GET route audit with controlled ES, Redis and chain API
dependencies reproduced a separate application defect: responses carrying
`timed_out=true` or a failed shard were shaped into HTTP 200 and cached. A disconnected
client's late result could also enter the cache. Raw red and green audits and their
sources are preserved alongside the server evidence; these are not real-ES route tests.

The scoped application fix rejects incomplete searches with **503**, maps transport
timeouts to **504** and request aborts to **503**, preserves upstream `ResponseError`
statuses, cancels the main ES search on an actual HTTP disconnect, and checks that the
request remains active before returning the shaped response to the cache layer. Healthy
JSON response shapes remain unchanged. Later archive/chain/ABI operations are not
independently cancelled by this helper; the final active check prevents their discarded
result from becoming a cache entry.

Pinned Fastify **5.8.5** binds its lazy `request.signal` to `IncomingMessage.close`.
The isolated signal controls reproduce that a healthy complete POST body aborts this
signal even though the connected client receives HTTP 200, on both Node and Bun. The
fix therefore observes `raw.aborted` and socket closure through its own controller,
with listener removal in `finally`, rather than forwarding that signal unfiltered.

## Evidence and remaining acceptance

[Summary JSON](evidence/es955-failures-20261019/summary.json),
[manifest](evidence/es955-failures-20261019/manifest.json) and
[raw evidence archive](evidence/es955-failures-20261019/raw-evidence.tar.gz) retain the
final cases, all five failed draft reports, the earlier control, corrected source-review
status, route audits, signal controls, fixture sources/jar, offline result and cleanup.
[SHA256SUMS](evidence/es955-failures-20261019/SHA256SUMS) covers the public archive and
JSON files. Every archived member is read back and verified against the manifest.

Keep #198 open for complete production template/API/plugin mappings, retained index
creation versions and the 8.19 upgrade bridge, multi-node replicas and recovery,
sustained pressure and partial-bulk durability, PIT where applicable, and sustained
controlled live/write/query profiling. Actual late successful transport delivery after
a closed REST coordinator consumer also remains unestablished by this fixture. This
slice neither authorizes a production server-major migration nor requires a full history
reindex, and it does not rank Node against Bun or establish full Bun runtime support.
