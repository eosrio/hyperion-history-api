# Combined fresh protocol-index metadata reads

Component candidate for [#371](https://github.com/eosrio/hyperion-history-api/issues/371),
under [#277](https://github.com/eosrio/hyperion-history-api/issues/277) and
[#191](https://github.com/eosrio/hyperion-history-api/issues/191). This is not a full Wire replay,
Elasticsearch engine qualification, measured runtime improvement, or release acceptance.

A logical frontier record read requests fresh mappings and settings once inside the immutable
bundle read, using `features: ['mappings', 'settings']`, `flat_settings: true`, and
`include_defaults: true`. The response must satisfy the union of the original predicates, including
frontier lifecycle name/rollover rejection. Frontier construction enables that internal read policy;
callers supply only the record identity and cancellation signal, never a prevalidated snapshot.
Every new logical read obtains a new response. Generic bundle policy, frontier control reads and
write boundaries remain unchanged. Read-only stores still cannot provision or write. Provisioning
retry state, durable receipts, manifest/chunk/digest validation, source/plan equivalence,
certificate/membership and current owner/generation checks remain. There is no metadata/data/
authority cache across reads or owners, shared in-flight validation, or parallel ancestry walk.

An exact concrete namespace is required. The combined response must have one entry at the requested
index; foreign/multiple/alias resolutions fail the existing mapping guard. A `data_stream`
association also fails that guard. This explicit refusal uses information the old separate
responses did not expose; it is not a claim that historical data-stream refusal was tested.
Flat settings and the existing nested-index/default fallbacks are interpreted by the same helpers.

The pinned JavaScript client8.19.1 already supports the combined request and needs no upgrade.
Official [Elasticsearch8](https://www.elastic.co/docs/api/doc/elasticsearch/v8/operation/operation-indices-get)
and [9](https://www.elastic.co/docs/api/doc/elasticsearch/v9/operation/operation-indices-get)
describe the endpoint and index-level metadata privileges. No cluster-state privilege is needed
by that API. Explicit HTTP endpoint/action allowlists may need to admit Get-index requests; actual
scoped credentials and ES8.x/9.5.5 output/default/refusal behavior remain engine qualification gates.
There is no Hyperion configuration, dependency, SDK, retained-history format or reindex change.

## Observation limit

The earlier combined-response slice retained separate outer-frontier and inner-bundle metadata
samples. This successor coalesces those two records-index samples into the bundle read's fresh
response. Mapping predicates still precede settings predicates, and lifecycle rejection now runs
with the bundle settings checks before document reads. A transient change between the former
samples or two distinct transport failures has no exact one-response equivalent; both sets of
predicates now observe the same response. The next logical read rechecks fresh state, including
after a previous success. This is not request-trace or error-observation-order equivalence.

Frontier record mapping/retention refusals now use the common bundle error messages. If a caller
aborts while the metadata request returns a late server failure, the bundle `checkedIo` boundary
preserves that caller's abort reason; the removed outer frontier await could expose the client
error first. Uncancelled permission/missing-index/server failures still propagate the original
client error. Remaining physical helper work must settle before its proof scope can drain.

## Validation and count scope

`tests/native/protocol-index-metadata.test.mjs` exercises normally emitted reader functions with
the actual pinned client and Transport through a controlled connection, without sockets or an
Elasticsearch engine. It checks request serialization, the full validator union, refusal/default
predicates, errors, independent cancellation, current authority, retained missing data, and an
actual held helper's scope drain. That drain is a local promise/scope observation, not physical
database/network cleanup proof. The memory fixtures declare constructed source data and do not
qualify Wire/native values or production storage. Existing controlled metadata fixtures are
adapted to the new request; original source, worker fences, waits and assertions remain.
Both metadata test adapters await asynchronous mapping/settings callbacks before assembling the
response, preserving their original held-operation, rejection and cancellation controls.

The current predecessor used four requests for one single-chunk frontier record: two metadata
responses, manifest and chunk. The fresh-union control uses three. A successful proof open at
ancestry distance D uses `3D+10` requests instead of `4D+12`; authority is still freshly read twice,
and every certificate/commit bundle retains its metadata and manifest/chunk reads.

The actual normally emitted native control measures distances 0/1/8/19/32/66 and repeats each
open eight times. The respective request counts per open are 10/13/34/67/106/208, versus
12/16/44/88/140/276 before coalescing. Each repeat pays the same fresh-read cost. These are
controlled one-chunk counts, not multi-chunk, engine-latency, CPU or full-worker throughput bounds.
The earlier six-request record / eighteen-request single-head model belongs to the historical
mapping-plus-settings request slice; the full historical captures did not run this successor.
Adjacent native/issued reads and source compilation are separate costs; nested durations are not
additive CPU. No elapsed saving or full replay success is established by these request counts.

Root owns actual ES9.5.5/8.x validation and the next unchanged full Wire/Mongo replay after source
review. Full replay and1480 gates remain open. No timeout, ancestry, source credit, queue, resource or durability
requirement changes, and no implication of full replay or AtomicAssets parity.
