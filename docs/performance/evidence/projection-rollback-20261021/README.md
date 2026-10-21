# Bounded projection rollback and process-crash recovery — 2026-10-21

Tested code: `781cd19bd30fac42a9d1318b00fb163bc357460e`,
[History API PR #245](https://github.com/eosrio/hyperion-history-api/pull/245),
for [History API #244](https://github.com/eosrio/hyperion-history-api/issues/244)
and [tools #21](https://github.com/eosrio/hyperion-tools/issues/21).
SDK: `c0156c7bc65bee780b2215ba731ee6e5fe2bb52d`,
[SDK PR #15](https://github.com/eosrio/hyperion-sdk/pull/15).
Reproduction: [bounded rollback guide](../../../projection-rollback.md).
Verify [SHA256SUMS](SHA256SUMS), then use [manifest.json](manifest.json) to verify
every member of [raw-evidence.tar.gz](raw-evidence.tar.gz).
[summary.json](summary.json) separates successful runs, earlier failures and limits.

## Verified component result

| Native Linux runtime on Hyperion-3 | Checks | Distinct child processes | Observed SIGKILL boundaries | Result |
| --- | ---: | ---: | ---: | --- |
| Node 22.23.3 | 14 | 34 | 7 | Passed |
| Node 24.19.0 | 14 | 34 | 7 | Passed |

Each run kills separate native processes after durable apply intent, immediately
before apply commit, after apply commit, after rollback intent, immediately before
undo commit, after one committed undo step and after a completed result is produced
but lost to the caller. Barriers use actual MongoDB command observations. Fresh
processes inspect persisted state and resume the original fenced source or rollback
request. Each run has seven intentional SIGKILL exits, two acknowledged retryable
unavailable exits and one expected stale-request rejection; the other 24 children
exit zero. Both parents succeed and verify that their children and clients close.

Independent expected rows cover orphaned inserts, updates, deletes and repeated
keys; replacement branches at reused heights; exact duplicates; stale views and
writers; and two successive recoveries followed by the retired first request.
Physical checks verify exact block IDs, checkpoint field shape, embedded revision,
rows and serving fences. Wrong-branch and older uncovered ancestors leave only the
affected projection incomplete. Block and actual BSON-byte retention budgets are
exercised independently; oversized undo preserves pending work without committing
effects or advancing progress. Unrelated projection queries continue.

Explicit v1 migration preserves rows and starts undo coverage at the actual
checkpoint. A native reproduction of the historical full-checkpoint update filter
matches no upgraded document; this does not claim execution of an entire historical
binary. A saved floor receipt supports duplicate replay after rollback beyond the
ordinary replay-receipt window.

The [public CI runner](https://github.com/eosrio/hyperion-history-api/actions/runs/39635039652)
also passes on Node 22/24 at `216af120f5b45bf43780f967d093224780bc1409`.
That commit adds only CI branch coverage after the tested code. Its owned Docker
fixture runs the existing v1 checks and the same 14 rollback checks; both reports
verify container, network and volume cleanup. Unmodified CI reports are in the
archive. Runtime, adapter, fixture and dependency pins are unchanged between these
native and CI code commits.

## Failures retained and corrected

The first native pilot preserved the predecessor checkpoint and exact pending
target after a kill before apply commit. Immediate replay returned acknowledged
retryable unavailable while the killed client's transaction remained open. The
owned server log records expiry of that exact transaction; the diagnostic report
then applies the identical pending source successfully. MongoDB's recorded
`transactionLifetimeLimitSeconds` remains 60; periodic cleanup can occur later.
The fixture now permits only explicitly acknowledged retryable unavailable errors,
checks exact physical state after every such failure and retries unchanged input
within three attempts per step, eight total rollback calls and a shared 180-second
deadline per crashed boundary. Unexpected failures and timeouts remain fatal.

Both successful native runs retain two such unavailable attempts: before apply
commit and before undo commit. Their child errors, bounded native causes, command
traces and independent physical observations remain in the reports. Two high-churn
retry traces per run reach the trace cap and explicitly report truncation; this
does not discard the failed process or turn its exit into a success.

The next Node 22/24 attempts passed all apply crash cases but failed a strict
prototype comparison between SDK null-prototype snapshots and ordinary native
checkpoint objects with identical values. Six comparisons now normalize validated
checkpoint fields while retaining exact IDs and physical revision checks. Those
failed reports remain unchanged in the archive.

Independent Spec review found and verified fixes for the SDK's running-coverage
floor invariant, the runtime's retired rollback request fence, and a fixture
assertion rejecting a valid duplicate after independently proven completion.
Original finding reports and their correction checks are retained. Final Spec
review has zero remaining findings; Standards review has zero documented breaches
and zero actionable smells. Machine-specific workspace prefixes in review text
are normalized; the manifest identifies each projection and original hash.

## Environment, validation and limits

Native processes use Hyperion-3, Ubuntu 24.04.4, kernel 6.8.0-136-generic and an
AMD Ryzen 9 5950X. Each Node parent/child cgroup is bounded to two CPUs and 2 GiB;
the separate native MongoDB 8.0.34 unit is bounded to two CPUs and 3 GiB, with a
0.5-GiB WiredTiger cache and one replica-set member. Reports retain original
source, lockfile, emitted-code and binary hashes, plus bounded resource samples.
Those samples include startup and intentional transaction-expiry waits; they do
not compare throughput, prove memory recovery or identify optimization targets.
The separate CI fixture uses the pinned MongoDB image digest in its reports.

The complete project check and native TypeScript 7 emission pass. Bun 1.4.3 unit
tests pass **947 tests / 6,853 assertions**. Native Node 22.23.3 and 24.19.0 each
pass all **47 SDK tests** and **24 adapter tests**; SDK CI additionally validates
packed ESM and strict TypeScript consumers. All nine CI jobs pass at the linked
code commit. A later evidence-only publication does not change the tested runtime.

All owned application data was captured before removal: six synthetic databases,
442 documents. The private 40-member native backup was verified member by member
before cleanup. The published subset includes the complete synthetic application
EJSON snapshot, server log and unchanged native run reports. Runtime/dependency
binaries, caches, administrative storage and protected process command lines are
omitted; the manifest records source archive hashes and projections.

Cleanup verifies that the temporary MongoDB listener is closed and the exact owned
directory is removed. The original Wire PID/binary, MongoDB, Elasticsearch and
`tibs` services remain intact; Wire advances from head 318,930 to 319,150 across
the cleanup checks. The private SSH forward is closed.

This establishes the tools #21 runtime/adapter component tracer. It does not
qualify live Wire fork/reconnect, irreversible-only mode, all legacy state routes
or production query publication. The production controller still uses v1;
integrating v2 with canonical host selection and affected-query gates remains
[History API #221](https://github.com/eosrio/hyperion-history-api/issues/221).
Historical-source retrieval/rebuild for uncovered undo, full Wire Node/Rust paths,
auto-map/reload, AtomicAssets/AtomicMarket parity, WormDB, Bun runtime support,
retained-history upgrades, stream-client #231 and sustained-load profiling remain
separate release gates. Existing Elasticsearch history requires no full reindex.
