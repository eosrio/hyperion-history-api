# First portable projection path

This development slice implements a fixed-ABI declarative table projection through
the SDK, a shared runtime and an independently packaged MongoDB adapter. It provides
the foundation for [SDK #1](https://github.com/eosrio/hyperion-sdk/issues/1) and
[History API #222](https://github.com/eosrio/hyperion-history-api/issues/222).

The definition selects a contract/table and ABI deployment, maps required scalar
fields, and declares genesis initialization. The runtime selects matching changes,
produces complete replacement or delete mutations, preserves source order per
projection, and submits backend-neutral operations. Native filters, storage,
transactions and query execution belong to the adapter. The SDK and its packaged
[example](https://github.com/eosrio/hyperion-sdk/blob/6913a7fcee0b29d3b8e4104806a4caa98469f463/docs/projection.md)
contain no MongoDB dependency.

`DeclarativeProjectionRuntime` requires every contiguous block, including empty
blocks. Its caller establishes protocol normalization and source ABI authority
before supplying frames. Contract/table selection is exact; this seam does not
implement operator allow-list configuration or establish Wire source coverage.
Each runtime has a bounded pending-work budget and independent ordered queue.

## Durability and serving

The adapter validates required capabilities and topology before initialization.
It requires a transaction-capable replica set or sharded cluster; standalone
MongoDB is refused before projection storage is created. This requirement applies
to the new adapter, without migrating existing state collections.

A majority-journaled source intent precedes the transaction that commits record
effects, a replay receipt and the completed checkpoint. Failed writes leave that
projection unavailable across restart. Exact replay can finish the pending source;
conflicting effects are refused. Bounded receipts recognize completed duplicates
without rewriting newer state. Older uncovered replays return an explicit error.

A future source gap records one bounded target identity and known mutation digest.
Missing predecessors can complete while affected queries stay unavailable. Only
the exact recorded target clears the fence. Additional future frames remain
unacknowledged and retry after that recovery slot becomes available. Invalid
contract data also records an incomplete marker; unrelated projections continue.

An apply result confirms durable progress. Serving requires a ready read view.
Queries bind the complete projection/backend identity and checkpoint, use snapshot
reads for rows and counts, and recheck readiness before publication. There is no
cross-projection or state/history snapshot barrier. Logical queries support typed
equality, UTF-8 binary keyset ordering, bounded pages and capped counts. These
capabilities establish behavior, without a throughput claim.

## Reproducible checks

Use the pinned Node.js 24 or 26 toolchain with TypeScript 7.0.2 and Bun 1.4.4:

```sh
npm ci --allow-git=all
npm ci --prefix packages/backend-mongodb --allow-git=all
npm run typecheck
npm run build
bun test tests/unit
bun check -p packages/backend-mongodb/tsconfig.json
npm test --prefix packages/backend-mongodb
node scripts/qualification/check-projection-mongodb.mjs projection-report.json
```

The runner owns its Docker resources and accepts no external MongoDB URI. It uses
the immutable Linux amd64 image for MongoDB 8.0.34 and driver 7.2.0, checks standalone
refusal, and then exercises CRUD, ordering, pagination/count boundaries, replay,
real write failure, two server restarts, contract failure, source-gap recovery and
projection isolation. Resource cleanup checks ownership and records verification
in the JSON report. Source/emission fingerprints and exact component pins accompany
the result. The report intentionally keeps release qualification false.

CI runs this real fixture separately on Node.js 24 and 26. Cleanup unit tests and
in-memory runtime tests do not replace the actual MongoDB result. See the
[adapter package](../packages/backend-mongodb/README.md) for its API and limits.

The runner records the Docker host kernel and refuses the known incompatible
6.19 through 7.0.13 range before startup, following the
[MongoDB 8.0 release notes](https://www.mongodb.com/docs/v8.0/release-notes/8.0/).
Container images share that kernel. The CI image label alone does not establish
compatibility; unsupported hosts fail rather than skipping the database checks.

## Remaining release work

The opt-in existing-worker and HTTP path is tracked in
[History API #191](https://github.com/eosrio/hyperion-history-api/issues/191). Its
production integration fixture must exercise the real source, RabbitMQ, MongoDB
and HTTP path; the adapter-only fixture above does not establish that acceptance.
Canonical fork rollback, recovery-window input coverage, live mapping activation
and the broader restart lifecycle remain
[tools #21](https://github.com/eosrio/hyperion-tools/issues/21) and its follow-ups.
The separate [bounded rollback path](projection-rollback.md) adds opt-in SDK v2
runtime/adapter recovery and a native process-crash fixture; the production
controller and live source/publication integration still require their own work.
Legacy extension state integration remains
[History API #221](https://github.com/eosrio/hyperion-history-api/issues/221).

This fixture does not qualify Wire testnet support, AtomicAssets/AtomicMarket
parity, WormDB, a retained-history upgrade or the complete M1 operator path. No
existing Elasticsearch history must be reindexed to run this independent state
projection fixture.

## Opt-in operator and HTTP contract

Set `features.portable_state` in the chain configuration. It selects exactly one
backend for that chain and an explicit list of fixed SDK `ProjectionDefinition`
objects. Each definition's source contract/table is its allowed indexing scope.
The existing `features.contract_state` configuration remains a separate legacy
path; its native MongoDB fields and filters do not become portable queries.

```typescript
features.portable_state = {
  backend: {kind: 'mongodb', id: 'chain-state-1', database: 'hyperion_portable_state'},
  projections: [definition],
};
```

The database uses the existing operator MongoDB connection. The packaged
`@eosrio/hyperion-backend-mongodb` adapter owns native execution and isolated
collections. Definitions include an immutable mapping revision, fixed source ABI
SHA-256 and the source-proven ABI deployment identity
`<deployment-block-id>:<contract>:<abi-sha256>`. A current-head ABI RPC response is
not deployment authority. The host derives a stable instance generation from the
chain, backend and individual definition; configuration has no generation or ready
flag. Unrelated projection additions do not replace existing instance identities.
Changed definitions still require the adapter's explicit activation/cutover
contract rather than silently adopting existing state.

The API attaches read-only consumers. It never initializes storage, publishes a
ready flag or marks a failed projection complete. A ready adapter checkpoint must
be greater than zero and have current certified canonical source coverage from
actual block one. Readiness, exact binding/checkpoint and source authority are
checked again after asynchronous query work. Snapshot rows and an optional count
come from the shared logical query contract.

`POST /v2/state/query` accepts a configured projection ID and SDK query:

```json
{
  "projection": "inventory",
  "query": {
    "filter": [{"field": "owner", "op": "eq", "value": "alice"}],
    "limit": 100,
    "count": {"upTo": 10000}
  }
}
```

The response is `ProjectionQueryResult`: `view`, `rows`, optional `nextAfterKey`
and optional bounded `count`. Supply `query.afterKey` from `nextAfterKey` for the
next page. Typed equality preserves false, zero and explicit null. Native database
operators, arbitrary sort/skip and unknown fields are rejected. Invalid queries
return 400; an unknown configured projection ID returns 404. Missing, incomplete,
stale or source-fenced state returns 503 with `retryable:true` and `Retry-After: 1`.
An initialized empty database at checkpoint zero cannot return a successful page.

Shared browser-readable response headers are `Hyperion-State-Block-Num`,
`Hyperion-State-Block-Id` and `Hyperion-State-Last-Valid`. They identify the actual
returned view; this slice always uses `false` for last-valid mode and serves no
fallback after failure. This route uses `Cache-Control: no-store` and bypasses
the history response cache, so history's last indexed block cannot replace its
state checkpoint. Existing extension state routes and streams retain their
readiness guards. Stream-client compatibility remains a separate
[#231](https://github.com/eosrio/hyperion-history-api/issues/231) gate.

The [actual-source worker reproduction](qualification/portable-state-worker.md)
packages a bounded Wire primary-KV tracer through the existing workers, RabbitMQ,
portable runtime, MongoDB adapter and real HTTP API, including controlled write
failure and projection isolation checks. Its source fixture and instructions do
not establish a successful run; record exact runtime results separately from
fork, crash, Bun and broader release qualification.

## Original mixed-input source boundary

For the mixed action/table owner tracked in [#366](https://github.com/eosrio/hyperion-history-api/issues/366)
and [#382](https://github.com/eosrio/hyperion-history-api/issues/382), the internal
`PortableProjectionSource.originalBlock` method first resolves an actual canonical
target and admits its certified commit, selection and observation references. That
callback completes before any retained selection/capture body is loaded. A missing
capture therefore leaves an exact original reference for recovery without invented
decoded data, timestamps or capture hashes. A callback failure or unknown outcome
stops further source reads. The original worker attempt owns the actual callback
promise: fencing prevents a new callback and physical drain waits for an already
started callback to settle.

After admission, the existing source graph verifies the retained selection,
observation, capture hashes and configured protocol profile, then revalidates the
issued canonical proof. The returned internal packet retains complete original
sections before contract/history filtering. It supplies neither decoded plugin
inputs nor a serving grant. Existing scalar frames keep their definition checks
and decoding path. Durable raw-target storage, complete mixed selector decoding,
the production mixed owner, scope-less Wire KV input negotiation and domain HTTP
readiness remain required integration work; these source controls do not establish
any of those acceptance results.
