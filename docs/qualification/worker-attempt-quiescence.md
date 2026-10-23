# Private worker attempt quiescence

Issue #286 builds a passive lifecycle prerequisite for #277. It grants no reader capacity,
source completeness, sink readiness or public activation. The default proof ancestry remains256.

## First frozen local proof API

`src/indexer/protocol/proof-consumer-scope.ts` exports `ProofConsumerScope`,
`ProofConsumerFencedError`, `currentProofConsumerScope`, `assertProofConsumerCapability`,
`trackProofConsumerOperation`, `proofConsumerSignal` and `assertProofConsumerEnd`.

```ts
const scope = new ProofConsumerScope('opaque-physical-attempt-id');
try {
    await scope.run(async () => {
        // The real ProtocolAbiProofReader and its read-only clones retain inner reads.
        await reader.waitForOpen(originalSource, selectionId);
        // Existing processing, final checks, original ACK attempt and finalizers belong here.
    });
} finally {
    const end = await scope.closeAndDrain();
    assertProofConsumerEnd(scope, end);
}
```

`run` accepts one root. `operation` tracks the actual promise before work starts; a caller's
abort race cannot remove it. `fence` prevents new operations and retained capability use;
`closeAndDrain` fences and awaits the complete root and all real registered children. It has
no timeout that fabricates drainage. Its opaque end is process-local and is not a master receipt.
Snapshots contain diagnostics only. Fencing cannot retract already-dispatched remote effects.

Managed proof readers use the private `requireAttemptScope` option; API readers retain their
independent request lifetime. Retained issued views carry their original context, including use
outside its async call stack. The native provider's synchronous codec contract is unchanged.

The first behavioral tracer uses the actual proof reader over a controlled, held storage read.
Unmodified emitted Node22/24 code returns `proof_cancelled` with that read still pending; the
scoped path cannot issue its local end until the held read actually settles. This does not
qualify worker IPC, RabbitMQ, canonical source, Wire/Mongo production or runtime performance.

That first tracer remains historical evidence; it does not establish whole-worker qualification.

## Private IPC API

`WorkerAttemptSupervisor` in `src/indexer/protocol/worker-attempt-supervisor.ts` attaches to
the actual physical worker with `attach(worker, role)`. Its own message/disconnect/exit listeners
remain attached to retired workers independently of the master's replaceable logical `wref`.
`retire(worker)`, `observeExit(worker)` and `stop()` are private lifecycle adapters; `snapshot()`
is diagnostic only. `onEnd` receives an opaque `AcceptedWorkerAttemptEnd`;
`describeWorkerAttemptEnd(supervisor, end)` validates its same-supervisor issuer before returning
a detached description. A JSON copy cannot reissue that evidence.

`WorkerAttemptClient` in `worker-attempt-client.ts` takes
`{mode:'managed', role, transport, timeoutMs?,drainTimeoutMs?,retries?}`. The transport is existing
worker IPC (`on`, `removeListener`, `send`). `capture(descriptor)` synchronously creates an opaque
physical receipt before cargo wait. `run(handle, callback)` awaits master registration before the
callback, and ends only after its root/ACK/finalizers and real children drain. `bind(handle,fields)`
or `bindCurrent(fields)` attaches verified optional fields without replacing original values.
`markAcknowledgementAttempt()` records an attempt, not broker settlement. `fenceChannel(id)` and
`fenceAll()` prevent new use; `dispose()` removes owned listeners. `describe(handle)` is diagnostic.

Descriptors have exact fields `kind,receiptId,payloadSha256,headersSha256,consumerId,publisherId,
queue,deliveryTag`. Roles are `deserializer,ds_pool_worker,projection`; kinds are
`source-delivery,ds-delivery,projection-initialization,projection-frame`. No absent semantic ID is
invented. Optional binding fields are declared in `WorkerAttemptBinding`.

Registration, binding and end requests use exact-response retries with a stable request ID.
The parent checks physical owner/incarnation, epoch, session, sequence and original association;
an ended/evicted sequence cannot register anew. Master metadata is bounded, and exhausting it
refuses new authority without discarding unresolved attempts into success. The trust boundary is
audited host/plugin code and existing physical IPC; the challenge is an identity/replay fence,
not a plugin sandbox or a cryptographic proof of arbitrary code behavior.

Standalone fixtures must explicitly use `createControlledLocalAttemptClient(role)`. That mode
never contacts a master and never issues a master-accepted end; it is controlled engineering only.
The current API component tests do not establish actual production role integration.

## Actual role wiring

The master attaches the supervisor at each physical `cluster.fork`, before dispatching ordinary
worker messages. Its listeners survive logical `wref` replacement and reused numeric IDs. Source
replacement/revocation fences existing roots without waiting inside the canonical mutation lane.
Retirement retains unresolved owners until their exact process exit. A non-draining fence requests
supervised retirement; neither the deadline nor SIGTERM/SIGKILL invocation issues a normal end.

`HyperionWorker` installs a managed client over the existing parent IPC for MainDS, DS and projection
roles. Source/action consumer callbacks call `captureWorkerAttemptDelivery` before cargo enqueue.
`runWorkerAttemptDelivery` waits for parent acceptance before invoking actual parser/DS work and
verifies the original body/header digest again. Headers use a bounded native structured snapshot,
which preserves broker-decoded byte/timestamp/undefined values instead of treating them as action
JSON. No source/admission/trace ordinal is inferred at receipt. Verified associations are added with
`bindWorkerAttempt`; quarantine and unknown-ordinal paths keep their narrower known fields.

MainDS parser work and DS message work run once per physical delivery. Original ACK/NACK attempts,
contract-incomplete handling and local cleanup stay inside that root. A broker redelivery requires
a new physical receipt even when its original semantic/source/admission identity is unchanged.
DS proof-bearing ABI/type/view/native cache memos clear between tracked deliveries. This changes
their earlier cargo lifetime; independent same-input read-count comparison is required, and no
throughput improvement is claimed. Pure default component helpers still have their original return
contracts. Saved worker/common helpers retain the issuing root, including calls outside its async
context or while another root runs.

Projection initialization and each controller frame use separate managed roots. The frame binding
retains projection/configuration binding, actual recovery checkpoint and subsequently verified
source position. A frame fence prohibits new recovery I/O. Worker proof readers and retained source
reads require the accepted root; API/source-query readers retain independent request lifetimes and
the existing ancestry expiry. This passive record does not protect demand between projection
attempts and is not a source-capacity reservation.

Confirmed publication keeps the original callback and required buffer-drain lifecycle alive after
the outer wait aborts, or until the exact original channel closes. Ordinary non-confirm helper sends
track observable buffer backpressure without claiming a durable broker confirmation. Queued host
callbacks retain their original root; detached work cannot acquire a later root by saving a helper.
Already-dispatched remote work may finish. Local quiescence does not certify its semantic result.

Existing component fixtures explicitly install a controlled local-only transport using
`tests/unit/worker-attempt-fixture.mjs`. They produce no parent-accepted end. Their immediate controlled
channels are augmented with event registration so a missing close/drain/confirm cannot be silently
fabricated. Actual managed worker/IPC, retained original Wire inputs, projection isolation and cache
counts are exercised by the separate issue286 qualification lane. Full integration/review remains
required; this note does not activate #277 capacity, #225, #191 or release support.
