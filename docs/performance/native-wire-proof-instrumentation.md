# Native Wire proof and observer accounting

Qualification instrumentation for [#277](https://github.com/eosrio/hyperion-history-api/issues/277),
[#248](https://github.com/eosrio/hyperion-history-api/issues/248) and
[#196](https://github.com/eosrio/hyperion-history-api/issues/196). This supplies the next
measurements after the [frozen CPU capture](native-wire-worker-profile-20261024.md).
It is not a new replay result, bottleneck determination or release qualification.

The guarded native worker preload installs the observer in every actual worker process.
It wraps the installed proof reader, immutable bundle store and Undici connection;
it does not replace results, request options, retries, cancellation or proof decisions.
No production source file, source fixture, 256-block ancestry default, queue policy,
durability requirement or timeout changes. Standalone module imports install no hooks.

## Records in `native-PID.jsonl`

Each actual `ProtocolAbiProofReader.open` call emits `proof_open_finished`, with a
process-local `openId`, requested chain/block identity and selection, first/last observed
canonical generation and head, outcome and elapsed nanoseconds. Failed opens are retained.
Authority observations are not a new applicability certificate or permission to serve.

Counters distinguish logical immutable-store GETs, bundle reads, commit-validation
calls, and actual connection GET attempts. The last includes authority/metadata reads
and transport retries; it must not be equated with immutable GETs or ancestry depth.
The independent loopback test compares the actual production proof walk with every
request received by its HTTP server, including a real 503 retry.

Response sizes are recorded at the installed connection return boundary:

- `compressedBodyBytes`: lengths of returned gzip/deflate buffers, before transport
  decompression and JSON parsing.
- `utf8ReencodedBodyBytes`: UTF-8 byte lengths of the connection's returned strings,
  including whitespace. These are not HTTP header/TLS/framing sizes. Invalid UTF-8 can
  be replaced by the connection's decoder, so this field is explicitly not raw wire bytes.
- `unknownBodySizes`: requests that throw or return an unmeasured body representation.
  Failed/aborted partial responses are not silently counted as zero-byte bodies.

`httpCompleted` counts connection returns, including non-2xx responses counted in
`httpNonSuccess`. `httpErrors` counts thrown connection requests. Subsequent transport
decompression/JSON/proof validation can still fail after a connection return.

Timing distributions cover complete bundle reads, logical GETs, connection requests,
authority calls and synchronous commit validation. They are nested elapsed intervals;
do not add them together, subtract them to claim CPU, or label connection elapsed time
as server execution or exclusive network wait. Parsing/hash CPU, exclusive wait,
queue residence and native codec costs require further attribution.

Cancellation can settle an open before an already-started operation finishes. Its
summary reports `operationsInFlight`; subsequent `proof_open_late_operation` records
retain the same open ID and updated accounting. Do not discard those records or treat
the first summary as complete I/O accounting while an operation remains outstanding.
Async-local scopes separate concurrent opens; no per-GET log write is added on the
ordinary path. A logging failure increments `reportFailures` without replacing the
original production return/error and makes the native observer's exit unsuccessful.

At shutdown, `observer_metrics` records write/sync counts, actual returned write-byte
counts, failed calls and elapsed distributions. `coverage: before-this-row` excludes
that summary and the following exit row's own I/O. The existing write-then-fsync for
every native record remains in place, including the new proof-summary records.
The logger's increased record volume and all instrumentation overhead must be measured
in paired controls before interpreting a new worker capture.

Each distribution keeps count, exact decimal-string total/minimum/maximum nanoseconds
and 64 bounded histogram buckets. Bucket 0 is zero; bucket b (1..62) covers
`[2^(b-1), 2^b-1]` ns; bucket 63 covers at least `2^62` ns. Bucket-derived percentile
bounds are not exact percentiles. Histograms retain no per-request sample arrays;
per-open accounting lives only with that operation's async scope.

## Validation and remaining work

Run the native regression on both maintained Node versions after the ordinary build:

```sh
node --test tests/native/portable-worker-proof-metrics.test.mjs
```

The tests use real proof/store implementations and the locked Elasticsearch client's
actual Undici transport against an ephemeral loopback fixture. The fixture's constructed
three-commit ancestry validates accounting; it does not qualify a Wire codec or busy-chain
memory. Tests also cover concurrent/cancelled scopes, late I/O, exact error preservation,
bounded distributions and actual guarded preload shutdown with synchronous logging.

Next: run a fresh owned native Linux capture with the unchanged original source/oracles,
inspect these records alongside all physical-worker profiles and original replay/ACK/
cleanup results, and measure logger overhead, host/backend I/O and exclusive validation/
wait attribution. Full replay, live canonical recovery, count/byte capacity and #248's
dense concurrent-view/retained-memory matrix remain open. Keep the failed historical
capture immutable. Use the current Node 24/26 release policy.
