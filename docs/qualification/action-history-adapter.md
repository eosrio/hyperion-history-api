# Exact action history adapter foundation

This is the first implementation slice of [#225](https://github.com/eosrio/hyperion-history-api/issues/225),
under [#219](https://github.com/eosrio/hyperion-history-api/issues/219). It adds production modules for
the physical codec, mapping lifecycle, logical query compiler and PIT transport. **Host activation remains
disabled.** It does not close either issue or qualify a retained-history upgrade, the Wire testnet or 4.5.

The accepted contracts remain ADR 0053/0054 and the no-full-reindex upgrade requirement. See the
[public JSON migration](sequence-json-boundaries.md), [physical design experiment](action-sequences-design.md)
and [source coverage / caller inventory](action-history-coverage.md).

## Implemented boundary

| Module | Responsibility |
| --- | --- |
| `src/indexer/history/action-sequence-storage.ts` | Clone logical documents into strict `h45_sequences_v1` metadata and restore complete logical documents. Install/read back additive mappings and validate effective future templates. |
| `action-sequence-query-plan.ts` | Compile complete Boolean predicates independently for exact and qualified legacy cohorts; clip legacy operands before native long queries; emit exact string sort/cursor plans. |
| `action-history-adapter.ts` | Resolve concrete index UUIDs, open a PIT, require a coverage lease, run checks and native membership/count/page queries in that PIT, restore and project source privately, and close the latest PIT. |
| `action-history-coverage.ts` | State the backend-private source coverage authority/lease contract. The default authority refuses. It is not a durable journal implementation. |
| `action-source-projection.ts` | Apply logical includes/excludes after full metadata restoration, without exposing injected physical fields or rewriting contract data. |

`ElasticRoutes` accepts an internal `exactActionSequenceStorage` qualification option. All existing
production callers leave it false. The master retained-target capability guard is likewise opt-in.
There is no operator configuration enabling this candidate. Public HTTP, stream, cache and plugin readers
have **not** been switched to the new adapter. The additive namespace enters the ordinary action template;
its successful write now requires acknowledgment and actual named template readback. Existing index names,
`index_version`, physical index sort and retained documents remain unchanged by that template update.

The exact writer preserves the canonical root as its document ID, validates Wire source/root agreement,
and emits numeric uint32 ABI/code counters. It removes only copies exceeding their old signed mapping.
Receipt and authorization sidecars include explicit positions, receiver/account bindings, exact values and
20-digit keys. Restoration checks the complete associations and corresponding legacy copies. It never
infers the root from `receipts[0]`, mutates the caller's document or traverses arbitrary contract data.

The writer bypasses a default ingest pipeline using `pipeline: _none`; an unqualified final pipeline is
refused. Writable targets require complete stored source, compatible mappings, acknowledged updates and
stable UUIDs. Read-blocked or write-blocked legacy partitions are not automatically qualified for reads.
The effective template is simulated for the next target before the gated master can start workers.

The planner handles supported `term`, `terms`, `range`, `exists` and Boolean combinations, preserving
ordinary object-array membership. Unsupported sequence DSL, indexed tuple selectors, reserved physical
references and unqualified metadata sort options return an explicit unavailable error. This does not
introduce nested tuple semantics or waive #220. HTTP uint32 query text can become a native numeric operand;
stored/public counter values remain numeric.

Mixed sorting returns a 20-digit string from indexed exact metadata or a safe legacy long padded in
Painless. It does not use floating point, runtime queries or keyword ranges. Returned sequence cursor
positions must remain strings; the implicit PIT tie-breaker must be safe. Cluster script restrictions are
capabilities to qualify, not settings to change automatically.

## Coverage and availability

A source coverage authority must bind a lease to the opened PIT, concrete index UUID set, source evidence
and a scoped coverage generation. It must prove missing and empty inputs as well as present-row precision,
including every legacy sequence leaf whose predicates the compiler clips. It must fence forks, replay,
deletion, outside writers and index replacement before response/cache/stream publication.

There is deliberately no built-in authority that trusts a configuration flag or an Elasticsearch maximum.
The adapter's index-wide same-PIT probes are additional rejection checks. They cannot issue a coverage
certificate. Contract/time-filtered probes can miss a lost row; even a zero index-wide unsafe-survivor count
can follow selective replay that overwrote the final survivor. Persistent incomplete source membership
must survive both situations.

Under qualified producer semantics, a whole Boolean query proving roots confined to `[1, MAX_SAFE]` can
exclude unsafe-root rounding losses. Receipt-only bounds, unsafe exclusions and unsafe OR branches do
not provide that proof. Other receipt/auth metadata still needs independent qualification. A canonical
pre-threshold source anchor and a proved protocol monotonicity invariant can qualify common safe old
history without replaying all of it; this source qualification is not implemented by this foundation.

Native membership, total hits, offset and cursor pagination happen before returning a page. `count` uses
`_search size:0` in the same PIT and preserves its numeric count contract. Selected non-sequence numeric
aggregations can use the adapter; metadata aggregations, nested top hits and secondary filter queries
remain explicitly unsupported until translated. Filtered/routed aliases also require a scoped coverage
implementation; unfiltered aliases and concrete/wildcard targets retain their actual index identities.
PIT opening uses the resolved concrete names, never a second mutable alias/wildcard lookup. Selected
metric operators are explicitly allowlisted; `global`, `filter`, `filters`, opaque scripts and other
unqualified aggregation/query paths cannot escape the compiled membership and coverage scope. The mixed
legacy counter profile uses the existing root signed-integer domain; wider retained root counters require
separate qualification and are refused rather than clipped out of successful counts.

Each context owns one request at a time and the latest PIT ID, including IDs returned with partial results.
Timeout, failed shards, early termination, cancellation, stale generations, source mismatch and shaping
errors cannot become successful pages. Cleanup uses an uncancelled request and releases both PIT and
coverage lease. Indexed namespace-version evidence prevents pruned source from falling back as legacy.

## Qualification

After `npm ci --allow-git=all` and `npm run build`, run:

```sh
node scripts/qualification/check-action-sequences.mjs action-sequences-report.json
```

The runner imports emitted production modules under native Node and exercises them against its owned,
resource-bounded Elasticsearch 9.5.5 server. Its production-module fixture uses a finite original-input
manifest and explicitly fixture-only authority, with known empty inputs and concrete UUIDs. It checks
additive retained mappings, the real bulk route and redelivery, full-range restoration, metadata queries,
numeric uint32 counters, mixed counts/pages/cursors, logical source filtering, collision taint that survives
the last unsafe row, scoped availability, generation/cancellation cleanup and source-pruning refusal.

Its original design experiments remain separately labeled; the category-filtered prototype probe does
not become a valid coverage proof. The report keeps `liveActivation`, `durableCoverageAuthority`,
`retainedHistoryUpgrade`, `wireTestnet` and `release` false. Small scalar-fixture times are descriptive;
they identify no production bottleneck or optimization. Repeat native checks on Node22/24, then qualify
actual source-pinned Antelope and both Wire engineering profiles before the host integration is accepted.

## Required next slices of #225

1. Implement the durable bounded source manifest/journal and scoped generation protocol, including
   canonical empty blocks, expected IDs, per-item durable effects, visibility and resumable reconciliation.
   Qualify pre-threshold retained history from source anchors; preserve incomplete taint until source replay
   recovers every missing identity. Existing reader/RabbitMQ/ABI checkpoints do not certify action effects.
2. Migrate the inventoried HTTP, count/statistics, historical stream, transaction/cache, archive and enabled
   executable-plugin readers. Keep logical metadata in caches and bind their reuse to coverage generations.
   Integrate repair, fork, reindex and retention invalidation before their mutations.
3. Qualify all scopes and failure paths, stored source/mappings and future partitions, plugin compatibility,
   native Antelope and both Wire engineering profiles, with the selected Wire testnet still a release gate.
4. Only then expose normal per-chain activation and enable the writer. Profile stage/resource costs with
   guarded ABI-correct workloads before choosing physical sort or mixed-query optimizations.

These are remaining implementation and acceptance obligations, not a requirement to rewrite all existing
history or a waiver of any 4.5 support/parity gate.
