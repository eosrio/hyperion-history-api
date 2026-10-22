# Typed action-attempt dispositions before capacity accounting

Research snapshot: HAPI `ba007bf279f1a72048fa966ea89d5201817debf0`, the
[#283](https://github.com/eosrio/hyperion-history-api/pull/283) candidate for #282.
This note proposes one prerequisite of [#277](https://github.com/eosrio/hyperion-history-api/issues/277);
it implements nothing and makes no worker, canonical, restart or release qualification claim.

## Findings at the fixed source

The current engineering gate is disabled. MainDS verifies retained frame/handshake, original
selection, stable capture, installed protocol components and producer configuration. It retains
source bytes plus policy, producer/executable pins and target name/UUID before acknowledging the
original source delivery. A **pure inventory compilation failure** produces an admission with
`planId: null` and an incomplete string; storage failures escape. [Admission store][admit]. Consequently source ACK means
recoverable admission/dispatch, not successful action decoding. Pre-admission quarantine is a
separate capsule path and can also ACK its owned delivery. [Source admission and ACK][main],
[quarantine][quarantine], [inactive gate][gate].

| Existing path | Required output and present ACK behavior | What it does not establish |
|---|---|---|
| Missing/unsupported original source | Retained source and incomplete admission; genuine genesis has no trace vector. MainDS can finish and ACK. | An empty transaction set, complete history, or a contract fault. |
| Policy excluded / no effects | Inventory derives disposition from full original source and captured policy. Admission prepares empty membership fragments for non-process transactions. MainDS dispatches only transactions with a dispatch body. | A confirmed publication, or a permanent rejection under another policy/revision. |
| Contract/member finalization fails | DS catches `ActionSourceInventoryError`, persists `noteIncomplete`, attempts sealing and may ACK with no successful handoff. | Zero expected effects, a structured reason, or capacity settlement. |
| Schema1 proof/ABI incomplete | Restored raw metadata has `ds_error`; membership validation rejects it, normally reaching the DS incomplete path. | That transient authority, lag, I/O, or fork trouble is a bad contract. |
| Schema2 native incomplete | Exact raw fallback can satisfy original membership, be confirmed/persistently handed off and ACKed. #283 expressly excludes it from successful handoff records. | Successfully decoded effects or readiness, even if membership seals. |
| Complete nonempty output | #283 records the exact confirmed/drained final-action group, durably writes the semantic outcome, rechecks original authority, then ACKs. | Sink acceptance, a fresh capability from a read, or released source credit. |

These branches follow [inventory derivation/validation][inventory], [MainDS dispatch][dispatch],
[DS fallback][fallback], [DS settlement][ds], and [private confirmed outcomes][outcomes].
`noteIncomplete` currently stores only admission ID, nullable ordinal and bounded message, so its
text cannot distinguish these cases. Plan/fragment/seal records certify membership only. [Store][notes],
[journal contract][journal].

Error classes are not terminal-reason enums. ABI/native unavailability errors carry retryable 503
semantics, including pending authority, missing certificates, bounded-wait timeout, cancellation,
noncanonical source and expired ancestry. An `ActionSourceInventoryError` can describe source
shape, filtering/grouping or final output. Classifying by that class or parsing its message would
confuse contract failure with unavailable authority. Ordinary I/O, failed/unknown publication or
write receipts, changed owners/configuration/targets and cancellation must remain failures;
none can manufacture a terminal contract disposition. [ABI authority/wait][proof],
[native authority][native], [publication owner/confirm/drain][publication].

## Original-corpus boundary

A pure Node 24 codec scan authenticated the unchanged source archive
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`, all 1,488 members
and 1,480 block frames with the installed Wire `7167659` / SDK `339b5c9` pins and native engineering profile.
It found absent traces only at block 1, no encoded-empty trace vectors, 1,956 nonempty transactions and
2,356 actions, all with `except: null`; no zero-committed-action candidate or unsupported transaction
status was found. The classification receipt is SHA256
`94d0818c9d9e3ba378cbf58e2ac6e5643addd14093fe93db5f69fcd432713b77` in the companion raw artifact.
This invokes only the pinned codec and examines structure: it issues no inventory/proof, does
not decode applicable contract values, and does not establish a genuine no-effect host transaction.

Keep explicit-empty/no-effect cases **constructed**, as in the current [inventory tests][empty].
The actual worker controls use operator-disabled block 37, policy-excluded block 38, and a constructed hook
failure on original block 39; that last case preserves `native_output_incomplete` raw output and ACK
without successful outcome. Original block 36 has real `setcode/45` and `setabi/46` effects and cannot
serve as a no-effect fixture. [Original-source worker controls][worker]. Genesis block 1 must remain
missing action membership even though the separate native-genesis verifier can establish its
own limited ABI/native context. [Genesis distinction][genesis].

## One next issue: retain private typed attempt-disposition evidence before existing ACKs

Depend on #283's private evidence/store conventions. Add one bounded internal record family to
`ActionSourceAdmissionStore` and wire it into the existing MainDS/DS ACK seams; preserve public
activation and existing contract isolation. Name it **attempt disposition**, with explicit cases:
source-unprocessable; policy-excluded; no-effects; contract-output-incomplete; and confirmed
raw-incomplete handoff. These describe the owned processing attempt at its captured revisions,
not permanent rejection or projection completeness.

* Freshly resolve retained source/admission. Bind chain/block/capture/ingress and original selection,
  producer/config/plugin/executable revisions, target name/UUID, and policy digest. Transaction
  cases additionally bind the exact original ordinal/trace/dispatch digests and plan; source-level
  incomplete records must not invent a plan, ordinal, empty vector or zero expected count.
* Issue the reason at its **known pure branch**, using a bounded enum and stable source parameters;
  do not upgrade a generic caught exception or message into trusted evidence. Preserve diagnostics
  separately. Policy/no-effect cases require freshly derived complete inventory; no-output contract
  cases retain the unresolved expected membership. Native raw fallback requires the complete exact
  group of newly issued confirm-and-drain tickets, body/header/fragment association and raw-status
  checks; a fragment alone is insufficient. Typed proof-unavailability diagnostics remain distinct
  from contract reasons and confer no terminal-work authority.
* Reuse #283's semantic work context where it exists. Use a separate source-level context otherwise.
  Keep disposition/reason/output-root records immutable and idempotent, allowing a later successful
  handoff to coexist without erasing the earlier gap. Exclude random message IDs, queue positions,
  wall-clock data and unbounded error text from stable identity. Do not select a current/permanent
  outcome from these observations.
* Before the existing ACK, require fresh configured-copy write acknowledgment and unchanged original
  delivery owner, producer configuration and target; repeat the applicable proof/native checks across
  awaits. A primary-visible record or an observed read cannot substitute. If authority is unavailable,
  record only that narrower observed failure; never claim canonical completion or a successful handoff.
  The implementation must separate persistence errors from pure branch classification. Preserve current
  raw fallback and unrelated progress; do not introduce a wait inside a serialized coordinator lane.

The acceptance oracle is actual emitted MainDS/DS plus fresh admission/store and real helper tickets:
original genesis remains incomplete; actual policy controls yield only their typed observations;
constructed no-effect input is explicitly labeled; original contract/native incomplete cases preserve
membership/gaps; complete siblings proceed. Hold/fail/partially acknowledge writes, revoke authority,
change configuration/target/owners across awaits, and retry with new genuine tickets. Require no ACK
on uncertain I/O, no invented effects/seals and no successful outcome for incomplete/disabled work.
An opaque bounded producer-issued disposition must be distinguished from its serialized stored read.

This slice supplies typed evidence only. Later #277 work must authenticate settlement of each
**actual** attempt, prove proof-consuming operations have ended or been fenced (a returned/aborted
promise alone is insufficient), and prospectively grant bounded count **and bytes** before canonical
advancement. Retry, worker crash/restart, fork/generation invalidation, deduplication and retained
recovery coverage require their own proof. Keep ancestry 256 and contract-failure isolation under
[ADR 0011][adr11], [ADR 0021][adr21], [ADR 0022][adr22] and [ADR 0043][adr43]; do not infer capacity from
a disposition record, ACK counter, generic incomplete marker or a larger window.

[main]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/deserializer.ts#L340-L419
[quarantine]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/deserializer.ts#L428-L511
[gate]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/hyperionWorker.ts#L85-L112
[inventory]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/history/action-source-inventory.ts#L409-L519
[dispatch]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/deserializer.ts#L907-L921
[fallback]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/ds-pool.ts#L533-L625
[ds]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/ds-pool.ts#L751-L795
[outcomes]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/history/action-source-admission.ts#L201-L293
[notes]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/history/action-source-admission.ts#L303-L310
[admit]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/history/action-source-admission.ts#L145-L163
[journal]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/history/action-source-journal.ts#L29-L62
[proof]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/protocol/abi-proof.ts#L173-L250
[native]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/protocol/native-authorization.ts#L32-L40
[publication]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/history/action-confirmed-publication.ts#L5-L104
[empty]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/tests/unit/action-source-inventory.test.ts#L154-L176
[worker]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/tests/unit/action-handoff-outcome-worker.mjs#L465-L515
[genesis]: https://github.com/eosrio/hyperion-history-api/blob/ba007bf279f1a72048fa966ea89d5201817debf0/src/indexer/workers/deserializer.ts#L554-L590
[adr11]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0011-contract-issues-never-halt-chain-indexing.md
[adr21]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0021-at-least-once-idempotent-indexing.md
[adr22]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0022-retain-infrastructure-backpressure.md
[adr43]: https://github.com/eosrio/hyperion-tools/blob/81da2f26de84b655ace531c073e9dc58e05d876c/docs/adr/0043-bound-recovery-retention-and-report-unavailable-inputs.md
