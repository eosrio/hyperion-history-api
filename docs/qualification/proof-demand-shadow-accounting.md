# Verified proof-demand transitions and shadow accounting

Status: component implementation under review for [#277](https://github.com/eosrio/hyperion-history-api/issues/277#issuecomment-6424091233).

This slice adds an opt-in private accounting seam around original action-attempt
adjudication. It does not activate reader admission or repair the failed full Wire
replay. The existing engineering fixture selects the observer; ordinary construction
and production defaults retain their existing behavior.

## Seams and acceptance

The integration boundary is the existing producer/proof/DS path: the original Wire
consumer, its native managed worker, the real supervisor and admission/adjudication
stores, and the original publisher-confirm and drained-end callbacks. Controlled
storage, RPC and broker transports delimit this component test. No fabricated end,
persisted association or readback can stand in for an original completion transition.

The first regression holds the same original durable return and observes outstanding
accounting before release. It must remain outstanding through pending publication,
missing or unreturned ends, and failed final source/configuration/target checks.
Only the verified original transition can resolve its matching accounted stage.
Repeated, copied, foreign or stale transitions must not resolve another demand or
release twice. Observer failure and accounting overflow leave explicit uncertainty
without changing the original durable/ACK/end outcome.

The observer runs synchronously and returns no value. Its opaque token is usable
only inside that callback, by the issuing adjudicator, once. Accounting resolution
is provisional until the callback returns and its source/configuration checks still
pass. A throwing or asynchronous observer leaves charges uncertain. Duplicate
adjudication cannot reissue the same original end's transition.

Accounting separates actual captured encoded payload bytes, unmeasured bytes,
physical owners, exact source selections and stages. It is bounded, observational
state. It grants no source proof, broker settlement, SHiP credit, serving readiness,
whole-source completion or heap/RSS guarantee. Contract-specific failures remain
isolated. Missing byte coverage must not be represented as zero or complete coverage.

The finite observation window retains resolved identities for deduplication. Count
or byte exhaustion records incomplete accounting and bounded omitted-byte lower
bounds; it does not evict an unresolved demand. A DS-input transition cannot release
retained copies, downstream or recovery charges. Incomplete contract/source output
stays charged because a durable isolated-recovery handoff is outside this slice.
Both budget primitives are captured once, validated and frozen. Later changes to
the supplied configuration cannot expand the window; unrelated configuration
properties are not retained or evaluated.

## Validation and remaining gates

The new native regression first failed at the missing callback on both Node 24.19.0
and 26.4.0. Coupled accounting then exposed a real source-shape mismatch: the inventory
included producer/timestamp fields outside the ledger's declared position key. The
issuer now selects its declared fields explicitly, and the source-unit fixture keeps
those real inventory fields.

All five new native cases pass on both majors: held original input, missing headers,
source fencing after a visible association write, a lost association receipt with
fresh conditional retry, and accounting with copied/reused/expired tokens. The
original block-33 dispatch is 1,369 encoded bytes. Missing headers remain unknown
and charged; supplied V8 header bytes must match the original worker digest.
These cases use the actual Wire consumer, supervisor, admission/adjudication stores
and original callbacks with controlled broker/storage/RPC boundaries.

The focused source controls cover finite quotas/tombstones, other stages/copies,
observer failure and source revocation, incomplete classifications, unsafe typed
headers and unknown-byte diagnostics. Complete application and qualification checks
and normal emission pass. Record the final full-suite result, independent reviews
and CI on the pull request before merging.

Use `npm test`, which selects `./tests/unit` explicitly. The initial unqualified
`bun test tests/unit` run passed both tracked queued-proof cases but also discovered
an old partial copy under `out/`; that copy failed because its transport helper was
absent. Preserve that failed result separately from the intended-suite rerun.

Active admission still requires all relevant producer/sink/projection stages,
isolated durable recovery handoff and compaction, fork/restart reconstruction,
redelivery and conservative grant/expansion headroom. Preserve the default 256-block
ancestry, source 1..1480, original queue/resource budgets and deadlines. Full native
and notification seals, physical MongoDB checks at 1244/1480, expiry/genesis controls
and clean teardown remain open under #277/#191. This foundation does not close them.
