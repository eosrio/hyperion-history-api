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

The supervisor, actual worker role adapters, native/helper/cache fencing and complete qualification
are subsequent vertical steps within this same issue; this first tracer is not issue completion.

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
