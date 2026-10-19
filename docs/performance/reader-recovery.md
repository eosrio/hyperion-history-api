# Reader confirmations and supervised source replay

Hyperion retains the active reader assignment until every requested block has a
successful publisher confirmation. Reader completion no longer depends on the
publisher library's private callback window. A NACK, unroutable mandatory
publication, unknown outcome after channel loss, or replacement with pending
confirmations prevents completion and requests supervised replay.

Publisher confirmation means RabbitMQ accepted a persistent message. It does not
mean the deserializer, Elasticsearch, a state adapter, or a plugin finished that
input. SHIP credits are released after successful confirmations for the current
input batch. Existing Elasticsearch queue budgets and live-reader priority stay
in place.

The master retains the current historical or repair range and its assignment ID
before dispatch. A replacement reader reissues that range. Late messages and
disconnect events from an old worker cannot alter its replacement. Completed
historical readers receive a bounded finish instruction; they drain their cargo
and confirmations, close their channels, and exit normally. One finished reader
cannot retire another reader's unfinished assignment.

Replay is intentionally at least once. Inputs accepted before an unknown outcome
may be delivered again. The history pipeline's deterministic document IDs make
replayed writes idempotent; this qualification does not establish equivalent
behavior for every plugin or state projection.

## Live resume and bounds

A supervised live reader advances its resume point only through a contiguous,
ID-linked prefix whose publications are confirmed and whose blocks are
irreversible. Higher confirmations received first do not cover a missing lower
confirmation. A new reversible branch invalidates the old suffix, and late
callbacks for that suffix cannot advance the checkpoint. The reversible tail is
replayed after a worker replacement.

`settings.reader_recovery_window_blocks` limits retained live checkpoint entries;
the default is 100,000 blocks. Exhausting that window, receiving an unlinked
irreversible input, or requesting input older than SHIP retention marks the
affected reader incomplete and pauses its automatic replay. Other workers keep
running. Operators must restore a suitable source and restart the affected
indexer after investigating the incomplete range.

Each outstanding publication has a 60-second deadline measured with a monotonic
clock. Confirming newer work cannot postpone a lost older confirmation, and a
continuously nonempty healthy window does not expire just because it stays open.
Clean channel-only loss has a one-second replacement grace period. Reader finishing
shares one 10-second deadline across draining and both channel-close operations.
These bounds fail closed; timing out does not manufacture progress.

The master keeps these assignment and checkpoint records in memory. This work
qualifies worker replacement while that master remains alive. It does not claim
master restart, broker data loss, host power loss, or an external durable source
checkpoint. Upgrading does not require a full Elasticsearch history reindex.

## Reproducible qualification

Use an explicitly owned disposable broker on the test host. The harness requires
an explicit loopback URL, fixture run ID, and a new output directory:

```sh
export READER_RECOVERY_AMQP_URL='amqp://qualifier:qualifier-test-only@127.0.0.1:PORT'
export READER_RECOVERY_RUN='OWNED_FIXTURE_RUN_ID'
npm run build
node scripts/qualification/reader-recovery.mjs /absolute/new/fixed-results
node scripts/qualification/reader-recovery-baseline.mjs /absolute/new/baseline-results
```

The fixed harness uses actual RabbitMQ connections, actual Node.js worker
processes, emitted `StateReader` publication methods, and the master's cluster
scheduler and disconnect supervision. It tests healthy completion, injected
negative confirms, accepted-but-unconfirmed connection loss, channel-only loss,
replacement before completion, and historical and repair worker crashes after a
later assignment. Later source inputs are withheld before those crashes, so only
the replacement can supply the missing inputs. Every case checks exact numeric
message identities, actual exit codes and signals, intentional replay duplicates,
and owned queue/process cleanup.

The baseline harness emits unmodified reader and master sources from commit
`37e3ee6bb897a3647b88d272e55d43240ecf7dc6` into separate temporary-named modules.
It checks that negative and unknown confirmations can still produce completion,
and that the old scheduler can restart its original assignment while leaving a
later assigned range absent. Baseline source copies, emitted-module hashes,
runtime hashes, messages, and process outcomes are retained in its report.
The duplicate historical classes use emission with `--noCheck` to avoid nominal
private-member conflicts with the current classes; this provides a semantic
counterexample, not baseline typecheck acceptance. Current production is checked
and built normally.

These cases use deterministic numeric source payloads. They do not exercise SHIP
decoding, ABI transitions, live chain forks, Elasticsearch durability, or full
master construction. Contract replay qualification in #195 covers the separate
SHIP and decoding boundary. Focused unit cases also exercise reverse live
publication, a missing lower confirmation, branch replacement, bounded retention,
stale worker fencing, and the existing publisher drain behavior.

## Executed qualification, 2026-10-19

On Hyperion-1 bare metal Linux with Node.js 24.19.0 and an isolated owned broker,
all seven fixed cases passed. Both historical and repair crash cases held all
input from the later assignment before killing the first worker. Each then
observed the replacement launch with that later range, a normal final exit, and
all six expected source identities exactly once.

The three baseline cases reproduced the actual defects: completion after an
injected NACK with no successful read report; completion after accepted but
unconfirmed connection loss; and an actual supervised historical restart of the
original range, with blocks 13, 14, and 15 absent while the old scheduler finished.
The baseline's wrong restart was forced before those later inputs could be
published, so already accepted messages could not conceal the missing replay.

The measured fixed harness SHA-256 is
`0ea960b73f91b3fb0c59905174a0f036b4c1cd9af9993b65e48b97cea22f9ad6`.
The measured baseline harness SHA-256 is
`190e3f2a8f484557296717370360644f80ddd39a0f5aff591c69db7a08f417c0`.
The [evidence summary](evidence/reader-recovery-20261019/summary.json) and
[manifest](evidence/reader-recovery-20261019/manifest.json) identify all 53 regular
members of the [raw archive](evidence/reader-recovery-20261019/raw-evidence.tar.gz).
All 13 source snapshots match their measured report hashes, including emitted
reader/master code and both harnesses. The original reports, runtime and lockfile
hashes, worker outcomes, fixture identity, and cleanup receipts remain in the
archive. Earlier failed harness pilots are retained as excluded provenance.

The fixed run observed 13 worker processes and the baseline observed four. Three
consecutive postflight samples found all 17 gone, no owned broker queues or
connections, and no active search/write tasks before fixture cleanup. Receipts
confirm removal of the seven owned containers, seven data volumes, and one
network. [SHA-256 checksums](evidence/reader-recovery-20261019/SHA256SUMS) cover the
archive, manifest, summary, and attributes; CI verifies those exact bytes.

The Node workers ran natively on the shared bare metal Linux host against the
owned containerized broker. These are correctness results. They establish no
capacity or throughput comparison, and the qualification did not change the
host's production services.

At the frozen runtime commit
`f42172860e833c348db9bce4fbc47311af6dcfde`, whole-project checking covers 192
files, the full unit suite passes 237 tests and 1,903 assertions, and the observer
checker passes eight real child-process cases with 353 assertions and 17 saved
CPU profiles. Local Bun unit runs can set `READER_RECOVERY_NODE` to an explicit
Node.js 22/24 binary for the native master test; CI uses its selected Node binary.

Issue #208 stays open for integration of live chain fork/restart recovery,
broker-delivered late old-generation callback evidence, and the full SHIP replay
oracle from #195. The live checkpoint's missing-confirm and branch cases are
currently unit qualification. Master and host failure durability remain outside
this process-only qualification.

## Review follow-up, 2026-10-19

[Review 5574356339](https://github.com/eosrio/hyperion-history-api/pull/210#pullrequestreview-5574356339)
identified confirmation and finish deadlines that did not follow each pending
publication's age or bound both channel closes. The correction at
`94c89bcd499e7ef888f6acff8fae4a664ca83188` uses monotonic publication deadlines
and one finish budget through draining and both closes. Both qualification CLIs
also return a nonzero exit when cleanup or recorded AMQP errors leave the final
report unsuccessful. Controlled-clock regressions cover the deadline boundaries;
isolated Node command regressions reproduce failed reports with exit zero before
the correction and preserve successful exit zero afterward. The latter stub only
the expensive workload while executing the original cleanup, report and CLI
status paths; they do not exercise a broker.

A fresh native Node.js 24.19.0 run on Hyperion-1 passed all seven existing broker
cases at that frozen commit. It used a new checkout, the unchanged pinned npm
dependency tree, and a new disposable fixture. The Linux application and qualifier
typechecks, build, and full 247-case unit suite with 1,949 assertions passed using
Bun 1.4.3. This is integration smoke for the correction; the new elapsed-time
boundary faults remain focused regression coverage. The original baseline
counterexamples were not rerun.

Independent postflight checked eight measured source/build snapshots and 12
supporting source/native snapshots, all 13 observed worker PIDs gone, and three
consecutive samples with no broker queues, connections, deliveries or consumers
and no active Elasticsearch search/write tasks. Guarded cleanup removed the exact
seven owned containers, seven volumes and one network, with none remaining.
Recovery cases include intentional exit-one workers and two deliberate crashes;
their replacements exited normally. An orchestration attempt with duplicated test
credentials failed before creating cases, workers or queues and is retained as an
excluded pilot.

The separate [follow-up summary](evidence/reader-recovery-review-20261019/summary.json)
and [member manifest](evidence/reader-recovery-review-20261019/manifest.json)
describe all 52 regular files in the
[raw archive](evidence/reader-recovery-review-20261019/raw-evidence.tar.gz), SHA-256
`915025c700401651210981240b36086cebb6a6f035a68bb1851a19d3d1e9be00`.
It retains the source bundle, measured/native bytes, Linux setup and validation
logs, Windows red/green/full-suite logs, original reports, postflight and exact
cleanup receipts. CI verifies its checksums. The original qualification archive
remains unchanged. This follow-up adds no full-chain, live-fork, master/host
failure, Elasticsearch durability or performance qualification.
