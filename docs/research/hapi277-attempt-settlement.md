# Actual attempt settlement before proof-window capacity accounting

Source-only research at HAPI `f80ab829ac987e369a51a07575869ad99afecea3`
(tree `b232615a04e0714540800a72ed2f68f9d980cf01`, #285). This proposes one prerequisite
of [#277](https://github.com/eosrio/hyperion-history-api/issues/277); it implements or
qualifies no runtime behavior. No worker, service, codec, build or test was run for this note.

## What exists and what settlement must add

The admission gate remains disabled. Original channel objects are captured at broker receipt;
publication ownership checks the original consumer/publisher against current channels and readiness.
That predicate does not express attempt lifetime. [Worker ownership][owner], [MainDS ingress][ingress],
[DS ingress][ds-ingress]. #282/#284 records bind source/output observations and require fresh writes;
`readAttemptDisposition` only validates observed JSON. They neither close an actual consumer nor
issue settlement/capacity authority. [Disposition contract][dispositions], [store write/read][store].

These are separate facts:

| Fact | Limited meaning |
|---|---|
| Stored handoff/disposition/capsule | A source-bound observation; a read is not fresh durability or live authority. |
| Original queue ACK attempted | Local broker action after that path's checks; not a confirmed global delivery settlement. |
| Actual attempt ended | Every owned proof consumer ended, or an effective fence makes further proof use impossible. |
| Successful handoff | Exact final-action publications confirmed/drained; not Elasticsearch acceptance or projection readiness. |
| Input resolved / capacity protected | Additional source-wide, queued/downstream, retention and prospective grant obligations. |

The last two rows cannot be inferred from the preceding rows. Confirmation waits for mandatory,
persistent send, confirm and drain, but a timeout/abort can reject while a later broker callback
still exists. [Publication implementation][publication]. No disposition chooses a permanent/current
outcome; incomplete diagnostics must not become empty membership. [Disposition contract][dispositions].

## Current path and owner inventory

| Actual path | Existing boundary and missing lifecycle fact |
|---|---|
| MainDS normal source | Original frame, ingress, handshake, components and capture are checked; admission/config/target and applicable selection/proof are rechecked before ACK. `activeActionSource` and decoder context clear in outer `finally`, after the parser's ACK path. [MainDS source/ACK][main], [parser ordering][parser]. |
| Pre-admission quarantine | Durable `h45srcq1` capsule plus original channel can lead to ACK, without an admission, plan or verified block/ordinal. Binding/read/codec failures are separate branches; a missing owner cannot ACK. Capture the actual receipt/frame, not invented semantic identity. [Quarantine][quarantine], [capsule shape][capsule]. |
| Missing source, empty/excluded/no-effect/disabled work | Source observations precede ACK where derivable. Dispatched no-effect work ends at DS, not at MainDS. `fetch_traces` suppression can retain nonempty inventory. Missing traces are not an empty vector. [Source observations][source-observations], [dispatch][dispatch], [disposition contract][dispositions]. |
| MainDS proof unavailable | ABI/native PREPARE precedes proof waiting. A recognized unavailable proof may be suppressed while original inventory remains available; this is not contract failure or proof-consumer drain. [PREPARE/wait][prepare]. |
| Incomplete-admission raw dispatch | Fallback can send admission/selection headers without `action_trace_ordinal`; DS verifies ordinal/dispatch membership only when inventory exists. Physical attempt identity cannot require a plan or ordinal. [Dispatch fallback][dispatch], [DS admission][ds-admission]. |
| DS complete or checked raw/mixed output | Redis/native checks, sealing and successful-handoff or raw-disposition writes precede ACK. Full mixed output remains checked; raw disposition is not decoded success. Every retained original view remains relevant through final awaits. [DS ACK paths][ds], [publication/cache work][ds-output], [final fences][ds-admission]. |
| DS known pure contract fault / narrower diagnostic | Branded pure source/output validation or the separate hook diagnostic can retain incomplete membership and ACK. Unknown hook I/O/proof errors gain no contract reason. A physical end receipt must cover these paths without upgrading their semantic meaning. [DS catch/ACK][ds], [disposition contract][dispositions]. |
| Core I/O, publication, owner or authority failure | Escapes ACK handling. Extension/admission cargo failure kills cargo and requests process exit; that request is not parent-observed death. Legacy nack paths remain separate. [MainDS cargo][main-cargo], [DS cargo][ds-cargo], [DS finally][ds]. |
| Derived/detached work | MainDS stages record helper effects with an async-local scope and refuses publications after closure, but closure is not proof that a detached handler/read ended. DS retains views for cache/revalidation and has queued publication/stream paths. Track or fence these consumers, not just parser return. [Derived helpers][derived], [record scope][record], [DS output][ds-output], [DS queues][ds-ingress]. |
| Projection worker | Separate retained-journal consumer, no history/source delivery ACK. `source.frame/open` consumes the same bounded proof reader; controller runs independent projection drains, applies and revalidates, preserves failed target/checkpoint, and `stop` awaits its outer current promise. This is a real proof consumer, not a history disposition. [Projection source][projection-source], [controller][controller], [worker][projection-worker]. |
| API/stream proof reads | Request/batch cancellation and final output checks are independent of worker attempts. They reopen bounded proofs, and cancellation also races an operation. They must remain expiring request scopes, never ingestion credits or head pins. [Request lifecycle][api-request], [API proof consumers][api-proof], [state read gate][state-gate]. |

MainDS emits `consumed_block` **before** its awaited admission ACK; periodic worker reports are
aggregate observations. Neither is an end receipt. [Parser][parser], [DS reports][reports].

## Why return, disconnect and revocation are insufficient

`waitForOpen` races polling against abort. Its caller can reject while the actual retained-store
promise is held; `activeReads` decrements only when that inner operation finishes. Native opening
uses an independent `asReadOnly()` proof reader and later native/store operations, so tracking only
the caller's reader misses children. Issued-view revalidation accepts a newer head with the same
owner/generation; passing distance 256 does not revoke every retained view. [Read/wait/revalidation][proof],
[independent proof issuance][proof-copy], [native opening][native]. Node documents cancellation as
signaling selected APIs; signaling alone is not evidence that an arbitrary operation stopped.
[Node AbortController][node-abort].

Master assigns the logical `worker.id` again and authenticates ordinary messages by the exact
`Worker` object in `wref`. Disconnect clears that reference and schedules replacement without
waiting for exit. Transition waits on disconnect or a timeout; graceful stop sends `stop` and can
exit without a per-attempt child-drain receipt. [Launch][launch], [disconnect][disconnect],
[transition/shutdown][shutdown]. Canonical-source RPC already checks physical worker plus
session/generation; its source revocation changes authority, not the lifetime of DS/provider work.
[Existing RPC fence][rpc].

Node 22/24 distinguish IPC disconnect from worker exit. An IPC send callback can precede receipt;
`killed` records signal delivery, not termination. Parent-observed exit establishes process death;
stdio `close` is a later, distinct boundary for complete log capture. Neither death nor pipe closure
settles remote writes. [Node 22 cluster][node22], [Node 24 cluster][node24], [child lifecycle/IPC][node-child].
Async work cannot be completed from a process `exit` listener. [Node process exit][node-process].

## One next issue: private live-attempt supervision and proof-consumer settlement

**Implement a passive, usable lifecycle from actual ingress through authenticated end, covering
MainDS, DS and projection attempts.** No new store/index, public SDK, executable sandbox, source
grant, coordinator advancement guard or operator activation is needed for this prerequisite.
The following are proposed private boundaries, not existing APIs:

1. **`registerAttempt` / `bindAttemptSource`.** Master owns a fresh boot epoch and a unique
   incarnation for each physical `Worker`; retain retired incarnations outside replaceable `wref`.
   Worker creates an opaque receipt token and immutable payload/header digests at the actual consumer
   callback, before cargo can wait. Registration must be explicitly acknowledged before that attempt
   can consume a proof; IPC send success is insufficient. Bind semantic fields only after the existing
   verification: ingress/frame/schema/capture, selection/session/generation, optional admission/plan,
   exact original ordinal/dispatch, producer/config/target. Quarantine and incomplete inventory retain
   unknown fields; a digest/claimed selection is not verified position. Projection registers its
   initialization/frame job with definition/binding/checkpoint and later verified frame identity.
   Redelivery creates another physical attempt, linked to original input only when verified.

2. **`runAttempt` / `trackChild` / `assertAttemptActive`.** One core-owned registry owns each root
   and its actual child operations. Propagate the same revocable context through async-local helpers,
   retained ABI/native views, `asReadOnly`, provider/hook awaits, Redis/derived publication and original
   ACK paths. Track the *inner* storage/native operation before invocation, including the losing
   `waitForOpen` poll; an outer timeout's `finally` must not decrement that child. Guard every later
   proof use and effect/cache/publication helper before invocation and after awaits. Existing canonical,
   input, target and configuration checks still apply; a local attempt token grants no protocol authority.
   DS caches currently span a cargo batch while these roots span deliveries. For this first slice,
   invalidate proof/native associations, including any cargo cache entry referring to them, when their
   delivery ends; the next delivery must acquire its own current scoped views. Retain a cache across
   roots only if tests establish that it carries no ended proof/grant. Report changed cache lifetime
   and read counts; do not silently reuse fenced authority or claim a performance improvement.
   [Cargo cache lifetime][ds], [native clones][native]. Keep native encode/decode synchronous.
   [Native codec contract][native-codec].

3. **`closeAndDrain` / `fenceAttempt`.** Normal end follows the **whole** local attempt, including its
   existing ACK attempt and actual finalizers. All final pre-ACK proof/target checks remain inside the
   active attempt; do not insert a new canonical-settlement wait before ACK or perform those checks
   after accepting end. Stop root acceptance of new children, wait registered handler
   work needed for the existing result, irrevocably fence retained capabilities, cancel remaining reads,
   and join their actual underlying completion. Detached callbacks inherit the closed context and cannot
   reopen a proof or publish later. Normal settlement requires the root and all descendants drained,
   not a count supplied by a caller. Trusted audited operator plugins must use the owned scope for
   detached proof work; unknown/unregistered descendants cannot receive a quiescent receipt. This is
   cooperative lifecycle discipline, not a new adversarial-plugin sandbox. Synchronous stuck native
   work or a non-draining child requires supervised termination and observed exact-process exit.
   Keep semantic ACK/effect status, proof-capability fencing and physical transport/resource drainage
   separate; an aborted remote write can stay unknown after its local consumer has ended.

4. **`acceptAttemptEnd` / `observeOwnerExit`.** Only the audited registry can issue the matched end
   reply, after closure/fence/drain. Master validates physical sender/incarnation, boot epoch,
   registration/close request nonce and immutable binding; duplicate replies are idempotent and stale
   siblings cannot end replacement work. No serialized `settled: true`, record readback, ACK counter or
   copied token is an issuer. Expose opaque accepted end evidence plus an immutable diagnostic snapshot
   to the future guard. The evidence states only `quiescent` or `process-exited-unresolved`; output
   observations, ACK attempt and unknown remote effects remain separate. Never replay stored evidence
   into a fresh master epoch.

5. **All exit branches.** Consumer/publisher replacement, reload/config/target changes, selection/fork
   revocation, cancellation, channel loss, cargo failure, mode transition, stop and IPC disconnect must
   fence the affected root and descendants. A timeout, failed/lost registration/end reply or unavailable
   authority stays `unknown`, with no fabricated success. Disconnect retains the old owner while the
   existing replacement launches. Kill/escalation is a request until parent observes exit; a surviving
   delegated process is not covered by its parent's death. New-master startup cannot infer old-owner
   quiescence from an empty local registry. Original broker/source recovery remains required.

Keep waits outside the coordinator's serialized mutation lane. Registration is lifecycle custody,
not a prospective reader credit. MainDS closure does not end DS work already handed to RabbitMQ;
a DS end does not resolve queued redelivery. Do not couple independent projection failure to history
ACK, block unrelated contracts for an ordinary incomplete outcome, or promote existing unconfirmed
legacy publications into durable success. Preserve [contract isolation][adr11], [at-least-once effects][adr21],
[shared infrastructure backpressure][adr22] and [bounded recovery/gaps][adr43].

### Smallest owned implementation groups and rejection obligations

* One private attempt-context module plus master supervisor/IPC schemas; wire
  `hyperionWorker.ts` and `modules/master.ts`. No replacement worker service or record-only substitute.
* Delivery/root adapters in `deserializer.ts`, `ds-pool.ts` and their actual parser ACK/finally path;
  projection adapters in `workers/projection.ts`, `projection/controller.ts` and `projection/source.ts`.
* Child/fence boundaries in `abi-proof.ts`, `native-authorization.ts` and existing publication/helper/cache
  calls. Preserve public proof grant/ancestry semantics and current publication caller contracts.
* Focused tests through those real classes plus native Node 22/24 IPC: all ACK/no-ACK/quarantine/diagnostic
  branches; missing plan/ordinal; source-to-DS handoff; parallel projection failure isolation; held inner
  read after timeout; `asReadOnly`/retained-view and late detached callback reuse; held confirm/write;
  source/config/target/fork and both channel changes; duplicate/stale/unknown receipts; actual disconnect
  while child remains alive; reused logical ID/replacement; root death/restart; close/exit ordering and
  failed termination. Hold each gate and show **no accepted end** before actual drain or effective death.
  Constructed controls remain labeled; no invented original empty-vector/no-effect case.

This is one complete passive tracer bullet, not merely a record schema: an accepted end must be
consumable by a later guard because the real continuation paths have been fenced and drained.
If any listed consumer cannot be covered, report that as an unresolved lifecycle gap rather than
accepting its end. Bounded metadata/operation admission is required; these bounds are not measured
memory budgets or source-credit reservations.

## Explicitly later #277 work

Still required: prospective **count and byte** grants before canonical advancement, including already
granted/queued/downstream original inputs; a policy for independent projection lag and bounded historical
recovery; crash/restart ownership reconciliation and retained original identities; replay/fork invalidation;
then unchanged full-worker Wire/Mongo qualification. API proofs must still expire for original early
blocks at head 1480. Keep default ancestry **256**, inactive public admission, RabbitMQ and existing
shared-reader backpressure. This research closes none of #277/#270/#191 or release/runtime readiness.

In particular, no active projection frame attempt does **not** mean no future proof demand:
checkpoint-plus-one remains required between polls, after failure and while another projection advances.
The later capacity/recovery policy must represent that demand or recover it from bounded historical
sources; a passive frame-end receipt cannot authorize forgetting it. [Controller retry][controller],
[projection worker polling][projection-worker].

[owner]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/hyperionWorker.ts#L78-L123
[ingress]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L684-L705
[ds-ingress]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/ds-pool.ts#L1215-L1279
[dispositions]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/docs/qualification/action-attempt-dispositions.md#L1-L18
[store]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/history/action-source-admission.ts#L480-L500
[publication]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/history/action-confirmed-publication.ts#L5-L89
[main]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L340-L441
[parser]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/modules/parsers/3.2-parser.ts#L197-L234
[quarantine]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L448-L541
[capsule]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/protocol/source-bindings.ts#L29-L43
[source-observations]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/history/action-source-admission.ts#L323-L405
[dispatch]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L914-L1007
[prepare]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L544-L681
[ds-admission]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/ds-pool.ts#L878-L942
[ds]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/ds-pool.ts#L745-L858
[ds-output]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/ds-pool.ts#L1110-L1211
[main-cargo]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L148-L174
[ds-cargo]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/ds-pool.ts#L170-L200
[derived]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L1727-L1772
[record]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/deserializer.ts#L2296-L2359
[projection-source]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/projection/source.ts#L38-L216
[controller]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/projection/controller.ts#L26-L111
[projection-worker]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/projection.ts#L9-L47
[api-request]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/api/helpers/protocol-proof-request.ts#L13-L67
[api-proof]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/api/helpers/protocol-abi.ts#L168-L202
[state-gate]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/projection/production.ts#L8-L38
[reports]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/workers/ds-pool.ts#L1297-L1336
[proof]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/protocol/abi-proof.ts#L112-L247
[proof-copy]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/protocol/abi-proof.ts#L93-L109
[native]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/protocol/native-authorization.ts#L98-L211
[native-codec]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/protocol/native-authorization.ts#L244-L274
[launch]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/modules/master.ts#L1287-L1300
[disconnect]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/modules/master.ts#L2154-L2184
[shutdown]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/modules/master.ts#L2005-L2115
[rpc]: https://github.com/eosrio/hyperion-history-api/blob/f80ab829ac987e369a51a07575869ad99afecea3/src/indexer/modules/master.ts#L639-L705
[node22]: https://nodejs.org/download/release/v22.23.3/docs/api/cluster.html#event-disconnect
[node24]: https://nodejs.org/download/release/v24.21.0/docs/api/cluster.html#event-disconnect
[node-child]: https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#subprocesssendmessage-sendhandle-options-callback
[node-abort]: https://nodejs.org/download/release/v24.21.0/docs/api/globals.html#class-abortcontroller
[node-process]: https://nodejs.org/download/release/v24.21.0/docs/api/process.html#event-exit
[adr11]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0011-contract-issues-never-halt-chain-indexing.md
[adr21]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0021-at-least-once-idempotent-indexing.md
[adr22]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0022-retain-infrastructure-backpressure.md
[adr43]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0043-bound-recovery-retention-and-report-unavailable-inputs.md
