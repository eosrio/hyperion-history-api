# Exact action sequence index: native design prototype

This is the Elasticsearch design experiment for [#219](https://github.com/eosrio/hyperion-history-api/issues/219).
It does not qualify the production adapter, a retained-history upgrade, ABI proofs, the Wire testnet or the release.
The actual API, worker, cache, stream and archive paths still need end-to-end qualification.

Hyperion 4.5 returns uint64 sequence identifiers and aliases as canonical decimal strings on **every chain**,
including Antelope and Wire, under [ADR 0053](https://github.com/eosrio/hyperion-tools/pull/50).
The user also approved always returning `/v2/stats/get_action_usage.action_count` as decimal text, using exact
subtraction. Unrelated counts, block numbers, ordinals and uint32 ABI/code counters remain numeric.

## Physical representation

Use a versioned, strict core namespace, with two representations per logical sequence:

| Representation | Mapping | Purpose |
| --- | --- | --- |
| Canonical decimal string input, such as `9007199254740993` | `unsigned_long` | Native exact equality, exclusion and numeric range membership |
| 20-digit key, such as `00009007199254740993` | `keyword` with doc values | Exact order and JSON string sort tokens |

Keep the public sequence values as strings outside Elasticsearch. Physical fields and query translation belong
inside a shared adapter; endpoint handlers must not know these field names. The prototype namespace is
`h45_sequences_v1`, with `global.value`/`global.key` and corresponding receipt/authorization members.

Elasticsearch accepts quoted uint64 values and recommends strings for precise ranges. Native unsigned-long
sorts still return JSON integers, and mixed same-named `long`/`unsigned_long` sorts are unsupported. Those
limitations make a bare type replacement insufficient. The installed default client serializer parses large
JSON numeric tokens as JavaScript numbers. [Unsigned-long documentation](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/unsigned-long).

Using native numeric predicates avoids keyword range queries, which are rejected when
`search.allow_expensive_queries=false`. A padded key alone therefore does not satisfy the range requirement.
[Range-query restrictions](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-range-query#using-the-range-query-with-text-and-keyword-fields).

## Existing partitions and continued writes

Existing action indices map root, receipt and authorization sequences as signed `long`, and sort physically by
root `global_sequence desc`. Updating a template does not update an existing index. Adding the strict namespace
must be acknowledged and read back on retained target mappings before new writers start.

The physical writer keeps complete exact values in the namespace. It removes an individual old signed-long
copy when that value exceeds `2^63-1`; it preserves the receipt/account and complete namespace value. It does
not clamp, coerce through `Number`, ignore malformed values or treat a failed bulk item as successful.
Restoration must recreate the complete logical action before API/cache/stream/archive use.

The fixture also retains uint32 ABI/code counters as JSON numbers in optional `long` metadata sidecars when
they exceed the old signed-`integer` range. This tests storage shape only; it does not change their public type.

Preserve existing physical index names and immutable index sort initially. Missing old root sort values are
allowed by the documented sort settings; this prototype verifies the actual full-range write path. Explicit
query order uses the new key. Changing physical sort for future partitions requires separate profiling:
index sorting has ingestion and merge costs and cannot be changed on an existing index.
[Index-sort settings](https://www.elastic.co/docs/reference/elasticsearch/index-settings/sorting).

A global `settings.index_version` bump is not an upgrade mechanism. General reads use an all-version wildcard
or read alias, while transaction block hints and some maintenance paths use only the configured version.
Changing it without revising those readers can hide retained history. Native plugin/direct Elasticsearch
readers also need an inventory before enabling the physical omissions.

## One query across qualified retained and exact cohorts

Keep the two cohorts disjoint:

1. A complete, validated exact namespace with known source/coverage identity.
2. Untouched retained rows qualified for the requested native predicates, order and response values.

For this prototype, the legacy root cohort is bounded to positive values at or below
`Number.MAX_SAFE_INTEGER`. The fixture's original legacy rows and their original string receipts are known
inputs; that is not a qualification of every historical producer schema.

Compile the **entire predicate conjunction** separately inside each cohort, then OR those cohort clauses.
Native membership, total hits, offset pagination and deep pages remain inside Elasticsearch. Clip range
bounds against the qualified legacy domain before passing them to old signed mappings; an out-of-domain
equality becomes `match_none`, and a negated out-of-domain equality excludes nothing.

For a mixed scope, use a `_script` sort of type `string` that returns the indexed padded key or pads a qualified
legacy `long` directly in Painless. It reads only indexed doc values. It does not read `_source`, create a runtime
field, return a double or round through JavaScript. A present but incomplete exact namespace is not a reason to
fall back silently. Fully materialized scopes can use a direct key field sort as a separate fast path.

Exact ES 9.5.5 source, tag commit `48acba663b09e70b115dd879329141506c377890`, distinguishes script sorts from
script queries:

- [ScriptSortBuilder](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/search/sort/ScriptSortBuilder.java#L273)
  compiles `StringSortScript` and uses a string comparator without an `allowExpensiveQueries` check.
- [SearchExecutionContext.compile](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/index/query/SearchExecutionContext.java#L625)
  delegates compilation without that check.
- [ScriptService](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/script/ScriptService.java#L595)
  enforces allowed script types and contexts. Administrators may disable string sorting.
- [ScriptQueryBuilder](https://github.com/elastic/elasticsearch/blob/48acba663b09e70b115dd879329141506c377890/server/src/main/java/org/elasticsearch/index/query/ScriptQueryBuilder.java#L133)
  explicitly rejects expensive queries when the setting is false.

The owned native experiment checks both successful string sorting with expensive queries disabled and an
explicit error from a separate owned node that disables the string-sort context. It does not change operator
cluster or script restrictions. Runtime queries are not the fallback: they are also rejected under the setting.
[Runtime-field limits](https://www.elastic.co/docs/manage-data/data-store/mapping/runtime-fields).

## Coverage and retained precision gaps

Precision-dependent unknown rows must not disappear from membership, order or totals. The original
category-filtered probe in this prototype demonstrates PIT visibility, **not completeness**: filtering the
probe by contract/time can hide the surviving neighbor of an overwritten action. Even an index-wide zero
unsafe-survivor result cannot certify completeness after selective replay removes the last survivor. The
[gated production foundation](action-history-adapter.md) requires a source-backed coverage authority and
retains index-wide same-PIT probes only as additional rejection checks. The
[coverage investigation](action-history-coverage.md) defines the missing-row counterexamples and activation barrier.

A rounded number alone cannot restore its original sequence. The old parser and ordinary writer can also
have mapped adjacent originals to the same rounded `_id`; the fixture demonstrates one row overwriting the
other. An exact surviving receipt can identify its row, but cannot recover the overwritten row or prove that
the original source range was complete.

Production coverage needs source schema/producer qualification, original occurrence association, physical
index UUID/generation, block/fork coverage and restartable bounded enrichment progress. Never assume
`receipts[0]` is the selected action: certified notification grouping can choose a different origin. Recover
precision gaps from validated exact retained metadata or historical inputs. Keep safe/unrelated retained
history usable without an entire-history rewrite, in accordance with
[ADR 0040](https://github.com/eosrio/hyperion-tools/blob/main/docs/adr/0040-preserve-history-without-full-reindex-on-45-upgrade.md).

Receipt/auth arrays are ordinary object arrays today. Independent predicates can match values from different
members. This experiment does not establish paired tuple semantics or remove #220's decoded-query gates.
Any paired query plan needs its own logical contract and nested/tuple representation, including count and
filtered min/max sort behavior. Retain original associations in `_source`; flattened doc values cannot recreate
them. [Nested-array behavior](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/nested).

## Running the prototype

After `npm ci --allow-git=root` and `npm run build`, run:

```sh
node scripts/qualification/check-action-sequences.mjs action-sequences-report.json
```

The runner uses the pinned Elasticsearch 9.5.5 image digest already used by the qualification program. It
creates random names, an owned network, loopback-only ephemeral ports, four primary shards, zero replicas,
bounded CPU/memory/data and two sequential owned server roles. It verifies image/labels/IDs before removal,
recovers resources after lost creation responses and verifies final absence. It accepts no cluster URL or image
override. A Docker failure is a failed run; unavailable cleanup inspection is not verified cleanup.

The JSON report records source/client/server identity, effective mappings/settings, each actual native check,
descriptive resource counters and cleanup. It covers exact neighbors around `2^53`, `2^63` and `2^64-1`, default
serializer rounding, native predicates/exclusion/counts, mixed offset/PIT pages, same-PIT coverage checks,
rounded legacy `_id` collision, numeric uint32 metadata and script capability refusal.

The runner also imports emitted production codec, mapping, bulk and PIT modules for the gated #225
foundation. Its authority is explicitly fixture-only; the durable host coverage journal and live reader
activation remain absent. `productionModules` records those module checks separately from release qualification.

Latest PIT IDs and exact returned sort arrays are retained, and all numeric tie-breakers must be safe. Contexts
are closed on success and failure. A padded sequence key does not prove an arbitrary custom numeric sort or
`_shard_doc` value is safe. [Pagination requirements](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results).

Case elapsed times and the small fixture's counters describe that run. They do not compare throughput,
establish a bottleneck or qualify a performance optimization. Actual profiling must compare direct native key
sort versus mixed script sort, old versus new partition sort, ingest/merge/refresh cost, bytes per action,
resource pressure and representative query latency under the profiling program.

## Native engineering result: 2026-10-20

The final local run passed **13/13 checks** with Node 24.19.0, Elasticsearch 9.5.5, JavaScript client 8.19.1 and
transport 8.10.1. It ran from 03:54:37 to 03:55:11 UTC. Script SHA-256:
`bcdd04f7763ad9c8c763cbf4322babf356cd55aea47f225ad8030bd5bad4d6df`.

The native server accepted the full-range additive writes into the existing signed-sort partition. Exact
predicates, counts and mixed-cohort string sorting/offset/PIT pages passed with expensive queries disabled.
The separate script-restricted server returned the expected explicit string-sort capability error. Both owned
containers, their network and all PIT contexts were verified released.

Earlier local attempts exposed a flat-settings response assertion and a misspelled statistics metric; those
failed runs are excluded. A native client startup await also required external ownership-checked fixture
cleanup. The corrected runner bounds readiness independently before opening the client and keeps its event
loop referenced until cleanup completes. These are harness corrections, not production transport fixes.

The passed scalar fixture supports this physical/query design for implementation. It does not establish the
actual worker/API adapter, an upgrade path, multi-value custom sorts, full receipt tuple semantics or runtime
performance. Node 22/24 CI results must be assessed separately at the exact committed script revision.

Before closing #219, qualify the actual production writer/query adapter and all supported filters/custom sorts,
source/tuple semantics, Node/Bun boundaries, HTTP schemas, aliases, old caches, live/replay streams, archive
identity and Rust emitters. Contract-proof, fork recovery, retained-history upgrade and Wire testnet gates
remain independent requirements.
