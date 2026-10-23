# Hyperion 4.5 stream request contract

This records the server-side selector and filter behavior exercised by
`tests/native/stream-filter-parity.test.mjs` for [#231](https://github.com/eosrio/hyperion-history-api/issues/231).

| Request | Accepted selector |
| --- | --- |
| Action | An account alone, or an exact contract with an exact action or `*` action. A contract/action pair may also include an account. |
| Delta | An exact code with an exact table or `*` table. An omitted or empty scope selects all scopes; a nonempty scope is compared as an exact string, including decimal uint64 scope strings. |

Wildcard contracts and codes, `*` scope, and half-filled contract/action pairs
return a request validation error. Legacy ABI validation checks exact action and
table names but permits the supported wildcards. Extension-provider action
validation uses the provider's source/occurrence proof instead of the node's
current ABI.

Filters use strict equality for `eq` (the default), preserve `false`, `0`, and
empty-string values, and combine with AND unless `filter_op` is `or`. History
and live delivery use the same predicate, including decoded action/table aliases.
History may push an exact delta scope into Elasticsearch when that cannot
exclude a matching live record. Mixed OR filters remain postfiltered. The
configured `stream_scroll_limit` still bounds **candidate** history records
before postfiltering, so a broad filter can be rejected even if few records
would pass it.

`read_until` bounds historical replay only. A request that also subscribes to
live delivery continues receiving live records past that block; use
`ignore_live: true` for a finite historical request. This behavior needs a
separate protocol decision before a finite-live promise can be made.

The native fixture proves local server semantics, not source completeness or
production client compatibility. #231 remains open for the known Antelope
dataset, transport drop mid-block, fork and LIB advancement, and exact sequence
and retryable-error checks through the real client/server route.
