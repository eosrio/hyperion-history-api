# First portable projection path

> The `features.portable_state` host path was removed before any release, along with
> `POST /v2/state/query`. Setting that key now stops startup with an error. Use
> [`stateful_owner_v2`](architecture/stateful-owner-v2-host.md) for chain state. The SDK
> family and packaged adapter described here remain, and this page records their design.

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

The `portable_state` path has no fork rollback or finality selection. Use
[`stateful_owner_v2`](architecture/stateful-owner-v2-host.md) for projections that
need canonical fork recovery or an irreversible view.

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
issued canonical proof. The internal packet preserves all retained original section
fields before contract/history filtering, including explicit absent sections. It
does not establish decoded completeness: the mixed decoder must refuse missing
required non-genesis sections and separately verify native genesis; absence must
never become an empty logical block. It supplies neither decoded plugin inputs
nor a serving grant. Existing scalar frames keep their definition checks
and decoding path. Durable raw-target storage, complete mixed selector decoding,
the production mixed owner, scope-less Wire KV input negotiation and domain HTTP
readiness remain required integration work; these source controls do not establish
any of those acceptance results.
