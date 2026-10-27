# Combined fresh protocol-index metadata reads

Component candidate for [#371](https://github.com/eosrio/hyperion-history-api/issues/371),
under [#277](https://github.com/eosrio/hyperion-history-api/issues/277) and
[#191](https://github.com/eosrio/hyperion-history-api/issues/191). This is not a full Wire replay,
Elasticsearch engine qualification, measured runtime improvement, or release acceptance.

The frontier store and immutable bundle store each request fresh mappings and settings in one
`indices.get` response, using `features: ['mappings', 'settings']`, `flat_settings: true`, and
`include_defaults: true`. Both original logical validators remain: a frontier record read still
checks layout in the frontier store and again inside its bundle read. Each retains its predicates
and error messages; frontier additionally rejects lifecycle name/rollover settings. Read-only
stores still cannot provision or write. Provisioning retry state, durable write receipts, immutable
manifest/chunk/digest validation, certificate/membership and current owner/generation checks remain.
There is no metadata/data/authority cache or shared in-flight operation.

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

Each former mapping-then-settings pair becomes one metadata response. Predicates still run in
mapping-before-settings order, but a transient state change between the old calls, two distinct
transport failures, or an abort at the removed await has no exact two-call equivalent. The outer
and inner validators remain independently fresh: shared predicates see changes between them,
while frontier-only lifecycle rules remain at the frontier boundary and are rechecked next call.
Remaining awaits retain their abort/error handling. Do not describe
this as exact request-trace equivalence or remove a second validator to obtain a larger saving.

## Validation and count scope

`tests/native/protocol-index-metadata.test.mjs` exercises normally emitted reader functions with
the actual pinned client and Transport through a controlled connection, without sockets or an
Elasticsearch engine. It checks request serialization, both boundaries, complete refusal/default
predicates, errors, independent cancellation, current authority, retained missing data, and an
actual held helper's scope drain. That drain is a local promise/scope observation, not physical
database/network cleanup proof. The memory fixtures declare constructed source data and do not
qualify Wire/native values or production storage. Existing controlled metadata fixtures are
adapted to the new request; original source, worker fences, waits and assertions remain.
Both metadata test adapters await asynchronous mapping/settings callbacks before assembling the
response, preserving their original held-operation, rejection and cancellation controls.

The baseline reader control makes six requests for one single-chunk frontier record; the candidate
uses four, retaining the two layout validations and manifest/chunk reads. The single-head proof
control uses12 rather than the source-model baseline18. Neither count establishes elapsed savings.
The earlier profile2 open-only census was336,106 GET attempts. A source model predicts224,037
with this request change (112,069 fewer,33.34%); that historical capture did not run this candidate.
Adjacent native/issued reads were outside that census and nested durations are not additive CPU.

Root owns actual ES9.5.5/8.x validation and the next unchanged full Wire/Mongo replay after source
review. The original900s run failed during the1244fault after42passed cursor waits through1243;
full1244 and1480 gates remain open. No timeout, ancestry, source credit, queue, resource or durability
requirement changes, and no implication of full replay or AtomicAssets parity.
