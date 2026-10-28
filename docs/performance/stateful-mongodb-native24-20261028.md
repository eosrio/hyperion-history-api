# Stateful MongoDB fixture: native Node 24 result

The bounded synthetic stateful-adapter fixture passed on Linux Node 24.19.0 with
MongoDB 8.0.34 and JavaScript driver 7.2.0. This covers a single-member replica set,
transaction abort, clean application-process restart, rollback and a small retention
window. It does not complete [#366](https://github.com/eosrio/hyperion-history-api/issues/366)
or the [Wire integration gate](https://github.com/eosrio/hyperion-history-api/issues/191).

| Component | Exact source |
| --- | --- |
| [Standalone fixture](stateful-mongodb-engine-fixture.md) | `8e87f06339842e3b50a2295cc0c68cae80b333bd` |
| Stateful MongoDB adapter | `e4a46cfa69f0a0cf7f6ca51847a0efa51da80795` |
| Public stateful SDK | `b64bac478fc8015d409d44aa6f100668e0e091d2` |

The fixture used an isolated component assembly, including separate host and adapter
SDK instances. This does not change Hyperion's default installed dependency profile.
The six fixture files published with this report are unchanged from the reviewed
fixture commit. TypeScript 7.0.2/Bun 1.4.4 remain toolchain pins; this result makes no
Bun engine-compatibility claim.

Five separate application invocations (`a`, `fail-b`, `recover-b`, `fork-c`,
`retention`) and five independent primary/snapshot observers all exited normally
with code 0 before their deadlines. The owned MongoDB process stopped normally with
code 0, and owned container/volume cleanup and the original host guards passed.
Archive verification covered all 2,483 retained payloads. A separate independent
data-only semantic audit regenerated plan-derived row/image identities, original before-values, ordered
receipts/undo descriptors, canonical hashes, BSON byte totals and retention floors.
It found no actionable semantic discrepancies.

The actual DELETE failpoint produced MongoDB error 2 without transient labels after
the outside-transaction durable intent and seven successful transactional writes.
The transaction aborted successfully: A's business data, undo, receipts and progress
remained unchanged while pending B survived. A different application process
recovered the exact fsynced candidate without rerunning B's hook. Exact/conflicting
replay and stale checkpoint/revision fences were asserted.

Physical image progression was A2 → failed-B/A2+pending → B5 → rollback-A2 → C3 →
D1 → E0. **Rollback-A2 and D1 have original executed plan-derived assertions, but
no separately retained supplemental raw snapshot.** The five independent raw
snapshots cover the five phase endpoints. Final retained state has C's values,
empty D/E undo descriptors, floor C, zero images and the unavailable older-rollback
fence. The synthetic values also cover exact integers represented as decimal
strings, vectors, null versus absence, inert `__proto__`, dotted/dollar keys, NUL
and a literal escape sequence.

The case limits were 120s per phase, 10s per operation, 30s per transaction, 32 records,
256KiB per candidate and 64KiB output. The fixture retained two receipts and two
undo blocks, with a 1MiB undo budget and 256KiB maximum undo block. MongoDB's owned
container had two CPUs, 1GiB memory and a 128-PID limit. These are qualification-case
limits, not production defaults or an aggregate per-chain capacity configuration.

Node 26 qualification remains **incomplete**. One attempt completed A, expected
failed-B and recovery before a host postguard refusal stopped progression; a second
attempt stopped after A on another host postguard refusal. Owned cleanup completed
normally. Neither attempt completed fork/retention qualification, and neither is a
full native Node 26 pass. The existing Node 24/26 CI matrix now runs 22 offline fixture source
controls only; it does not run this engine scenario.

This result does not cover engine crash, power loss, HA/failover, unknown commit,
source authority, production serving or the full Wire worker replay. It establishes
no PostgreSQL comparison, AtomicAssets/AtomicMarket API parity or complete #366
acceptance. Raw manifests, candidate/state files, command traces, network details
and runtime archives remain private; this document publishes only the bounded
result and its limits.
