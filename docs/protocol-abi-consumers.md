# Canonical ABI proof consumers

Implementation of the consumer continuation of #213, stacked on #217. This is not release or
Wire testnet qualification. The SDK/provider interfaces and exact installed component pins stay in use.

Only the coordinator publishes an immutable settled-head certificate, after the complete control CAS
receipt and the following source-epoch check. Its content binds chain, installed profile/components,
owner, generation and the exact certified head. A consumer never repairs control or acquires ownership.
Observed control selects and may revoke a certificate; it cannot grant additional ABI coverage.

`ProtocolAbiProofReader` is the shared read-only boundary. `open(source, selectionId?)` finds a current
settled certificate and follows exact immutable parent links, bounded by `maxAncestryBlocks` (default
256, 1 through 4096). It returns the exact source selection and compact input bindings. Ancestor commits
may have older generations. Missing certified ancestry is unavailable, including older history until
a qualified historical membership/checkpoint mechanism exists. This bound does not waive that work.

`action(view, input)` matches the original transaction/allocated ordinal, receiver/account/name,
lossless receipt sequences and original raw bytes. The returned certified binding supplies the input
origin ordinal when the caller has not yet obtained it. Persisted metadata must supply that ordinal
and match it. Its immutable state ID selects the input ABI; a final-state root cannot select an action
epoch. `finalState(view, account)` uses the target commit's root. UNKNOWN, deleted, empty and rejected
ABIs retain raw input and explicit incompleteness, without an older-schema fallback.

`waitForOpen` permits at most a 30-second deadline (five seconds by default) and accepts cancellation,
including while a storage operation is pending. A reader permits at most 64 concurrent storage reads;
an expired waiter cannot start additional reads or publish a late successful result. The underlying
client's transport timeout still bounds an already-issued read. Consumers never provision proof indices.

`revalidate(view)` is mandatory after asynchronous decoding and before publishing/serving a derived
result. Readers recheck current owner/generation, phase and replay fencing. Cache immutable bytes or
retain exact source/occurrence metadata with cached results; validate cached extension results before
returning them. API JSON compatibility remains unchanged; internal proof metadata is not product copy.

MainDS preserves the source selection across Rabbit handoff. The action pool retains original raw
bytes and anchors before grouping and Number conversion, groups notifications by certified input
origin, and stores opaque `protocol` metadata in additive action mappings. Final KV normalization uses
the same certified source when available. The API encodes only with the certified input ABI and checks
response/transaction cache paths too. Proof failures affect the requested data; unrelated indexing
continues. Native storage queries remain inside adapters.

Optional action roots that decode to JSON `null` are derived values too. Their cached responses require
the same proof checks as object payloads; retained raw `00` remains readable. Internal response-cache
sidecars are versioned separately and never appear in public JSON.

The master adds the opaque action `protocol` mapping to existing open/hidden partitions before workers
start and verifies the result. Existing documents are not rewritten. Incompatible existing fields are
refused rather than reinterpreted. New extension action document IDs and transaction-cache keys use the
original decimal receipt sequence. The legacy public numeric sequence and query/sort precision across
the full uint64 range still need separate Wire history qualification; these fixtures do not establish it.

Waits, ancestry and retained proof work are bounded. Existing Elasticsearch history remains usable;
new metadata/mappings initialize separately without a full history reindex. Cumulative retention,
trusted bootstrap, bulk/historical authority, complete recovery/query qualification and representative
profiling remain open in #213.
