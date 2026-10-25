# Reproduce the portable state worker tracer

This is the bounded integration fixture for [History API #191](https://github.com/eosrio/hyperion-history-api/issues/191).
It runs the existing launcher, reader, deserializer, ingestor and projection workers,
RabbitMQ, the shared projection runtime, the selected MongoDB adapter, and the real
Fastify HTTP host. This document defines the reproduction and its assertions. The
fixture files are source inputs, not a successful-run report. Record acceptance for
each exact code/runtime run separately.

The [2026-10-21 evidence](../performance/evidence/portable-state-worker-20261021/README.md)
records passing native Linux Node 22/24 runs at the pinned code commit, independent
reviews, process observations and verified cleanup. Its scope and remaining release
gates are explicit.

For new qualification, [the current baseline](https://github.com/eosrio/hyperion-tools/issues/65)
requires Node 24 or newer, with selected Node 24/26 runs. Dated Node 22 observations and their
then-pending gates below are historical; they do not establish Node 26 acceptance.

## Original inputs and independent expectations

The [fixture bundle](../../tests/fixtures/portable-state-worker/README.md) retains
1,480 contiguous, originally irreversible Wire blocks from the actual testnet,
including the native genesis state. Its chain ID is
`9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d`.
The selected provider profile is `wire-sysio-6508c9e8-engineering-v1`, with upstream
revision `6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`.

The archive preserves original schema/status/get_info responses and original binary
SHiP result payloads. Its capture receipt still describes the original blocks 1-2400;
only files 1-1480 are packaged. `retained-subrange.json` explicitly records that
selection. Neither the receipt nor its original investigation summaries are rewritten
to imply another capture. The driver ignores investigation/application summaries
when deriving actual source semantics.

Block 1 has original SHiP `prev_block:null` and no retained trace section. The selected
native-genesis verifier must establish its real header-zero parent and empty initial
application state. Every later block requires its original trace section, including
blocks whose header lists no transactions. The startup RPC control view derives
head/LIB 1 from the original block 1; original SHiP head/LIB/status bytes remain intact.
The fixture never seeds an ABI frontier or invents an empty initial source.

Two healthy definitions select actual `sysio.msgch` primary KV tables. Both bind the
original ABI deployed at block 222, with SHA256
`5adef7ede21018b2891598858d2bb57cc9e06a5761ee7b794f15cf8b532db28b`.
The original physical rows are joined independently to exact official `clio`
conversion receipts and that deployed ABI. Worker/database output never supplies
the expected values.

| Held prefix | `attseq` | `outenvelopes` |
| --- | --- | --- |
| 1244 | ID 0 inserted with `next:"5"` | IDs 1/2 inserted |
| 1480 | ID 0 replaced with `next:"9"` | IDs 1/2 deleted; IDs 3/4 inserted |

These are primary projection rows. Secondary-index state, legacy dynamic Mongo
collections and the legacy Elasticsearch state route are outside this tracer.

## Prepare the checkout and source

Run from the repository root on an isolated Linux qualification host with Docker,
Python 3.10+, PowerShell 7, native Node 24 or 26, and pinned Bun 1.4.4 on `PATH`.
Allow roughly 12 GiB RAM and 45 GiB free fixture storage. Docker uses only pinned images
and ephemeral loopback ports. The existing ES fixture requires an appropriate host
`vm.max_map_count`; provision host prerequisites separately before running it.

Use the committed dependency locks and native compiler emission:

```sh
npm ci --allow-git=all
npm ci --prefix packages/backend-mongodb --allow-git=all
npm run typecheck
npm run build
bun check -p scripts/qualification/tsconfig.json
bun test tests/unit/portable-state-worker-harness.test.ts tests/unit/portable-state-worker.test.ts
python -B tests/fixtures/portable-state-worker/test_helpers.py -v
```

The locked SDK/Wire revisions and exact component artifacts are verified by their
normal installation/provider loaders. Keep preparation scripts enabled. The Node
driver verifies those components again; these checks do not run or qualify Rust.

Create an existing ordinary output parent, then prepare a new source directory:

```sh
mkdir -p out
python tests/fixtures/portable-state-worker/prepare.py out/p191-source
```

`prepare.py` verifies the archive SHA256, the complete 1488-file inventory and every
uncompressed member before writing. It rejects links, unknown/duplicate members,
path traversal, changed bytes and an existing destination. It writes original
source bytes plus `out/p191-source/plan.json`. Only `source.directory` and the two
`oracleFiles[].path` values change from the original plan. They become absolute
ordinary paths: the driver resolves source directories from its current working
directory and oracle files from the plan's directory. Do not run the template
directly or move an already generated plan; prepare a new directory instead.

## Create exclusively owned services

```sh
python tests/fixtures/portable-state-worker/services.py create out/p191-services
```

This helper invokes the existing `es955-replica-fixture.ps1` with
`-ExposeRabbitManagement -IndexingPressureLimitMb 64`. It then creates one
labelled, pinned Redis container/volume on
that fixture's network and writes `out/p191-services/worker-state.json`. Redis
uses an ephemeral loopback port, AOF and `noeviction`. No Spring node or unused
legacy Mongo instance is created. No external service or MongoDB URI is accepted.
The native driver creates its own transaction-capable MongoDB 8.0.34 replica set and
removes it in its bounded cleanup.

The pressure fixture's one-MiB default intentionally rejects large writes. An
original source-journal publication for block 13 measured 2,132,724 bytes and was
rejected after completed checkpoint 12 in an initial one-MiB setup. This actual-source
tracer explicitly creates a 64 MiB fixture budget. The pressure fixture retains its
original default; this value is neither
a production recommendation nor a performance result.

## Run and inspect

```sh
node --experimental-strip-types scripts/qualification/portable-state-worker.ts out/p191-services/worker-state.json out/p191-source/plan.json out/p191-node24
```

Select the intended native Node executable on `PATH`. Use a fresh service fixture
and new output directory for a separate Node 26 run. The source can be reused
unchanged. A passing typecheck or a prepared fixture is not runtime acceptance.

The driver starts the actual indexer/API processes and requires:

- Retryable HTTP 503 before covered initial source; the API cannot initialize or
  declare readiness from configuration.
- Every original block 1-1480, paced in windows of at most 32, with source credits,
  actual RabbitMQ consumer deliveries/ACKs, contiguous durable projection checkpoints
  and source-linked canonical proofs. State effects do not add a history ACK barrier.
- Actual healthy HTTP queries at prefixes 1244/1480, exact official/source expected
  rows, replacement/deletion, binding/checkpoint headers, equality filters, keyset
  pages and bounded counts through the backend-neutral query interface.
- An exclusively owned Mongo `failCommand` update/error2 injection after completed
  block 1243. Actual server entry count, durable 1244 intents and affected HTTP 503 must
  be observed before disabling the failpoint and allowing exact-source recovery.
- A third fixture-only mapping with a missing required field. It remains durably
  pending 1244/checkpoint 1243 and returns retryable 503 while healthy projections
  advance. It is derived from the same real contract; it is not a second deployment.
- Independent Elasticsearch block history on both physical data nodes and HTTP 200
  from the existing `/v2/history/get_block` endpoint while state is fenced. The
  public action-source admission gate remains unchanged.
- No undeclared RPC fallback, drained owned queues, exact source hashes after the
  run, parent-observed clean worker/API shutdown and verified owned-Mongo cleanup.

## Native engineering replay for #270

The same tracer has an explicit native mode. Use a new owned service fixture and
output directory for each native Node 24/26 run, with the ordinary committed npm
lock and preparation scripts enabled:

```sh
bun test tests/unit/portable-state-worker-native.test.ts tests/unit/portable-state-worker-harness.test.ts
node --experimental-strip-types scripts/qualification/portable-state-worker.ts out/p191-services/worker-state.json out/p191-source/plan.json out/p270-node24 --native
```

Select `wire-sysio-6508c9e8-native-engineering-v1` through the generated ordinary
chain configuration and installed provider loader. The prepared source plan,
1,480 original frames, archive SHA256
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`,
legacy oracle profile IDs and original clio receipts are unchanged. The optional
mode does not alter default profiles, operator configuration or dependencies.

The launcher additionally imports the **existing**
`action-source-admission-preload.mjs` to activate its documented engineering
membership seam, with no crash control. Public/default operator admission
activation remains disabled. The new `portable-state-worker-native-observer.mjs`
only records actual method boundaries and returned results; it does not replace
providers, native decisions, transport responses, receipts or worker services.
This is a guarded replay of the production implementations, with that explicit
engineering activation, rather than qualification of public/default activation.

The replay holds actual source prefixes 1/33/122/256/397 before the original
Mongo prefixes 1244/1480. Prefix 256 keeps all genuine notification occurrences
within the **default 256-block** proof ancestry; no recovery-window override is
allowed. At 33/122/397, independently authenticated official native-header
conversions must equal physically persisted schema 2 values, retaining the
original `onblock` `{header: ...}` wrapper. All receipt/authorization sequence
fields remain exact decimal strings, and encoding must reproduce every original
byte. The native journal's actual PREPARE/readback must precede the owning source
ACK, and independently reopened retained records must bind the original frame,
capture, context, profile, canonical native epoch and occurrence. Complete action
membership seals must fingerprint the real physical outputs. Confirmed RabbitMQ
publication and successful captured Elasticsearch bulk items are separate checks.

The fixed state definitions bind the original `sysio.msgch` ABI deployment at
block 222. Their durable empty checkpoints at 1/33/122 are successful indexing
progress, while public state queries must still return retryable HTTP 503 with
code `projection.incomplete`, no rows and no served-state completeness headers.
The serving boundary is derived from the independently authenticated original
source/official ABI oracle, never inferred from Mongo progress. Prefixes
256/397/1244/1480 require the full existing HTTP 200 row/count/header assertions.
Raw block history must remain HTTP 200 at every held prefix. Genesis history uses
the independently verified header-zero predecessor; raw SHiP `prev_block:null`
remains unchanged in source/native evidence. The first Linux native pilot
correctly reached durable checkpoint 1 and failed a harness expectation of HTTP
200 before deployment; it does not demonstrate a product or codec failure.

Original contract notifications are authenticated from the original 1..397 source:
**25 occurrences across 17 blocks**, with each first-receiver origin, certified
input ordinal, exact receipt and grouped physical output checked. This dataset
has no genuine native notifications. Constructed native notification fixtures
remain separate codec/unit controls and are not relabelled as captured traffic.

Three explicitly labelled controls change one owned native output row after the
genuine prefix 397 has passed and the state ABI is deployed. Exact raw fallback
must remain HTTP 200 with the original hex string and no decoded value. Corrupt raw data and a decoded value
with incomplete metadata must return HTTP 503 with the existing named retryable
proof-error code while unrelated state queries and raw block history continue.
Each control restores and rereads the exact original row before continuing.
Original replay bytes and expected values remain unchanged. Genuine
genesis has absent traces, an incomplete native observation and incomplete
action membership; it must never acquire an invented empty trace vector or
whole-history certificate. Its separately verified initial application state
still permits unrelated state/history progress.

At 1480, the earlier 33/122/397 decoded API requests must return 503 outside verified
ancestry, while their original source/ingress records and raw block history stay
accessible. Held-prefix correctness is not broad historical serving. The
existing physical Mongo insert/update/delete/filter/count/header, write-failpoint,
contract-isolation, broker-credit, worker-shutdown and cleanup assertions all
remain required. Inspect `prefixes/native-*.json` and `report.native` alongside
the ordinary prefix, raw bulk and process/resource evidence. A passing source-only
preflight or typecheck does not establish this runtime result.

At the original 1244/1480 source holds, `prefixes/block-*.json` additionally retains
`physicalMongo`: direct read-only MongoDB storage inspection independent of the
HTTP and adapter recovery results. The audit verifies the owned loopback database,
replica identity/version, exact metadata plus all three projection collections,
simple collation, immutable bindings/generations, original-source checkpoints and
receipts, and every physical key/value against the unchanged independent plan rows.
The invalid mapping must remain empty at checkpoint 1243 with source 1244 pending.
At 1480 this requires deleted envelope keys 1/2 to be absent, keys 3/4 present, and
the attseq next value to have changed from 5 to 9. No extra physical fields, rows,
bindings or collections are accepted. A read-only snapshot session and matching
majority metadata, namespace and server-identity reads before/after bind the audit
to the held source. The receipt includes actual documents, counts, hashes, storage
version and budgets: at most nine projections, 256 rows per projection, 1 MiB per
document and 4 MiB cumulative inspection bytes. Native storage queries remain in
this qualification helper; no product query or adapter interface is changed.

This mode does not close #191/#256/#225 or qualify full fork/restart/finality
recovery, bulk ownership, a Rust deployment, client streaming #231, launch pins or
release readiness. Preserve the incumbent Wire node/binary/listeners before and
after the isolated bare-metal-hosted run and verify external fixture cleanup as
described below.

For the private [#288](https://github.com/eosrio/hyperion-history-api/issues/288)
attempt-adjudication investigation, an optional `--native --authority-rpc URL`
mode checks the retained source against a current Wire testnet RPC. Pass an HTTP
origin ending in `/` after the normal state, plan and new output-directory
arguments. The driver first verifies the chain ID and retained irreversible
height. It permits only `get_info` and `get_block` for a block in the original
1..1480 source or an original SHiP irreversible anchor. Each fetched block ID
must match the original captured ID; captured blocks also require the exact
predecessor. Replay `get_info` follows the released original irreversible
prefix. The source frames and original status bytes remain unchanged. This
mode checks historical identity against the running RPC; it does not exercise
live SHiP fork recovery or qualify public activation.

The native observer records the actual persistent, mandatory AMQP action send
and broker confirmation callback on the owned publisher. The DS worker's
confirmed-publication helper bypasses the older `publishAdmitted` method, so
that older observation alone cannot prove action handoff. The original
confirmed-publication evidence and journal seal still govern drain, source
membership and effects; the observer does not issue a replacement receipt.

The production worker reserves the exact certified source target as non-serving
before contract-dependent source materialization or declarative mapping. Only
successful exact-source application clears that durable intent. Failure to persist
a later diagnostic reason must not reopen the old checkpoint. Ordinary lag before
source admission retains its existing serving behavior; this fence does not add
a state-backend barrier to history/source acknowledgments.

Inspect `report.json`, `prefixes/`, byte-preserving `bulk/` requests/responses,
`observer/`, and process stdout/stderr. A passing report must also have successful
shutdown and cleanup receipts; source files alone provide no such result. Failure
outputs are preserved, including nested error causes and uncertain failpoint cleanup.
The run is bounded to 15 minutes plus a separate 90 second cleanup reserve.
This tracer reserves at most 20,000 captured bulk requests; other callers retain
the shared ledger's 10,000-request default. The cumulative request/response byte
cap remains 256 MiB and each message remains bounded to 16 MiB. `report.bulkCapture`
records the configured limits and admitted request count, including failed runs.
These are observation budgets, not permission to skip or truncate publications.

## Clean Redis before the core fixture

After the driver and its workers have exited, retain its report/logs and run:

```sh
python tests/fixtures/portable-state-worker/services.py cleanup out/p191-services
```

The helper verifies Redis ID/name, exact image, run/qualifier labels, volume and
exclusive volume consumer before removal. It records `redis.cleanup.json`, then
invokes the existing core cleanup and requires zero remaining run-labelled
containers, volumes and networks. Removing Redis first matters: core cleanup
deliberately refuses unplanned run-labelled resources or network consumers.
Setup failures preserve service intent/state for this same cleanup command. A
hard-interrupted driver additionally requires inspection of its own Mongo/native
process receipts; this service helper does not remove arbitrary Mongo resources
or kill native PIDs.

This tracer does not establish fork rollback, process-crash/restart recovery,
recovery-window coverage, mapping reload, Bun runtime support, Rust-worker parity,
AtomicAssets/AtomicMarket parity, WormDB, complete Wire testnet support or the full
4.5 release. Existing Elasticsearch history remains independent and usable.

## Recorded native qualification status

The [2026-10-22 evidence](../performance/evidence/native-wire-worker-20261022/README.md)
records a source-reviewed certificate handoff fix and a **failed** native Linux
Node 24 worker qualification. Original held prefixes through 397 passed after
the fix; later DS backlog caused genuine queued actions to expire outside the
default 256-block verified ancestry. The full Node 22 replay and final 1480
acceptance remain pending. Follow #277 for measured worker/proof backpressure;
keep #270/#274 open. Do not widen ancestry or relax queue/seal guards to turn
that failed run into a passing result.

## Owned broker restart instrumentation

The initial #319 fault mode uses `--native --authority-rpc URL --broker-recovery`
on native Linux Node 24/26. It excludes profiling and other fault modes. Create
its private services with `services.py create NEW_DIRECTORY --pin-rabbit-ports`.
The ordinary fixture still uses dynamic Docker ports. The explicit option
reserves two distinct loopback ports, persists the intended binds, then releases
the reservations immediately before Docker binds them. A competing bind fails
setup; it does not choose replacement endpoints after recording intent.

The preload holds the actual block-33 DS handoff manifest response after the
original publication confirmation and before its fresh-write observation or
ACK. The original store call stays awaited when its attempt is fenced. The
controller releases that response separately; it neither replaces the returned
bytes nor converts cancellation into a successful write. Store validation and
the original owner checks still decide what can happen after release.
Channel errors use passive `errorMonitor` observation so the existing handled
error path and unhandled worker exit both retain their original behavior. A
native counterexample against the pinned amqplib dispatch distinguishes passive
observation from an ordinary listener that would suppress an unhandled error.

Only a privately issued, single-use census can restart the owned RabbitMQ
container. The helper rechecks the exact run, image, container, exclusive data
volume, unchanged CPU/memory budgets, fixed loopback binds, Docker socket/daemon
identity and Linux process birth/command before the single-container restart.
It preserves the daemon and other fixture services. Before/after counters retain
their separate broker process incarnations; reset counters are not cumulative
work, durable completion, ACK settlement, source authority or capacity evidence.

This is instrumentation, **not completed broker-recovery qualification**. The
report retains `recoveryQualified: false` and records the full workload verdict
separately from cleanup. #319 still requires an actual owned Linux baseline and
fault run, independently verified terminal custody, authentic recovered attempt
and association checks, and resumed Mongo/API output oracles. Existing ordinary
publication cardinality and source checks remain strict: an unexpected duplicate
or unavailable input remains a visible failure until independently adjudicated.
Do not close #288 or #277 from these resource-free guards or a restart observation.

## Production-master worker replacement

For #288, append `--worker-recovery` to the native, source-bounded RPC command
instead of `--profile`. This opt-in case exits one actual Wire DS worker after
its confirmed handoff has a fresh durable acknowledgment and before its original
consumer ACK. The existing Hyperion master replaces the worker; RabbitMQ owns
redelivery. The source archive, 1..1480 interval, grants, queue budgets, ancestry,
independent Mongo/action oracles and deadlines stay unchanged.

At the original block-33 hold, the additional oracle requires the production
master to retain the dead attempt as unresolved, with no private association.
The replacement must receive the same body and headers on a distinct physical
receipt/channel, obtain a fresh acknowledged write for the same semantic handoff,
ACK the broker delivery and produce its own authenticated end and stored
association. Actual broker delivery/ACK/redelivery totals must reconcile. Stored
association metadata continues to say broker settlement is unknown; the
independently observed broker counters do not change that runtime contract.

Ordinary runs still require exactly one confirmed publication for each stored
output. For the exact recovered transaction, a completed in-process recovery
audit declares the original and replacement physical publication owners. The
fault case requires exactly one confirmation from each, and checks every copy's
full payload hash, admission, fragment, block, persistence and mandatory routing.
Copied/stored audit JSON, another transaction, a missing/extra copy or a different
owner cannot declare this expectation. Physical stored effects and independent
source oracles remain unchanged.

The fault control binds the owned output/config, exact source frame, chain and
installed engineering profile. Its exclusive durable marker permits one exit.
Raw observer and process outcomes remain unchanged. Cleanup validates the full
process census and precisely the expected exit before feeding a detached view
to the normal shutdown verifier. This mode does not capture CPU profiles.

An observed block-33 recovery case remains separate from the full replay result.
A later replay failure is still a failed run. This case does not qualify parent
restart, broker/server restart, forks, launch pins or the complete release.

## Reader handover during canonical RPC

On native Linux, use `--reader-recovery` with `--native --authority-rpc URL`.
This mode requires the original Wire 1..1480 source and excludes CPU capture and
the other fault modes. It is an opt-in engineering fixture; ordinary launches
load no reader-fault controller.

The original block-33 handoff/end reaches the actual master's canonical callback.
The fixture holds its real RPC result, retains the source-checked node response
bytes, and captures the current native reader's IPC, PID, Linux birth, command,
role, executable, working directory and parent. Only that captured child receives
the deliberate SIGKILL. The same master stays running and uses its normal reader
disconnect, source revocation, relaunch and source-open paths.

Fixture reconnect permission requires an opaque receipt issued after the original
parent's correlated native IPC reply and independently checked process death.
Copied controls, snapshots, exit diagnostics and replies cannot issue it. The
original stream must have closed with exactly 1..33 sent and acknowledged before
the next original frame is permitted. The expected resume is the coordinator's
next block, 34; no duplicate block is added. Neither this permission nor an exit
receipt grants runtime source membership, broker settlement or count/byte credit.

After the new reader/session/generation and its LIB are current, release the old
RPC result. Its original call must reject, its association must remain absent,
and the fresh source must have its own authenticated end, conditional write and
association. Retain the original Elasticsearch missing-document response beside
the typed absence audit. Check native output, physical history and both MongoDB
checkpoints for the resumed source; predeployment state must still return 503.

Keep every raw observer row and the interrupted reader log, including any partial
tail. Exclude that tail from parsed evidence. The cleanup oracle accepts only
the privately issued intentional reader fault; it checks every other physical
start, fork, exit, flush and disabled-profile receipt. Its detached normal-lifecycle
input excludes the killed reader and accounts for that one expected failed child.
The raw master exit and shutdown report remain unchanged, including exit 1 when
the observer reports the deliberate child crash. Any other failed, forced,
unresolved or omitted process makes cleanup fail.

Record this boundary separately from the complete replay verdict. Passing it does
not qualify live SHIP forks, the remaining recovery matrix, prospective capacity,
full replay, launch pins or the release. Source bytes/oracles, queue budgets,
256-block ancestry, durability, activation and phase/run deadlines are unchanged.

## Production master restart before adjudication

The irreversible canonical RPC check retains the original physical live-reader
anchor across awaited reads. It checks current role ownership, reader IPC and process liveness
and compatible LIB state before and after each block read. A replacement, disconnect,
exit, shutdown, withdrawn/regressed anchor or same-height conflicting ID cannot
authorize a stale RPC completion. Each successful recheck retains the latest
validated LIB height and ID, so an inter-read regression or conflict after an
accepted advance also rejects. Routine same-owner LIB advances and identical
refreshes remain valid. Offline/no-live-reader and reversible selection retain
their existing authority paths. When a canonical source coordinator is present,
its original source, reader session and generation must also remain available
and current across those reads. A synchronous coordinator revocation guard covers
its own fork fence before the master receives the new generation and immediate
source revocation before storage completes. This local guard adds no reads and
does not replace source membership, certificates or canonical RPC verification.
The native `action-canonical-reader-fencing`
fixture uses the actual emitted master callback and physical native worker
identities with controlled RPC/handover inputs; it does not qualify a live SHIP
fork or the complete recovery matrix.

On native Linux, use `--master-recovery` in place of `--profile` or
`--worker-recovery`. This case holds the actual master's adjudication after the
original block-33 DS handoff has a fresh durable write and an authenticated
quiescent end. The original state/native hold and owned queue drain must pass
before the crash. The old association must still be absent.

A current-parent source transition may fence projection initialization while a
Mongo connection or setup operation is pending. The production projection worker
allows at most four separately accepted initialization attempts. Each recovery
waits for the old physical root and retained operations to drain and for its real
parent end reply. Only a source-fence failure issued by the original proof scope,
including its own abort reason, can consume one retry claim. A constructed or
foreign-scope error cannot authorize recovery even after a real active fence.
A stop, retired/disconnected owner, uncertain end reply, ordinary
storage/configuration error or copied diagnostic cannot authorize recovery. Frame
and broker-delivery attempts retain their existing behavior. The native
`projection-startup-fencing` cases use the actual emitted worker/client/supervisor
and cluster IPC with controlled Mongo/controller I/O; real-service restart and
full replay acceptance remain separate gates.

The controller checks the launched master's parent, executable, command, working
directory, session/process group and birth identities against the physical
observer census. It refuses unobserved members or a changed group, then sends
SIGKILL only to that owned group and verifies the original identities have gone.
This process fence proves no storage effect, source completeness or broker ACK
settlement. Copied census and exit JSON cannot issue a restart receipt.

The normal Hyperion launcher then starts another master against the same owned
RabbitMQ, Elasticsearch, Redis, MongoDB and configuration. The source permits
one resumed stream from block 34 only after the original stream has closed and
the genuine crash receipt matches the original frames/profile/chain. The
existing coordinator resumes at its completed head plus one; it does not replay
the already acknowledged block 33. Ordinary runs still start at block 1. Source
grants, queue budgets, ancestry and deadlines are unchanged.

The replacement's real adjudicator must reject a JSON copy of the old end. Its
own block-34 attempt needs a fresh conditional write, authenticated end and
persisted association against that block's original source; reading the old
block-33 result cannot substitute for those facts. The old association remains
absent, and stored broker settlement stays unknown.

The exact replay remains `1..1480`: 1,480 unique original inputs and deliveries/ACKs
if the complete run succeeds, without skips or duplicates across the restart.
The old block-33 hold retains its independent native/state/publication checks.
The resumed block-34 source, physical owner, canonical native observations,
admission/publication fingerprints, captured successful bulk and recovery state
are checked before continuing. The ordinary single-version stored-output oracle
remains unchanged.

Raw pre-crash observer files retain their actual bytes and any unterminated tail;
they are not rewritten into successful shutdowns. The crash census and file
hashes are reported separately. The replacement master and persistent API still
require normal complete shutdown evidence. CPU capture remains disabled.

The driver continues through the unchanged full source and independent physical
Mongo barriers. An observed restart boundary is separate from the final replay
result: a later failure is still a failed run. This single drained-queue crash
does not qualify other crash windows, broker/server restart, generic reversible
inputs, live forks, launch pins or the complete release.
