# Action source-membership journal qualification

Tracking: [History API #228](https://github.com/eosrio/hyperion-history-api/issues/228), under
[exact action-history integration #225](https://github.com/eosrio/hyperion-history-api/issues/225).
The same owned runner also exercises the private post-confirm outcome storage component in
[#282](https://github.com/eosrio/hyperion-history-api/issues/282), under pending-input work
[#277](https://github.com/eosrio/hyperion-history-api/issues/277).

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

The dedicated index is `<chain>-history-source-journal-v1`, outside the ordinary
`<chain>-action-*` template and wildcard and its `<chain>-action-read` alias. It requires stored unpruned source,
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
metadata and immutable storage modules, plus the production action template and master alias logic.
Its JSON evidence records their source/emitted SHA-256 hashes and committed Git blob hashes,
the script hash, Git head, native runtime, actual installed Elasticsearch client/transport versions
(`8.19.1`/`8.10.1`), exact image pin and each check's result/time. Recorded elapsed times describe this
fixture and are not component profiling results. Tracked inputs must match the reported Git head;
source comparison permits Windows CRLF checkout normalization and retains both raw and Git hashes.
The final status requires verified cleanup too.

The only input is the optional evidence output filename. There is no cluster URL, credential, image,
index-name or live-settings input. The runner creates a fresh labeled user-defined Docker bridge and two
containers from Elasticsearch 9.5.5 digest
`sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c`.
Each node is limited to 2 CPU, 2 GiB memory, 512 MiB Java heap and a 256 MiB data tmpfs; HTTP binds only
to an inspected random loopback port. Aggregate container limits are 4 CPU, 4 GiB memory and 512 MiB
data tmpfs. No host data directories are mounted. The inspected bridge is not `--internal`, which can
suppress requested host port publication; this matches the existing sequence qualification harness.
The report retains the Docker server version/revision along with owned-container identity.

One node is master/data/ingest; the second is data/ingest. The journal has one primary plus one replica,
and intercepted **real** write responses must show both configured copies successful. Actual shard
placement is recorded before restarting the secondary data node. That node may hold the primary or
replica copy; role labels do not establish shard placement. Its tmpfs is recreated, its node ID changes,
and the recovered cluster must expose both STARTED copies and the same journal membership from new
adapters on both HTTP endpoints. This exercises data-copy recovery with the sole master continuously
alive. It does not qualify master failover, availability during a node outage, or a production topology.
Recovery preserves the default delayed allocation and waits at most 90 seconds, using health polls
with a 1-second server wait and a 5-second request budget. The pinned transport's constructor-level
Undici timeout can expire before a longer per-request override, so the fixture does not depend on
extending that timeout. A health wait's expected HTTP 408 is accepted only with a validated owned-cluster
response and `timed_out: true`; other request failures still fail qualification. Evidence records poll
count, expected timeout replies, elapsed wait and observed delayed shards.

Fault wrappers first perform the real two-copy ES side effect, inspect its complete receipt, then
simulate a lost or partial returned receipt. Evidence labels these injected response faults. They are
not an actual replica-loss experiment. GET-only observations produce no fresh receipts; identical
retries must obtain fresh all-copy CAS receipts before the API reports successful preparation/sealing.

The checks exercise:

- Invalid schema, count/copy bounds, accessor rejection and cancellation before provisioning.
- Production action-template, wildcard and read-alias isolation with one inert owned history sentinel;
  journal records must inherit neither action mappings nor the action index sort.
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
this cleanup path. Startup waits at most 30 seconds for inspected loopback port publication while
rechecking ownership, resource and configured-binding guards. Failures retain bounded owned-container
state and log tails before removal. The component opens no PIT. When reachable, native per-node search-context counters
must be zero; verified removal also destroys all contexts in those owned servers. An unavailable
counter observation is recorded explicitly rather than invented as zero.

## Evidence scope

Inputs are constructed **journal component fixtures**. Their source/trace digests, target UUID and
producer labels describe fixture records. They are not a captured chain, consensus-valid source,
actual worker fanout or a certified action sink. The isolation regression writes one inert sentinel
to an owned action index through the production template/read alias. It processes no chain action
effects and does not certify that index as an action sink or as the plans' declared target.
Native success demonstrates this journal's expected-membership and storage behavior for these cases.
It does not enable ordinary live fanout or physical field omissions and does not authorize queries.

## Private confirmed-handoff outcome cases

`scripts/qualification/action-handoff-outcomes.mjs` runs through the same owned two-copy client and
cleanup path. It imports emitted `ActionSourceAdmissionStore` and
`publishAdmittedActionWithEvidence`; it does not serialize a fake confirmation ticket. The actual
publication helper obtains its opaque evidence from a controlled confirm-channel transport, with
mandatory persistent output and original-owner checks. Original block 122, its schema and independent
native value oracle come from the normal installed Wire `7167659` package, using the native profile
and shared SDK `339b5c9`. Package/source receipts and fixture members are hash checked. The installed
provider observes and decodes the original bytes; no capability is added to a legacy provider.

This is a storage component fixture. The original trace inventory is retained and rederived through
the admission API, and the target UUID is observed from the runner's existing owned action index.
Producer/executable pins and native metadata locator IDs are constructed associations. They grant no
canonical or native decoding authority; the component does not execute DS or acknowledge its input.
Output confirmation is controlled broker behavior, not an actual RabbitMQ or sink experiment. The
only ordinary action row remains the inert isolation sentinel; these cases do not write action effects
to that index or certify it as a complete sink.

The cases exercise:

- Actual helper evidence, exact original source membership and real complete-copy outcome writes,
  followed by validated reads from a fresh admission store.
- Buffered publication requiring both confirmation and its original drain, without resending.
- Controlled NACK or publisher close refusing confirmation evidence and a retained success outcome.
- Same-work/same-effect retries with new message IDs and round-robin queue position, requiring fresh
  all-copy CAS receipts while preserving the stable semantic outcome.
- A controlled pre-manifest failure, lost receipt and altered partial-copy response after real writes.
  Readable bytes remain observations; identical repair must obtain fresh complete-copy receipts.
- Serialized tickets, cross-source/target evidence, an index-action route outside the pinned
  configuration and changed effect bytes, preserving existing immutable output.
- Controlled owner replacement or cancellation immediately after a real outcome write; the call must
  reject even when the record is subsequently readable. This is not actual network cancellation.

`readConfirmedHandoff` reports validated observed bytes. It supplies no fresh durability receipt,
capacity grant, physical Elasticsearch/MongoDB acceptance or query readiness. Existing journal seals
remain expected-membership evidence; they cannot mint publication confirmation. These cases do not
qualify successful handoffs for empty/excluded work, absent-trace genesis or incomplete contracts.
Typed terminal handling, authenticated capacity consumption, bounded grants/bytes, restart/replay and
full native worker/MongoDB qualification remain separate work under #277 and the release gates.

JSON evidence records the new case's canonical Git hash, relevant source/emitted module hashes, exact
provider/SDK pins, original-frame/oracle digests, real copy receipts and controlled fault boundaries.
`qualification.confirmedHandoffOutcomes` describes this component only. Actual DS ACK ordering is
covered by separate emitted-worker tests; this runner does not infer it from a constructed ACK wrapper.

## Private typed attempt-disposition cases

The same owned runner imports `scripts/qualification/action-attempt-dispositions.mjs` for
[#284](https://github.com/eosrio/hyperion-history-api/issues/284). It exercises emitted admission,
typed-disposition and opaque publication APIs against real two-copy Elasticsearch storage. New
`qualification.actionAttemptDispositions` describes that component scope only; it does not replace
actual MainDS/DS ACK-order, source/configuration/target or proof-fence tests. The parent implementation
and this runner must be combined and emitted before running the existing command above.

The original archive stays SHA256
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`. A bounded Python `tarfile`
read returns only the exact named, regular block 1 and 36 members, with fixed sizes/hashes; it extracts
no files or directories. Original block 1 is 3,711 bytes, SHA256
`bdfdb8832cc573cca61f3e53cfa71219241e008b5c9665626295ea9342c2fb60`. The installed native-genesis
`result.bin` is a different capture of the same block and is not substituted. Missing traces stay
missing; the source-scoped unresolved observation invents no plan, transaction, ordinal or zero
expected membership.

Complete original inputs use the normally selected Wire `7167659` / SDK `339b5c9` provider and fresh
inventory. A captured exclusion policy remains separate from `disable_indexing` and `fetch_traces`
suppression. Those configuration controls produce `operator-disabled` observations retaining process
or unresolved expected work; they never mean source-derived exclusion or no effects. The constructed
whitelist **and** blacklist `sysio::setabi` on unchanged original block 36 routes transaction ordinal 1
(`140abb3d398f206518e117c02ccf1f1604b37b9fb55f7abed2034cf2fb374c66`) while selecting zero groups.
Its real `setcode/45` and `setabi/46` inputs remain present. This is a constructed operator-policy
control of a DS dispatch, not a genuine normal-policy no-effect transaction. Main-source processing
and the DS transaction stage retain distinct semantic identities.

Empty source and empty-action transaction frames are explicitly constructed with the installed
codec and retain different source/transaction scopes. The mixed fixture keeps the original native
onblock root and adds a deliberately constructed inline contract sibling. The normal installed
provider classifies them as native and contract; decisions and grants are never patched or cloned.
The sibling's portable value and shape-valid native locators are constructed associations. These
component cases do not obtain canonical/native/ABI grants or establish accepted chain blocks.

The cases retain a known pure output-portability gap with unresolved nonempty membership, confirm
all mixed raw/complete outputs through the actual helper, and require original drain. Schema1
incomplete groups fail whole-transaction membership before publication. Generic exceptions,
publicly constructed inventory errors, unavailable proof errors and async hook rejection do not
become known contract reasons. A no-output gap can coexist with later successful handoff storage;
neither selects a permanent/current disposition. Output is an immutable value under the semantic
work/disposition/reason ID, so conflicting roots cannot mint an alternate record.

Real returned write receipts are checked before controlled pre-manifest, lost-receipt or partial-copy
response faults. Readable bytes after an unknown call are observations. Repair requires newly issued
owner/store-bound evidence and fresh complete-copy acknowledgment, including immutable CAS on retry.
Serialized/foreign/stale evidence, wrong configuration or target associations, incorrect raw headers
and changed effects are refused. Controlled owner replacement and cancellation after a real write
must reject despite readable records. These controls are not real broker, replica-outage or socket-
cancellation experiments. Reads cannot be reused as issued capabilities.

Source/emitted modules, both helper scripts, normal package receipts, original frames, constructed
frames, native value oracle and actual write receipts remain hash identified in JSON evidence.
Admission/default/proof-window/dependency settings and the runner's owned-resource checks and cleanup
path remain unchanged. Authenticated settlement, proof-operation quiescence, prospective count/bytes,
restart/replay/retention, physical sink/API readiness and full native worker/MongoDB release
qualification remain open under #277 and the release gates.

#225 still needs real source admission before filters/dispatch, actual DS grouping before publication,
source-retention/replay scheduling, sink durability and set/visibility reconciliation, fork/repair/
retention invalidation, same-PIT coverage authority and complete reader integration. Rounded-ID losses
can span blocks/contracts in one partition; a finite source window cannot certify erased membership
outside its qualified scope. Existing retained-history compatibility, Wire testnet, AtomicAssets parity
and full release qualification remain independent requirements.

This document describes the runner and component contract. Passed runs must be linked to their exact
code head and retained JSON/checksum evidence before being cited as completed native qualification.
