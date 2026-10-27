# Opt-in original-context mapping and preserving MongoDB recovery

[HAPI #359](https://github.com/eosrio/hyperion-history-api/issues/359) consumes the independently
released [SDK contextual recovery family](https://github.com/eosrio/hyperion-sdk/issues/30), pinned
to merged commit `8d37e932df5e0e7d671c9682505de3dd55f0edb4` in both application and adapter locks.
Wire remains pinned to its existing package, nested SDK, native components and source receipts;
[the development build](development-build.md) describes the explicit two-SDK compatibility check.

This is a separate standalone source/runtime/adapter slice. Existing production configuration,
`createMongoDbProjectionAdapter`, ordinary definitions and `put`/`delete` semantics remain unchanged.
There is no automatic migration, contract plugin activation, HTTP route or production canonical-fork
integration. [#246](https://github.com/eosrio/hyperion-history-api/issues/246) and
[#221](https://github.com/eosrio/hyperion-history-api/issues/221) retain recovery/serving ownership.

## Original context and source authority

`PortableProjectionSource.contextualFrame(height, contextualDefinition, admit?)` returns a separate
frame with `context: {contract, table, blockTimeMs}`. Legacy `frame()` results retain their exact
shape. The configured source is captured using the SDK's strict contextual definition validator;
contract/block/time context never comes from decoded table fields.

The source uses the selected provider's original retained block header, including native genesis.
The qualified Wire716 representation is exactly `YYYY-MM-DDTHH:mm:ss.sss` in UTC without a suffix.
`originalProjectionTimeMs` appends an explicit UTC suffix for parsing and requires exact round-trip
formatting, a nonnegative safe integer and valid calendar values. It rejects missing data, guessed
zero, local time, numeric coercion, offsets and extra precision. Explicit verified epoch zero remains
valid. No wall clock, current head or snapshot height supplies a substitute timestamp.

Original source/block/selection/capture/ABI provenance checks remain shared with the existing source
reader. The contextual path additionally rechecks the fixed source-point ABI after awaited decoding
work. `revalidateContextualFrame` checks that mapping/ABI and the original proof again across host
awaits. Native controls compare original blocks2–4 against retained source-pinned official `clio`
header output, including half-second timestamps; they do not invent new chain captures.

`ContextualProjectionRuntime.processSource(source, height)` consumes that actual journal/proof reader,
admits known canonical target identity before mapping, and revalidates source/ABI/owner before apply
and after awaited completion. Missing context cannot become an empty successful block: known targets
remain durably incomplete. Failure marking preserves the error it receives; the source retains its
existing frame-error envelope and original cause. This slice does not include the separate worker
cancellation-recovery changes. The component
`process(frame)` seam accepts already normalized fixture/host input; a matching frame DTO alone grants
no source authority. Foreign-chain sources fail before any admission marker. Once attached through
`processSource`, reads additionally validate the exact completed point and current-head fixed ABI
against that actual source before/after awaited work. Source revocation fences publication, and
complete pre-deployment input coverage does not make an unavailable mapping ABI serveable. Neither
method's apply result grants production serving readiness or activates a route.

## Runtime ordering and recovery

The runtime explicitly negotiates `contextual-table-recovery` host/adapter capabilities before
initialization or effects. It captures one revision per lane and invalidates that lane before
draining actual pending work and submitting the original rollback plan. Queued old frames never
adopt a newly read revision. Stale planned checkpoints fail rather than being rewritten; completed
exact recovery retries do not undo a replacement branch. Resumable rollback retains the existing
operation ID, original source revision, exact `from`/ancestor identities and bounded step semantics.

Mapping and its local FIFO remain per projection. Defaults/maxima match the existing runtime:
32/256 pending frames, 16/64 MiB pending bytes, with the SDK's 4 MiB frame/batch ceiling. Unknown-size
`processSource` reads conservatively reserve the configured local byte budget, so that path does not
prefetch frames. Already captured frames are charged their canonical byte size. There is no new
aggregate chain budget, reader admission policy, retry queue or numeric operator default in this slice.

Mapping validates fixed ABI deployment/hash and the complete normalized change vector. Absent rows
follow the definition's explicit `delete` or `incomplete` policy. Required-context/mapping failures
mark only that projection incomplete; unrelated runtimes and queries continue. Failure handling
preserves the original error when a scope retires during fallback writes, rather than manufacturing
a later owned fence. Query publication requires the captured current revision and exact checkpoint
before and after asynchronous work; production canonical serving still requires #221.

## Native adapter execution

`createMongoDbContextualRecoveryAdapter(options)` implements the SDK's separate contextual family,
including retained-checkpoint inspection. It uses storage version `h45-contextual-mongodb-recovery-v1`.
It cannot adopt v1/v2 storage or invent original creation values. Legacy adapters cannot access it
as ordinary state. The full definition and immutable binding are retained and checked.

A private typed dialect shares the established MongoDB transaction/CAS/undo/recovery machinery with
the v2 factory. Contextual batches never become schema1 batches. The original full candidate,
source context, preservation/absence policy and ordered operations determine the replay digest,
before any prior-state merge. Ordinary `put` remains complete replacement and cannot bypass a
definition that requires preservation.

Inside the existing snapshot transaction, one pre-block before-image is retained per distinct key.
Each ordered operation resolves against current transaction-local state; repeated keys observe
earlier operations. Complete candidates insert absent keys; preserving updates retain declared own
fields, including required null. Both the original candidate and final merged record are bounded.
Effects, original digest receipt, checkpoint and undo commit together using the existing majority
journaled durability and bounded retry/timeout behavior.

Failure/pending and gap metadata keep exact source identity across restart. Exact retry retains the
original candidate, even if stored creation values are older. Rollback restores each pre-block image;
undoing an original insert removes the key, and a later canonical insertion receives its own creation
context. Persisted revision checks fence old applies, incomplete markers, read views and inspection.
The runtime coordinates ancestry; the adapter owns native data/undo and coherent scalar queries.

## Checks and qualification limits

Normal builds emit application and adapter artifacts. Focused native Node24/26 tests cover original
Wire header time, context/mapping failure isolation, bounded FIFO/drain, causal error preservation,
ordered/null preservation, final record bounds, original replay, restart reconstruction, stale
revisions/views, legacy-family refusal and standalone undo/replacement controls. Their in-memory
database boundary is explicitly not MongoDB atomicity or durability evidence.

The crash-worker reply controls execute its original native entry point and the installed driver's
original command construction, monitoring and write-concern error path, with scripted BSON at the
external database wire boundary during a controlled connect. No socket or engine is started, and
the adapter is not reached. A write-concern failure retains the original driver error and cleanup;
`writeErrors` cannot issue a durable receipt. A successful reply still exits before the driver promise
settles or cleanup runs. These controls establish reply discrimination, not storage durability.

`npm run test:package --prefix packages/backend-mongodb` normally installs a packed adapter with the
exact Git-pinned SDK and compiles/runs an independent strict declaration/runtime consumer, including
the legacy factory types. It attempts no database connection. Native tests and this package check
are included in the existing Node24/26 CI jobs.

The refusal-first owned Mongo runner now invokes `projection-contextual.mjs` after the existing v1/v2
checks. It is written for actual A/B/repeated-key/replay/conflict controls, server restart, native
transaction failure, a child exit after the original driver's durable intent acknowledgement, exact
recovery after restart, bounded undo, replacement C and stale/isolated failure checks. The child is
restricted to the owned loopback endpoint and namespace; source/digest/majority response identity
must match, with `ok: 1`, no write-concern error and no write errors, before its deliberate exit.
The runner retains native command and physical-record evidence
and uses the existing fixture's ownership/cleanup checks. It accepts no external cluster CLI URL.
The owner passes its exact replica-set name into contextual readiness, including after restart.
The runner requires `h45rs_<run nonce>` before owned I/O; the original strict primary/set-name
checks and 60-second readiness deadline remain unchanged. A failed engine run at the preceding
revision remains failure evidence; native controls do not establish the corrected engine result.

Writing/wiring that runner does not establish a successful engine run. Record its exact source and
Node24/26 Mongo results separately. No production fork/finality, HTTP, initialization snapshot, Wire
launch, WormDB or full AtomicAssets/AtomicMarket parity claim follows from this component slice.
