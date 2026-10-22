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
