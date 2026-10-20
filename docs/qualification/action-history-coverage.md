# Exact action history coverage and caller inventory

Read-only investigation for HAPI #225 / #219, 2026-10-20. HAPI source references below are fixed at
`92c1a237eb01e609363a662b9f98a7aad16e143a` (merged #224 in its stack branch, not a claim of release/4.5
integration). Tools source was inspected at `61446d79abedb9810c5cfb640ee7965e7b09476c`. No production
requests, native experiments, source edits, commits or pushes were performed by this investigation.
The new native cases below are a test plan, not passed tests.

## What is proved and what is missing

ADR 0053 requires exact uint64 strings on all chains; ADR 0054 makes `action_count` exact decimal text.
ADR 0040 preserves usable retained history without a mandatory full history reindex; ADR 0043 forbids
silently advancing through unavailable recovery inputs. These requirements are compatible with a
query-specific precision coverage error. They do not authorize excluding unknown members silently.

The existing native prototype proves its scalar physical/query mechanisms for its known inputs. Its
`unknownCoverage(base)` guard is deliberately not a durable coverage proof
(`scripts/qualification/check-action-sequences.mjs:191`, `:216-225`; corresponding design note).
Applying the user's contract/time filter to that guard is unsound after a rounded-ID overwrite:

1. Original root `9007199254740992`, contract A, and root `9007199254740993`, contract B, both become
   Number `9007199254740992` in the old ordinary parser/writer.
2. The second indexed document replaces the first `_id` in that partition.
3. A contract-A search and contract-A missing-coverage check both see zero rows. A zero count is not
   evidence that A had no action.

The old parser conversion is source-pinned at `95feb8f:src/indexer/modules/parsers/3.2-parser.ts:61-62`;
the ordinary `_id = body.global_sequence` and `index` operation remain visible in
`src/indexer/helpers/elastic-routes.ts:63-75`. Extension actions have a distinct exact protocol identity
path at `:65-69`; do not attribute every ordinary-producer collision to that path.

Even an **index-wide** zero unsafe-survivor count is not a general completeness certificate. A later
exact replay of `9007199254740992` can replace the final rounded survivor with a valid namespace while
the lost `9007199254740993` row remains absent. Deletion, pruning, reindexing and fork maintenance can
also remove survivors. Source-code pins identify producer behavior; they cannot reveal erased inputs.

## Minimum safe eligibility rules

Use one shared action-query adapter for search, count and historical page iteration. Keep membership,
totals and pagination in ES. Coverage must be decided before returning/cache-publishing any page.

**Mathematically safe retained root domain.** Under a qualified producer that received a positive
uint64 root and keyed the grouped action using that root converted once to Number, no original root
greater than `9007199254740991` can round into `[1,9007199254740991]`. Thus a whole Boolean query whose
possible root domain is contained in that interval is disjoint from losses caused by unsafe-root
rounding. It can remain available while another sequence interval is incomplete. This proves precision
integrity for that domain, not the historical presence of every action after arbitrary operator deletion.

The qualification must name the decoder/profile, parser, grouping revision, writer and applicable
executable plugin set. An arbitrary legacy mapping or a Number that happens to be safe is not a source
schema. PR #224's normalizer validates present leaves; it neither requires all leaves nor proves missing
rows (`src/indexer/helpers/action-sequences.ts:13-44`). Check `_id`/root association where that producer
contract requires it and independently validate required receipt/auth response values.

Derive a conservative root-domain envelope from the **entire** Boolean expression: intersect required
clauses, union required alternatives and account for `minimum_should_match`. Unknown non-root clauses
have the full root domain. An excluded unsafe equality, a receipt-only bound, or `(safe-root OR
contract=A)` does not establish a safe root domain. Do not infer a global root bound from a receiver or
authorization counter. An actually contradictory root-domain expression can return a proven empty set.

**Ambiguous legacy region.** Without stronger evidence, inspect all relevant concrete physical indices
for unsafe/missing roots and invalid/incomplete namespace markers, independently of contract, actor,
transaction, action-name and time predicates. Block/time filters can miss a replacement row because the
victim and survivor can be in different blocks/times of the same partition. A positive ambiguous result
is sufficient to refuse overlapping precision-dependent queries, but a negative result is not sufficient
to authorize them after untracked mutation. Retain durable taint until source-backed reconciliation,
including when the last unsafe survivor disappears. Do not use the request's `track_total_hits=false`,
result limit or `terminate_after` for an absence proof.

**A narrower source-backed region.** Contract or time can narrow coverage only when independently
recorded source manifests prove the relevant contract/time/block membership, including zero-action
intervals. A validated explicit block range can select independently certified intervals. A timestamp
predicate needs a source-backed timestamp-to-block envelope; surviving action dates are insufficient.
Do not derive complete transaction membership from one surviving hit.

**Common pre-threshold old history.** A canonical source anchor that establishes an interval's maximum
root is <= MAX_SAFE, together with a source-pinned proof of monotonic global sequences for that protocol,
can qualify the preceding anchored interval without replaying all its action data. This is a proposed
qualification route, not a proof already present for every Antelope/Wire deployment. An ES maximum,
node head block number or unverified version declaration is not that anchor. Do not apply monotonicity
across an unproved source reset/fork/chain identity.

**New exact intervals.** A valid per-row namespace proves that row's value; it does not prove the interval
contains all expected rows. Qualify new source/producer generations through durable expected effects and
completion records. Preserve all safe retained intervals and independently certified new intervals while
only intersecting incomplete intervals return retryable 503. No chain-global migration barrier is needed.

## Smallest durable bounded recovery/journal design

The following information is required; the physical store and SDK interface can be chosen separately:

- Immutable job/source identity: chain ID, protocol/codec pins, source capture digest and canonical block
  IDs/ancestry; parser/grouping/filter/plugin revisions. Filtering is legitimate only under that recorded
  configuration. Numeric gaps in global sequences do not enumerate missing grouped documents.
- Concrete target identity: index name **and UUID**, schema version, writer/mutation generation and fork
  generation. Bind every certificate to these identities; recreating an index with the same name or
  moving it through aliases cannot inherit coverage by name.
- Bounded prepared interval: source block range and block IDs, restart cursor, expected logical action-ID
  set or a digest/count backed by a retrievable manifest, and explicit empty-block records. Include root
  association and complete receipt/auth metadata. The retained receipt array cannot recreate a lost row.
- State: pending/incomplete/complete, validated source bounds, last fully reconciled interval and failure
  cause. Write durable invalidation/preparation **before** mutating a certified interval. Do not advance
  completion on reader publication, a max block, an arbitrary `_source` scan or one successful item.
- Completion: validate every expected bulk item/identity and required durability receipt, establish search
  visibility, reconcile the expected membership in the actual target snapshot, then CAS-publish the
  immutable completion record. Crash after effects but before completion is a resumable pending job.
- Forks, repair, pruning, reindexing and outside writers invalidate or deliberately replace affected
  generations. Old generation certificates must fail before response/cache/stream publication.

Reuse bounded immutable-bundle and CAS storage patterns, not ABI meanings. The existing immutable store
and `ProtocolAbiFrontierStore` have bounded payloads, durability/configuration checks and CAS control
receipts (`src/indexer/protocol/immutable-bundle-store.ts:18-43`,
`src/indexer/protocol/abi-frontier-store.ts:63-112`, `:127-177`). They need a distinct action-coverage
schema/namespace and lifecycle. An ABI complete commit is not an action-effects complete commit.

Recovery can enrich exact retained metadata with a proven association and selectively replay ambiguous
source ranges into their existing concrete partitions. Preserve canonical IDs and remove/reconcile stale
rounded IDs only with source evidence. A rounding equivalence class can span a chosen block window;
do not clear index taint after repairing only one survivor/window. Source unavailability leaves that
region incomplete, with bounded local recovery storage and explicit operator-visible reason. This is not
a requirement to rebuild safe history or a permission to require a full reindex for upgrading.

**Snapshot/generation rule.** Resolve the selected alias/wildcard to a fixed concrete UUID set. Bind
coverage to the same PIT used for native checks/results, and retain every latest returned PIT ID. A
certificate completed *after* the PIT opened cannot retroactively authorize its older data. A practical
sealed-span protocol is: read a complete immutable certificate/control generation after its visibility
barrier, open PIT, perform the same-PIT checks/search, then revalidate the same scoped generation and
UUIDs before publication. Every writer touching that span must invalidate its generation before effects.
Unchanged generation is meaningful only with this enforced writer discipline. Alternatively include
versioned journal observations in the PIT, but that alone supplies no cross-index atomic commit; the
effect-visibility and generation protocol is still needed. Bind cursor continuation to the selected plan,
source/coverage generation, UUID set and exact sort tokens.

Existing progress cannot replace this journal:

| Existing evidence | Verified behavior and limitation |
| --- | --- |
| `LiveReaderCheckpoint` | Confirms contiguous irreversible **publication**; `state-reader.ts:179-200` calls it after AMQP publisher confirmation, not action ES effects. |
| Master `live_checkpoint` | Updates the live reader's in-memory resume fields (`modules/master.ts:484-490`). |
| `chain:last_idx_block` | Set from `consumed_block` (`modules/master.ts:298-320`), not a reconciled action manifest. |
| `ingestor_block_report` | Master currently ignores it (`modules/master.ts:367-368`); `buildActionBulk` does not call its max-block callback (`helpers/elastic-routes.ts:55-77`). |
| Graceful-stop last block | Uses the latest block-index hit and writes file/Redis (`modules/master.ts:2064-2076`), not complete action membership. |
| ES bulk settlement | Per-item IDs/statuses are checked and failed items requeued (`helpers/elastic-routes.ts:317-421`); there is no durable per-source-block expected action manifest. |
| ABI frontier complete commit | Records canonical ABI observations/state and bindings (`protocol/abi-coordinator.ts:247-267`); no complete action sink acknowledgement is included. |
| Repair block count | Counts block-index rows (`cli/repair-cli/scan.ts:298-325`), so a complete block index cannot prove complete action effects. |

## Verified caller inventory and activation requirements

All paths here are relative to the HAPI repo unless prefixed Tools. Source projection, counts, sorting and
aggregation membership must be translated **before** limit/offset/scroll, not patched after fetching hits.

| Caller | Existing contract; required treatment |
| --- | --- |
| `api/helpers/action-search.ts:39-77` | Shared HTTP search; abort/socket lifecycle, complete shard validation and source normalization. Put exact query/coverage/restoration behind this seam and preserve error/cancellation cleanup. |
| v2 `get_actions/get_actions.ts:18-71`, `functions.ts:3-16,133-191` | Bool filters with eq/ne/list/range, account/contract/time filters, arbitrary `sortedBy`, offset and requested total relation. Preserve whole-conjunction cohort compilation, custom-sort meaning and native membership. |
| v1 `get_actions/get_actions.ts:203-272,300-335` | Legacy POST, signed offset slicing, root sort, public sequence aliases and first receipt shaping. Its first-receipt response choice is not authority to infer a legacy root. The ABI helper at :28 reads `-abi-*` and needs no sequence adapter. |
| v1/v2 `get_transaction/get_transaction.ts:88-100` / `:72-84` | Cache fallback searches root ascending. Block hint directly selects configured index version; normal branch uses `readIndexset('action')`. A global version bump hides old hinted history. |
| `helpers/transaction-cache.ts:4-26`; `workers/ds-pool.ts:811,832-835` | `trx_seq_v1:<chain>:<trxId>`, full-cache rejection on any invalid member, exact sort. Producer emits logical documents. Do not put physical sidecars/omitted fields into this cache or accept a partial transaction as complete. |
| v1 `get_controlled_accounts.ts:11-34`; v2 `get_created_accounts.ts:14-28`; v2-state `get_key_accounts.ts:143-157` | Action-root descending plus decoded-data filters/response shaping. Share restoration/coverage; preserve Wire decoded projection gates. The permission-table query in key_accounts :112 is separate. |
| v2 `get_creator.ts:33-44` | One action match with source shaping; action membership needs coverage even without an explicit root filter. Its block-header lookup :61 is separate. |
| v1-trace `get_block.ts:82-105` | Block scope, root ascending, source receipt iteration. Preserve all receipt identities. Block-header search :63 does not need sequence restoration. |
| v2-stats `get_action_usage.ts:6-24` | Root-descending predecessor bound, `_source.includes=['global_sequence']`. Fetch internal fields needed to restore this logical projection, then remove injected physical fields. Validate missing bounds explicitly. |
| Same `get_action_usage.ts:30-59` | Raw `_count` for tx_count and size:0 cardinality for actors. Use the shared snapshot/count seam for membership; keep these response counts numeric and existing cardinality semantics. CountRequest has no PIT (`node_modules/@elastic/elasticsearch/lib/api/types.d.ts:98-115`). |
| Same `get_action_usage.ts:96-134` | Exact string subtraction and separate `act_stats_seq_v1` cache already exist. Bind/invalidate coverage generations for cached results too; string shape alone proves no membership. |
| v2-stats `get_resource_usage.ts:10-55` | CPU/net stats/percentiles, size:0. Native numeric aggregation fields are unaffected by physical sequence omissions, but their action membership/totals need the gap guard. |
| v2-stats `get_trx_count.ts:204-212` | `validate_actions` is a raw action search/aggregation on configured version, counting `cpu_usage_us`; route through shared coverage seam. Main block aggregation :154 is separate. |
| `api/helpers/functions.ts:86-340` | Historical action/delta stream. Action initial search :185 and scroll :318 bypass HTTP search; per-page normalization, total/limit, on-demand filters, ACK loop, proof revalidation and finally-clearScroll are active. Restore before predicates/emission. Preserve preexisting filtered-stream semantics explicitly; do not call postfiltered totals matching totals. Delta path remains separate. |
| `api/helpers/functions.ts:931,973-1048` | Response-cache namespace already `sequences-v1`, Wire checks run before reuse and proof data is revalidated. Sequence source coverage needs its own generation check before cache read/write; preserve late async proof fences. |
| `api/helpers/archive-hydration.ts:178-190,282-286` | Needs logical canonical root before requesting data, validates returned block/global identities. Best-effort hydration cannot repair membership/order/count or certify a missing action. |
| `cli/repair-cli/repair.ts:115-153` | Action dry-count/delete by block range, configured version. Root omission does not alter the block predicate; mutation must invalidate/reconcile coverage and cannot recover precision via a dry count. |
| `workers/state-reader.ts:1233-1249` | Fork action deleteByQuery by block/source scope, configured version. Invalidate affected coverage before mutation and revalidate before serving; preserve protocol/fork recovery coordination. |
| `modules/lifecycleManager.ts:471-494,537-547` | Action last-block read uses only block_num and `_source:false`; later deletes whole indices. Physically valid with omissions; update retention/coverage catalog and invalidate the old UUID. |
| `cli/hyp-es-config.ts:349-465,681-705,944` | Action index analysis uses block_num; generic min/max helper's only current caller passes block_num. Reindex copies physical source and IDs without logical migration; new UUIDs need fresh coverage validation. It is not a 4.5 mandatory migration. |
| `connections/manager.class.ts:49-58` | Read alias/wildcard spans all physical versions. Preserve retained names and resolve actual UUID set; hot alias in v2 get_actions :58-59 is a separate selected target. |
| `api/server.ts:168,384-391`; `modules/loader.ts:136-175` | Raw ES client is exposed to dynamically loaded executable API plugins. No plugins directory exists in this worktree. External native readers cannot be certified from this repo: require tested compatible adapters/declared support before enabling omissions with those plugins. Do not silently intercept all arbitrary ES indices. |
| Tools `crates/es-load/src/main.rs:142-156,259-264` | Exact string NDJSON normalization/IDs, direct `_bulk`, no `h45_sequences_v1` mapping/codec or coverage lifecycle. It remains a local benchmark loader; do not describe it as a production full-range storage adapter. Qualify/update its selected harness mode separately before comparing physical production writes. |

Excluded after tracing targets: `api/server.ts:551,594` histogram/first-hit reads, master
`streamBlockHeaders:1934-1977`, common last/first-block helpers, ds-pool/deserializer ABI lookups,
snapshot account-table reads, ordinary block/delta/permission/voter/schedule queries. These do not read
omitted action sequence copies and must not receive an unrelated sequence availability barrier.

## Activation barrier

Install and read back the strict sidecar mapping on every retained target and future template before
bulk writes; retain stored source and original receipt associations. Existing proof-mapping provisioning
is a lifecycle example (`protocol/action-proof-mapping.ts:6-29`), not a sequence mapping guarantee.
Pin and qualify every writer and every enabled logical/native reader above before omissions are enabled.
Restore logical metadata before hooks/cache/stream/archive/API consumers, and hide the physical namespace
from public bodies. Validate custom multi-value sort modes; a root string comparator does not establish
receipt min/max/nested/filter semantics or arbitrary numeric sort-token safety. Preserve #220 gates.

Do not select fallback native old-field sorting when string-script contexts are disabled. The prototype
already documents the capability refusal and its performance qualification gap. It does not identify a
production bottleneck. Keep the selected query plan/cursor stable and close the latest PIT on every path,
including timeouts, cancellation, shard failure, source-proof failure and response shaping failure.

## Native counterexample and production qualification plan

1. Same-index rounded ID collision, contracts A/B: filtered guard returns zero incorrectly; source/index
   coverage refuses A's unbounded query, independent safe-root query succeeds with exact safe fixture IDs.
2. Same collision across two blocks/timestamps in one partition: victim-only block/time filter cannot
   suppress the survivor from the guard. A source-certified disjoint block interval remains available.
3. Replace the final unsafe survivor with one valid exact sidecar action: zero unsafe survivors must not
   erase persistent taint; only a source manifest recovering both original IDs clears the interval.
4. Entire missing document, missing root leaf, incomplete namespace, and source empty block: distinguish
   missing effects from certified zero expected effects. Equal raw row counts with different IDs fail.
5. UUID replacement, alias reassignment, reindex/new partition, stale certificate and duplicate writer:
   name/schema equality does not transfer generation coverage; unaffected concrete indices remain usable.
6. Open PIT before pending repair; publish repair/certificate after it opens: old PIT cannot borrow the
   new certificate. Fresh certified PIT succeeds; latest PIT IDs are tracked/closed and exact sort arrays
   retained without coercion.
7. Fork/repair invalidation during async hydration/proof or between coverage and search: discard the
   response before cache/emission. Invalidation of a different certified interval does not block this one.
8. Crash after preparation, partial bulk receipt, lost receipt, before refresh, and before completion CAS:
   no ready claim; idempotent bounded restart reconciles expected IDs and stale rounded IDs.
9. Whole-Boolean root-domain cases: safe intersection, unsafe union, negation, receipt-only bounds,
   minimum_should_match=0/1, empty root domain, MAX_SAFE neighbors, 2^63 neighbors and u64 max. Test before
   pagination/count and across shards, old/new indices, cache hit/fallback and both transaction endpoints.
10. Real source projections: full source, root-only includes, excluded metadata and `_source:false` size:0;
    no namespace leak, correct restoration, numeric code/ABI counters, no contract-data coercion.
11. Custom receipt/auth sorts and mixed full Boolean filters: native array min/max and exclusion behavior
    remain declared; no accidental tuple semantics. Script-restricted server gives explicit refusal.
12. Actual HTTP/stream cancellation, timeout/failed shard, capped versus exact totals, pagination/ACK
    limits and cleanup; direct count/aggregation callers use the same coverage decision. Repeat with the
    source-pinned Antelope and both Wire engineering profiles; Wire testnet/fork/ABI gates remain separate.

Primary technical sources already used by the native experiment are linked from
`docs/qualification/action-sequences-design.md`: the official unsigned_long, index-sort, pagination and
nested-array docs, and exact ES 9.5.5 source commit `48acba663b09e70b115dd879329141506c377890`.
This report adds source/data-integrity reasoning and a caller inventory, not an additional ES experiment.
