# Native streaming implementation

The additive native streaming lane is tracked in [#294](https://github.com/eosrio/hyperion-history-api/issues/294),
coordinated with [client #20](https://github.com/eosrio/hyperion-stream-client/issues/20) and
[release #24](https://github.com/eosrio/hyperion-tools/issues/24). Existing server/client acceptance
remains [#231](https://github.com/eosrio/hyperion-history-api/issues/231).

## Current modules

`replayStreamHistory` shares the existing queries, response shaping, filters, canonical proofs and
cursor cleanup through `StreamHistoryDelivery`. `streamPastCommon` remains the Socket.IO wrapper.
Every delivery connection supplies disconnect listeners. `HistoryStart.firstBlock` describes the
first matching hit; native subscription acceptance must resolve its inclusive replay anchor separately.

`native-json` implements the experimental `hyperion-stream.v1.json` envelope rules, canonical
decimal-string identifiers, complete UTF-8 frame limits, duplicate-key rejection and metadata checks.
Contract JSON under `data` stays opaque; compound or wider delta identities retain their strings.
Outgoing serialization validates the actual encoded document and rejects non-finite numbers.

The shared protocol and fixtures are from client commit `346c473f55979ff2dd841aa2bbba4bcfebc49ef7`.
[The fixture source record](../tests/fixtures/native-stream-v1/source.json) retains repository,
paths, license, byte counts and SHA-256; tests verify all frozen bytes against the source manifest.
All 37 wire vectors run through the codec, including receipt shape and opaque payload cases.
The 24 state scenarios and two network sessions are
retained for subsequent session/endpoint integration; this module slice verifies their identity,
without claiming their server acceptance. The textual contract remains an implementation draft.
Updates require an explicit new pin.

`NativeStreamCredits` owns count and complete encoded-byte accounting for one connection incarnation.
It maintains both connection and subscription windows, per-scope data sequences and bounded active
and lifetime subscription identities. Its default bookkeeping limits are 16 active subscriptions
and 4,096 lifetime subscriptions. Window values are positive integers bounded locally to 65,536
records and 64 MiB; the default frame cap is 1 MiB. These are module limits, not qualified operator defaults.

Send fences same-scope serialization reentry and reserves measured costs before invoking a synchronous writer. Only `true` commits the frame;
`false` or an exception releases the reservation without consuming its sequence. The transport
adapter must distinguish accepted-but-buffered writes from dropped writes. An ACK releases only
the next committed frame's retained costs, exactly once. Old, foreign and out-of-order ACKs grant
no credit. Closing a scope releases its pending and outstanding costs, including during synchronous
transport retirement. It never reissues an old generation or subscription identity.

The credit module reports immediate send outcomes and coalesced capacity-change notifications.
The session adapter must bound unsent queues and history/live overlap, split pages into nonempty
frames, give every wait a deadline, clean up cancelled work and keep control traffic deliverable.
Packet acceptance and credit release do not establish application durability.

## Remaining integration

The native endpoint, session coordinator and socket adapter remain under implementation. Their
acceptance includes actual resolved anchors and block identities, connection/generation fencing,
history-before-live ordering, pending cancellation, relay replacement, fork/LIB handling, bounded
query/queue memory, and installation/proxy guidance. Proposed `/stream/v2` listener coexistence has
only a loopback prototype observation; it still needs production-adapter and proxy checks.
Relay replacement/outage must close the native WebSocket; a new physical connection receives a
new incarnation. An in-band second `hello` is invalid. Pending cancellation may return the allocated
full scope without manufacturing an `accepted` packet, after actual cleanup completes.

Module and shared-vector tests supplement real HAPI/client tests. They do not establish full
native endpoint support, retained-history completeness, selected Wire testnet qualification,
Bun indexing-runtime compatibility, throughput or peak-memory recovery. Keep #294 and #231 open.
