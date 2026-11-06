# Original queued-publication lineage

Implementation foundation for [#357](https://github.com/eosrio/hyperion-history-api/issues/357),
within the unfinished [capacity work](https://github.com/eosrio/hyperion-history-api/issues/277).
Admission remains disabled. The ordinary master and workers do not enable this component.

The managed main-deserializer's original publication owner asks its existing lifecycle
supervisor for a publication identity before calling its original AMQP publisher. The parent
captures the authenticated worker object, epoch/incarnation, original source-delivery attempt
and bound source context. A private host callback must supply the current chain, source
generation and reader session. The parent assigns the existing physical AMQP `messageId`;
business bodies and required typed headers remain unchanged. The child rechecks its original
scope, channels, payload and headers immediately before calling the publisher.

The original DS-pool consume callback captures that identity before cargo can wait. The parent
checks its own configured destination for that physical worker, original queue/body/header
digests and source fence. Registration retries retain the exact publication claim: another
equal-byte publication cannot replace the original identity. An unknown ID, changed bytes or
destination, stale source, or a duplicate unfenced physical delivery fails closed.

This uses the existing worker-attempt IPC, not a new service. Private host qualification must
inject `queuedPublications` into `WorkerAttemptSupervisor` and explicitly request
`queuedPublicationLineage` in both participating managed `WorkerAttemptClient`s. The host owns
the worker-to-queue assignment and source-fence callbacks. A host source cancellation must also
fence the original worker scopes through the existing lifecycle supervisor; a changed callback
alone cannot synchronously cancel a previously delivered IPC response. There is no chain
configuration switch, public byte-budget default, reader-grant activation or executable update.

Each record carries count one, exact payload byte length/SHA-256 and a canonical scalar-header
representation's UTF-8 length/SHA-256. The first cut supports MainDS's required string, finite
number, boolean and null headers. Canonical encoding preserves their types and ignores key
insertion order; it is **not AMQP frame size or heap/RSS accounting**. Opaque/native/accessor
header values are rejected only in the explicitly enabled private path. Payload metadata
describes the actual encoded body; the parent retains metadata, not another body copy.

Private metadata bounds are required for publications and captured deliveries (each 1–4096).
An exhausted window rejects further issuance/capture without evicting uncertain records. These
are observation-retention bounds, not operational queue or aggregate-byte budgets. Lifecycle
registration metadata also remains subject to the existing parent census limit.

Confirmation **and** drain remain necessary on the original publisher. A thrown send, return,
channel close, source fence or original owner exit does not erase lineage. A fenced redelivery
can add a new physical lifetime while the old lifetime remains unresolved; an active unfenced
overlap is rejected. Authentic quiescent and observed-process-exit ends are recorded without
releasing capacity. Every record still reports broker settlement `unknown`: neither an ACK
attempt nor an accepted business end establishes broker settlement or ingestor completion.

The focused native test drives the emitted managed `MainDs.routeToPool`, existing IPC/parent
and emitted DS-pool consume callback using the pinned Wire block-33 frame and codec. Transport
callbacks and source-fence authority are controlled; the real cargo is paused at capture.
The fixture's frame-derived locator strings are controlled host bindings, not canonical journal
membership proofs. It performs no DS business effects or broker ACK and requires no services.

After normal emission, run `bun test ./tests/unit/queued-publication-lineage.test.ts` with
`HYPERION_NATIVE_NODE` pointing to native Node 24 or 26. Optional
`HYPERION_QUEUED_LINEAGE_EVIDENCE` retains each native process's raw stdout/stderr. The matrix
covers held parent authorization/confirm/drain, changed body/header/queue, foreign and duplicate
identities, immutable retry claims, metadata exhaustion, source cancellation, owner replacement,
active/fenced overlap, redelivery, unknown send, return/channel loss and the disabled default.

This does not qualify full Wire/MongoDB replay or close #277/#191. Outstanding reader grants,
all fan-out and ingestion/sink lifetimes, projection demand, fresh authenticated completions,
operator byte-budget policy and independent full-component review remain necessary before
any capacity admission gate can be enabled.
