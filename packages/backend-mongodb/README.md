# MongoDB portable projection adapter

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

This slice does not implement fork rollback, snapshot bootstrap, legacy state
API migration, AtomicAssets parity or Wire testnet qualification. Those remain
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
