# Action source-membership journal qualification

Tracking: [History API #228](https://github.com/eosrio/hyperion-history-api/issues/228), under
[exact action-history integration #225](https://github.com/eosrio/hyperion-history-api/issues/225).

`ActionHistorySourceJournal` stores expected source membership. It prepares immutable block plans,
records one immutable fragment for every declared transaction, and seals an immutable manifest only
after all transaction memberships are present. An explicit excluded/no-effect transaction needs an
empty fragment; a block with an explicitly empty transaction list can seal an empty manifest. Missing
inputs are not empty membership. Fragments bind exact action fingerprints to the source plan and
transaction. Stable transaction and seal links are written last and cannot silently change output.

The module lives in `src/indexer/history/action-source-journal.ts` and exposes:

```ts
new ActionHistorySourceJournal(client, chain, replicas = 0, {readOnly: false});
preparePlan(plan, signal?);                       // {id, plan}
readPlan(planId, signal?);                        // {id, plan}
recordFragment(planId, transactionId, actions, signal?); // {id, fragment}
seal(planId, signal?);                            // {id, manifest}
readManifest(planId, signal?);                    // {id, manifest}
```

All actions passed to `recordFragment` are complete logical grouped documents, after actual grouping
and metadata validation. This API does not perform grouping or reconstruct source actions. Every
action must have the declared transaction's lowercase ID and numeric source block number; any
provided block ID must match the plan. Full finite contract data contributes to the document digest
without retyping arbitrary contract fields. Known sequence metadata is validated independently using
the production exact storage codec, including uint64 boundaries and numeric uint32 code/ABI counters.

The dedicated index is `<chain>-action-source-journal-v1`. It requires stored unpruned source,
`translog.durability=request`, one primary shard, the requested replica count, disabled automatic
replica expansion and no default/final ingest pipeline. Fresh complete-copy receipts are required for
every prepared record. Identical redelivery uses bounded CAS repair and requires a fresh receipt;
finding bytes with realtime GET does not substitute for that write receipt. `seal` reasserts the plan,
fragments and links before its final seal. A read validates observed bytes/references, including a seal
whose response was lost, and grants no all-copy, canonical, sink or query-readiness authority.

`readManifest` distinguishes a missing seal from missing referenced records and malformed/cross-bound
records through `ActionHistorySourceJournalReadError` (`missing`, `incomplete`, `invalid`). A read-only
instance does not provision storage or prepare/seal records.

## Bounds and remaining recovery work

Per-record limits are 128 MiB of canonical JSON, at most 100,000 transactions and 100,000 action effects.
The immutable store uses chunks of at most 512 KiB, with at most 256 chunks per record. Serialization
rejects accessors, unsupported/cyclic values, nonfinite numbers and excessive structure before effects.
The journal rejects more than four overlapping operations per instance; sealing performs member I/O
sequentially rather than retaining an unbounded asynchronous task queue. These are concrete component
bounds, not a measured throughput or memory budget for a production workload.

Per-record bounds do **not** bound total disk usage across plans, journals or chain lifetime. This
component does not implement automatic expiry, the configurable local source-recovery window,
historical-source discovery, operator recovery commands or safe pruning of referenced records. Its
plans carry source digests and producer pins; they do not themselves retain the complete SHiP source
bytes needed for replay. Those obligations remain in #225 and the accepted recovery policy. Do not
advertise this journal alone as a bounded end-to-end recovery solution.

## Owned native runner

After the normal lockfile install and native TypeScript build, run:

```sh
npm ci --allow-git=all
npm run build
node scripts/qualification/check-action-source-journal.mjs action-source-journal.json
```

The runner supports native Node 22 and 24. It imports the emitted production journal, manifest, exact
metadata and immutable storage modules. Its JSON evidence records their source/emitted SHA-256 hashes,
the script hash, Git head, native runtime, actual installed Elasticsearch client/transport versions
(`8.19.1`/`8.10.1`), exact image pin and each check's result/time. Recorded elapsed times describe this
fixture and are not component profiling results. The final status requires verified cleanup too.

The only input is the optional evidence output filename. There is no cluster URL, credential, image,
index-name or live-settings input. The runner creates a fresh labeled internal Docker network and two
containers from Elasticsearch 9.5.5 digest
`sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`.
Each node is limited to 2 CPU, 2 GiB memory, 512 MiB Java heap and a 256 MiB data tmpfs; HTTP binds only
to an inspected random loopback port. Aggregate container limits are 4 CPU, 4 GiB memory and 512 MiB
data tmpfs. No host data directories are mounted.

One node is master/data/ingest; the second is data/ingest. The journal has one primary plus one replica,
and intercepted **real** write responses must show both configured copies successful. Actual shard
placement is recorded before restarting the secondary data node. That node may hold the primary or
replica copy; role labels do not establish shard placement. Its tmpfs is recreated, its node ID changes,
and the recovered cluster must expose both STARTED copies and the same journal membership from new
adapters on both HTTP endpoints. This exercises data-copy recovery with the sole master continuously
alive. It does not qualify master failover, availability during a node outage, or a production topology.

Fault wrappers first perform the real two-copy ES side effect, inspect its complete receipt, then
simulate a lost or partial returned receipt. Evidence labels these injected response faults. They are
not an actual replica-loss experiment. GET-only observations produce no fresh receipts; identical
retries must obtain fresh all-copy CAS receipts before the API reports successful preparation/sealing.

The checks exercise:

- Invalid schema, count/copy bounds, accessor rejection and cancellation before provisioning.
- Durable plan preparation, real all-copy receipts, source-order manifests and idempotent reopening.
- Complete membership including explicit process-empty, excluded/no-effect and zero-transaction cases.
- Missing/unplanned/malformed transactions; cross-plan/source actions; duplicate effect roots within
  and across transactions; conflicts on stable links after reordered or changed effects.
- Exact metadata at 2^53, 2^63 and uint64 max, opaque finite contract values, unsafe numeric inputs,
  malformed decimal inputs, nonfinite data and excessive effect count before writes.
- Secondary data-node restart, changed node identity, two-copy recovery and retained manifest reads.
- Multi-chunk interruption, unknown/partial returned receipts, fresh identical CAS repair and GET limits.
- Cancellation after a real chunk write, with no later chunk or completion marker released.
- Corrupt retained bytes, source pruning, changed durability/replica settings and default/final pipelines.
- Read-only non-provisioning and zero native PIT/search contexts before owned server removal.

Destructive guard probes modify only the run-owned journal indices/pipeline. Cleanup checks exact
names, full IDs, labels and image identity before deleting containers, removes the empty owned network,
then verifies container names/IDs and network absence. Partial startup and failed tests still enter
this cleanup path. The component opens no PIT. When reachable, native per-node search-context counters
must be zero; verified removal also destroys all contexts in those owned servers. An unavailable
counter observation is recorded explicitly rather than invented as zero.

## Evidence scope

Inputs are constructed **journal component fixtures**. Their source/trace digests, target UUID and
producer labels describe fixture records. They are not a captured chain, consensus-valid source,
actual worker fanout or a certified action sink. The runner never writes action-history documents.
Native success demonstrates this journal's expected-membership and storage behavior for these cases.
It does not enable ordinary live fanout or physical field omissions and does not authorize queries.

#225 still needs real source admission before filters/dispatch, actual DS grouping before publication,
source-retention/replay scheduling, sink durability and set/visibility reconciliation, fork/repair/
retention invalidation, same-PIT coverage authority and complete reader integration. Rounded-ID losses
can span blocks/contracts in one partition; a finite source window cannot certify erased membership
outside its qualified scope. Existing retained-history compatibility, Wire testnet, AtomicAssets parity
and full release qualification remain independent requirements.

This document describes the runner and component contract. Passed runs must be linked to their exact
code head and retained JSON/checksum evidence before being cited as completed native qualification.
