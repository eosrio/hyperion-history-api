# Canonical native-action authorization

`ProtocolNativeActionReader` is an internal read-only boundary for the host's already selected,
loader-verified provider and coordinated component set. It does not select executable code from
journal metadata or activate native requirements in installed profiles.
It obtains detached read-only journal and proof handles even when the caller supplies writer
instances. Cold reads cannot provision indices, prepare records or transfer existing issued proofs.

`open(source, selectionId, {signal})` first opens the existing canonical ABI proof reader. It then
reads the native journal and its original source references, matches the exact chain, block,
predecessor, context, handshake and component profile, and reruns the pinned native observer.
An independent trace decode re-derives the full source inventory and notification ancestry.
Every first-receiver decision and raw digest must reproduce the retained journal; every original
occurrence must also match the canonical proof's receipt membership. Journal readback alone grants
no authority. Whole-source incomplete or missing evidence returns retryable unavailable.

`authorize(view, input, {signal})` uses `ProtocolAbiProofReader.occurrence`, so membership does not
require a known or valid deployed contract ABI. The exact original input is required. A notification
inherits its certified first receiver's decision only through independently verified ancestry.
Explicit contract and per-origin incomplete decisions remain distinct. Native decisions produce an
opaque grant owned by this reader and view; copied, serialized or rebound handles are rejected.

`decodeValue(grant, {signal})` accepts no caller-selected kind, ABI, name or replacement bytes.
It decodes with the pinned provider and requires strict encoding back to the authorized original
bytes, including rejection of source mutation. Unsupported kinds and codec errors return retryable
unavailable; they never fall back to a deployed contract ABI.
The returned value and encoder input are separate detached snapshots, each with owned serialization
bytes, so provider-retained objects or binary views cannot mutate a checked result during the final
authority read. The per-value snapshot is bounded to 64 MiB and preserves supported structured data
such as bigint, binary views, maps and cycles; unsupported values remain unavailable. Snapshot bytes
are transient local data and are never a persisted protocol or API format. The host uses
[Node's serialization API](https://github.com/nodejs/node/blob/main/doc/api/v8.md#serialization-api)
with a separate owned input buffer for each deserialization.

Canonical authority is revalidated around awaited reads and before successful consumption. Owner
replacement, recovery and fork generation changes invalidate old views and grants. The caller's
same optional signal reaches all nested reads; its exact abort reason takes precedence over late
success or translated failures. Independent consumers keep separate cancellation and grant state.
At most eight source openings run concurrently per reader. Existing retained-record limits and
the proof reader's default 256-block ancestry bound (maximum 4096) remain unchanged. Sources outside
qualified coverage remain unavailable; enlarging a test window is not historical qualification.

The installed loader still refuses native-required profiles. Worker decoded-value publication,
versioned document metadata, HTTP/cache/current-Socket.IO consumers, historical and full-worker
recovery, fork/testnet acceptance and coordinated activation remain separate #256/#191/#231 work.
Existing Elasticsearch history remains usable without a mandatory full reindex.
