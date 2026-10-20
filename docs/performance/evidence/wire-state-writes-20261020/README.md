# Wire legacy Mongo write qualification — 2026-10-20

[PR #239](https://github.com/eosrio/hyperion-history-api/pull/239) fixes operator state
opt-in and extends the [captured Wire worker harness](../../wire-worker-replay.md).
The tested code commit is `093e111e739805a9b4eb531259709647042a8c20`, stacked on
[PR #236](https://github.com/eosrio/hyperion-history-api/pull/236).

The [summary](summary.json) describes four successful cases. The [manifest](manifest.json)
binds every ordinary file in [raw-evidence.tar.gz](raw-evidence.tar.gz), including the
original reports, held-prefix Mongo observations, source/component snapshots, bulk
requests/responses, process observations, and exact service ownership/cleanup records.
Verify [SHA256SUMS](SHA256SUMS) before extracting. Relative log aliases are metadata only;
their ordinary targets are retained, and no archive member is a symlink.

## Observed cases

| Native runtime | Operator setting | Held state prefixes | Final selected rows | Original blocks / ACKs |
|---|---|---|---|---|
| Node 22.23.3 | enabled | 9 | 12 | 119 / 119 |
| Node 22.23.3 | disabled | none | 0 | 119 / 119 |
| Node 24.19.0 | enabled | 9 | 12 | 119 / 119 |
| Node 24.19.0 | disabled | none | 0 | 119 / 119 |

All cases use fresh owned services on bare-metal Hyperion-1: Ubuntu 24.04.4,
Linux 6.8.0-136, Ryzen 9 5950X and 128 GiB RAM. Elasticsearch is 9.5.5 with its
JavaScript client pinned to 8.19.1. The existing worker fixture's digest-pinned MongoDB
is **8.0.32**, with driver **7.2.0**. This is separate from the portable adapter's
MongoDB 8.0.34 conformance cases. No dependency or production setting was upgraded.

Enabled and disabled cases use the same explicit source-derived contract/table mapping
and an active owned Mongo connection, with no plugin-declared dynamic dependencies.
The enabled source pauses at blocks 78, 81, 84, 87, 90, 93, 96, 99 and 120. Each pause
requires the expected original block ID in history, drained queues, and an independent
comparison of complete selected Mongo collections before more original frames are released.
Only Mongo's generated `_id` is ignored; row fields, full logical keys, deployment/source
provenance and exact decimal values must match.

This observes an actual insert at 78, update at 81, distinct insert at 84, and absence
of the deleted primary key at 87. Later checks retain the full-width key/amount, five
signed-key records, two primary and two distinct secondary records, and the post-upgrade
ABI row. The disabled controls require zero selected rows after the same complete input.
Original SHiP status/result bytes, credit/ACK accounting and source proof checks remain active.

All four cases retain complete expected history/publication checks and independent reads
from both owned Elasticsearch data nodes. Physical reads are distinct from the number of
copies reported in each bulk acknowledgment. All observed worker/master exits pass the
existing strict shutdown check, and every owned fixture restores its prior Docker inventory.
The separate [postflight receipt](postflight.json) checks for remaining processes in the
owned run directories and resources bearing all five case ownership labels, including
the excluded preflight attempt.

## Corrections and validation

The producer now requires `contract_state.enabled === true` and own contract/table entries
for operator mappings. Explicit plugin-required dynamic dependencies and absent-feature
behavior retain their existing semantics. Native emitted-method regressions reproduced
the inherited-property selection defect before the fix and pass under Node 22 and 24
afterward, including explicitly selected `constructor` names.

The active route is Mongo: it reads presence from message headers and separates ordinary
scope/key identities and full protocol identities. The earlier missing-body-field concern
described an unregistered Elasticsearch helper. Controlled component receipts retain that
distinction; they are not native database acceptance. Old published evidence is unmodified.

The first Linux attempt stopped before worker startup because the new guard incorrectly
expected MongoDB 8.0.34. Its raw failed report and successful cleanup remain in the archive
and are excluded from acceptance. The guard was corrected to the unchanged fixture pin.
An earlier full suite exposed three positive fixtures that omitted state opt-in; their
configuration now explicitly enables it, preserving every original output/proof assertion.
Both earlier failed logs are retained separately from successful results.

The final production-change suite passes **978 tests**, skips one optional installed-corpus
audit, and fails zero, with 6,728 assertions. Complete app/qualifier typechecks and native
emission pass. All nine CI jobs pass at the tested code commit. Independent Standards and
Spec reviews close the reported selection finding; their fixed ranges and hashes are
retained in the raw records. Later evidence-only commits have separate CI results.

## Acceptance limits

These are legacy Mongo effects for the original engineering corpus, blocks 2–120. They
do not establish complete initial state, portable runtime integration, HTTP read views,
canonical rollback or request/cache readiness. Those remain under
[#191](https://github.com/eosrio/hyperion-history-api/issues/191) and
[#221](https://github.com/eosrio/hyperion-history-api/issues/221); state-serving gates stay closed.

The corpus contains two secondary insertions, with no secondary update/deletion.
Duplicate delivery, write failure/retry, crash/restart around state effects, fork/reconnect,
Wire 6508, Rust/offline workers and Bun runtime remain unqualified by these runs. Supervised
clean process exits do not prove production checkpoint/restart or power-loss durability.
Observer and repeated proof-read overhead prevents throughput conclusions.

The source/package commits remain engineering pins. Selected testnet launch pins and
initial ancestry/ABI coverage remain pending. Public action admission, gated full-range
history storage and retained-history upgrade acceptance are not enabled by this slice.
