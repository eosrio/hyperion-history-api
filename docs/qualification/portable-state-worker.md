# Reproduce the portable state worker tracer

This is the bounded integration fixture for [History API #191](https://github.com/eosrio/hyperion-history-api/issues/191).
It runs the existing launcher, reader, deserializer, ingestor and projection workers,
RabbitMQ, the shared projection runtime, the selected MongoDB adapter, and the real
Fastify HTTP host. This document defines the reproduction and its assertions. The
fixture files are source inputs, not a successful-run report. Record acceptance for
each exact code/runtime run separately.

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
Python 3.10+, PowerShell 7, native Node 22 or 24, and pinned Bun 1.4.3 on `PATH`.
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
node --experimental-transform-types scripts/qualification/portable-state-worker.ts out/p191-services/worker-state.json out/p191-source/plan.json out/p191-node24
```

Select the intended native Node executable on `PATH`. Use a fresh service fixture
and new output directory for a separate Node 22 run. The source can be reused
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
