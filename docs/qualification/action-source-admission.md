# Source-backed action admission

Implementation slice: [#230](https://github.com/eosrio/hyperion-history-api/issues/230),
following the [source membership journal](action-source-journal.md) and parent
[#225](https://github.com/eosrio/hyperion-history-api/issues/225).

Public activation remains disabled. `HyperionWorker.actionSourceAdmissionEnabled` defaults to
false; the owned qualification harness explicitly overrides that internal seam before launching
the actual workers. It is not an operator configuration option or a query-readiness certificate.

## Producer flow

The reader verifies its SHiP connection's chain ID and retains the original frame, handshake,
selected profile/components and session ID before confirmed RabbitMQ publication or source
credit. Native Antelope uses the same connection-generation fence as extensions, without
inventing extension component manifests.

MainDS resolves that durable ingress reference and decodes with its original handshake. Before
filters, truncation, hooks or derived publication can discard action membership, it retains the
complete original traces, raw source bytes and effective policy. Its immutable producer epoch
binds the emitted host code, selected handlers, configuration fingerprint, lockfile, installed
SDK/plugin artifacts and selected protocol components. Native codec files are included only for
Antelope; Wire does not resolve or import the Antelope addon. This identifies an audited
installation, and does not sandbox plugins or certify an arbitrary executable dependency graph.

The source inventory independently enumerates every original transaction and action occurrence.
It preserves original ordinals, original trace hashes, separate canonical dispatch hashes,
policy exclusions, source origin identities, selected groups and ordered receipt metadata.
Antelope's existing grouping/counter policy and Wire's observer-derived input origins remain
separate. Real native hexadecimal casing is accepted without rewriting original bytes.

Only source-proven exclusions and supported effect-free transactions get empty fragments.
Missing traces, unknown transaction semantics, absent predecessors and unsupported policies
remain explicitly incomplete. A source-bound plan is prepared against the real concrete action
target name and UUID; no fixture UUID or surviving Elasticsearch rows establish membership.

MainDS routes the exact admitted canonical bytes using persistent, mandatory confirmed
publications. A false `sendToQueue` return means the message was buffered: the producer waits
for both drain and confirmation and never resends that buffered message. Original consumer and
publisher ownership is checked across awaits. MainDS acknowledges only after recoverable
source retention, explicit empty/excluded records and confirmed process-work handoff.

DS resolves the admission and checks its source, ordinal, payload, producer epoch and concrete
target before hooks. It awaits the complete handler chain, groups, revalidates, normalizes and
cleans every action, then detaches the whole transaction before storage awaits. Independent
membership validation rejects a missing group, receipt, authorization member or changed
identity/counter, including unexpectedly empty output. The journal records one complete
fragment before the first action publication, stream or Redis effect. Only the detached bytes
are released, with their admission/fragment references.

A contract hook or unsupported Wire output can leave a durable incomplete record with retained
replay input. No empty fragment or partial action batch is issued for that transaction; unrelated
work can proceed. Such a delivery can be acknowledged after the incomplete record is durable.
Transport/storage/ownership failures preserve unacknowledged work for supervised replacement.
Acknowledgments and source seals grant no Elasticsearch sink-completion authority.

## Recovery boundaries

The `-history-source-admission-v1` namespace is outside action templates, aliases and history
wildcards. Source manifests are discoverable through bounded, resumable pages even when a
later admission/fragment was not prepared. Source/fragment bytes and links require fresh
all-configured-copy write receipts; a successful read does not replace one.

These are bounded individual records and operation budgets. Total retention, automatic replay
scheduling, historical source retrieval and safe pruning remain #225 work. Old producer epochs
or recreated targets must not be silently reinterpreted as current work. Public activation still
requires sink set/fingerprint and visibility reconciliation, canonical/fork invalidation and
same-PIT authority across every history reader/cache/stream. No full history reindex or index
version change is introduced.

## Qualification

Resource-free regressions invoke actual production methods with controlled transports. They
cover source/dispatch separation, empty and excluded membership, full-batch staging, delayed
hooks and caller mutation, dropped/changed groups and receipts, fresh durability receipts,
restart reads, corrupt references, bounded discovery, confirmations, drain, cancellation and
original channel ownership. These tests do not establish real broker or database recovery.

The retained-source native replay uses the existing ownership-checked Elasticsearch 9.5.5 /
RabbitMQ worker fixture. It audits the original fixture before any service effect, replays its
exact SHiP bytes through the real launcher and native Antelope codec, and serves only a bounded,
explicitly derived fixture `get_info` view. Unknown RPC calls fail without network fallback.
The final inspection independently re-decodes the captured bytes, checks retained original
traces, every source transaction/fragment/seal and the actual target UUID, and compares the
contract outputs on both physical Elasticsearch copies.

```powershell
pwsh -NoProfile -File scripts/qualification/es955-worker-fixture.ps1 -Action create -StateFile OWNED_STATE
node --experimental-strip-types scripts/qualification/action-source-admission-replay.ts OWNED_STATE NEW_OUTPUT AUDITED_FIXTURE
pwsh -NoProfile -File scripts/qualification/es955-worker-fixture.ps1 -Action cleanup -StateFile OWNED_STATE
```

Always perform ownership-checked cleanup, including on failure. Run supported Node 24 and 26
separately with fresh fixture state. Keep source/emitted/runtime/service hashes, raw response
receipts, observer/resource evidence and cleanup receipts. This is a correctness run; it does
not establish production throughput or a measured bottleneck.

The retained Spring capture has 88 audited blocks. Its trace log begins at block 2, so 87 blocks
are replayable; the empty genesis is audited and is not assigned an invented action certificate.
The complete replay inventory has 103 transactions; its selected contract oracle has 12 actions
and two ABI revisions. The 12 application outputs alone are not the complete source inventory.

Wire profiles require their own qualification. Constructed frames must remain labeled as such;
the actual retained 7dede884 onblock capture does not establish a running 6508c9 chain, deployed
application contracts or the selected new testnet. All parent #225 and Wire release gates remain
open until their corresponding evidence exists.

The guarded Wire runner invokes emitted Reader/Parser/MainDS/DS methods with real owned
Elasticsearch stores, ABI coordinator and RabbitMQ channels. It checks both constructed
engineering profiles separately from the unmodified retained 7dede884 capture. That capture has
no invented prior ABI frontier: unavailable decoding stays explicitly incomplete and cannot
produce a source fragment. The constructed cases check notifications, identical inline inputs,
full-range sequences, missing-ABI isolation, confirmed publication and original receipt ACKs.
IPC scheduling is bridged in-process; the action target stays empty. This establishes source
admission and broker handoff, and grants no sink or testnet authority.

```powershell
node scripts/qualification/check-action-source-admission-wire.mjs OWNED_STATE NEW_OUTPUT
```

The retained native launcher also supports one deliberate DS process exit per run. Each stage
requires a fresh owned fixture and output directory:

```powershell
node --experimental-strip-types scripts/qualification/action-source-admission-replay.ts OWNED_STATE NEW_OUTPUT AUDITED_FIXTURE --crash-at before-fragment
# Repeat separately for after-fragment and before-ack, on both supported Node versions.
```

The fault control writes and fsyncs a bounded one-shot marker before the actual process exits
with code 86. Existing master supervision and RabbitMQ redelivery must recover the exact
original body and admission through a distinct replacement worker. Qualification requires
complete source manifests, the exact contract outputs on both copies and paired ACK evidence.
Raw observer outcomes remain in the report: the injected child exits 86 and the master records
its failure with exit 1. Only that precisely matched deliberate fault may pass the recovery
check; extra failures, forced shutdown, missing redelivery or incomplete output fail it.
This exercises process recovery, with no host/power-loss or master-failover durability claim.
Directory fsync is unavailable on Windows; file fsync remains required and recorded.

The [2026-10-20 evidence bundle](../performance/evidence/action-source-admission-20261020/README.md)
records both Wire runs and all six Antelope process-exit cases at code commit
`8b483fd0aec2819e1c15171e3950d39e715c6bd6`, with seven verified cleanup receipts.
Its raw reports preserve the exact inputs, source/emitted/runtime hashes, expected failure
codes and native bulk copy-count distributions. These are Windows process correctness
results; the remaining sink, canonical, query-activation and selected-testnet gates stay open.
