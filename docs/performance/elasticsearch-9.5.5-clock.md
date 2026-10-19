# Elasticsearch 9.5.5: bulk timing clock control

Measured on 2026-10-18 in São Paulo (2026-10-19 UTC) for
[#198](https://github.com/eosrio/hyperion-history-api/issues/198).
The short-bulk timing warning in the [initial qualification](elasticsearch-9.5.5-initial.md)
has a source-backed explanation supported by a controlled A/B/A experiment. ES bulk
`took` uses a cached monotonic clock with a default 200 ms update interval. A request
crossing a cache update can report about 200 ms while its complete HTTP round trip
takes much less. Requests between updates can report zero. These values cannot be
subtracted from client wall time to derive precise network/client overhead.

## Controlled observations

Each cell below represents 100 sequential, one-document bulk requests. An overshoot
means raw server `took` exceeds client wall time by more than 5 ms. Both probes use raw
HTTP, without the Elasticsearch JavaScript library. Node 24.19.0 uses `fetch` and
`performance.now()` on Windows; Java 27 uses HTTP/1.1 `HttpClient` and `System.nanoTime()`
inside the same Linux container as ES. Both timers include reading the complete body.

| ES clock interval, in execution order | Node overshoots / 100 | Colocated Java overshoots / 100 | Observed bulk `took` values |
| --- | --- | --- | --- |
| Unset, source default 200 ms | 3 | 4 | 0 or 200 ms |
| Explicit 0 ms, direct monotonic reads | 0 | 0 | Node 11–43 ms; Java 11–101 ms |
| Explicit 200 ms, cache restored | 9 | 8 | 0 or 200 ms; one Node response 209 ms |

All **600** responses contain one successful `201` item with the expected ID and
`errors: false`. Every probe removed its exact owned index. A final ownership-checked
cleanup removed the disposable container and volume with no labelled resources left.
The colocated reproduction shows that a Windows-versus-Docker clock difference and
the JavaScript client library are not required for this behavior. The setting-only
reversal supports the cached clock as the cause of this reproduced warning pattern.

All stages used the same volume and cluster UUID, image digest, resource limits and
request corpus. Only the clock setting changed between recreated nodes; the loopback
port/container ID and randomly named probe index necessarily changed. The fixture was
ES **9.5.5**, build `48acba663b09e70b115dd879329141506c377890`, image
`docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`,
four CPUs, 3 GiB container memory, 1 GiB heap, one primary, zero replicas, refresh
disabled. Test-only disk thresholds stayed at 20/10/5 GiB. This is a separate dedicated
fixture from the initial qualification. Host workloads, warmup and restart ordering
were not controlled for performance comparisons. The different medians and overshoot
counts therefore do not rank clients, quantify timer overhead or establish throughput.

## Exact server source

The links below pin the actual server build, rather than the changing main branch.

- [TransportBulkAction injects the timer](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/action/bulk/TransportBulkAction.java#L143)
  from `threadPool::relativeTimeInNanos` and
  [passes it into BulkOperation](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/action/bulk/TransportBulkAction.java#L861-L877).
- [The start time](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/action/bulk/TransportAbstractBulkAction.java#L430-L437)
  and [elapsed-time calculation](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/action/bulk/BulkOperation.java#L290-L292)
  use that supplier. The result is
  [stored in BulkResponse](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/action/bulk/BulkOperation.java#L492-L501).
- [`thread_pool.estimated_time_interval` defaults to 200 ms](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/threadpool/ThreadPool.java#L247-L252).
  [A zero interval reads System.nanoTime directly](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/threadpool/ThreadPool.java#L789-L794);
  positive intervals use the cache, whose updater
  [sleeps between reads](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/threadpool/ThreadPool.java#L825-L835).

For example, a hypothetical 10 ms request from 195 to 205 ms can read cached endpoints
of 0 and 200 ms. Timer scheduling can also delay updates; 200 ms is the nominal update
interval, not a guaranteed error bound. The observed 209 ms response is retained.

This setting is read at node construction and has only `NodeScope`, without `Dynamic`.
The experiment recreated **only its owned disposable node**; it did not submit a live
cluster-setting update. Disabling the cache affects other time consumers and is a
diagnostic control, not a production tuning recommendation. Standard harness defaults,
dependencies and live clusters remain unchanged by this experiment.

## Evidence and reproduction

[Summary](evidence/es955-clock-20261018/summary.json) contains all six distributions and
raw `took` histograms. The [manifest](evidence/es955-clock-20261018/manifest.json) hashes
each artifact in [raw-evidence.tar.gz](evidence/es955-clock-20261018/raw-evidence.tar.gz):
six full probe reports, exact Node/Java source and fixture restart script, per-stage
state/settings, variant Docker arguments, image/container metadata, executable hashes,
source research and final cleanup receipt. One earlier probe setup failure (HEAD was
incorrectly checked using an exact `_cat/indices` request, which returned 404) is also
preserved; it produced no measured samples and no index. No failed run is counted green.
[SHA256SUMS](evidence/es955-clock-20261018/SHA256SUMS) covers the archive and public JSON.

To repeat, extract the archive into a scratch directory and inspect the two probe sources.
Provision a fresh uniquely labelled, loopback-only fixture using the recorded digest and
resource/settings arguments; obtain its actual cluster name and UUID. Use new index names
and output paths. The archived restart script records this experiment's exact identity
guards and local paths; adapt it to that new fixture rather than running it verbatim.

1. Run the Node probe with the fixture state JSON and a new output JSON path.
2. Copy `EsBulkClockProbe.java` into the fixture and run its bundled JDK with arguments
   `http://127.0.0.1:9200`, the exact cluster name and UUID; retain stdout JSONL.
3. Recreate only the owned node at an explicit `thread_pool.estimated_time_interval=0ms`,
   preserving its volume/settings, then repeat. Restore 200 ms and repeat again.
4. Verify response IDs/status, exact-index cleanup, fixture ownership and final resource
   removal. Both probes exit 1 for a reproduced overshoot, 0 for no overshoot, 2 for failure.

This closes the timing-source investigation for the reproduced pattern. It does not close
#198: full templates/API/plugin mappings, timeout/failed/late-shard and cancellation
recovery, replicas/pressure/durability, retained-history upgrade evidence and sustained
profiling remain required. Continue using request wall time and server counters/profiles
for attribution, while preserving the raw server duration and its resolution caveat.
