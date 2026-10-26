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

`occurrence(view, input)` proves exact original input membership in the issued canonical source. It
matches the original transaction/allocated ordinal, receiver/account/name, lossless receipt sequences
and original raw bytes. The returned frozen `{binding}` supplies the input origin ordinal when the
caller has not yet obtained it; an explicitly supplied origin must match. The reader rechecks current
authority before returning, without looking up or validating an account ABI. Thus a complete source
can prove an occurrence even when its input ABI state is unknown, absent, empty, malformed or missing
from retention. The binding's `stateId` is only an opaque reference, which may be null; this grant does
not resolve ABI state, classify a native action or authorize decoding. Incomplete source observations
still cannot issue a proof view. This is the occurrence foundation of
[#256](https://github.com/eosrio/hyperion-history-api/issues/256); native interfaces and persisted native
decisions remain separate work.

`action(view, input)` performs the same original-input match and additionally requires the certified
input ABI state. Its existing order remains input validation, ABI-state resolution and validation,
then authority revalidation. Persisted metadata must supply the origin ordinal and match it. The
immutable state ID selects the input ABI; a final-state root cannot select an action epoch.
`finalState(view, account)` uses the target commit's root. UNKNOWN, deleted, empty and rejected ABIs
retain raw input and explicit incompleteness, without an older-schema fallback. Nonempty ABI hex is
opaque at the proof reader boundary; successful `action()` state resolution does not establish that
the codec can decode those bytes.

`waitForOpen` permits at most a 30-second deadline (five seconds by default) and accepts cancellation,
including while a storage operation is pending. A reader permits at most 64 concurrent storage reads;
an expired waiter cannot start additional reads or publish a late successful result. The underlying
client receives the cancellation signal for already-issued reads. HTTP disconnects cancel their own
proof work and remove request listeners; independent stream scopes keep their own lifetime. Consumers
never provision proof indices.

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

Built-in and plugin state handlers may await nested decoding. Core publication helpers retain bounded,
snapshotted effects for each normalized row until the handler finishes and its proof is revalidated;
every drained effect checks validity again. A revoked proof discards the remaining effects. Arbitrary
plugin-owned external I/O remains the plugin's responsibility. These guards do not establish complete
state rollback or projection qualification.

Optional action roots that decode to JSON `null` are derived values too. Their cached responses require
the same proof checks as object payloads; retained raw `00` remains readable. Internal response-cache
sidecars are versioned separately and never appear in public JSON.

The API preserves the certified JSON root, including arrays, scalars, optional nulls and contract fields
named `account`, `name`, `authorization` or `data`. Standard compacting handlers keep enrichment separate
from the retained contract payload. Missing members are restored from the certified raw bytes, supplied
contract values must re-encode exactly, and contract values take precedence over lossy annotations.
Response-cache identity includes the HTTP method and versioned route; each extension hit still requires
fresh proof validation. Live action delivery uses a per-chain FIFO with a bounded pending count and byte
budget, snapshots retained input before waiting, and revalidates before emission.

The master adds the opaque action `protocol` mapping to existing open/hidden partitions before workers
start and verifies the result. Existing documents are not rewritten. Incompatible existing fields are
refused rather than reinterpreted. New extension action document IDs and transaction-cache keys use the
original decimal receipt sequence. The legacy public numeric sequence and query/sort precision across
the full uint64 range still need [separate Wire history qualification](https://github.com/eosrio/hyperion-history-api/issues/219);
these fixtures do not establish it.

The legacy extension state projections do not yet provide canonical rollback or a compatible read
view. A final-block ABI proof cannot establish missing/deleted query members, complete counts, or
pagination. Until those capabilities are qualified, the shared API boundary rejects affected
extension projection routes before response-cache or storage access with retryable HTTP 503 and
`Retry-After`. This covers contract state, native permission/link projections, row history and table
state; delta streams use the same readiness guard. Composite account responses cannot bypass it.
Antelope routes, raw action history and deployment evidence retain their existing behavior.

Decoded-field predicates and sorts also require a complete query-membership contract. Validating
only the returned hits cannot detect a true member omitted by stale indexed contract fields. The
shared action-query classifier therefore gates unqualified extension decoded-field queries before
response caches, searches or stream registration. Metadata-only history, certified action bodies,
created-account queries selected by native metadata, and unfiltered CPU/net statistics remain usable.
Action-derived membership lookups and transfer-filtered resource aggregates retain an explicit
readiness gate until their complete query plans are qualified.

These are temporary readiness gates, not working Wire state support or a release waiver. Their
replacements require [source-bound row and action query coverage](https://github.com/eosrio/hyperion-history-api/issues/220)
and [runtime/adapter state read views and canonical recovery](https://github.com/eosrio/hyperion-history-api/issues/221),
coordinated with #191 and eosrio/hyperion-tools#21. A configuration flag cannot authorize an
unqualified projection. The route tests exercise poisoned retained caches and unavailable feature
paths as well as unchanged Antelope cache serving.

Waits, ancestry and retained proof work are bounded. Existing Elasticsearch history remains usable;
new metadata/mappings initialize separately without a full history reindex. Cumulative retention,
trusted bootstrap, bulk/historical authority, complete recovery/query qualification and representative
profiling remain open in #213.
