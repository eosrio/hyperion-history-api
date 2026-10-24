# Shared reader backpressure

[HAPI #279](https://github.com/eosrio/hyperion-history-api/issues/279) corrects
infrastructure pause/resume for the existing `reader` and `continuous_reader`
workers. Queue budgets and resume hysteresis are unchanged.

While paused, a reader finishes accepted input within its already granted SHIP
window and waits for successful Rabbit publication confirmation. It retains
confirmed credits in one bounded `uint32` counter instead of returning them to
SHIP. The cargo loop completes; it does not wait for an operator resume. Resume
returns the retained credits once on the same current connection and decoding
session. Repeated pause/resume, confirmation and drain callbacks do not duplicate
credit returns. Bulk assignments received while paused keep their existing
deferred range scheduling.

Connection replacement, close, source revocation, session replacement, finish and
failed publication invalidate earlier credits. Legacy raw frames carry physical
connection ownership captured at the socket callback, before cargo queues them.
Distinct Buffer views retain per-delivery identity without copying their payload.
A frame queued before reconnect cannot bootstrap or credit the replacement
connection. Resume does not override local finish or publication failure.
An explicit `next_server` command drives endpoint rotation and reconnect for
both protocol paths; late callbacks from the retired socket cannot rotate or
reconnect again, or restore its invalidated credits.
Legacy attempts that fail before opening retain their normal reconnect path;
duplicate closes and late opens cannot reactivate a retired attempt.
The SHIP socket wrapper also fences callbacks by physical socket identity so a
retired close cannot clear the replacement's connection state and discard its
held credits. Current socket callbacks and graceful-close behavior are retained.

This implements infrastructure backpressure under
[ADR 0022](https://github.com/eosrio/hyperion-tools/blob/main/docs/adr/0022-retain-infrastructure-backpressure.md).
Contract failures retain their separate incomplete/recovery behavior under
[ADR 0043](https://github.com/eosrio/hyperion-tools/blob/main/docs/adr/0043-bound-recovery-retention-and-report-unavailable-inputs.md).
Already granted input may finish before a pause takes effect. Queue polling and
message counts do not bound the age of one unresolved action input: the strict
proof-coverage requirement in [#277](https://github.com/eosrio/hyperion-history-api/issues/277)
and the full #270/#191 qualification remain separate.

The focused tests use actual emitted reader, queue-monitor/master dispatch,
canonical source and SHIP encoding methods with controlled socket, broker and
storage transports. Wire cases authenticate the original captured block 33 and
select the installed native provider normally. Legacy cases use the real default
Antelope provider and the captured Spring genesis fixture. These are component
regressions, not live chain or complete worker qualification.
Socket-wrapper cases load the actual emitted `StateHistorySocket`, replacing
only its `ws` transport with an event emitter. The late-close case carries the
captured Spring frame through actual reader publication and confirmation before
pause/resume, then checks the replacement transport's encoded credit bytes.

After installing the committed npm lockfile with preparation scripts enabled and
building the emitted artifacts, run with the CI Node.js 24 or 26 executable:

```sh
READER_RECOVERY_NODE=/path/to/node bun test tests/unit/state-reader-live-backpressure.test.ts
```

The matrix covers both roles, hysteresis, confirmed-input coalescing, pause/resume
during retention/confirmation/drain awaits, queued and in-progress reconnects,
late socket callbacks, explicit endpoint switching, source/session invalidation,
stop/finish guards, unchanged range requests, and failed or unknown publisher
confirmation. No public admission
activation, proof-window increase, timeout change, dependency upgrade, service
deployment, or weaker durability/drain/seal guard is part of this correction.
