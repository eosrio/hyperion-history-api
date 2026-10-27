# Original DS receipt enrollment

Status: engineering-only component slice under [#277](https://github.com/eosrio/hyperion-history-api/issues/277#issuecomment-6426242656).

This extends the [verified transition foundation](proof-demand-shadow-accounting.md) with
optional original DS receipt observations. Ordinary workers/master construction do not install
the observer. There is no public configuration, SDK contract, active reader admission, credit,
source/window/resource/deadline change or production activation.

## Original ordering and authority

The original `DSPoolWorker.initConsumer` callback captures the actual received payload and typed
headers before pushing the message into the original cargo. At this point the bridge can report
receipt/process custody without an authenticated registered attempt or semantic source binding.
The source-keyed ledger correctly remains empty, while combined receipt custody and its known
encoded bytes remain visible. Missing data is unknown, not zero coverage.

The optional supervisor observation callback runs after original registration insertion or binding
acceptance and before their original replies. Its opaque token is same-supervisor, synchronous
and single-use. JSON, PIDs, snapshots, caller-supplied epochs and old tokens cannot recreate it.
The associated private lifecycle predicate checks that exact owner/entry remains active. This
prevents late data from enrolling after a genuine end even if the ended observation itself failed.
Ended observations fence diagnostic lifetime; they do not resolve semantic demand.

Only after the original DS admission bind and its following owner/configuration checks does the
worker emit the observed source/selection/ordinal. The parent matches it to original registration,
binding and captured byte digests. This remains a child-checked source observation. It is not
canonical source authority, a fresh write, readiness or permission to advance the source.

Only the existing original parent-adjudicated `onVerifiedDsTransition` can resolve its matching
DS-input stage, after its canonical/source/selection/configuration/target checks and fresh durable
association. There are no parallel RPC/store lookups. A late capture or binding remains uncertain;
it cannot replay an expired transition, even when its bytes can subsequently be measured.

## Bounds and byte meanings

The internal observation window bounds records and encoded bytes before payload copying,
header traversal/serialization, hex expansion, decoding or diagnostic sending. The lifecycle
message cap remains 16 KiB. Child observations reserve conservative space for overlapping header,
hex, JSON and IPC copies plus per-receipt metadata. Missing callbacks or failed sends retain
charged transport uncertainty; timeout does not free it. Diagnostics neither await business
callbacks nor occupy the business request/retry queue.

The parent reserves bounded registration/binding/claim/parse metadata per receipt and checks
aggregate captured data before decoding. Received V8 header bytes are hashed directly, never
deserialized by the parent. They represent serialization of the actual broker-decoded typed
headers, not original AMQP wire framing. Unsupported/missing headers stay unknown.

The combined view separates unbound semantic custody, source-keyed DS accounting, retained
observer copies, conservative metadata reservations and in-flight envelope bytes. Joining a source
binding transfers custody without dropping its known lower bound. Failed/saturated enrollment,
missing transport, wrong owners/digests, late data or observer failure leaves incomplete coverage.
Resolved identities retain finite dedup slots; the observation window stops enrolling on exhaustion.
It does not evict uncertainty, accumulate unbounded failure tombstones or block unrelated indexing.
These encoded byte observations do not measure heap/RSS, broker/native IPC internals or all
pipeline storage/copies.

## Component validation boundary

The native regression uses the original `initConsumer` callback and `createConsumerQueue` cargo
factory, paused before DS processing entry. The new single-input fixture fixes `prefetch.block=1`
before producer epoch capture; this is fixture setup, not a capacity result. Existing default
fixture modes retain their previous setup. Automatic enrollment replaces the new mode's prepared
message bookkeeping and manual parent `retain` call.

The matrix preserves the original producer/proof/DS/adjudicator callbacks, publisher-confirm hold,
durable result, ACK-attempt and genuine end assertions. It exercises registration request/reply
holds, observer transport failure, and capture/binding delivered after original adjudication.
Controlled broker/storage/RPC boundaries remain explicit. Source controls cover overwritten
original bytes/headers, distinct physical owners/redelivery/selections, foreign/expired tokens,
metadata/count/byte/in-flight exhaustion, failed ended observations and bounded unknown headers.

The queued diagnostic notification does not synchronize the separate asynchronous registration
request. In the late-capture control, withholding capture can therefore leave the parent receipt
window empty until that registration arrives. Under [#363](https://github.com/eosrio/hyperion-history-api/issues/363),
the fixture waits for original registered custody matching both receipt and attempt identity before
sampling it. A delayed-registration control holds the real supervisor request while capture and
cargo remain held, then releases it through an explicit microtask gate. The old immediate snapshot
fails with receipt count zero versus one; the observation wait preserves the original unknown-byte,
authority, enrollment, physical-drain and ACK assertions, errors and deadlines. This is a fixture
ordering correction; it changes no production callback or release gate.

Record exact final native Node 24/26 results, source/emission pins, focused checks, independent
reviews, full-suite result and CI before merging. Focused component success does not establish
full worker/Wire or release qualification.

## Remaining gates

Reader grants/raw frames, MainDS, downstream sinks, independent projections, diagnostic/native
copies and isolated recovery still need their own original ownership and release witnesses.
Publisher confirmation, source/DS ACK attempts, counters and progress snapshots cannot stand in
for durable sink completion or broker settlement. Recovery/readback/restart must not reconstruct
expired opaque authority. Contract failures require bounded isolated durable recovery rather than
an indefinite global failed-projection barrier.

Preserve 256 ancestry, original source 1..1480, queue/resource budgets and deadlines. Historical
input qualification, fork/restart reconstruction, live/bulk reservations, durable isolated handoff,
compaction/expiration and any public admission policy remain separate requirements. Current
architecture is pinned to Tools `5cfaa871257f796b1ceb9f912dc5bc6ed0a6a01a`; the earlier
`81da2f26` design inventory is retained as historical provenance. No full replay, performance,
capacity improvement or production activation is claimed here.
