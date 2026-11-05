# Wire34 / CBFB consumer qualification candidate

This isolated source candidate compares current consumer 7b535421 with a new explicitly selected Wire34 cohort. Root must review its immutable patch before an external workflow or Linux execution. It does not repin a merged branch, deploy a service, change Wire121, or qualify full sync/parity. The existing all-CBFB/Wire69 profiles, source hashes and failed-source assertions remain unchanged. Their rejection of the new lock is expected, not a reason to relax them.

The sole component dependency change is Wire 69a6606 to merged 1e7547ff52740ecaa88d7867d3ec887a2febaa58, tree be879185c104e218a0f18e0af79affd2434b5509. Root/native SDK stay cbfb2669 and Wire retains its separately installed SDK 58d68c5. The isolated candidate also includes the reviewed one-field a093 native graph digest correction. HAPI production source, public API, limits and interfaces are unchanged. Fresh normal npm preparation in this candidate produced merge 1e Node/Rust/source receipts; no 2eb or earlier receipt is relabeled. The Rust artifact says source-only-engineering and does not prove local Rust binary execution.

Root reports that current 7b unprofiled retained acceptance timed out on both Node 24/26. This disproves a profiler-only explanation. The new Wire source contains both the earlier bounded compiled-ABI cache and native hex conversion. Any eventual paired difference applies to the whole selected dependency delta; it cannot be attributed to hex conversion alone. Prior failed runs remain failed.

## Source and installation gates

Use two fresh Git-LF directories on the same isolated Linux runner, one at exact 7b53542111709cf8b225b381077e498e25bc5d61 and one at the final candidate commit recorded in its delivery manifest. Never copy node_modules or build output between them. Record real Git commit/tree/clean status, Node binary/version/SHA, npm version, Bun binary/version/SHA and embedded TypeScript, OS/kernel/CPU, memory/swap/cgroup limits and free disk before/after. No fleet/production services or existing data are needed. A future runner/resource envelope requires Root review; this plan grants no host/resource authority.

Execution admission pins Linux x64 Node 24.22.1 and 26.4.0 to the exact executable hashes in `contract.mjs`. Local Windows Node 24.19.0/26.4.0 runs only pure source controls. For each admitted Linux binary, install and emit independently, preserving normal scripts:

```sh
npm ci --prefix packages/backend-mongodb --allow-git=all
npm ci --allow-git=all
bun -p process.versions.typescript  # must be 7.0.2; Bun must be 1.4.4
bun check -p tsconfig.json
bun check -p packages/backend-mongodb/tsconfig.json
npm run build
```

Keep each exact committed lock and its original install output. Do not use --ignore-scripts for execution admission, substitute a donor build or claim local Windows build as Linux acceptance. On the candidate, run:

```sh
node --test tests/native/wire34-cbfb-source-profile.test.mjs
mkdir -p out/wire34-linux
node scripts/qualification/wire34-cbfb/source-check.mjs > out/wire34-linux/git.json
node tests/unit/wire34-cbfb-source-admission.mjs --admit-wire34-cbfb > out/wire34-linux/source.json
```

The source observer validates all four MongoDB/BSON inventories, full root/native/SDK emitted trees, exact direct/nested SDK installations and merged Wire Node/Rust/member/prepared-lock/source receipts. Source and runtime identity do not grant workload or release acceptance. Baseline admission remains its unchanged `node tests/unit/all-cbfb-source-admission.mjs --admit-all-cbfb`; the standalone a093 graph issue is not used by that retained test gate. Retain genuine failures; do not overwrite their output with later guards.

## Paired retained acceptance and diagnostic plan

After Root review, use the same Linux host, runtime binary, environment and cgroup envelope for both variants. Run sequentially, with no overlapping cohort work; alternate current/new ordering over five pairs per Node major (AB,BA,AB,BA,AB). Use fresh owned per-invocation outputs and unchanged fixture-created state. If a gate cannot reach its original deadline/assertions, record failure/cancellation and the last retained stage; never infer speedup from a partial run or hide censored timings. Repeating a failed baseline and the run count require the reviewed execution plan, not an automatic retry from this local packet.

Current command from its own checkout:

```sh
HYPERION_NATIVE_SOURCE_PROFILE=stateful-all-cbfb-root-native-wire69-linux-engineering-v1 node --test tests/unit/wire-managed-state-v2-native.mjs
```

Candidate command from its own checkout:

```sh
HYPERION_NATIVE_SOURCE_PROFILE=stateful-all-cbfb-root-native-wire34-linux-engineering-v1 node --test tests/unit/wire-managed-state-v2-native.mjs
```

These commands are unprofiled acceptance gates. Both retain original 1..1480 input and 180000ms inner deadline, original callbacks/assertions/drain/close sequence and bounded progress telemetry. A nonzero exit, cancellation, missing EOF/exit custody or incomplete output is not success. A later workflow must retain the actual exit code and both streams, preserve source/installation/stage/resource receipts, and keep diagnostic work separate from acceptance status. No continue-on-error acceptance or silent journal-artifact downgrade is authorized.

Run `protocol-abi-history-native.mjs` with the same selected profile on each cohort after its source admission; all original owner/source/reset/fork/partial/restart controls remain. A failure remains visible and blocks acceptance. No Windows native/timer fixture was run for this packet.

Only after an independently recorded unprofiled result, schedule a separately named CPU diagnostic under a reviewed finite outer envelope (the existing 4-minute diagnostic policy is not an extension of the 180s acceptance). Record profiler overhead against the unprofiled results. Capture bounded existing stage records, CPU/GC/allocation and wall time from the owned process, and preserve producer/observer close/EOF/outcome evidence. Do not append --cpu-prof to the acceptance command. Five paired successful results and distributions/variance are needed before a performance claim; failed/partial cases stay labeled as such. No E2E gain or component causality is claimed by this source packet.

## Publication boundary

This packet deliberately leaves the old default CI routes/pins frozen. It is a local, separately selectable qualification cohort, not a claim that the old Wire69 workflow passes with a Wire34 lock. Root must review an explicit workflow/cohort integration before publishing or executing it. Full MongoDB/API/Atomic parity, current-testnet replay, full sync and production activation remain separate pending gates. Wire121 stays on 29bf/e691.

## One-attempt Linux workflow successor

The new `.github/workflows/wire34-cbfb.yml` is an additive compatibility workflow targeting PRs against `feat/atomic-managed-all-cbfb-20261104` and manual dispatch. It leaves every existing workflow unchanged. It runs one original retained attempt and one independently visible historical suite per supported major, with a separate failure-only CPU diagnostic. This is not the five-pair performance experiment above and grants no throughput/causality claim.

The owned child uses Node test isolation `none` so the bounded parent owns one Node process. The original fixture assertions/callbacks and180000ms inner deadline are unchanged. The225000ms custody envelope,2-second TERM/KILL/drain grace and1MiB per-stream cap fail closed on timeout, abort, missing close/EOF or lost data, even if the child later exits0. History still runs after an ordinary closed retained failure. An unresolved prior child/stream outcome refuses further workloads and leaves the step failed. CPU capture has its own4-minute workflow step and a64MiB exported artifact cap. The parent records intent before spawn and preserves the first failure while draining/closing the owned child and streams.

Resources are fresh observations from the GitHub-hosted Ubuntu22 job, bounded to2..8 visible CPUs and at most32GiB physical memory; available memory must be at least2GiB before and1GiB after, with4GiB disk available. These are compatibility-run limits, not the separate physical replay/full-sync envelope. No server, Docker, database daemon, shared data or host service is touched.

The predecessor2e0 path-closure review failed: its source checker accepted an extra tracked path. That commit and its failed check remain preserved. This successor lists the complete actual Git tracked-path inventory separately from the hashed execution/source inputs. Every remaining passive path has an explicit category/reason; all executable/configuration inputs, including the historical `verify.py` files and `.gitattributes`, are hashed. Passive historical document/receipt/archive content is bound by the actual Git commit/tree, not claimed as content-hashed by this profile. The retained1480 archive remains independently pinned and read by the unchanged fixture body. Actual-script VM controls demonstrate the predecessor red case and current extra/missing-path refusals. The profile and its reader are the only declared hash-cycle exceptions; both remain tracked in the actual source commit and immutable review patch.
