# Private worker attempt quiescence

Issue #286 builds a passive lifecycle prerequisite for #277. It grants no reader capacity,
source completeness, sink readiness or public activation. The default proof ancestry remains 256.

## Private proof scope API

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
An unavailable bounded header snapshot is explicitly `headersSha256:null`: raw receipt/body custody
still registers, but its processing callback is refused. This cannot issue header/source authority.

Registration, binding and end requests use exact-response retries with a stable request ID.
The parent checks physical owner/incarnation, epoch, session, sequence and original association;
an ended/evicted sequence cannot register anew. Master metadata is bounded, and exhausting it
refuses new authority without discarding unresolved attempts into success. The trust boundary is
audited host/plugin code and existing physical IPC; the challenge is an identity/replay fence,
not a plugin sandbox or a cryptographic proof of arbitrary code behavior.

Standalone fixtures must explicitly use `createControlledLocalAttemptClient(role)`. That mode
never contacts a master and never issues a master-accepted end; it is controlled engineering only.
The controlled API component tests alone do not establish actual worker integration.

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
MainDS checks the accepted root again after awaited source selection, protocol readiness, ABI
observation, native preparation, quarantine and contract work, before it starts another output,
hint or ACK. A late completion or rejection after a fence cannot start the next stage under the
old receipt.
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
Controller and runtime checks repeat after awaited initialization, recovery, source admission,
proof revalidation and application. A held call may finish after a fence; its completion cannot
start a fresh marker, apply, recovery read or subsequent projection definition.

Confirmed publication keeps the original callback and required buffer-drain lifecycle alive after
the outer wait aborts, or until the exact original channel closes. For an ordinary non-confirm
send, the observable boundary is synchronous transfer of message bytes to the transport and any
reported buffer backpressure. A `sendToQueue()` return of `true` or a `drain` event does not prove
physical socket flush, broker receipt, or durable settlement. Queued host callbacks retain their
original root; detached work cannot acquire a later root by saving a helper. Already-dispatched
remote work may finish. Local quiescence does not certify its semantic result.

Existing component fixtures explicitly install a controlled local-only transport using
`tests/unit/worker-attempt-fixture.mjs`. They produce no parent-accepted end. Their immediate controlled
channels are augmented with event registration so a missing close/drain/confirm cannot be silently
fabricated. The controlled qualification record below exercises managed worker IPC, retained
original Wire inputs, projection isolation and cache counts on native Node. Whole-suite, review
and CI checks are separate gates; this note does not activate #277 capacity, #225, #191 or
release support.

The source-binding component control intercepts the existing cargo exit request solely to assert
fail-stop/no-ACK behavior, then uses a separate worker object and fresh broker receipts for replay.
It does not report an observed physical exit or a normal end for that old worker's queued receipt.

## Controlled qualification record

The [frozen evidence archive](evidence/worker-attempt-quiescence/qualification.zip) has SHA256
`15f6173004016f9dd4e2693714b668a6d234d88379834417d61ef09e70a572bd`.
Its [index](evidence/worker-attempt-quiescence/index.json) records the qualified source and test
hashes, exact commands, runtime versions, case matrix and remaining gates. The
[transport manifest](evidence/worker-attempt-quiescence/transport-manifest.json) binds the
multipart evidence delivery to the same archive. Run
`python docs/qualification/evidence/worker-attempt-quiescence/verify.py` from the repository root
to check every archived byte hash, command log, raw case observation and controlled cache comparison.

With the normally installed pinned dependencies, both Node 22.23.3 and 24.19.0 completed normal
`npm run build` emission. Bun 1.4.4 completed `bun check -p tsconfig.json` across 252 project
files. Each native runtime passed 23 focused wrappers with 65 recorded case schedules, including
actual worker IPC, retained proof reads, source continuation rejection and success, a held
supervisor shutdown finalizer, projection frames, fork revocation and public ancestry expiry.
The source continuation cases demonstrate a failing pre-fix schedule and a passing fixed source
without changing the assertions. The archive contains the original raw outputs and emitted code;
the index identifies the test-only freeze after those commands.

The original Wire block 36 controlled same-cargo comparison used two independent physical
receipts and produced `setcode, setabi, setcode, setabi` with two ACK attempts. Both runtimes
recorded 238 DS memory-client `get` calls and 10,565,575 UTF-8 JSON bytes returned from successful
reads, with zero count/byte delta in all 16 measured families against the earlier source.
These are in-memory cache-read measurements for this one controlled Wire input. They do not
measure network traffic, throughput, managed Antelope cache behavior or production latency.

This evidence qualifies local quiescence behavior at the covered seams. It does not grant reader
count or byte capacity, settle queued inputs between attempts, prove complete Wire/Mongo testnet
support, or replace the unchanged original 1..1480 Linux replay and audits required by #277.
