# MongoDB operator lists v1

This additive adapter entry point implements the SDK `operator-list-read` family for operator-owned lists (HAPI #414). It is separate from chain projections: a list import grants no genesis, checkpoint, ABI, fork, coverage or initialization authority. Elasticsearch history and existing owner-v2/complete-kind capabilities are unchanged.

Import `createMongoDbOperatorListSourceV1` from `@eosrio/hyperion-backend-mongodb/operator-lists`. Create one source per configured chain/backend/source/generation, using the managed MongoDB 7.2.0 client with `retryReads: false`, `retryWrites: false`, `maxAdaptiveRetries: 0`. The adapter reuses the existing source-pinned driver command executor; its optional `timeoutMS` enables per-command CSOT outside transactions. Callers that omit that option retain their existing behavior.

All configuration bounds are explicit:

| Field | Meaning |
| --- | --- |
| `binding` | Exact chain ID (64 lowercase hex), backend ID, operator source ID and configuration generation. Other IDs are nonempty valid UTF-16, at most 256 UTF-8 bytes. |
| `limits` | Advertised request totals: distinct names, item occurrences, UTF-8 bytes and actual native command attempts. Native per-request UTF-8 capability is at most 8 MiB. |
| `publicationLimits` | Independent aggregate import/verification totals. They never enlarge a portable read. |
| `cache` | Aggregate completed cache limits for names, item occurrences and UTF-8 bytes. |
| `pageSize`, `batchDocuments` | Explicit native page and insert-batch document limits, 1–1000. Insert commands are also bounded by BSON size. |
| `operationTimeoutMS` | Per-command CSOT/signal ceiling, 1–30000 ms, further reduced to the original remaining deadline. |
| `snapshotTimeoutMS` | Ceiling for one cold snapshot/verification, 1–60000 ms, within the original request/import deadline. |

For each HTTP request the host creates a provider with `{signal, deadlineMS, guard}`. `deadlineMS` is an absolute `performance.now()` deadline on this process; it is not a renewable duration. The host performs SDK negotiation, batches all distinct requested names into one provider invocation, and keeps `provider.assertCurrent` through serialization, response/cache publication and final onSend. It then calls `provider.close()`. `source.retire()` immediately invalidates every old provider and clears completed data caches. Creating a new provider does not create a second state composition. Fastify, HAPI final onSend integration and Atomic route integration are subsequent work.

## Publication and retention

`source.publish({revision, expectedRevision, entries}, context)` captures inert bounded `{name, items}` records, preserving item order, duplicates and empty strings. The operator supplies a new immutable data revision and the current expected revision (`null` for an unprovisioned source). An ordinary data revision is not a configuration generation.

Storage is partitioned across four namespaced collections (`PREFIX_ol_v1_source`, `_revision`, `_header`, `_item`). A hash of the full binding isolates chains/backends/sources/generations even when list names match. The source pointer and revision metadata are small documents. Each list has a count/byte/digest header; items have stable ordinals and separate documents. A whole dataset is not constrained to one 16 MiB BSON document. Individual header/item records have an 8 MiB native safety ceiling; aggregate publication totals can exceed 16 MiB.

Publication inserts an incomplete revision and bounded batches, verifies complete header/item counts and every imported list digest in one majority-committed snapshot, then marks the revision complete with majority+journal acknowledgment. Only a final atomic majority+journal compare-and-swap of the small source pointer selects that revision. Concurrent or failed publication cannot expose staged data. A losing pointer CAS can leave an immutable **complete but unselected** revision; an earlier failure can leave an incomplete revision. Both remain explicit and unselected. Acknowledgment/timeout uncertainty remains a failed import; the adapter does not guess whether a pointer write committed.

Prior, incomplete and unselected revisions are retained. There is no automatic deletion/GC or overwrite/reuse API in this slice. Operators own their data, but out-of-band mutation of a revision violates this storage contract. Missing source configuration, absent source/revision metadata, incomplete markers, missing indexed storage, partial counts, malformed headers/items or a failed CAS are retryable unavailable errors. Only a known complete source can return `[]` for a missing/empty list. A complete empty publication is valid.

## Reads, budgets and failure

Cold misses use the driver's native snapshot session (`snapshot: true`, `causalConsistency: false`). The first find establishes majority-committed `atClusterTime`; subsequent finds, aggregates, getMore and cleanup retain that session/time. No transaction callback, commit or abort retry loop is used. Every source/revision metadata find, native count aggregate, header find, item find, getMore (including empty/exhaustion pages) and killCursors dispatch is charged to the same remaining attempt allowance. A possible cursor cleanup dispatch is reserved before opening/continuing a cursor; an unused reservation is not reported as an actual attempt. A query can therefore fail before using its final credit when that credit is required for possible cleanup. Budgets are never expanded.

Native batches and ordinals must exhaust and match their published count, UTF-8 total and digest. Names are counted once; all returned item occurrences consume item and byte totals, including completed cache hits. Native BSON framing/metadata bytes are distinct from these portable UTF-8 totals. Driver connection/SDAM traffic and eventual caller-owned client close/endSessions are lifecycle work outside this list-operation attempt counter; no transaction controls are hidden inside it.

Cancellation/config retirement forbids further data reads and successful publication. Cleanup may use only the already-owned session/cursor/namespace, remaining original deadline and remaining attempt credit; it does not inherit permission to query data. A deadline already expired forbids a late cleanup command. Unknown cursor ownership, failed/incomplete killCursors replies or expired cleanup remain explicit failures/secondary diagnostics. `endSession()` is not proof of remote cursor closure. No partial result or failed read is cached. The original error takes precedence over cleanup/session errors (`cause` and bounded qualification reports retain secondary `suppressed` failures).

## Five-minute completed cache

The reference Atomic 2.7.0 list implementation at `0aabc47dcf8bd0804d4dcecb336c90fc02a9c89e` resolves moize 6.1.7 and micro-memoize 4.2.0. Its miss inserts an asynchronous value and arms maxAge before resolution; `updateExpire` is false. The provider therefore fixes expiry at the batched miss invocation plus 300000 ms, rather than completion, and hits do not renew it. See the reference [list cache](https://github.com/atomicassets/atomicassets-api/blob/0aabc47dcf8bd0804d4dcecb336c90fc02a9c89e/src/api/namespaces/lists.ts), [moize expiration](https://github.com/planttheidea/moize/blob/v6.1.7/src/maxAge.ts), [default options](https://github.com/planttheidea/moize/blob/v6.1.7/src/constants.ts), and [micro-memoize miss insertion](https://github.com/planttheidea/micro-memoize/blob/v4.2.0/src/index.ts).

A completed hit can serve older data during the five-minute interval, even after an ordinary revision update or storage outage; it reports **zero native attempts**. Source/config retirement always fences it. Cache limits fail closed instead of silently evicting a still-valid entry or shortening freshness. Cached missing/empty names have the same age rule.

Only completed values are cached. Concurrent cold requests execute separately under their own deadlines/accounting. Each receives coherent items from its own selected snapshot; a concurrent winner's existing cache entry/expiry is not overwritten or renewed. Original moize in-flight promise coalescing and complete HTTP cache parity remain **pending qualification**, not an approved parity exception.

The focused modeled and real-driver preparation controls do not establish physical MongoDB acceptance. The guarded runner in `scripts/qualification/operator-list-mongodb` is provided for a later executor-owned Linux run, including a dataset over 16 MiB, real native attempts/exhaustion, CAS races and failure cleanup. HAPI final publication, Atomic 2.7 SQL pairing/parity and full Wire replay remain separate release gates.
