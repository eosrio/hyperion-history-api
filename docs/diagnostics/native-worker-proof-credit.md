# Native worker proof expiry and reader credit diagnosis

Issue: [#277](https://github.com/eosrio/hyperion-history-api/issues/277).
Investigated source: `c914dd8ca6d27f235c2c343d0c5ad1f45916998c`.
This is an engineering diagnostic, outside unit-test discovery. It changes no
production behavior, public activation, ancestry bound, timeout, or service.

## Reproduce

Use Node.js 22 or 24, Bun 1.4.4 for checking, and the committed npm dependency
tree with preparation scripts enabled:

```sh
npm ci --allow-git=all
npm run build
node scripts/diagnostics/native-worker-proof-credit.mjs
```

The last command is deliberately RED on the investigated source. Its final
assertion is:

```text
valid pending block-33 DS input lost canonical proof coverage at source head 290; it must remain processable and seal
```

`--observe-expiry` additionally asserts the precise existing failure and exits
successfully after printing its JSON evidence. That success records the defect;
it does not qualify worker correctness. Neither mode belongs in the ordinary
passing test suite. Once a credit interface is selected, adapt this prototype to
observe the blocked admission, process the held genuine input, then demonstrate
that only its authenticated settlement permits the next grant. The current
prototype does not select that interface or pretend a future blocked admission
is an already implemented passing path.

The diagnostic authenticates the unchanged original archive
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`,
extracts its original source plan, and feeds genuine frames 1–290 through the
emitted reader and deserializer. It selects the installed
`wire-sysio-6508c9e8-native-engineering-v1` provider normally, without replacing a
provider, native decision, observation, or receipt. The existing explicitly
guarded engineering admission seam is enabled on owned prototype objects;
public/default admission remains disabled. Broker and Elasticsearch transports
are controlled in memory. No real service, RPC, consensus validation, or complete
runtime qualification is claimed.

## Measured result

The prototype drives actual ordered source ingress, actual SHIP request encoding,
the real canonical coordinator, retained source/admission journals, actual
`DSWorker.processMessages`, and the existing queue monitor and master role
dispatch. The queue monitor runs after every producer frame, removing polling
delay as an explanation. Its controlled management total equals the genuine
published DS dispatch count minus acknowledged DS messages. Original inputs before block
33 are processed normally, so block 33 is the oldest unresolved input. The 64-message
maximum and 8-message resume threshold match the owned worker qualifier; the
management transport and deliberately held work are constructed controls.

| Boundary | Observed behavior |
|---|---|
| Source head 75, 64 DS messages pending | Queue monitor sends `pause` to role `reader`; the live role `continuous_reader` receives no pause. |
| Source head 289, held original block 33 | Distance 256: ABI open and native open/authorize/decode succeed, including the expected native value and production encode-original-byte verification. |
| Source head 290, same held dispatch | Distance 257: a fresh open returns `ancestry_unavailable`, HTTP status 503, `Requested ABI source is outside verified ancestry`. |
| Actual DS processing at head 290 | One original delivery is acknowledged after durable incomplete evidence; zero action publications; its source seal is absent. |
| Original source credits | 290 encoded `get_blocks_ack_request_v0` requests and 290 source-side ACKs occur while DS work is held. |
| Genuine genesis block 1 | No trace vector, zero DS dispatches, `planId: null`, incomplete cause `Complete bounded original trace vector is required`. No empty vector or seal is manufactured. |

The original block-33 dispatch SHA256 is
`52ff71eac764d107780fca90bfda9dc60808402adc5e760db91a12443d12365c`.
The failure is coverage expiry, not an imposed timeout: the source is demonstrably
readable at distance 256 and rejected immediately at 257. The native Node 24
diagnostic took approximately 35 seconds including genuine source preparation;
the final DS invocation took approximately 10 ms. These controlled wall times
are not production throughput, exclusive CPU, or Elasticsearch latency evidence.

## Current ownership and acknowledgment boundaries

1. `StateReader.bindProtocolSource` retains and authenticates the selected frame
   and awaits coordinator admission before publishing it to the source queue
   (`state-reader.ts:1072`). `processIncomingBlocks` returns SHIP credits after
   its own block publication confirms (`state-reader.ts:534`), before downstream
   DS settlement.
2. The producer retains the original frame/schema/capture and derives its action
   inventory before filtering (`deserializer.ts:373`). Each real transaction
   dispatch carries admission ID, original trace ordinal, block identity, and
   selected protocol source. It uses mandatory, persistent confirmed publication
   (`deserializer.ts:918`; `action-confirmed-publication.ts`). The producer then
   acknowledges its original consumer delivery (`deserializer.ts:412`). This
   ACK means the downstream input is recoverable, not that DS output is complete.
3. DS captures the original consumer channel when Rabbit delivers the message
   (`ds-pool.ts:1169`). `HyperionWorker.actionPublicationOwner` captures both
   original consumer and publisher and tests current channel identity and
   readiness (`hyperionWorker.ts:90`). `beginActionAdmission` re-derives the
   inventory and validates producer/configuration/target epoch, trace ordinal,
   selection, and exact dispatch body SHA (`ds-pool.ts:831`).
4. DS independently opens an ABI proof and a native proof (`ds-pool.ts:913`).
   Native opening itself uses an independent read-only proof reader. Source
   coordinator `pending[]` has already been discharged by retained ABI/native
   PREPARE and canonical commit (`abi-coordinator.ts:336`); it does not represent
   pending DS work.
5. A transaction fragment is prepared before confirmed action publication
   (`ds-pool.ts:1037` and `:1055`). A journal seal alone authenticates membership,
   not sink durability or visibility (`action-source-journal.ts:231`). DS final
   fences revalidate canonical/native authority and original channel ownership,
   then ACK (`ds-pool.ts:730`). A contract-output failure writes a durable
   incomplete association before that ACK; it grants no empty fragment or seal.

The existing queue monitor counts messages, not oldest unresolved block distance
(`queueMonitor.ts:39`). Its pause targets only role `reader` (`:25`);
`HyperionMaster.sendToRole` filters exact role equality (`master.ts:1414`).
Moreover, the `pause` message sets `allowRequests = false`, used for assigning new
ranges; the current ordered SHIP credit path does not consult that flag. Simply
fixing a role filter or polling sooner does not establish a finite proof-window
invariant.

## Candidate grant contract to test, not an approved product interface

The strongest existing linearization point is authenticated coordinator admission,
before a new selection enters canonical `pending[]`. Source/profile/session and
generation are already verified there. A prospective bound must include all
already granted selections, not only the latest certified head:

```text
next admitted block - oldest unresolved original input block <= 256
```

A count of unresolved messages or blocks alone cannot enforce that distance:
empty or independently settled blocks can advance the source while one old input
remains pending. SHIP prefetch and already granted coordinator inputs also count;
reactive polling with a one-block margin is insufficient.

A draft reservation would bind chain/profile components, authenticated reader
session and source generation, selection ID, exact block identity and capture,
and an idempotent reservation identity. Reserve before admitting/publishing the
source; later bind its real retained admission and expected transaction vector.
Completion must identify the actual admission/ordinal/dispatch digest and current
producer, target, consumer and publisher epochs. Its authority cannot be a bare
worker count, arbitrary IPC height, or source seal prepared before publication.
The existing public interfaces do not yet provide this complete settlement
contract; this investigation does not silently add one.

The necessary acceptance cases are:

- Block 33 remains queued; admission of block 290 cannot advance the canonical
  tip while that valid input still needs a fresh proof. Processing and confirming
  its genuine original output releases capacity, then 290 can proceed.
- Duplicate deliveries, confirmations and completion messages settle one original
  identity once. A consumer crash preserves the active reservation until retained
  source/journal evidence and actual redelivery are reconciled. Broker delivery
  tags or process-local objects cannot authorize another worker's settlement.
- Reader replacement, fork recovery, coordinator restart, or source revocation
  invalidate old grants and awaited continuations. Existing master checks current
  worker/session (`master.ts:652`), and coordinator changes source generation
  before recovery (`abi-coordinator.ts:152`, `:167`, `:206`). Reservations need
  an explicit bounded durable reconstruction or replay rule for each transition.
- Genuine trace-less genesis and permanently invalid contract scopes must reach
  truthful terminal-incomplete classification using retained source/admission
  evidence and release active capacity without a seal or readiness claim.
  Remaining bounded recovery/backfill state stays separate. Waiting forever for
  contract repair would indirectly halt unrelated indexing, violating ADR 0022
  and ADR 0043. Storage outages or unknown publication outcomes must not be
  misclassified as contract failures merely to free credits.
- Infrastructure backpressure must compose with these credits, retain bounded
  source/byte budgets, and resume through the existing worker infrastructure.
  None of this permits a larger ancestry window or a weaker physical drain gate.

## Existing issued-proof reuse boundary

The prototype confirms that an ABI view and opaque native view issued at distance
256 can still revalidate after monotone advancement to distance 257. The current
revalidation checks owner, generation, and non-regressing certified head; it does
not re-open ancestry. Both views are rejected after source revocation. Cancellation
is honored; a view from another reader and a serialized native handle are rejected.

This is a narrow in-process reuse opportunity, not transferable authority.
`ProtocolAbiProofReader` records issued views in a per-reader `WeakMap` and
`asReadOnly()` creates independent issuance state (`abi-proof.ts:96`, `:107`).
`ProtocolNativeActionReader` creates that independent reader and stores opaque
views/grants in its own weak maps (`native-authorization.ts:79`, `:99`). A JSON
copy from a producer cannot replace a consumer's issuance or canonical/final
publication checks. Reuse inside one request might avoid duplicate opens after
an explicit interface review; it cannot by itself protect queued work that has
never obtained a proof, repair crash recovery, or prove the grant invariant.

The separate proof-read measurement lane evaluates actual read counts, bytes and
cost. Faster reads can reduce observed lag, but they do not establish the safety
property exercised here.
