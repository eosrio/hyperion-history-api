# Broker recovery worker rejection provenance

Engineering evidence for [#331](https://github.com/eosrio/hyperion-history-api/issues/331),
within [#288](https://github.com/eosrio/hyperion-history-api/issues/288).
The earlier broker recovery captures retain failed shutdowns and an unclassified
producer/source/target mismatch. A mismatch message or a nearby broker restart does
not establish which predicate failed or make a worker death expected.

## Observation boundaries

The DS admission path names its first failed comparison, in the existing order:
owner, producer epoch, executable, chain, source headers, concrete target, dispatch
inventory, then owner/configuration after binding. Comparison operands are evaluated
once; later checks and target reads remain skipped after rejection. Existing error
messages, fencing, binding, drainage and settlement behavior remain in place.

The reader passes the actual publisher recovery decision and its original channel
from the callback that makes it. Qualification retains each original send's payload
hash, typed header hash, source ingress and channel identity until the original
confirmation callback returns. A thrown send keeps an unknown outcome.

The native observer writes `action_admission_rejected`, `action_admission_threw`
and `reader_publisher_recovery_required` records. The first includes the actual
failed predicate/operands, original attempt descriptor and scope, parent
epoch/incarnation, original/current channels, source, admission, producer/executable
digests and concrete target. Configuration comparisons retain digests rather than
operator configuration values. Exceptions outside a named rejection remain
unclassified and preserve the original exception.

`physical_worker_forked`, `physical_worker_exited` and `attempt_owner_attached`
observe original cluster Worker callbacks and the original supervisor attachment.
Linux birth ticks come from that PID's `/proc` stat record. A diagnostic incarnation
is explicitly distinct from the supervisor's epoch/incarnation. Unsupported local
platforms report unavailable birth ticks; they do not invent a birth identity.

The qualification-only fence observer retains the original supervisor's send,
callback outcome and complete chunked set of then-active attempts. Each member has
its original sequence and descriptor/binding digests. The send is joined to the
captured Worker, its observed PID/birth and parent epoch/incarnation. A source-open
or revocation context is recorded only when that original master call actually
reaches the supervisor. A send return or callback is not a delivery acknowledgment.
Worker births are retained from original fork/attachment observations. Source
context is realized only when a real supervisor send occurs: an unrelated no-op
needs no process lookup, and relevant revocation after exit uses retained identity.

On the child, wrappers preserve original EventEmitter dispatch and the client's
authority validation. The first actual scope fence records accepted parent IPC,
the original channel-close callback, disconnect, disposal, supervised retirement,
or an unclassified local call. A parent fence cached before hello is labeled
deferred and includes its captured sequence watermark. Normal root drainage is
counted separately; it cannot overwrite an earlier fence. Rejected admission rows
reference that same retained scope observation. No scope, message or end is created
by the observer, and original drain promises, returns and errors are preserved.

A child callback alone does not establish which parent operation issued a fence:
the matching parent send and member set are required. In particular, copied valid
IPC bytes can reach the child's existing callback without producing an original
supervisor-send observation. These descriptions cannot grant fault membership.

## Bounds and authority

Per process, captures allow 32 rejections, 64 outstanding publication descriptions,
256 physical worker observations and 64 KiB per record, within the existing native
observer's total byte budget. Overflow or capture/sink failure increments
`rejectionDiagnostics.reportFailures` in `observer_metrics` and fails qualification.
The observed operation still returns or throws its original result.
Fence captures additionally allow 1,024 events per process and 32 members per row.
The audit requires the child/client/channel hooks, the primary's supervisor/master
hooks, unchanged limits, and zero omissions/failures. Exhaustion leaves incomplete
evidence; it does not change processing or waive a raw failure.

Coverage reconciles the actual launched primary and ordinary start/fork census with
each native start and summary. Missing files or summaries remain explicitly
`incomplete` in the raw report. Required normal survivors must have complete
coverage. Existing deliberate-kill modes select survivors only through their
existing original-object fault verification; the killed process's absent summary
stays unknown in raw coverage. This creates no new fault allowance.

These records grant no source, end, retry, ACK, capacity, restart or fault membership
authority. There is no fault-accounted shutdown mode in this change. Raw
`shutdown.success: false`, nonzero master/child exits, unknown storage/ACK outcomes
and the strict shared shutdown checker remain unchanged. Copies, stale descriptions
and temporal proximity cannot normalize them.

## Validation and remaining qualification

After `npm ci` and `npm run build`, run:

```sh
node tests/unit/worker-rejection-provenance.mjs
bun test tests/unit/worker-rejection-provenance.test.ts
node tests/unit/worker-fence-origin.mjs active
bun test tests/unit/worker-fence-origin.test.ts
```

The native component loop exercises all admission decisions, short-circuit order,
actual controlled and managed attempt clients, copied/reused custody, diagnostic
sink failure, real cluster forks and original reader close/error/return/confirmation
callbacks. Expected reader failures actually exit 1. Storage and broker transports
remain controlled; a managed quiescent end with a thrown root does not prove semantic
completion. CI runs this loop on native Node 24 and 26.

The managed fence loop runs real cluster workers and the original admission,
supervisor and client callbacks with controlled storage/channels. It distinguishes
source-open, active/stop fences, channel closure, deferred hello, stale/copied input,
unrelated exceptions, and capture failures. Separate controlled EventEmitter tests
check disconnect/dispose dispatch, independent owners, multi-row membership,
send throw/callback errors and original result/promise identity. Those controlled
dispatches are explicitly not physical IPC disconnection or exit evidence.

Fresh, source-pinned Linux Node 24/26 runs of the original full broker recovery
scenario are still required. Keep the original corpus, oracles, default 256-block
ancestry window, queue/byte budgets, durable acknowledgments and deadlines. Retain
the failed raw run even when the new records identify the first failed comparison.
Identifying that comparison is not itself a causal fix or completed Wire/release
qualification. Any later fault-accounted shutdown design needs its own evidence and
private, original-object membership checks described in #331.
