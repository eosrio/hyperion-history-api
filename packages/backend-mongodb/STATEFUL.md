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
# Explicit owner/raw recovery v2

The separate `./stateful-owner-v2` factory negotiates SDK owner recovery v2 and
original source input v2. It uses `h45-stateful-mongodb-owner-v2` metadata and
`_stateful_v2_*` collections. It never adopts existing v1 storage. Factory
construction performs no native action and exposes no public `open` or `read`
readiness shortcut. The caller retains ownership of the connected client.

The current owner claim, original raw target, decoded-source binding, failure,
pending intent, receipts, progress and undo live in the same metadata document.
Owner acquisition compares exact inspected metadata version/view/previous claim;
an unknown claim ACK can only retry the same fixed claim.
Claims bind their acquisition revision: ordinary progress may retain an exact
claim retry, while rollback always requires a freshly inspected acquisition.
Initialization creates
empty collections transactionally with the owner-bound initialized CAS, requiring
a replica-set primary with MongoDB 4.4 or later wire capability. Existing domain
collection namespaces fail closed. Every native effect checks the actual host
guard, and transactional metadata CAS binds the current claim and revision.
That empty-namespace initialization transaction uses `readConcern: local`, as
required for [explicit collection creation](https://www.mongodb.com/docs/manual/reference/read-concern/),
with majority+journaled commit and the same-document owner CAS. Domain apply,
rollback and coherent read transactions continue to use `readConcern: snapshot`.

The real raw target is admitted before source decode. A raw failure has no fake
decoded digest. Takeover preserves its original owner and certified references.
Original source and candidate validation use SDK source v2, including scope-less
KV identities. V1 and v2 share the actual effect, observation, receipt, retention
and undo algorithms; recovery labels and captured source bytes are not translated.

Apply leaves raw/failure evidence until exact receipt/progress-backed retirement.
The retirement CAS writes an opaque terminal metadata version bound to the
declaration, owner claim, revision, checkpoint and target/source/candidate IDs.
This permits an exact lost-clear ACK retry while that version remains current.
Any later metadata write, owner acquisition, new raw target or revision invalidates
the old retry. There is no second journal, and clearing recovery grants no serving
authority. Cold reconciliation with `raw:null` still requires completed native
state/receipt validation and the host's current canonical and live-owner checks.

Private reduction reads and API-local completed reads are distinct opaque,
adapter-local capabilities. Plugin callbacks receive neither native capability.
A completed-read capability additionally requires the actual host live-owner/
request guard; persisted in-flight labels do not create that authority. The host
must refuse unknown/cold-unreconciled state and revalidate all selector epochs,
canonical source, view and current owner again at final response publication.
Native raw/source failures and rollback refuse completed reads. Successful normal
in-flight work may expose one coherent completed checkpoint under that host grant.
Rollback rotates revision and invalidates old leases/read capabilities.

Controlled driver tests cover these source semantics. Physical MongoDB crash,
Wire replay, SQL comparison, mixed-owner/API serving and full AtomicAssets/
AtomicMarket parity remain separate qualification gates.

The separate `./stateful-owner-complete-kind-v1` export implements SDK
`stateful-owner-complete-kind` version 1 at SDK revision
`7412889a14c84342551fd864ea3ebfcf28849385`. Its factory requires an explicitly
nonretrying client and explicit total attempts/records/serialized bytes. It
delegates the actual owner-v2 recovery and completed-read tokens, admits a generic
kind index under the owner, and enumerates until the native cursor id is zero.
`readCompletedKey` and `readCompletedKind` count data commands including any
transaction callback retries. Kind enumeration has no native limit or public
ordering guarantee. Successful serialized JSON totals are separate from wire/
BSON buffers and the documented extra-row overflow probe. The host manages the
lazy bounded client and retains final publication fencing. Existing factories,
clients, declarations and get-only callbacks remain unchanged. Source and packed
controls do not qualify physical MongoDB or public HTTP parity.
