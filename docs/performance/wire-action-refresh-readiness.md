# Wire qualification action refresh readiness

Scope: [#394](https://github.com/eosrio/hyperion-history-api/issues/394), under #191/#198.
This is a qualification-driver change. It does not alter indexer writes, acknowledgments,
cluster settings, source admission, or release qualification.

The 29 October readmission52 replay stopped at its first native hold (block 1). Its
retained action refresh response was `_shards: {total: 8, successful: 4, failed: 0}`.
The existing full-copy assertion correctly refused that result. The receipt has no
contemporaneous shard-allocation evidence, so it does not establish why four copies
did not succeed. The replay did not reach the later sustained-load barriers and
provides no throughput comparison with earlier attempts.

Elasticsearch 9.5.5 counts skipped unassigned or not-yet-ready initializing replicas
in the total, without treating each skipped copy as a failed operation. Unavailable
shard exceptions can also be omitted from the failure list. These are possible
explanations for the observed counts, not a diagnosis of this retained run.
See the pinned [replication implementation](https://github.com/elastic/elasticsearch/blob/v9.5.5/server/src/main/java/org/elasticsearch/action/support/replication/ReplicationOperation.java)
and [broadcast aggregation](https://github.com/elastic/elasticsearch/blob/v9.5.5/server/src/main/java/org/elasticsearch/action/support/replication/TransportBroadcastReplicationAction.java).

The driver already waits for green block-index health on its two data nodes. Action
refreshes now have a corresponding readiness wait for the same action wildcard used
by the actual refresh. It uses the existing wait loop and original inherited phase
deadline. Server health waits are at most five seconds per observation, with client
timeouts bounded by the remaining phase and run budgets. No fresh phase is granted.
Raw health responses, including timed-out or yellow responses, use the existing
bounded history diagnostic capture before assertions.

Readiness is only a prerequisite. The driver then makes one actual refresh and
retains its raw response. The original native hold still requires positive total,
zero failed, and successful equal to total. An index created or a copy lost between
health and refresh can still cause a refusal. The partial response is not retried,
normalized, or promoted by an earlier green observation. Diagnostic record and byte
limits, source ranges, workload barriers, and all original deadlines remain unchanged.

Focused native controls cover a controlled yellow-to-green startup transition,
invalid health, request-timeout clamping, pending/late results, original rejection
identity, and partial/failed/empty refresh receipts after green health. They establish
source behavior only. The next guarded physical replay must retain the new health
and refresh evidence and pass the original full-copy and later workload checks;
this change alone does not prove the old failure's allocation cause or full replay
acceptance.
