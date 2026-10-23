# Hyperion native streaming v1

Working implementation contract, 2026-10-23. This is an additive, experimental
protocol; the legacy Socket.IO endpoint remains supported. Server route ownership:
the Hyperion architecture task. Client implementation: this repository.

## Transport and identity

One UTF-8 JSON object per WebSocket text message, subprotocol
`hyperion-stream.v1.json`. Proposed listener path: `/stream/v2` on the existing
stream listener, subject to the server's route/proxy integration tests. No binary
messages, compression requirement, or Socket.IO/Engine.IO framing. The client
requires the server to select the exact subprotocol. Production uses `wss://`.

All IDs, generations, frame sequences and uint64 cursors are canonical decimal
strings in `0..=18446744073709551615` (no leading zeros except `"0"`). Block numbers
are JSON integers in `1..=4294967295`. Chain/block IDs are 64 lowercase hex digits.
Request/stream/subscription/connection IDs and generations are nonzero. Request
IDs and generations are fresh for every subscribe attempt; stream IDs identify a
logical client subscription and survive reconnect. Subscription IDs are assigned
by the server and unique within a connection. Connection IDs identify a server
connection incarnation. Every scoped packet carries the full scope:

```json
{"connection_id":"1","stream_id":"1","generation":"1","subscription_id":"100"}
```

Connection identity plus generation fences every data, ACK, error, cancel and
completion packet. Old/unknown scopes are ignored without granting credit,
delivering data or changing current state. Request IDs correlate subscribe and
accepted/rejected outcomes; they are distinct from server subscription IDs.

## Handshake and subscription

Server first:

```json
{"type":"hello","version":1,"chain_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","connection_id":"1","heartbeat_interval_ms":15000}
```

Client responds with its connection acceptance budget before subscribing:

```json
{"type":"ready","connection_id":"1","window":{"records":4096,"bytes":8388608}}
{"type":"subscribe","connection_id":"1","request_id":"1","stream_id":"1","generation":"1","request":{"kind":"action","contract":"eosio.token","action":"transfer","start_from":100},"resume_from":null,"window":{"records":1024,"bytes":2097152}}
```

`request` is an action or delta request with `kind`, the existing selectors,
`start_from`, `read_until`, `ignore_live`, `filter_op`, and filters. `replayOnReconnect`
is a local client policy, not a server request field. Falsy filter values must
survive serialization. `resume_from` overrides the original start bound with an
inclusive absolute block on recovery; a null value uses the original request.
The server retains the original end bound and filters. Initial start bounds may
be zero (live), absolute/relative block integers, or existing timestamp strings.
`read_until` keeps the existing history-only meaning; `ignore_live` requests a
finite stream. The existing server validates selectors and supported filters.

```json
{"type":"accepted","connection_id":"1","request_id":"1","stream_id":"1","generation":"1","subscription_id":"100","start_from":100}
```

The server resolves the actual absolute inclusive replay anchor in `start_from`,
including live/relative/timestamp requests. No data before accepted. Clients pin
the first chain identity (or configure one) and reject a different chain on a
later connection. Unknown version, malformed packets, wrong current request
correlation and sequence gaps fail visibly; they never advance replay.

## Data, credit and completion

```json
{"type":"data","connection_id":"1","stream_id":"1","generation":"1","subscription_id":"100","sequence":"1","mode":"history","records":[{"block_num":100,"block_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cursor":"18446744073709551615","payload":{"global_sequence":"18446744073709551615","act":{"data":{"amount":"1.0000 EOS"}}}}]}
{"type":"ack","connection_id":"1","stream_id":"1","generation":"1","subscription_id":"100","sequence":"1"}
```

Sequences start at `"1"` and increase by exactly one per data frame in each scope.
A frame is nonempty, contains one mode, and has nondecreasing block numbers.
Blocks cannot move backwards within a generation. `cursor` is optional exact
uint64 metadata, not a durable checkpoint. Arbitrary contract payload is retained;
known uint64 metadata (`global_sequence`, receipt sequences) uses decimal strings,
including values beyond JavaScript's safe integer range. Delta primary/secondary
keys retain their complete existing strings, including compound/wider identities.
Every record requires a real block_id; unavailable identity fails explicitly.

Both per-stream and per-connection windows bound **unacknowledged** record counts
and UTF-8 encoded bytes of complete data JSON messages (including envelope).
They are hard maxima, not incremental grants. ACK releases exactly that frame's
count/bytes in both budgets. ACKs are once per frame, in receive order; no repeated
or fabricated ACK grants credit. A client sends ACK when the batch is handed to
its caller. This is acceptance, not application durability. A caller that needs
durable recovery saves its own inclusive checkpoint and deduplicates records.

The server bounds its own unsent queues and history/live overlap too. It must
pause or fail a slow stream without blocking unrelated streams, silently dropping
records, or advancing its replay boundary. Control messages do not consume data
credit, but have bounded sizes, rates and deadlines. The server splits history
pages into bounded nonempty frames, charges its own retained frame's actual bytes
and records, and never trusts an ACK to declare those costs. A single record that
cannot fit the frame cap and both windows fails its stream. Unknown, repeated or
out-of-order ACK never releases credit. Active and lifetime control/subscription
state are bounded. Oversize frames and exhausted
budgets fail explicitly. Initial client maximum WebSocket/JSON message: 1 MiB;
maximum streams: 16; all budgets and deadlines are configurable within local bounds.

```json
{"type":"history_end","connection_id":"1","stream_id":"1","generation":"1","subscription_id":"100"}
{"type":"end","connection_id":"1","stream_id":"1","generation":"1","subscription_id":"100"}
```

Every stream emits history_end, including a live-only stream with empty history.
No live data before history_end; no history data after it. The server must buffer
live overlap within a bound or fail/replay, preserving history/live ordering.
history_end describes the server's history phase, not independently qualified
source completeness. end forbids further data; the client drains accepted queued
batches before reporting End. HistoryEnd can be observed while LIB-mode history
is still waiting for irreversibility. End also waits for those batches.

## Cancellation, failure, heartbeat

Client cancel uses the full current scope. Server cancelled acknowledges cleanup
of routing ownership, active history search, ACK waits and scroll resources.
Client local cancellation immediately stops delivery; its completion does not
claim the remote acknowledgement has arrived. Cancelling before acceptance uses
`connection_id`, `stream_id`, `generation`, `request_id` with `subscription_id:null`.
The server must cancel that pending attempt too.
For pending cancellation the server may allocate its subscription ID before
accepted, and return cancelled with the full scope and optional original
request_id. No artificial accepted packet is required. Locally cancelled clients
ignore that late acknowledgement; confirmed server cleanup is tested separately.

```json
{"type":"error","connection_id":"1","stream_id":"1","generation":"1","request_id":"1","code":"HISTORY_UNAVAILABLE","message":"Retained history unavailable","retryable":true}
{"type":"ping","id":"1"}
{"type":"pong","id":"1"}
```

Stream errors require stream_id + generation and matching connection_id. Optional
request_id must match the attempt. A connection error has neither stream_id nor
generation. Stream failure clears only that stream and is terminal for that
attempt; callers explicitly decide whether to retry retryable terminal errors.
Transport loss can be retried through reconnect with the original subscriptions.
No automatic infinite retry of protocol/authentication/source errors.

Either peer can send application ping; the other echoes its id in pong. Native
WebSocket Ping/Pong may supplement this but is not the browser-facing liveness
contract. Handshake, request acceptance, writes, idle connections, irreversible
progress and server cancellation/ACK waits have finite deadlines. A stalled
LIB cannot be hidden by repeated equal LIB notifications or heartbeats.

## Fork, LIB and recovery

```json
{"type":"lib","connection_id":"1","chain_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","block_num":100,"block_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
{"type":"fork","connection_id":"1","chain_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","starting_block":101,"ending_block":103,"new_block_id":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

These controls also require `connection_id` and are ordered within that connection.
Controls from an old connection are ignored. LIB never regresses; an equal LIB
must have the same block ID. Fork start must be above LIB. Irreversible delivery
buffers entire batches until every record is at/below LIB; control messages must
remain deliverable without data credit. To avoid deadlock, the server sends LIB,
history_end, fork and terminal controls independently of data ACK waits.

An outage invalidates all unconfirmed records and current server scopes. Fork
also invalidates the affected connection's outstanding delivery buffers. The
client cancels/replaces subscriptions with fresh request IDs/generations, retains
the earliest unread/unconfirmed recovery block across repeated outages, and
replays inclusively. Already accepted head-mode records can be replayed too.
With replay disabled, emit retryable STREAM_REPLAY_REQUIRED. Never confirm old
buffer contents using a LIB from a later connection. Relay replacement/outage
closes the native WebSocket. Reconnect gets a new hello/connection incarnation;
an in-band second hello is invalid. Old public scopes cannot silently stay active.

The accepted start_from is a real resolved lower bound, never the first matching
row or an optimistic indexed head. A live-only anchor uses the observed router
handoff block inclusively. If a timestamp/relative/live anchor cannot be resolved,
the server rejects retryably. Native history writes complete on admission into
the bounded in-flight window, allowing finality controls to arrive independently
of client-consumption ACKs. A replacement retires old history/routing/ACK ownership
before becoming active. cancelled follows actual history and confirmed router
cleanup, or a terminal retryable cleanup error.

## Shared conformance

Language-neutral scenarios under `conformance/v1/` describe server wire inputs,
client actions and literal expected public events/outbound packets. The Rust
driver uses the public core and JSON codec; native WebSocket integration exercises
the real adapter against a second implementation peer. A platform-JSON/BigInt
JavaScript driver validates the same wire corpus without runtime dependencies.
Run limits, stale-scope, completion, fork/LIB, outage, exact uint64, malformed JSON,
request correlation, cancellation and timeout cases on every supported platform.
These fixtures establish protocol/component behavior; actual HAPI retained-history,
filter/proxy/fanout and known-chain recovery acceptance remains owned by #231.
