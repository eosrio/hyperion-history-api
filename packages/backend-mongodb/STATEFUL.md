# Opt-in stateful MongoDB adapter development component

`@eosrio/hyperion-backend-mongodb/stateful` exports the asynchronous
`createMongoDbStatefulAdapter(options)` factory for SDK's separate
`stateful-projection-recovery` version1 contract. Existing root factories, consumers and capabilities
are unchanged. This component is not wired into production workers or HTTP, and does not establish
physical MongoDB durability, source authority, AtomicAssets/AtomicMarket parity or full HAPI366/SDK32 acceptance.

The caller supplies a connected, caller-owned `MongoClient`, explicit database/backend/prefix,
complete captured declaration, receipt retention, rollback block/byte/per-block bounds and operation/
transaction deadlines. There are no new numerical workload defaults. The factory performs pure
profile checks; `initialize` then requires a transaction-capable **replica-set primary**. This factory
does not advertise standalone or sharded support. It initializes separate empty genesis collections;
it cannot adopt older scalar/contextual state or switch mapping/generation under an existing slot.

```js
import {createMongoDbStatefulAdapter} from '@eosrio/hyperion-backend-mongodb/stateful';
import {captureStatefulDeclaration, negotiateStatefulProjection} from '@eosrio/hyperion-sdk/projection-stateful';

// definition, every logical limit, nativePolicy and hostCapabilities are explicit audited inputs.
const configured = await captureStatefulDeclaration(definition, limits);
const adapter = await createMongoDbStatefulAdapter({
  client, databaseName, backendId, collectionPrefix, declaration: configured, ...nativePolicy,
});
const declaration = await negotiateStatefulProjection(definition, limits, hostCapabilities, adapter.capabilities);
await adapter.initialize(declaration);
```

SDK declaration handles are issued per module instance. The adapter checks complete declaration/
limit bytes and digest through its own SDK's **pure receiving validators**. That recapture produces
no negotiated execution handle and grants no canonical/source authority. A host independently
negotiates execution using its own SDK instance, guards source/ABI/canonical identity and deadlines,
and retains original candidates in recoverable input custody before application. Tests deliberately
use separate SDK module instances and verify that cloned DTOs still cannot execute hooks.

All data operations use adapter-owned exact-key queries. Records store the SDK canonical JSON as a
BSON string, with kind/key stored as values and a collision-checked SHA-256 native ID. This preserves
generic JSON keys, NUL/literal escapes, exact declared integer strings, fractions and null/missing
without imposing BSON field-name or legacy AtomicHub codec policy. It adds no general query language
or domain reduction. Factory admission refuses value/key profiles beyond MongoDB's16MiB per-document
envelope; it also reserves the full configured metadata/receipt/undo descriptor envelope below the
existing8MiB metadata ceiling. Actual before-images and descriptor BSON bytes count toward the
explicit per-block/retained policies. Oversized work refuses; it is never truncated or acknowledged.
The metadata reservation includes full receipt/undo arrays, a retained floor receipt, maximum BSON
numeric widths, completed recovery with pending or gap, and running/unavailable recovery separately.
Reason strings reserve their permitted UTF-8 bytes; the fixed native unavailable reason must fit the
offered key/text profile. Near-ceiling profiles refuse before capabilities or native I/O are exposed.

Outside transactions, uniquely addressed metadata uses bounded primary **linearizable** reads.
Keyed reads use one snapshot transaction for metadata and records, with majority/journaled transaction
completion, and validate both revision and checkpoint against linearizable metadata before and
after it. An ordinary apply changes checkpoint without rotating revision. A stale or coincident view
therefore cannot pass merely because its recovery revision matches.
These choices follow MongoDB's [read concerns](https://www.mongodb.com/docs/manual/reference/read-concern/)
and [document limit](https://www.mongodb.com/docs/manual/reference/limits/); driver controls verify
the emitted options, while actual consistency still needs engine qualification.

Application persists one durable fixed source/candidate intent, then a snapshot/majority/journaled
transaction atomically verifies observations and the revision/checkpoint/recovery fence, stores one
original before-image per changed key, applies ordered full puts/deletes, and commits the original
receipt, progress and whole-block undo pruning. Driver callbacks receive only the captured immutable
candidate, never a hook. Lost/uncertain outcomes remain explicit and recover through original receipt
inspection or the same retained candidate. Exact completed replay returns durable progress without
rewriting later records; that result is not a serving grant. Expired receipts, conflicting content,
pending intent, incomplete source and running/unavailable recovery cannot grant readiness.

Recovery uses the established rollback lifecycle: durable original operation identity and revision
rotation before undo; one complete block per transaction; exact restart retry; completed duplicate
after replacement C; unavailable ancestry remains incomplete. Existing ceilings remain256 blocks/
call,4096 retained blocks and1GiB. Retained inspection returns the real bounded branch. A private CAS
token couples every metadata transition; this introduces no public begin/finish protocol.
An unavailable operation cannot be replaced with a same-head no-op to reopen orphan state; historical
recovery or qualified reinitialization remains required outside this component.

Run this package's own committed-lock install, whole TS7.0.2/Bun1.4.4 check/build, `npm test` and
`npm run test:package` on native Node24/26. Controlled driver fixtures cover A/B/rollback/C, original
before-images, ordered replacements, special values, stale reads, pending/unknown results, fixed
driver retries, reconstructed adapters, expired/conflicting replay and rollback interruption/bounds.
They do not simulate replication, fsync or a real process/database restart. Root still must qualify
physical transactions, cleanup, native process termination/restart and independent data/progress/undo
inspection. Host journals, canonical fork coordination, source admission, serving gates and plugin
domain/API integration remain separate work; production defaults and aggregate per-chain capacity
remain unchanged.
