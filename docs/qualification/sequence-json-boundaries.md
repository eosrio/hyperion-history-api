# Hyperion 4.5 sequence JSON migration

This implements the worker/API/cache/stream/archive JSON slice of
[#219](https://github.com/eosrio/hyperion-history-api/issues/219). The accepted public contracts are
[ADR 0053](https://github.com/eosrio/hyperion-tools/pull/50) and
[ADR 0054](https://github.com/eosrio/hyperion-tools/pull/52). They apply to Antelope and Wire.

| Public value | 4.5 JSON type |
| --- | --- |
| Action root and receipt `global_sequence` | Canonical decimal string |
| Receipt `recv_sequence` and authorization `sequence` | Canonical decimal string |
| Legacy response aliases `global_action_seq` and `account_action_seq` | Canonical decimal string |
| `/v2/stats/get_action_usage.action_count` | Canonical decimal string, including `"0"` |
| uint32 ABI/code counters, blocks, ordinals, `tx_count`, `unique_actors` and unrelated counts | Existing numeric type |

Canonical uint64 text uses ASCII digits, no signs, spaces, exponents, fractions or leading zeroes
except `"0"`, and is at most `"18446744073709551615"`. Committed action roots retain their own
positive-value requirement. Arbitrary contract data is not rewritten based on property names.
The unresolved legacy `parent` filter is a separate contract; it is not reinterpreted as an ordinal.

Clients must retain identifiers as text and use integer arithmetic such as `BigInt` for arithmetic
or comparison. For example, `"9007199254740993"` and `"9007199254740992"` are distinct; converting
them to JavaScript Number can lose that distinction. The stats endpoint subtracts exact bounds
before encoding the count and returns `"1"` for that difference. It returns unavailable for missing,
unsafe, inconsistent or incomplete bound results instead of returning a fabricated count.

Existing metadata filter syntax is validated before response-cache access or Elasticsearch query
construction. GET action filters retain their scalar/list/exclusion/range grammar; legacy POST
metadata term filters remain scalar. Explicit safe legacy numeric input is converted at known
metadata paths only. Unsafe numeric input and malformed text are rejected. This input validation
does not establish full-range native query membership or retained-history coverage.

Workers normalize exact metadata before contract handling, grouping and publication. Grouped
notification order does not replace the selected root identity. Flattened actions and complete
transaction caches use exact magnitude ordering. Transaction caches now use the chain-scoped
`trx_seq_v1` namespace, and response caches use `sequences-v1`; old entries expire normally.
A damaged transaction cache falls back as a whole instead of dropping one action. Action usage
has a separately versioned inner stats cache and validates its cached count type.

HTTP action schemas, historical streams and native/extension live relays preserve metadata strings.
Unsafe retained numeric metadata produces an explicit unavailable result rather than rounded text.
This is a per-result guard, not proof that the original history range contains every action.
Archive hydration sends canonical string IDs and verifies echoed block/sequence and available
contract/action metadata before attaching any payload in a batch. Invalid or mismatched archive
responses retain the existing best-effort behavior and leave cold data absent. Rust JSON/archive
validation is delivered separately in [Tools #52](https://github.com/eosrio/hyperion-tools/pull/52).

## Validation and remaining gates

Local validation uses the complete TypeScript 7.0.2/Bun 1.4.3 project check, native Node 24 build,
465 tests with 4,133 assertions, and both pinned Wire engineering profiles. Tests include actual
parser/DS-pool publication, v1/v2 HTTP schemas and transaction caches, historical/native live streams,
stats response caches, wrong archive identities and existing proof/fork/cache fences. Older proof
fixtures now supply exact sequence strings and valid cache member IDs so they continue to exercise
their original proof and revocation cases. Those gates were not removed to accommodate the type change.

The [owned native Elasticsearch prototype](action-sequences-design.md) tests an additive physical
representation and one-query mixed-history ordering separately. It does not install a production
mapping or adapter. Current signed-long storage still cannot accept the entire uint64 range.
The subsequent [#225 adapter foundation](action-history-adapter.md) adds gated production modules;
existing production callers remain disabled until durable coverage and reader integration are complete.
Before closing #219 or releasing 4.5, integrate and qualify the production writer/query adapter,
mapping installation on existing targets, complete predicate/tuple/sort/page/count behavior, exact
coverage and bounded recovery for retained partitions, and direct/plugin/maintenance readers.
Surviving receipts cannot prove that an old rounded document ID did not overwrite a neighboring row.

Existing Elasticsearch history remains usable without a mandatory full history reindex. Precision
gaps must be isolated to affected scopes and recovered from qualified exact metadata or historical
sources; this JSON slice does not provide that coverage mechanism. Selected Wire testnet, original
source proof and fork recovery remain independent release requirements. Small-fixture elapsed times
are not profiling evidence or a performance optimization claim.
