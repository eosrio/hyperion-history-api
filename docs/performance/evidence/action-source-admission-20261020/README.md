# Action source admission qualification — 2026-10-20

Implementation: [PR #232](https://github.com/eosrio/hyperion-history-api/pull/232),
code commit `8b483fd0aec2819e1c15171e3950d39e715c6bd6`, against journal base
`d94543d78f86f8c455af7e1a7a20a4e1f576e4a5`. See the
[runner and scope](../../../qualification/action-source-admission.md).

The [summary](summary.json) records eight final runs, seven independent owned service
fixtures and exact source/emitted/runtime hashes. The [manifest](manifest.json) identifies
every file in [the raw evidence archive](raw-evidence.tar.gz). Verify [SHA256SUMS](SHA256SUMS)
before extracting it. Pilot and pre-review runs are excluded.

## Results and scope

| Workload | Node 24.19.0 | Node 22.23.3 | Evidence |
|---|---|---|---|
| Wire admission with real ES/Rabbit | Passed | Passed | Constructed 6508c9e8 and 7dede884 inputs plus the unmodified retained 7d capture, reported separately. |
| Actual DS exit before fragment preparation | Passed | Passed | Original unacknowledged delivery recovered by a distinct supervised replacement. |
| Actual DS exit after fragment preparation | Passed | Passed | Prepared source membership reopened before publication. |
| Actual DS exit before original ACK | Passed | Passed | Confirmed publication followed by redelivery; final output identities remain exact. |

These are Windows x64 Node processes with isolated Linux Docker services, including
Elasticsearch 9.5.5 and RabbitMQ. They are finite correctness runs, with no production
throughput or Linux host runtime qualification claim.

Each native Antelope run replays 87 blocks from an audited 88-block capture, derives the
complete 103-transaction inventory and checks 12 selected contract groups/actions and two
ABI revisions. Genesis precedes the trace log and receives no invented certificate.
The real launcher runs Reader, master, MainDS, DS and Indexer processes. Final action and
block outputs are checked on both physical ES data nodes. Crash recovery must retain the
same source, body, admission and target through a distinct PID and real broker redelivery.
The expected worker exit 86 and master exit 1 remain visible in the raw reports; the
qualification accepts only that exactly evidenced intentional failure.

Each Wire run invokes emitted production methods with real stores, coordinator, durable
queues, persistent mandatory confirmations and original receipt ACKs. Its 402 store-write
receipts each report two successful copies. Constructed cases check notification grouping,
identical inline inputs, full-range uint64 values, missing-ABI isolation and unrelated
progress. IPC scheduling is bridged in-process; the action target intentionally remains
empty. This does not establish Wire Indexer/sink or selected-testnet acceptance.

The actual Wire input is 7dede884 block 6350 and contains only `sysio::onblock`. Its absent
prior ABI frontier remains explicit: no complete source certificate or fabricated fragment
is issued. No actual 6508c9e8 node capture or application deployment is inferred from it.

## Evidence interpretation

Source/fragment storage, broker recovery and final ES output observations are distinct.
Native legacy bulk acknowledgment-copy distributions are preserved per run, including
startup block writes reporting one successful copy out of two. The four final physical-copy
checks do not establish universal two-copy sink acknowledgments. Parent
[#225](https://github.com/eosrio/hyperion-history-api/issues/225) still owns sink set/visibility
reconciliation, canonical/fork authority, replay scheduling and same-PIT query activation.
Public exact-query authority remains disabled and existing history remains usable.

The archive includes exact source frames/schema, fixture and request bytes, bulk request/
response receipts, original crash/ACK/observer records, emitted/source snapshots and exact
resource cleanup journals. Dependency/runtime binaries are omitted; their hashes remain
in the unmodified reports. All seven owned resource sets have zero cleanup residue.
File fsync is recorded; Windows directory fsync is unavailable. Host power-loss and master
failover are separate requirements.

The final unit suite passed 870 tests with zero failures and 6,287 Bun expectations.
Its controlled production-prototype probe includes 13 named checks and internal strict
assertions for asynchronous hooks, cross-action corruption, immutable inputs and ownership.
Independent final reviews found zero documented Standards breaches and zero remaining
actionable Spec findings; one nonblocking duplication heuristic concerns constructed input
factories. The archived GitHub record shows all nine CI checks passing at the code commit.
Later evidence/CI commits have their own checks and are not inferred from that record.

Wire testnet support, Rust/offline equivalence, AtomicAssets/AtomicMarket parity, WormDB
qualification and the complete 4.5 release remain separate gates.
