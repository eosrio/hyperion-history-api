# Bounded projection rollback and restart recovery

The opt-in SDK v2 path adds stored undo and restart recovery to the fixed-ABI
declarative projection. It implements the adapter/runtime work tracked in
[History API #244](https://github.com/eosrio/hyperion-history-api/issues/244),
[SDK #14](https://github.com/eosrio/hyperion-sdk/issues/14) and
[tools #21](https://github.com/eosrio/hyperion-tools/issues/21).

`RecoverableProjectionRuntime` reuses the existing declarative mapper and ordered
queue. Contract definitions and full put/delete mutations remain backend-neutral.
The runtime's caller establishes canonical source authority and selects an exact
ancestor. The MongoDB adapter validates that ancestor against its retained branch
and owns native undo, transactions and storage integrity.

The rollback-only factory remains `createMongoDbRollbackAdapter`. The production
portable-state controller uses `createMongoDbRecoveryAdapter`, which independently
declares retained-checkpoint inspection without widening the existing closed v1
or v2 capability manifests. Both factories require explicit initialization before
changing a matching stored instance. Legacy state routes and broader publication
integration remain [#221](https://github.com/eosrio/hyperion-history-api/issues/221).

The recovery factory reads the validated durable metadata once and returns the
actual applied block IDs, descending through the retained floor inclusive, bound
to the caller's exact revision. The controller intersects that path with separately
certified canonical source ancestry; a matching height alone is insufficient.
Running operations resume from their original operation ID, source revision,
starting checkpoint and ancestor before a new canonical plan is considered.
The per-call block budget is not part of that durable operation identity.

Affected queries require the same revision, canonical source and configured
finality after asynchronous work. They return retryable 503 during recovery;
unrelated projection lanes and history indexing continue. Production worker/API
and restart qualification is tracked in
[#246](https://github.com/eosrio/hyperion-history-api/issues/246). Constructed branch
fixtures are engineering evidence; a live Wire fork remains separate acceptance.

## Durable processing and recovery

Each forward block first records its exact pending source and mutation digest.
One transaction then stores the first before-image of every changed key, applies
the ordered mutations, advances the checkpoint and retains a replay receipt.
An absent before-image restores absence. Repeated changes to one key retain its
value before the block, rather than an intermediate value.

Rollback starts by persisting the operation identity, original source revision,
completed checkpoint and requested ancestor. The same durable write rotates the
revision and fences earlier writers and read views before undo begins. Each undo
transaction restores one block and updates its checkpoint, receipts and journal
together. `maxBlocks` bounds work per call; it does not change the persisted
operation identity. A restarted runtime resumes the same operation. Retrying a
completed operation returns a duplicate result even after replacement blocks
advance the projection.

The caller captures a complete SDK rollback request, including its original
revision and expected source checkpoint, and preserves it across retries. The
runtime invalidates its old revision lane synchronously, rejects queued old work
before mapping, and waits for in-flight work to settle before sending that
unchanged request. If a commit changed the expected checkpoint, the request is
refused; the coordinator must explicitly plan the still-unadmitted recovery.
An older operation whose retained receipt was superseded cannot acquire a newer
revision. A durable commit can survive a caller losing its result without
becoming an omitted effect. Only a completed
rollback attaches a new lane; partial or unavailable recovery remains non-serving.
Read views include the revision, so a view cannot become valid again merely
because a later branch reaches its old height or checkpoint.

`recovery(binding)` is non-serving inspection. It returns the actual checkpoint,
pending/gap identities, revision, retained coverage and last rollback operation.
It cannot substitute for `open` or `query`. Unrelated projections have independent
queues, stored progress and recovery state.

## Coverage and migration

The MongoDB factory accepts bounded, persisted retention settings:

| Option | Default | Maximum |
| --- | --- | --- |
| `rollbackRetentionBlocks` | 256 blocks | 4,096 blocks |
| `rollbackRetentionBytes` | 64 MiB | 1 GiB |
| `rollbackMaxBlockBytes` | 16 MiB, capped by the retained-byte budget | Retained-byte budget |

Retained bytes count encoded BSON before-image documents and journal array
metadata. Each source block also has a separate undo budget. Large deletes can
require much more undo data than their forward mutations; exceeding the budget
leaves pending work fenced and commits neither row effects nor a new checkpoint.
Metadata has its own 8 MiB bound. Reopening with a different persisted retention
policy is refused rather than silently changing recovery coverage.

The reported floor is the exact oldest ancestor that the retained inverse effects
can restore. A wrong branch ID or older uncovered ancestor records an unavailable
operation and returns retryable `projection.rollback-unavailable`. It preserves
stored effects and completed progress while keeping the affected projection
incomplete. Historical source retrieval and qualified rebuild/reinitialization
remain required follow-ups; the adapter never fabricates missing undo or skips
orphaned effects.

Explicit v2 initialization can migrate a matching v1 projection. Existing rows
and its actual checkpoint remain intact; rollback coverage starts at that
checkpoint because old retry receipts contain no before-images. A saved floor
receipt supports exact replay after rolling back beyond the ordinary receipt
window. The native v2 checkpoint also carries the revision, preventing a
historical writer's already-loaded full-checkpoint update filter from matching
upgraded storage. SDK checkpoints retain their two-field shape.

Existing Elasticsearch history is unaffected. This independent state migration
requires no history reindex. Operators must coordinate projection owners and
adapters for activation; downgrading an activated instance to the v1 factory is
not supported.

## Repeatable checks

Use the pinned Node.js 24/26, TypeScript 7.0.2 and Bun 1.4.4 toolchain:

```sh
npm ci --allow-git=all
npm ci --prefix packages/backend-mongodb --allow-git=all
npm run typecheck
npm run build
npm test --prefix packages/backend-mongodb
bun test tests/unit
node scripts/qualification/check-projection-mongodb.mjs projection-report.json
```

The public runner creates and verifies ownership of its MongoDB Docker resources;
it accepts no external database URI. Its v2 extension launches distinct native
Linux Node.js children and kills them at observed source-intent, transaction and
undo boundaries. Fresh processes inspect and replay the stored operation. The
fixture uses explicit synthetic branch IDs and independent expected rows to
exercise orphaned inserts, updates, deletes, repeated keys, replacement branches,
duplicates, stale writers/views, bounded coverage, oversized undo and migration.
It also reproduces the historical v1 update filter against actual migrated
storage. It does not claim execution of a complete historical binary.

A killed worker can leave an open server transaction until MongoDB's periodic
[transaction expiry cleanup](https://www.mongodb.com/docs/v8.0/reference/parameters/#transactionLifetimeLimitSeconds).
Immediate replay may therefore return retryable unavailable while the original
checkpoint, pending target and rows remain intact. The fixture preserves default
server settings, bounds recovery to 180 seconds per crashed boundary and records
each received retryable failure before retrying the same fenced input. Each
attempt must preserve an explicitly expected physical state; a timeout cannot
stand in for successful application or completed rollback.

Reports retain the native child exits and command barriers, physical row hashes,
checkpoints, source/emission fingerprints and cleanup results. A failing rollback
run remains in the report. The Node.js 24/26 CI matrix runs this fixture separately
from the unit and toolchain checks.

The [2026-10-21 evidence](performance/evidence/projection-rollback-20261021/README.md)
records the native Hyperion-3 matrix, public CI runs, retained failures, independent
review corrections and verified resource cleanup.

This guarded correctness fixture does not qualify a live Wire fork/reconnect,
irreversible-only operation, all state routes, AtomicAssets/AtomicMarket parity,
WormDB, Bun runtime support or sustained-load performance. Those release gates
remain open in the [release roadmap](https://github.com/eosrio/hyperion-tools/blob/main/docs/roadmap/hyperion-4.5.md).
