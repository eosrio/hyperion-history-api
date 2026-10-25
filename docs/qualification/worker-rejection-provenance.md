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

## Bounds and authority

Per process, captures allow 32 rejections, 64 outstanding publication descriptions,
256 physical worker observations and 64 KiB per record, within the existing native
observer's total byte budget. Overflow or capture/sink failure increments
`rejectionDiagnostics.reportFailures` in `observer_metrics` and fails qualification.
The observed operation still returns or throws its original result.

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
```

The native component loop exercises all admission decisions, short-circuit order,
actual controlled and managed attempt clients, copied/reused custody, diagnostic
sink failure, real cluster forks and original reader close/error/return/confirmation
callbacks. Expected reader failures actually exit 1. Storage and broker transports
remain controlled; a managed quiescent end with a thrown root does not prove semantic
completion. CI runs this loop on native Node 24 and 26.

Fresh, source-pinned Linux Node 24/26 runs of the original full broker recovery
scenario are still required. Keep the original corpus, oracles, default 256-block
ancestry window, queue/byte budgets, durable acknowledgments and deadlines. Retain
the failed raw run even when the new records identify the first failed comparison.
Identifying that comparison is not itself a causal fix or completed Wire/release
qualification. Any later fault-accounted shutdown design needs its own evidence and
private, original-object membership checks described in #331.
