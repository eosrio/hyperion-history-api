The projection process in the Node 24 empty-table prefix capture spent a substantial fraction of sampled stacks in rollback metadata validation and SDK copying/encoding. `validateRollbackState` occurs in 11,988 of 37,254 projection ticks (32.1791% inclusive). Its own body contributes 143 ticks (0.3839% self); the inclusive total includes work below that function. This is attribution evidence for this workload, not a selected optimization or a full recovery qualification.

Both independent input archives, selected regular files, complete process inventories and observer lifecycles pass the analyzer. Public reproduction passes the same unchanged analyzer gates and produces identical per-process profile and CPU results. No H1 action, production code, dependency, service, process or captured input was changed by this analysis.

**Capture and method.** HAPI commit `03dd3e9758473bc563bf8d7cbbbc0557232f17dc`, native Linux Node `v24.19.0`, binary SHA-256 `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`, reversible mode. The source profile is `wire-sysio-6508c9e8-engineering-v1`, upstream `6508c9e8f4044df8d5acb082a7af3be6a80cd9a0`, chain `9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d`. Codec revisions and hashes, original source/input/oracle pins, invocation, runtime receipt, emission inventory and physical stage remain in the recipes and complete outputs.

Source blocks 1–288 advance in batches of 32 after all three physical projections catch up. Both final stages show the exact same checkpoint block 288, zero target rows and 256 retained undo descriptors in each projection. The source is an engineering fork fixture derived from captured Wire input. It is not node-authenticated Wire consensus. This prefix includes ABI deployment but does not execute the populated-table suffix, fork, restart or gap scenario. Elasticsearch 9.5.5 and MongoDB 8.0.34 provenance belongs to the separate runtime receipts; no new service observation was made here.

Each of the 14 CPU-on profiles passes bounded node-tree, parent/root, sample-ID, time-delta, lifecycle and SHA validation. The projection profile has 5,862 nodes, 37,254 samples, 377.725713 seconds of V8 extent, 377.725508 seconds of summed preceding tick intervals, and a 205 microsecond unweighted tail. `timeDeltas[i]` weights the interval preceding sample `i`, including the first interval from profile start. These are sampled elapsed weights and include idle and GC. They are not process CPU seconds. No V8 tick-to-prefix epoch alignment is claimed.

Functions aggregate every context with the same exact call frame. Only the two SDK `projection.js` copies are additionally grouped across script/URL identities, keyed by their verified common source hash plus function name, line and column. Inclusive function and module buckets count each sampled stack once, including recursion or cross-copy recursion. Inclusive buckets overlap and must not be added together. Self buckets remain exclusive.

**Projection attribution across all contexts.** Percentages use all 37,254 projection ticks, including idle. Weighted percentages use 377.725508 seconds of tick intervals. Emitted JavaScript lines are one-based.

| Function or module | Self ticks | Self raw % | Self weighted % | Inclusive ticks | Inclusive raw % | Inclusive weighted % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `validateRollbackState`, backend `rollback-contract.js:101` | 143 | 0.3839 | 0.3815 | 11,988 | 32.1791 | 32.2046 |
| SDK `snapshot`, both byte-identical copies, `projection.js:86` | 2,642 | 7.0919 | 7.0975 | 8,085 | 21.7024 | 21.6904 |
| SDK module union, both copies | 6,285 | 16.8707 | 16.8562 | 11,881 | 31.8919 | 31.8701 |
| `encode`, `node:internal/encoding:355` | 4,438 | 11.9128 | 11.9102 | 5,448 | 14.6239 | 14.6185 |
| `visit`, HAPI `bounded-json.js:33` | 2,089 | 5.6075 | 5.6179 | 3,150 | 8.4555 | 8.4671 |
| `_parse`, secure-json-parse `index.js:7` | 1,472 | 3.9513 | 3.9778 | 1,472 | 3.9513 | 3.9778 |
| `(idle)` | 10,447 | 28.0426 | 28.1014 | 10,447 | 28.0426 | 28.1014 |
| `(garbage collector)` | 439 | 1.1784 | 1.1841 | 439 | 1.1784 | 1.1841 |

The earlier independent nested-SDK-only `snapshot` cross-check remains 7,802 inclusive ticks (20.9427%); the verified two-copy union is 8,085. The largest individual secure-json `_parse` leaf context has 1,449 ticks (3.8895%); aggregating all its contexts gives 1,472. Neither difference is a conflicting observation.

`validateRollbackState` splits into two observed synchronous contexts:

| Context | Inclusive ticks | Tick interval seconds | Main immediate children, inclusive ticks |
| --- | ---: | ---: | --- |
| `storage.load` → `rollback.js:18` callback → `validateRollbackMetadata` → `validateRollbackState` | 10,348 | 105.033662 | SDK `validating` 6,632; SDK `validateProjectionApply` 2,758; backend `validateMetadata` 323 |
| `rollback.js:221` callback → `validateRollbackState` | 1,640 | 16.611487 | SDK `validating` 1,100; SDK `validateProjectionApply` 450; backend `validateMetadata` 19 |

Exact source correlation at the capture commit supports these paths. `storage.ts:73–79` fetches metadata and calls the supplied validator. The reversible adapter constructor supplies `validateRollbackMetadata` at `rollback.ts:54`. `rollback-contract.ts:150` calls `validateRollbackState`; its lines 178–189 validate retained undo descriptors, including `validateProjectionApply` for each descriptor. `rollback.ts:301` validates the next state before the durable metadata update. The byte-matching SDK `projection.js:86–137` copies bounded inert JSON, traverses properties, calls `TextEncoder.encode` for byte budgets and freezes the result through `validating`. This explains why copying and encoding occur beneath validation; sample counts do not establish invocation counts or per-call costs.

The ES transport module has 4,092 inclusive ticks (10.9841% raw); secure-json parsing is only one part of that stack work. Source recovery, source and ABI-proof modules have respectively 200, 910 and 792 inclusive ticks, with overlapping contexts. Async I/O and continuations can lose their initiating caller from a sampled synchronous stack. These numbers therefore do not prove or exclude an ancestry-I/O bottleneck, and aggregate Elasticsearch GET counters cannot be used as CPU attribution. The separate busy-chain ancestry-memory hypothesis in issue 248 remains unmeasured by this small prefix.

**Actual process CPU and resources.** These are observer counter deltas within each PID's monotonic clock. CPU includes native/helper-thread and observer work; it is measured separately from V8 ticks. The table's spans are first-to-last observed CPU samples, not each process's entire lifetime. RSS values below are sampled instantaneous memory; maxRSS is the separate Node/Linux process-lifetime high-water counter.

| Projection observation | CPU-on, PID 1993201 | CPU-off, PID 2010163 |
| --- | ---: | ---: |
| First release → all three physical checkpoints stable | 365.553 s | 364.505 s |
| Observer samples | 376 | 375 |
| First-to-last monotonic span | 376.529396 s | 375.212510 s |
| Actual user + system CPU | 319.981016 s | 307.510643 s |
| Average CPU, one core = 100% | 84.9817% | 81.9564% |
| Prefix-bracketed actual CPU | 309.416250 s | 297.214400 s |
| Prefix-bracketed monotonic span | 363.910103 s | 362.276805 s |
| First sample after release / last before stable | 1.616 s / 0.027 s | 1.522 s / 0.706 s |
| Sampled RSS minimum–maximum | 129.953–504.902 MiB | 119.125–514.461 MiB |
| `resourceUsage.maxRSS`, raw KiB | 558,492 | 553,872 |
| `resourceUsage.maxRSS`, MiB | 545.402344 | 540.890625 |

All 14 CPU-on PID measurements and all 14 CPU-off measurements are retained in the outputs and resource receipt. In the CPU-on run, the other largest observed process CPU deltas are indexer master 28.825068 s, deserializer PID 1993142 27.595391 s and pool worker 9.526756 s; the other workers use between about 2.8 and 6.1 CPU seconds. Their observation windows differ. Driver, database, broker, cache and host CPU are outside these profile families.

The one CPU-on run followed by one fresh CPU-off control is descriptive context. Existing observers, proxies and sampling have unquantified overhead. The phase times are not throughput benchmarks, and neither the wrapper durations nor the difference between these runs quantifies profiler overhead or an improvement. No runtime ranking follows.

**Analyzer repair and validation.** The immutable preparation helper remains unchanged at SHA-256 `8a49e7da93aaba71dd905ca9aa19655098b3ffc394dd90048c06ce7828d9a3f8`. It rejected valid zero-child shutdown receipts in leaf workers before writing any analysis result. Private `analyze.v2.mjs`, SHA-256 `0d629321e420212158142230b38e5d4cf409e1935a1885733ac2be9349f5165b`, permits that native collector shape only when exactly one successful leaf shutdown reports zero children/exits and empty child-exit, failed, forced and unresolved lists. Nested forks/exits still fail. The captured input bytes and all other gates are unchanged.

The revised suite passes 41 tests on Node 22.23.3 and 41 on Node 24.19.0, including five leaf-shutdown negative controls, missing-child controls in enabled and disabled mode, malformed graph/profile/time-delta cases and fresh-output bounds. Three further aggregation tests pass on each runtime, checking cross-copy recursion union, distinct unverified scripts, weighted conservation and broken paths. Actual 14-process results match the root agent's independent CPU and selected sample arithmetic. Earlier malformed public preparation attempts left only fresh private partial folders, preserved separately; the final recipe and successful outputs below are distinct.

Pre-freeze review also found that the first public extractor's separator check accepted Windows drive-relative `C:escape`. That source is preserved as `prepare-public-inputs.prior.py`. The repaired extractor requires a lowercase portable child name of at most 64 characters, rejects Windows device names, symlinks and existing targets, and checks the resolved parent equals its own folder before input reads or target creation. Five focused CLI tests pass with no skips: 17 invalid-name subcases, an actual dangling symlink, an existing directory, optimized Python, and a complete valid fresh extraction reproducing the same recipe hash. This correction changes only extractor source and tests; no v2 gate, capture, recipe or successful analysis bytes changed.

**Public reproduction and provenance.** The raw public archive is SHA-256 `1e272c1f9c9bd10db3be5bcd11c67b98dbcef1f0f5fec53ef328d56720cef6b3`, 24,543,244 bytes. Its external manifest is `22d25840359e6e271d759f23e4166240c3f49533f47d27e41a91f44e60e05ba9`. The recipe verifies both and selects 54 ordinary regular members; it does not extract all archive paths. Original exact profiles, observer logs and stage evidence are unchanged.

Public reports have different hashes and named omissions. The recipe retains them unchanged and makes separately hashed `report.analysis-input.json` derivations. It restores only `/runtime/executable` from all 14 agreeing public raw starts and validates its published canonical omission hash. It also restores `path,bytes,sha256` object insertion order for the unchanged emission entry values and array, verifying the original inventory digest. Source-emission pins independently match the 508 overlapping report inventory entries; three report-only paths are explicitly recorded. Other named omissions remain omitted. The analyzer itself has no special public-input exception. The complete equality receipt proves all process objects, every profile node/function/stack, observed CPU and physical phase data agree with the private analysis; only the evidence path changes.

Private CPU-on archive: `aac8bcb2a5f3f46bc33eec4359caabfa12b61cfed528b9d9c46b25f041f166dc` (33 selected files). Private CPU-off archive: `ce2337166d56a1e2a089a7d1760e11a7406ce1ebdc41c03c6ef84b0048889450` (19 selected files). Both were independently scanned and byte-compared with selected originals before fresh copying. The SDK dependency receipt is separate after-capture provenance: root/nested `projection.js` hashes agree at `8eb0e934f7762f3d4849eb58fe83fa01c828e9d22c10def4fa09975b034f0591`; the local root SDK code independently matches it. The local nested copy is absent. The committed lockfile pins SDK Git `ae1f670016d6f4a63b42eb08563ee9d544867915` despite package version `0.0.0-dev.1`. Secure-json code also matches the supplied SHA. ES client 8.19.1 and transport 8.10.1 are separately pinned.

The smallest next attribution experiment is to measure the existing metadata-validation path with valid retained-undo descriptor cardinalities such as 0, 32, 128 and 256, preserving all validation and durability checks. Keep metadata load/admission versus next-state validation separate, record calls and input bytes independently of CPU sampling, and verify unchanged accepted/rejected inputs. That would test the observed copying/validation mechanism before an optimization is chosen. Repeated independently pinned CPU-on/off runs and a populated-table workload would be needed for overhead and broader performance claims. This report does not authorize or select a production change.

`PUBLIC-USAGE.md` contains exact fresh-output commands. `public-attribution-summary.NEW.json` retains every aggregated function and module for every CPU-on process, both runs' process CPU and exact public source/emission pins. Its separately pinned derivation excludes private service inspection content; the original private outputs remain local and immutable. `public-equality-and-resources.NEW.json` retains cross-run resource distinctions and public/private equality. The bundle manifest pins all helper, recipe, test, report and output files.
