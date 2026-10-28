# Source seal preparation and incomplete membership

The #371 component experiment on production source
`032813e243d4451dbac0fcb15a73296f21e47054` found repeated prefix work when
`trySeal` ran before any fragment and after each transaction arrived. With 32
transactions, the original journal read and freshly prepared 528 existing
fragments and 528 transaction links. A single final-only diagnostic seal read
and prepared 32 of each. These were synthetic parser-boundary inputs and the
existing controlled ES transport, not a Wire capture or Elasticsearch engine.

`sealPlan` now first reads and validates all bounded plan membership, including
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
speedup. The two-pass change still scans prior fragments and re-derives source
membership on incomplete attempts; actual full-worker replay acceptance remains
separate.
