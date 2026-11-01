# MongoDB portable projection adapter

The separate [stateful development factory](STATEFUL.md) is available only through the explicit
`/stateful` subpath. It does not change these existing factories or activate production workers.

This development package implements native MongoDB operations behind the shared
Hyperion projection contract. Contract definitions, source selection and API
response shaping remain outside this package. The application owns the connected
`MongoClient` and closes it after its adapters have drained.

```js
import {MongoClient} from 'mongodb';
import {createMongoDbProjectionAdapter} from '@eosrio/hyperion-backend-mongodb';

const client = await new MongoClient(uri).connect();
const adapter = createMongoDbProjectionAdapter({
  client,
  databaseName: 'hyperion_portable_state',
  backendId: 'chain-state-backend-1',
});
```

The first implementation requires a transaction-capable replica set or sharded
cluster. Initialization rejects standalone and uninitialized servers before
creating projection storage. It uses a durable application intent followed by a
bounded transaction for record effects, the completion checkpoint and the replay
receipt. Transactions use snapshot reads, majority journaled writes, a total
driver timeout and sequential awaited operations.

An interrupted or explicitly failed application keeps its projection unavailable
across process restarts. Replaying that same source can resume it. Retained exact
replays return their receipt without rewriting later state; conflicting replays
and older replays outside the bounded receipt window fail explicitly. Receipt
retention is configurable and does not retain an unbounded source archive.

An observed future source gap also persists a query fence before returning
`projection.source-gap`. One bounded future block identity and, when known, its
mutation digest are retained separately from the failed current application.
Missing contiguous frames may complete durably while this fence remains. Only
replaying the recorded target with its exact known identity and effects clears
the fence; conflicting target or adjacent predecessor identities are rejected.
Additional future frames return retryable `projection.apply-unavailable` while
that recovery slot is occupied. They remain unacknowledged, are not durably
recorded, and cannot replace the retained authority or accumulate stored inputs.
A successful apply result reports durable
progress; `open` and `query` determine whether that progress is ready to serve.

`recovery(binding)` exposes the adapter-owned durable checkpoint and pending/gap
identities to restarting workers, including while `open` rejects incomplete state.
The returned snapshot validates the full storage/binding invariants and never
grants serving readiness. Resume at the next contiguous source, using the exact
retained pending identity; do not replay from zero beyond receipt retention.

Logical records contain all declared scalar fields. Equality filters, binary
UTF-8 key ordering, keyset pagination and capped counts execute inside the adapter.
A query reads its records and count from one checkpoint and rejects a stale or
incomplete view. There is no cross-projection or state/history snapshot barrier.
Pages honor the SDK's 4 MiB response budget and may return fewer rows than the
requested maximum, with a continuation key when more matching records remain.

`receiptRetention` defaults to 256 and accepts 1 through 4096. Old receipts are
trimmed on completion of the next application. `operationTimeoutMS` defaults to
5000 with a maximum of 30000; `transactionTimeoutMS` defaults to 15000 with a
maximum of 60000. SDK limits additionally bound input bytes, mutation counts,
filter terms, record sizes, page counts and count probes. Equality predicates
currently use the native collection plan with the key index; this slice does not
promise an equality index per field or establish a throughput qualification.

Storage uses an isolated record collection per complete backend/projection
binding and shared metadata under the configured collection prefix. One immutable
binding owns each chain/projection slot; changing its mapping or generation is
rejected until an explicit activation/cutover contract exists. Existing Hyperion
MongoDB collections and Elasticsearch history are unaffected.

The v1 interface does not implement fork rollback. Snapshot bootstrap, legacy state
API migration, AtomicAssets parity and Wire testnet qualification remain
release requirements in their owning roadmap issues. This package must not be
advertised as satisfying those broader capabilities.

During restart, `initialize` returns `projection.incomplete` only after validating
the existing exact binding, complete definition and initialized storage metadata.
The runtime may reconstruct a recovery instance for that case; `open` and `query`
continue to reject reads until the same failed source is successfully applied.
For a recorded gap, this includes recovering its missing predecessors and then
the exact recorded target.
Definition changes, corrupt metadata and incomplete initialization retain distinct
errors and cannot enter this recovery path.

From this directory, run `npm run typecheck`, `npm run build`, and `npm test` using
the repository's pinned TypeScript 7.0.2, Bun 1.4.3 and committed npm dependency
tree. The root qualification runner additionally exercises the adapter against a
real MongoDB service; unit fixtures do not replace that evidence.

## Opt-in rollback interface

`createMongoDbRollbackAdapter` implements the SDK's separate revision-fenced
`ProjectionRollbackAdapter` interface (interface version 2). The original factory,
v1 capability list and exact v1 request shapes remain available. Select the new
factory explicitly; ordinary projection initialization never upgrades itself.

```js
import {createMongoDbRollbackAdapter} from '@eosrio/hyperion-backend-mongodb';

const adapter = createMongoDbRollbackAdapter({
  client,
  databaseName: 'hyperion_portable_state',
  backendId: 'chain-state-backend-1',
  rollbackRetentionBlocks: 256,
  rollbackRetentionBytes: 64 * 1024 * 1024,
  rollbackMaxBlockBytes: 16 * 1024 * 1024,
});
```

The runtime owns canonical branch selection, quiesces its local writer, and
supplies the exact `from` and `ancestor` checkpoints plus a stable operation ID.
An admitted rollback persists its intent and rotates an opaque revision before
undoing any rows. All writes, including failure and future-gap markers, require
that revision. Read views also include it, so an earlier view cannot become valid
again when rollback returns to the same block ID. Immutable binding `generation`
does not change. The native checkpoint stores its revision as an additional CAS
fence against preloaded historical v1 writers; SDK checkpoints remain unchanged.

Forward application saves one pre-block image for each distinct key, including an
explicit absence marker. Repeated mutations retain their original order. Images,
row effects, checkpoint, replay receipt and undo-window pruning commit in the
same snapshot/majority/journaled transaction. Individual image documents avoid
MongoDB's per-document limit for blocks containing many large deleted records.

`rollback` undoes at most its requested `maxBlocks` per call (1 through 256), one
whole source block per transaction. Each step atomically restores records and
updates the checkpoint, receipts and undo cursor. Repeating the original request
after a process restart resumes that intent. A completed request returns
`duplicate` even after replacement blocks advance; it never undoes that later
branch again. The last operation receipt is replaced only by a new recovery.
Queries and forward writes remain unavailable while recovery is running or its
required ancestor is unavailable. An exact same-checkpoint recovery can cancel
orphan pending/gap inputs without changing rows and still rotates the revision.

Undo retention is bounded by complete blocks and encoded bytes. Defaults are 256
blocks, 64 MiB total retained undo and 16 MiB for one block. Maximum retention is
4096 blocks and 1 GiB; the per-block limit cannot exceed the total. If the total is
below 16 MiB, the default per-block limit is reduced to match. Retained bytes count
actual BSON image documents and growth of the descriptor array in metadata; fixed
metadata and replay receipts have a separate 8 MiB document ceiling. Row storage,
indexes and MongoDB journal/replication overhead are not included in this undo
budget. The policy is persisted, and an instance configured differently cannot
silently reopen or alter the retained coverage.

A block whose before-images exceed its budget aborts before any effects or
completed progress commit. Its durable pending intent keeps only that projection
unavailable. Pruning removes whole undo blocks and reports the exact retained
branch floor. A wrong-ID or older ancestor durably records unavailable recovery
and returns retryable `projection.rollback-unavailable`; it does not fabricate
undo or skip to another checkpoint. Historical recovery and qualified
reinitialization require later host work.

Explicit v2 initialization can adopt an exact existing v1 binding and definition.
It preserves records and pending source context, starts undo coverage at the real
completed checkpoint, and saves that checkpoint's actual receipt. Existing v1
receipts are not evidence of inverse effects. Once upgraded, unfenced v1 access
is rejected. This is an explicit, one-way storage activation; no automatic
downgrade or mapping/generation cutover is provided. Elasticsearch history and
unrelated MongoDB projection instances are unaffected.

`recovery` exposes the completed checkpoint, revision, pending/gap identities,
bounded coverage and last rollback intent. Inspection is never a serving grant.
The integration fixture under `scripts/qualification/projection-rollback*` tests
the portable runtime/adapter seam against real MongoDB with native process
termination; it does not establish live SHiP fork/reconnect, complete state-route
migration, irreversible-only behavior or release qualification.

## Operator-owned lists

The additive [`./operator-lists`](OPERATOR-LISTS.md) entry point provides bounded request-local SDK list reads and partitioned immutable operator publications. It grants no chain/projection readiness. Native MongoDB, HTTP/onSend and Atomic parity qualification remain separate gates.
