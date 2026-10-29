# Stateful owner-v2 host integration

Work is scoped to [#366](https://github.com/eosrio/hyperion-history-api/issues/366)
and [#382](https://github.com/eosrio/hyperion-history-api/issues/382), using SDK39
and the separate native owner-v2 adapter. This is an implementation checkpoint.
The production worker, master/API request control and plugin registration callers
remain required. This checkpoint does not activate a stateful service or establish
Wire testnet or AtomicAssets/AtomicMarket parity.

## Original source

`PortableProjectionSource.statefulBlock` admits the original canonical target
before loading retained input, then verifies the existing observation graph.
The decoder consumes complete original traces and delta vectors independently
of history filters. Native genesis must have its original verified empty
application state. Missing non-genesis sections cannot become an empty source.

Selected actions retain exact sequence strings and original transaction,
action and receipt-vector coordinates. The reader resolves each occurrence's
ABI. The v2 epoch hashes its full deployment provenance, including repeated
identical-byte `setabi` occurrences within one block. Scalar deployment IDs stay
unchanged. Actions are ordered by original receipt sequence, followed by the
block-end table vector in physical delta/row order.

The selected protocol's `statefulTables/interfaceVersion:2` supplies original
table identity and payer. Hyperion core does not parse Wire KV fields or invent
a scope. Primary/deleted values and secondary key-only null values remain
distinct. All matching selectors must have exactly one applicable declared ABI
epoch. The Wire capability is source-pinned; an Antelope original-table v2 port
is still required before that protocol can use the table path.

Input evidence hashes immutable source addresses and coordinates. A later head
certificate does not change an exact source/candidate retry. Completed-view
validation checks its own canonical ancestry and applicable selector epochs;
it does not require equality with a later live-head ABI.

## Owner and custody

`StatefulProjectionControllerV2` uses the real SDK owner runtime and native
adapter. The existing metadata recovery slot retains raw source before decode;
there is no parallel completeness journal. Candidate custody uses the existing
immutable bundle algorithm, keyed by declaration/source. Partial or corrupt
custody refuses, rather than authorizing another reducer run.

Cold acquisition starts unavailable. Retained raw target and fixed candidate
custody are reconciled before the controller can attest to a request. Applied
but unretired work uses its exact receipt and candidate without reducer rerun.
An unknown admission or failure keeps the local gate unavailable even if durable
failure marking also fails. Normal acknowledged in-flight work may retain an
eligible completed snapshot. Actual production callers must require the managed
attempt scope; controlled component fixtures explicitly disable that requirement.

A known noncanonical checkpoint or retained raw target starts native rollback.
Unknown/missing ancestry cannot select a rollback target. Revision rotation
invalidates the old lease and requires fresh observed acquisition. A request
attestation rechecks actual native owner claim, completed view and original
source before and after its reads. Its DTO is not a serving grant.

## Remaining production boundaries

The optional `getStatefulProjectionsV2` method belongs on the existing enabled
plugin instance. Its single descriptor supplies backend-neutral selector
templates, record definitions, limits and reduction callbacks. Templates omit
ABI epoch/hash; the host must resolve original canonical provenance before SDK
capture. Binding and actual hook inventory are host-owned. Existing `addRoutes`
receives an additive request-local owner-v2 query-host context. The plugin receives
no native adapter, raw proof, owner lease or readiness setter.

Actual worker registration and managed master/API request probes are pending.
Final `onSend` revalidation, shared state headers and serialization budgets are
required before the public route can serve. The controller's `attest` operation
cannot replace that cross-process control path.

SDK39 fixes selector epochs in the declaration digest, and native storage is
namespaced by that digest. Adding another ABI deployment therefore changes
durable identity. Live mapping-version continuity requires an explicit SDK/native
transition contract or a separately rebuilt and validated projection cutover;
mutating a captured declaration or falling back to an earlier ABI is invalid.
This remains required 4.5 work, as does the production hook inventory/registration
and full domain/API differential qualification.

The local source assembly pins reviewed SDK39 and Wire28 to exercise the new
port. It does not update frozen qualification profiles. Old native fixture
helpers keep their explicit old component pin; coordinated new source-profile
admission must be resolved before promoting this assembly into the default build.
