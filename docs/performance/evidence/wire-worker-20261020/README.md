# Captured Wire application worker qualification — 2026-10-20

Implementation: [PR #236](https://github.com/eosrio/hyperion-history-api/pull/236),
tested code commit `5da54fb77699ce0a92d52f59c7569cb8d3e81ba7`, against merged
`release/4.5` base `5289dfa25b1ea47a1679f0a5eef6174f5226c47b`.
See the [runner and scope](../../../wire-worker-replay.md).

The [summary](summary.json) records two successful native Linux runs and the separately
excluded Windows pilot. The [manifest](manifest.json) identifies every ordinary file in
the [raw archive](raw-evidence.tar.gz). Verify [SHA256SUMS](SHA256SUMS) before extraction.
The archive retains original reports, source/component snapshots, bulk bytes and receipts,
observer/IPC records, configuration, service ownership and exact cleanup journals.
Two relative Linux log aliases are recorded as metadata; their ordinary target files are
retained. No archive member is a symlink.

## Observed results

| Check | Node 22.23.3 | Node 24.19.0 |
|---|---|---|
| Original blocks 2–120 and source ACKs | 119 / 119 | 119 / 119 |
| Continuous reader/master confirmation coverage | 119 | 119 |
| Selected application action documents / grouped receipts | 16 / 18 | 16 / 18 |
| Selected row history / primary deletion tombstones | 15 / 1 | 15 / 1 |
| Selected account ABI references | 38 | 38 |
| Complete ABI commits / original action-input bindings | 119 / 160 | 119 / 160 |
| Physical data-node reads passing the same expected-field and source checks | 2 | 2 |
| Child exits observed by the master, all code 0 | 11 | 11 |
| Master exit | 0 | 0 |
| Remaining owned containers / volumes / networks | 0 / 0 / 0 | 0 / 0 / 0 |

These runs used bare-metal Hyperion-1, Ubuntu 24.04.4 / Linux 6.8.0-136, with isolated
Docker Elasticsearch 9.5.5 and RabbitMQ services. The JavaScript Elasticsearch client
remains pinned to 8.19.1. Each run uses a fresh resource set, one replica, request translog
durability and the existing launcher, continuous reader, deserializers, pools and writers.
Fixture services and all worker processes were removed; the original Docker inventory
was restored. No production service or cluster setting was changed.
The separate [postflight receipt](postflight.json) confirms no processes matching the
owned run directories/launcher and no Docker resources bearing either run label remain.

Every retained commit resolves its source context, selection, observation link and
observation to the original frame, schema and block/trace/delta sections. Independent
source facts bind native ABI deployments, action membership and final account rows.
Both physical reads retain identical source-proof hashes within each run. Application
checks cover the six receipts grouped into four documents at block 108 and the two ABI
epochs around the deployment at 117. Full-width application values remain exact decimal
strings; the actual source sequence counters in this corpus are small.

Physical reads independently pass the same logical assertions. The whole-document digest
also includes unsorted search-result structures and was not normalized across copies;
one Node 22 read has a different digest. All original digests are retained. This record
makes no whole-document byte-equality claim or diagnosis from that difference.

Node 22 recorded 303 bulk requests and Node 24 recorded 302. Each recorded 307 successful
items, no failed items and no repeated attempts. Each run has three items reporting one
acknowledged copy and 304 reporting two. Later physical reads do not establish universal
two-copy bulk acknowledgments. No performance conclusion follows from these durations:
the observer, bulk ledger and repeated source-proof reads add qualification overhead.

The native Node 22/24 source guards each verify 89 installed component files and the
original credit/ACK replay. Both complete typechecks and native TypeScript emission pass.
The local complete suite passed 957 tests, skipped one optional one-shot audit and had
zero failures; the corrected source-proof suite separately passed 64 tests. Independent
Standards and Spec reviews closed all reported findings. The archived GitHub record has
all nine CI jobs passing at the tested code commit; subsequent evidence commits have
their own checks. CI source guards do not rerun this bare-metal worker qualification.

## Failed pilot and remaining scope

The earlier Windows Node 24 pilot used a work-in-progress harness and remains failed,
excluded from acceptance. Its oracle replica mismatch was corrected. All eleven children
logged JavaScript exit 0, but the master observed only forced SIGKILL exits after its
five-second deadline and exited 1. Twenty-one isolated probes passed without reproducing
the full-worker failure. Their exact receipts and diagnosis are retained; no causal fix
or relaxed shutdown check is inferred. Follow [#237](https://github.com/eosrio/hyperion-history-api/issues/237).

The original 7d corpus and package revision are engineering pins; selected testnet launch
pins remain pending. The separate derived RPC startup view starts the reader at captured
block 2 while preserving the original SHiP status and result bytes. Initial ancestry/ABI
state remains unknown, with no seeded frontier or current/head ABI fallback.

Contract-state projections stay disabled. A primary deletion is retained as history;
actual state deletion and secondary update/deletion remain unqualified. Sequence storage
is explicitly legacy with exact decimal strings; `h45_sequences_v1` and public admission
stay disabled. Full-range storage, sink/canonical/PIT authority under
[#225](https://github.com/eosrio/hyperion-history-api/issues/225), retained-history upgrades,
fork/reconnect, Rust/offline execution, Bun runtime/performance and selected-testnet
acceptance remain separate work. Qualifier-supervised exits do not establish production
graceful checkpoint/restart: the recorded live progress key is null in both runs.

This advances [#212](https://github.com/eosrio/hyperion-history-api/issues/212) and
[Tools #22](https://github.com/eosrio/hyperion-tools/issues/22); neither is closed.
