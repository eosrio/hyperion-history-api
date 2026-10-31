# Optional complete-kind reads through owner-v2

Owning issue: [HAPI #402](https://github.com/eosrio/hyperion-history-api/issues/402).
SDK contract: `7412889a14c84342551fd864ea3ebfcf28849385`, optional
`stateful-owner-complete-kind` interface version 1. This component implements that
accepted contract; it does not qualify physical services or full Atomic parity.

The existing owner-v2 public factory, clients, get-only API and declaration/storage
formats retain their behavior; historical profiles keep their exact frozen sources.
A separate native factory
and per-projection `requiredCompleteKindRead` offer select explicit attempt/row/
serialized-byte totals. Registry negotiation refuses missing support before
projection activation. A separately named source profile pins the new SDK,
native emissions and caller assembly without rewriting old pins or results.

The new native adapter delegates the existing owner/recovery/reduction ports and
keeps the same opaque completed-read capability. Owner acquisition creates the
generic declared-kind index. Completed-read acquisition checks that index and
its complete/nonpartial access semantics before exposing a query callback.
Native rows remain scoped by the declaration-specific collection; no Atomic
table, predicate language, synthetic key registry or public order is introduced.

MongoDB driver 7.2.0 can retry overload errors inside transactions, independently
of ordinary retryable reads, and `withTransaction` may rerun its callback. The
complete-kind path therefore uses a lazily created, lifecycle-managed host client
for the same configured URI/database with supported typed `retryReads: false`,
`retryWrites: false`, `maxAdaptiveRetries: 0`. The adapter verifies the effective
options and fails closed. Existing clients keep their original behavior. The
host adds no operator configuration, service or executable auto-upgrade.

Each explicit projection data `find` or `getMore` command is charged before it
is sent. The counter lives outside any transaction callback, so callback retries
share the supplied remaining total. No driver-hidden data retry is permitted.
Owner/view/index/readiness metadata inspections are guarded authority work,
separate from projection data attempts; they cannot contain hidden data reads.
Each transaction callback also reuses the native adapter's actual opaque
completed-read token to inspect owner/revision/checkpoint metadata inside that
same session and snapshot, before any projection rows. The session must belong
to that adapter's bounded client. Outside bookends are additional checks; they
cannot authorize a server-selected older snapshot or a different retry snapshot.
This follows the distinction in [MongoDB 8 snapshot guarantees](https://www.mongodb.com/docs/v8.0/reference/read-concern-snapshot/).
The private bridge registers sessions created by that same native adapter and
rejects foreign, unissued, ended or nontransaction sessions. It exposes no new
SDK port or plugin handle. A controlled older-snapshot and retry counterexample
failed before this check and now refuses before stale projection data reads.
Commit/abort/cursor cleanup are transaction/resource lifecycle, not projection
data reads. Every await retains cancellation/deadline and completed-view fencing.

Enumeration uses the native kind index, batches one row, and has no native limit.
A short or empty live batch is not completion: continue only within the remaining
attempt allowance until the native cursor identifier is exactly zero. An extra
row proves row overflow and causes refusal. Duplicate/malformed/foreign rows,
unknown kinds, byte/attempt overflow, native errors, cold/gap/fork/takeover and
closed/cancelled views refuse without partial success. All exits close/kill the
cursor and end the session through bounded cleanup.

The record and canonical UTF8 byte budgets govern successful returned SDK
envelopes and the final composed record. They are not a promise about MongoDB
wire bytes, BSON buffers, documents examined or native query CPU. A failed
overflow probe may fetch one extra native row, and a malformed/oversized native
row may occupy a driver BSON buffer before it is rejected. Batch-one/native BSON
limits and operation timeouts are separate bounds and must be reported as such.

The additive API accessor `statefulCompleteKindQueryHost(request, projectionId)`
returns the selected projection's SDK query host and advertised explicit totals.
It uses the same request state, live-owner probe, source/ABI checks, cancellation,
single composition and final route `onSend` fence as the get-only API. A completed
record is no transferable serving grant; publication revalidates the real owner.

Source/native Node24/26 and actually installed package controls must be retained
with exact pins. A prepared real MongoDB runner must record command traces proving
true exhaustion, no hidden data retries, budgets, refusal, cleanup and final
view/publication fencing. Root alone runs physical services/hosts after source
review. Boundary fixtures cannot establish physical acceptance. MongoDB is the
4.5 state target, Elasticsearch holds history, and WormDB remains follow-up.
