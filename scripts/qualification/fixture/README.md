# Disposable ES 9.5.5 fault fixture

This plugin is solely for the isolated qualification harness. It is compiled against
the Java 27 and Elasticsearch jars already present in this exact image:

```text
docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c
```

It requires no dependency download, build tool, or running cluster. The build uses
`javac -Xlint:all -Werror`; the jar timestamp is fixed for reproducible output.
Run `build.sh` inside a disposable container from that image, with this directory
mounted read-only at `/fixture` and a new writable directory at `/output`:

```powershell
$fixture = (Resolve-Path scripts/qualification/fixture).Path
$output = 'C:\path\to\a\new\output'
New-Item -ItemType Directory -Path $output | Out-Null
docker run --rm --network none --entrypoint /bin/bash `
  --mount "type=bind,src=$fixture,dst=/fixture,readonly" `
  --mount "type=bind,src=$output,dst=/output" `
  docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c `
  /fixture/build.sh
```

Copy only `hyperion-qualifier.jar` and `plugin-descriptor.properties` into a new
`plugins/hyperion-qualifier` directory of the owned disposable node before startup.
The descriptor accepts only Elasticsearch 9.5.5. The Node.js harness remains
responsible for fixture ownership, limits, resource cleanup and recording evidence.

## Script gate

The `hyperion_qualifier` script engine accepts only source `gate` in filter context:

```json
{"script":{"script":{"lang":"hyperion_qualifier","source":"gate","params":{
  "key":"hyp-es955-example-timeout-1","mode":"timeout","delay_ms":1500
}}}}
```

Each document must have exactly one `qualifier_role` keyword doc value: `healthy`,
`slow`, or `fail`. Healthy documents match immediately. Slow documents delay once
per leaf factory, bounded to 1–2000 ms. Modes `timeout`, `cancel` and `mixed` call
the FilterScript cancellation check around nominal 5 ms parks and after the
delay. `fail` injects a shard failure on fail documents and never delays;
`mixed` combines the delay and injected failure. These are synthetic fault paths,
not measurements of natural expensive queries.

`late` intentionally omits cooperative checks during its one bounded delay.
This mode alone does **not** prove that a successful transport result arrives
after its coordinating result consumer closes. The separate offline
production-class check covers close-before-consume ownership.

Keys must match `hyp-es955-[a-z0-9][a-z0-9-]{0,69}`. A maximum of 64 keys and
256 retained events per key bound fixture metadata. Totals remain available when
old events are dropped. Query execution itself is bounded by the harness's
document, shard, concurrency and timeout limits.

## Early timeout

`{"hyperion_qualifier_timeout":{}}` forces a query-rewrite timeout on each owned
index. `{"hyperion_qualifier_timeout":{"index_suffix":"-slow"}}` forces it
only on index names ending `-slow`; other owned indices match all documents.
All names must start `hyp-es955-`. Set a normal request `timeout` as well.

This mirrors the upstream
[early timeout test](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/internalClusterTest/java/org/elasticsearch/search/SearchTimeoutIT.java#L684).
It distinguishes a timeout before collector initialization from a naturally
expired collection-time timeout.

## Observation

`GET /_hyperion_qualifier/state?key=KEY` returns `active`, `entered`, `completed`,
`task_cancelled`, `query_timed_out`, `failed`, `dropped_events`
and the event ring. The unfiltered endpoint lists all keys. Every event includes
its monotonic sequence, wall-clock time and elapsed monotonic milliseconds.
Exception class names remain in raw events. Only Elasticsearch's
`TaskCancelledException` increments `task_cancelled`; only
`ContextIndexSearcher.TimeExceededException` increments `query_timed_out`.
Other runtime exceptions and errors increment `failed`. A timeout is not proof
that a task was cancelled. These totals do not replace inspection of the actual
Elasticsearch response.

The separate totals `active_slow`, `slow_entered`, `slow_completed`,
`slow_task_cancelled`, `slow_query_timed_out`, `slow_failed`, `delay_active`, `delay_started` and
`delay_finished` remain available after event eviction. Use `delay_active > 0`
to synchronize cancellation with an actual running delay, then require it and
`active_slow` to return to zero. An event ring is diagnostic history and must
not be used as the sole synchronization mechanism.

Every entered execution has one terminal outcome, so `entered` equals `active`
plus `completed`, `task_cancelled`, `query_timed_out` and `failed`; the same
identity applies to the slow-role totals. The delay counter is released in a
`finally` block for every outcome.

`POST /_hyperion_qualifier/reset?key=KEY` removes an inactive key. Reset only after
the harness has confirmed that all corresponding tasks have ended; an inactive
instant between documents does not prove that a query has finished.

## Offline production-class ownership check

Run `check-late-results.sh` in a new disposable container with the same exact image
and `/fixture` read-only and new `/output` mounts described above. The command
compiles `HyperionLateResultCheck.java` and runs it with assertions enabled. It
does not start a server, install the fixture plugin or contact an external target.

The main class uses package access to the **production classes in the bundled
Elasticsearch jar**. It covers stored-result release, late arrival after close,
close from a continuation, a deterministic close between storage and reference
acquisition, and 200 concurrent consume/close rounds with eight shard results.
It also directly exercises `QueryPhaseResultConsumer` with real query results,
aggregation storage and a production reduction-context builder: close before a
late arrival, injected failure then close before a late arrival, and 200 concurrent
consume/close rounds. A supplied accounting breaker records the bytes the real
consumer charges and credits; this is not an Elasticsearch server heap measurement.
The cases avoid queued partial merges deliberately, and do not cover a merge
worker still running at close.

These independent checks are informed by the upstream
[array ownership tests](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/test/java/org/elasticsearch/action/search/ArraySearchPhaseResultsTests.java)
and [query consumer tests](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/test/java/org/elasticsearch/action/search/QueryPhaseResultConsumerTests.java).
The JSON result identifies its scope as `offline-production-class-check`. It
does not establish that a REST response ended before a late shard transport
response arrived. Keep it separate from the server timeout, failure, cancellation
and memory recovery reports.
