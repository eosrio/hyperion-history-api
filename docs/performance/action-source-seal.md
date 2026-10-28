# Source seal preparation and incomplete membership

The #371 component experiment on production source
`032813e243d4451dbac0fcb15a73296f21e47054` found repeated prefix work when
`trySeal` ran before any fragment and after each transaction arrived. With 32
transactions, the original journal read and freshly prepared 528 existing
fragments and 528 transaction links. A single final-only diagnostic seal read
and prepared 32 of each. These were synthetic parser-boundary inputs and the
existing controlled ES transport, not a Wire capture or Elasticsearch engine.

Before traversing prefix fragments, `sealPlan` checks transaction-link manifest
existence with a bounded realtime `_mget`, with `_source:false`. Each batch still
freshly validates index mappings/settings. All returned items must match the exact
index and ordered IDs; malformed responses, item errors, transport failures and
cancellation throw, including when another item is genuinely missing. No ordinary
search, forced refresh, cached settings or durable-format change is involved.

A hint request contains at most 256 IDs and 64 KiB of canonical request JSON; response
bytes are bounded to 1 MiB both at the pinned transport and parsed-response boundary.
The journal scans multiple batches within its existing 100,000-transaction/128 MiB
plan limits. These per-request bounds do not lower the accepted plan size. The
hint is not a snapshot and proves no integrity, durability or canonical authority.
An observed missing manifest returns incomplete; presence continues through all
original fresh reads, validation and write receipts.

The complete path reads and validates all bounded plan membership, including
the assembled manifest. An incomplete attempt performs no sealing repairs.
Only a complete candidate starts the existing fresh plan/fragment/link prepares,
followed by manifest then seal publication. It keeps fragment-before-link order,
digest validation, CAS conflict checks, all-copy receipts, operation bounds,
cancellation and proof-consumer fencing. There is no persistent cache or new
completion index.

This deliberately changes error observation order. Previously an incomplete
attempt could fail a fresh prefix repair before finding a missing suffix. The
new attempt can find the missing suffix and return false without attempting
that opportunistic repair or observing its potential write error. This defers
repair; it does not grant a seal, coverage, durability, visibility or query
authority. Every actually attempted infrastructure operation can still fail,
and every successful seal still needs fresh complete-copy receipts for every
reference. Current-fragment and confirmed-handoff guards remain independent.

The realtime hint deliberately also defers prefix corruption/missing-chunk
observation while a link manifest elsewhere is absent. Once the final link arrives,
the next attempt must observe the same corrupt prefix and refuse a seal. A positive
hint never skips the full reads: deletion or mutation after it is handled by the
existing missing/integrity checks and fresh preparation. Caller cancellation and
owner/fork fencing apply after either positive or negative hint settlement.

The native differential control covers both partial and unknown receipt faults:
the original emission throws before discovering missing membership; the new
emission returns false without writes. Once the suffix arrives, the same faults
must throw, no seal may be published, and a later fault-free retry must repair
and succeed. Further controls cover complete publication order, corruption and
deletion between reading and writing, abort, and owner fencing. Existing journal
and admission tests cover receipt repair, infrastructure errors, bounds and
concurrent-operation admission.

Run the focused native control after the normal build:

```sh
npm run build
node --test tests/unit/action-source-seal-native.mjs
```

For a source-pinned component comparison, use a normally built checkout at an
exact Git commit and pass that commit explicitly:

```sh
node scripts/qualification/measure-action-source-seal.mjs \
  --module-root /path/to/built-checkout --expected-source <40-character-commit> \
  --output /path/to/component-result.json
```

The arrival schedule and logical/transport counters are unchanged by selecting
another source revision. The harness verifies tracked source bytes and records
emission hashes; retain normal-build provenance with each result. Treat nested
wall times as descriptive elapsed time, never exclusive CPU or a full Wire
speedup. The harness now separates incomplete and complete seal attempts from
transaction preparation, with independent compilation and hinted-item counts.
Default sizes are 1/2/8/16/32/64. The hint targets incomplete prefix reads; source
membership is still freshly re-derived on every attempt and preparation. Request
counts, payload bytes, compilation work and elapsed time are separate costs:
even a linear request count in the measured single-batch range does not imply
linear CPU or transmitted bytes, or a linear bound across all multi-batch plans.
Actual full-worker replay acceptance remains separate.

The controlled one-chunk measurement of runtime source `6db1ffd4` gives the
following sealing-request counts against the preceding two-pass source. Native
Windows Node 24.19.0 and 26.4.0 checks remain component evidence, not native ES,
Wire decoding or release acceptance:

| Transactions | Two-pass incremental | Hint incremental |
| --- | ---: | ---: |
| 1 | 64 | 66 |
| 2 | 106 | 102 |
| 8 | 484 | 318 |
| 16 | 1324 | 606 |
| 32 | 4156 | 1182 |
| 64 | 14428 | 2334 |

Within this measured range, incomplete attempts use at most `14N` requests in
aggregate and the complete attempt at most `22N+30`; incremental sealing totals
at most `36N+30`. The harness asserts those bounds for the controlled hint path.
Transaction preparation remains separate at `28N` requests. The complete attempt
pays two extra requests for the hint, so N=1 regresses from64 to66; a membership
hint does not optimize already-complete work.

Compiled transactions remain `N²` across incomplete attempts, `N` in the complete
attempt, and another `N²` during preparation. Aggregate hinted IDs are `N(N+1)`.
The harness records logical JSON request/response bytes for hints separately;
these are not captured wire bytes or an all-traffic census. Linear request count
over one bounded hint batch is not a linear byte/CPU bound, nor an extrapolation
to larger multi-batch plans. Pure compile memoization and broader batching remain
separate measured follow-ups; no metadata freshness or durable receipts are cached.
