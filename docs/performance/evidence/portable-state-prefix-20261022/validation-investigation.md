# Portable projection validation: captured CPU contexts and next experiment

The capture supports measuring repeated metadata/undo validation next. It does **not** select a cache, prove an end-to-end bottleneck, or establish an optimization benefit. No production, dependency, service, H1 or publication action was performed for this investigation.

## Evidence and limits

HAPI source is pinned to `03dd3e9758473bc563bf8d7cbbbc0557232f17dc`; SDK source is `ae1f670016d6f4a63b42eb08563ee9d544867915`. The relevant local source files match those commits. All 33 selected input files match their byte/SHA receipts, and the original archive independently hashes to `aac8bcb2a5f3f46bc33eec4359caabfa12b61cfed528b9d9c46b25f041f166dc`.

Projection PID1993201's profile SHA is `333ea38acc136aceeb11944e1f6b8ab3326dc4c25bc9cbc8977a6027c0afbe33`. I independently reconstructed its sampled ancestor paths and reproduced the validation aggregate and two contexts below. These are whole-process capture samples, including startup and idle periods, not an exactly isolated catch-up CPU interval. Inclusive rows overlap their descendants and must not be summed.

| Observed context | Samples | Of all37,254 samples | Preceding tick interval weights |
|---|---:|---:|---:|
| `validateRollbackState`, inclusive | 11,988 | 32.1791% | 121.645149s |
| `validateRollbackState`, self only | 143 | 0.3839% | Not separately attributed here |
| Under metadata `load → constructor validator → validateRollbackMetadata` | 10,348 | 27.7769% | 105.033662s |
| Under `apply` transaction callback, validating candidate next state | 1,640 | 4.4022% | 16.611487s |
| Node `encode`, self, whole capture | 4,438 | 11.9128% | 44.987931s |
| `encode` self with `validateRollbackState` on its stack | 4,211 | 11.3035% | Not separately attributed here |
| Nested/backend SDK `snapshot`, inclusive, whole capture | 7,802 | 20.9427% | 79.084878s |
| Nested SDK `snapshot` with `validateRollbackState` on its stack | 7,618 | 20.4488% | Not separately attributed here |

The weights are sampled elapsed intervals, **not exact CPU seconds**. Sample counts are not invocation counts. Most inclusive validation samples are descendant work, rather than the validator's own143 leaf ticks. The nested SDK entry is kept distinct from the root SDK copy; merging same-named functions would change the context aggregate. The existing root crosscheck agrees with these counts. Source release to stable prefix took365.553s; the wrapper's413.383s includes other phases. Neither is the table's CPU time. Root owns the CPU-off comparison; it is outside this investigation and no overhead conclusion is drawn here.

The actual result is `profiled-prefix`, not full recovery `passed`. All three projections reached288 with256 undo descriptors and coverage floor32. Their selected rows and total descriptor image counts are zero. The measured cost therefore includes proof/ABI handling, empty-block progress, metadata and retention; it does not qualify mutated-row throughput, before-image payload cost, forks/crashes/restarts, busy-chain memory, Rust, genuine Wire producer consensus or release readiness.

The final stored metadata canonical JSON sizes are140,154 /140,365 /140,150 bytes for attseq/outenvelopes/independent attestations; each undo array is94,654 bytes and each has256 receipts. Definition sizes are561 /766 /538 bytes. These are measured UTF-8 canonical JSON sizes, not BSON sizes, allocated byte counts or wire traffic.

## Why the work repeats

All source paths below are relative to the pinned HAPI tree unless prefixed SDK.

1. `packages/backend-mongodb/src/storage.ts:73-80` performs a native read and invokes the supplied validator on **every load**. Outside a transaction it reads primary/majority; transaction loads use the active snapshot. `rollback.ts:54` supplies `validateRollbackMetadata`. These are fresh durable-state checks, not mere configuration reads.
2. `rollback-contract.ts:142-150` checks stored checkpoint/revision agreement and invokes logical `validateRollbackState`. At lines154-193, each call checks inherited binding/definition/receipt/pending/gap integrity, policy and metadata BSON bounds, recovery coverage, floor receipt, every undo descriptor's shape/size/digests/contiguous parent, unique block identities and final checkpoint. Every descriptor invokes SDK `validateProjectionApply(definition, emptyMutationRequest)`.
3. SDK `src/projection.ts:560-563` revalidates the definition for **each** such request. Its generic validation path at422-427 snapshots input, validates shape, canonically serializes/UTF-8-encodes the full copy for its byte bound, and recursively freezes it. Snapshot at369-407 walks descriptors without invoking getters/toJSON, rejects exotic/cyclic/sparse data, validates Unicode and budgets, allocates detached objects, and repeatedly encodes keys/strings. For example, `string()` encodes for its bound, then snapshot encodes that string/key again for its traversal budget. This matches the captured encoding/snapshot/canonical/freeze descendants; no exact allocation count was measured.
4. Backend `contract.ts:123-176` also verifies the definition hash and binding and scans retained receipts; `stableJson/hash` at50-60 sort/serialize and SHA-256 identities. `rollbackRecovery` additionally copies a recovery view and computes retained BSON sizes. Cryptographic hashing remains correctness evidence; this capture does not show hashing itself dominates. Encoding/copying is the clearer sampled descendant here.
5. The ordinary inspected controller path calls `resumeRecovery`, `retainedCheckpoints`, and source-admission `markIncomplete` before `apply` (`controller.ts:71,81,128`). Each reaches a metadata load. A nonduplicate `apply` then loads outside and inside its transaction and validates the newly constructed candidate (`rollback.ts:237,256,301`). That is a **source-derived prediction** of five loads plus one candidate-state pass per normally applied block, before idle ticks, queries, retries and startup. At a full256-entry window, those six passes can revisit1,536 undo descriptors per block per projection. It is not a measured call count. Each boundary currently protects a different observation/admission/transaction state and must not simply be removed.

## Identity and freshness constraints

SDK binding `generation` is immutable instance identity; `mappingRevision` identifies the immutable definition. The separate metadata `revision` is a persisted rollback fence. Normal apply retains it while changing checkpoint, receipts, pending/gap and undo (`rollback.ts:300-303`); rollback rotates it. **None is an ordinary metadata progress generation.** A cache keyed only by binding, definition hash, checkpoint height, or rollback revision cannot certify a freshly read complete state, pending intent, coverage or corruption. Even the same checkpoint/revision may coexist with a newly persisted pending marker. Stored hash fields are untrusted until their actual content is validated.

Preserve primary/majority reads, transaction snapshot isolation, compare-and-set source filters, exact receipt/digest replay, persisted rollback-operation identity, source/finality/ABI checks and query gating. ADR0048 assigns coordination to runtime and rollback to adapters; ADR0051 binds requests/caches to compatible contexts. Neither grants permission to reuse stale durable metadata across I/O or source-generation changes.

## Ranked, falsifiable next questions

1. **Per-descriptor SDK capture dominates validation's repeated work.** Prediction: exact `validateProjectionDefinition`/snapshot/encoding calls and synchronous validation cost grow with retained descriptor count even with empty images; the count relationship can be tested independently of MongoDB/ES latency.
2. **Repeated full loads amplify that kernel cost.** Prediction: a logical-operation counter shows multiple validated loads per completed block and additional loads while waiting at a fixed head. Sampling cannot identify the public operation across every async boundary, so instrument operation/load counts rather than infer them from10,348 ticks.
3. **BSON accounting, recovery copying and canonical hashing add separate costs.** Prediction: bounded span/counter attribution distinguishes these from descriptor SDK validation as undo/receipt counts vary. Do not equate a definition hash comparison with checking the whole undo state.
4. **Other paths still constrain completion.** ES transport parsing, source-proof JSON processing, native waits and GC remain present. Separately measured awaited spans and observer CPU counters are required before attributing end-to-end elapsed time or predicting a speedup.

## Narrow follow-up and possible later changes

First run an unoptimized, pinned **validation-count/span fixture**: (a) a service-free kernel matrix of known-valid metadata with0,1,32,64,128,256 retained descriptors and exact source/floor/receipt relationships, using the real existing validators; (b) the unchanged owned1–288 actual-worker fixture with qualification-only logical-operation/load counters. Keep count/coverage collection separate from timing captures because instrumentation changes execution. Record counts, descriptor visits, UTF-8/BSON input sizes, synchronous validation spans, inclusive load wall time, independent process CPU/RSS/GC, native waits/retries and original workload/progress oracles. Compare same-state control, advancing state, and a bounded waiting-at-head phase. Alternate CPU-on/off and counter-on/off runs with identical pins/host bounds; one pair is not a capacity result.

Only after that baseline, evaluate separately: computing each string's validated UTF-8 length once within a single traversal; reusing one freshly captured immutable definition **within one validation operation** while still validating every descriptor; precomputing immutable expected-policy/binding encodings while checking actual stored values on every read; or combining redundant temporary-copy/size passes without changing the input contract. These are investigation candidates, not selected implementations or promised gains. Do not replace inert snapshotting with JSON cloning that invokes getters/toJSON, skip entire undo windows, trust mutable/unverified objects, or cache fresh-state validation by revision.

Any candidate needs differential corruption/budget/Unicode/accessor tests plus stale binding/revision, pending/gap, conflicting replay, coverage-floor, malformed descriptor/image hash, fork/finality/source generation, retry/lost receipt and interrupted rollback cases. Re-run all original Node22/24 recovery/finality acceptance with exact rows/revisions/headers and durable acknowledgments before a qualification claim. Preserve existing failed/timed-out artifacts. The accompanying private issue draft scopes measurement only.

## Provenance

Report JSON SHA `67bd1870f463256d137596d145a21b624e1286e19dd5491aec1309ac7b0f4a69`; stage JSON SHA `1cc987491552f7467cf11b0d6bd67e4329bb81edcce91ee1ad51da1c5ec53325`; root crosscheck JSON SHA `6165946ece6cbe8c965627128b3ecdf266a3664fb879e5a87d712471e5d334a8`.

The locally inspected backend emissions independently match captured source/emission pins: storage `ec4a4af6c2b2e7c5e6750ab827eadc51ffb5a4ed1289b9aff7ea560b771f8399`; rollback `c9660fe80803e97a362a70b7b0a618306a557c960ef6afc614d9fa9f762273dc`; rollback-contract `06d97fe507a3dc68cb3b11c4d2382f078ca6e184f3123985d9e170d62a447baf`; contract `a550fa7e3e0237192c871c8aa53cee871762e13c0a1386aa1971fd463b4e6e6c`.

Local SDK emission hashes to `8eb0e934f7762f3d4849eb58fe83fa01c828e9d22c10def4fa09975b034f0591`, equal to the captured dependency receipt's root and nested backend SDK bytes. The nested dependency is not separately installed in this local checkout; that H1-copy equality is receipt-backed, not a new remote inspection. Server/client pins in that evidence are ES9.5.5, JS client8.19.1/transport8.10.1; no dependency or compatibility decision is made here.
