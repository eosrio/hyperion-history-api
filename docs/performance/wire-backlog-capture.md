# Private Wire backlog byte capture

This is a needed capture component for #277/#371, not a restartable fixture or a
passing replay. The original plain f307 control failed its60s cursor wait at1037
with both primary Mongo recovery views at1036. Its wait inherited49.497s of an
already active reader pause. The original full control remains the observed slow
RED; a faithful60–90s reproduction remains to be constructed.

## Explicit diagnostic activation

After root reviews and prepares a fresh owned native Wire fixture, the existing
qualification CLI accepts `--backlog-capture` after `--native --authority-rpc URL`.
It requires native RPC-bound qualification without CPU/stage profiling or added
recovery faults. Environment sanitization prevents ambient `ES198_*` variables
from opting in. No production config, SDK, database, queue, resource or credit
policy changes. Existing900s run/60s wait/90s cleanup, queue64/resume8, prefetch,
source window32 and ancestry256 remain unchanged.

The native observer installs the optional hooks only for this flag. It retains:

- Original publication bytes at the actual confirm publisher's `sendToQueue`,
  alongside typed options/headers and the original physical delivery/attempt
  description. Its queue invocation is not a confirm, drain, ACK or settlement.
- Original consumer delivery bytes, typed properties/fields and actual attempt
  receipt after the original consumer-capture method returns. Redelivery remains
  explicit; repeated observations do not establish unique queue membership.
- Reader pause/resume and credit-flush before/after observations: actual withheld
  count, generation, session/epoch observation IDs and source-context references.
  No capture method grants a credit, calls an ACK or reuses an old physical owner.

The hook passes the exact receiver, arguments, callbacks and original return
values through. It attaches no Promise rejection handlers, confirmation/drain
listeners, timers, broker consumers or additional database requests. It does not
call an ownership predicate as an extra authorization decision. Capture failure
or a full budget marks the evidence incomplete while the original call still
executes. Original synchronous exceptions propagate unchanged.

Each process retains at most16,384 rows/32MiB, with1MiB per body and128KiB bounded
typed values. All limits describe this private diagnostic capture, not runtime
admission. At terminal exit it writes one fresh `backlog-PID.json` and fsyncs it;
the existing native log records its exact byte hash and elapsed write time.
Overflow/errors make the diagnostic exit unsuccessful. The extra copies and
terminal write introduce unmeasured overhead: the capture cohort is diagnostic,
never a replacement for the original failed control or a throughput comparison.

## Restore admission is deliberately incomplete

`validateWireBacklogCapture` requires an externally pinned file byte count/hash,
checks body hashes/base64, typed data, row sequence, route and bounds. It returns
only byte-integrity evidence with `restorable:false`.
`requireWireBacklogRestore` always refuses. Adding JSON fields claiming complete
genesis, a consistent snapshot or a current owner cannot authorize restoration.

The existing immutable source/proof/admission journals retain recoverable data,
but there is no atomic cross-store plus AMQP/in-flight savepoint at the already
paused pre1006 boundary. A destructive queue get/requeue would change the backlog;
stopping workers and draining would erase its physical pending work. Therefore
this component does neither and never labels its terminal file a checkpoint.
Its source-authority field is explicitly unavailable, not inferred from chain
configuration or a source height. Published typed headers and body hashes can
now be joined to captured exact bodies, but original broker outcomes/membership
remain unknown until separately proved.

The remaining restore work must bind actual complete genesis coverage and ABI
revision inputs; an atomic ES proof/control/admission and Mongo state/undo/
progress snapshot; exact queued/active publication membership and unknown sends;
and authentic fresh source, worker/attempt and credit-owner establishment.
Captured process/session/epoch descriptions are observations of old execution,
never capabilities for a new process. A32-frame feed or an injected pause loses
the measured backlog and is not a RED for this failure.

## Source-level controls and pending validation

`node --test tests/unit/wire-backlog-capture.test.mjs` runs only this helper and
Node builtins, without app imports, engines, sockets or compiled production code.
It covers binary/typed header round trips, unchanged send/callback/Promise/throw
semantics, held sends, detached bytes, consumer custody, credit state, overflow,
foreign/changed inputs and refusal of forged restore authority. These controls
do not demonstrate actual Wire capture, complete-genesis restoration, MongoDB/
Elasticsearch snapshot consistency or the original timed failure.

Whole-project checks/build, existing driver option tests and an actual guarded
capture are pending root review. Full1244/1480, Wire #191 and capacity #277 remain
open. No optimization, capacity activation, deadline extension or fresh server
execution is selected by this patch.
