# Stateful owner-v2 host integration

Work is scoped to [#366](https://github.com/eosrio/hyperion-history-api/issues/366)
and [#382](https://github.com/eosrio/hyperion-history-api/issues/382), using SDK39
and the separate native owner-v2 adapter. Source wiring now attaches the existing
projection worker, plugin loader, master/API request control and final Fastify
publication pipeline behind an explicit per-chain version2 configuration. This
does not activate a stateful service or establish physical Wire testnet or
AtomicAssets/AtomicMarket parity.

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
no native adapter, raw proof, owner lease or readiness setter. The loader inventories
the actual installed entrypoint and declared runtime/optional/peer dependencies
before and after import. Code identity is separate from canonical source authority.

`ProjectionWorker` creates and drains the registered controllers through the
existing managed frame lifecycle. The existing `/local` controller connection
routes request nonces to the exact physical worker; the master checks its active
lifecycle session and outstanding fences. A matching DTO or cached dispatch hash
grants nothing. The API binds each request to its current socket and probes the
actual owner/view before and after composition, and in the route's final `onSend`
hook. It revalidates original source, enforces the declaration's serialized response
budget and emits the existing shared state headers while preserving the verified
serialized payload. Deadline, abort, owner loss and source revocation return retryable
unavailable. Other routes continue. One composition uses one request-local SDK
`StatefulQueryHostV2`; internal native reduction reads are never public read grants.

The optional configuration is `features.stateful_owner_v2`:

```json
{
  "interfaceVersion": 2,
  "sourceInputVersion": 2,
  "backend": {"kind": "mongodb", "id": "chain-state", "database": "chain_state"},
  "generation": "initial",
  "recovery": {"bytes": 67108864},
  "api": {"timeoutMs": 5000, "maximumPendingProbes": 32}
}
```

Presence explicitly enables the new family; omission preserves the scalar path.
Both families must use the same chain backend. Recovery bytes and request/probe
budgets are explicit. Defaults retain 256 blocks/receipts, at most 8 MiB per block,
eight frames per drain and native operation/transaction deadlines of 5/30 seconds.
The stateful request timeout is separate from the Elasticsearch search timeout.
`generation` chooses an explicit private namespace; changing an ABI or executable
does not adopt or mutate an incompatible existing metadata record.

SDK39 fixes selector epochs in the declaration digest, and native storage is
namespaced by that digest. Adding another ABI deployment therefore changes
durable identity. Live mapping-version continuity requires an explicit SDK/native
transition contract or a separately rebuilt and validated projection cutover;
mutating a captured declaration or falling back to an earlier ABI is invalid.
This remains required 4.5 work under #389. Full domain/API differential and physical
worker qualification also remain required; source/inject fixtures do not establish
the original API's complete parity.

The local source assembly pins reviewed SDK39 and Wire28 to exercise the new
port. It does not update frozen qualification profiles. The retained native API
source helper preserves its default 716 component pin. Its sealed internal
`stateful-owner-v2-18d235e-engineering` option verifies the exact reviewed package,
descriptor, Node/Rust artifacts and members, SDK/native emission sets and lock
sources before runtime import or capture extraction. Callers cannot provide an
expected SHA to override that admission. Three native unit callers explicitly use
this engineering option; neither it nor the separate default716 test assembly
qualifies a default distribution or testnet launch.
