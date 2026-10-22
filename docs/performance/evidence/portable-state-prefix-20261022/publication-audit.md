# Independent publication audit: prefix pair and six-case evidence

Result: no blocking publication finding in these exact audited artifacts. This private audit does not publish evidence or authorize native/release acceptance; root remains the final publisher. The auditor did not author the evidence packager. The auditor previously worked on the qualification harness; these evidence checks use independent Python readers and assertions rather than calling the harness acceptance functions.

Audited at: 2026-10-22T00:58:59.836780+00:00

## Frozen artifacts

- Six-case preview: `out/portable-state-recovery/evidence-prefix-six-20261022`.
- Public raw archive SHA-256: `1e272c1f9c9bd10db3be5bcd11c67b98dbcef1f0f5fec53ef328d56720cef6b3`; 24,543,244 compressed bytes.
- Manifest SHA-256: `22d25840359e6e271d759f23e4166240c3f49533f47d27e41a91f44e60e05ba9`.
- Summary SHA-256: `d9600e186c48f2e776eb592fd435a70e8dab40ffc5ae0fd6ec94d379c4421de1`.
- Recipe `evidence-prefix-cases-20261022.json` SHA-256: `d94d76e0df1b8ac91dd8d93f8f230b12e0d0f2aaeecb16141293182209ecedcc`.
- Packager SHA-256: `652214d717281526ed3ee58eb56ee0ca44d1c2b52be7c037ed68d0b459f6ca4d`.
- Separate auxiliary emission archive SHA-256: `25aad00b3766db8918259a6907b99ab26d765b96e4c4d6fec2e958605e29a093`; 890,259 compressed bytes.

All 15,893 public regular members and 160,614,041 uncompressed bytes match the manifest; all external checksums match. All six original source archive hashes and archive receipts match the recipe. All 16,055 original source-member inventory entries were independently checked, including their header hashes, file sizes and file hashes where applicable: 15,863 copied, 23 derived and 169 explicitly omitted. Every copied regular member was checked byte-for-byte against its original source archive. Five original log symlinks match regular link-metadata files, with safe relative targets and `followed=false`; archives were never extracted.

All report, invocation and runtime derivations equal their originals after only the declared omissions or basename substitutions. All 102 requested omission/transformation receipts match presence and, when present, canonical original-value size/hash. Generated public archive receipts retain the explicitly allowed original receipt fields and enumerate omitted fields. Named config/connections, inspection, environment/preparation and service-state omissions remain visible through exact original source hashes and reasons; omitted bytes are not represented as published.

## Continuity and outcomes

The four prior case summary objects, all four prior source inventories, and 9,120 prior public member manifest rows are identical to the independently audited four-failure preview; only the combined summary changes to include the new cases. The prior audit report remains unchanged at SHA-256 `a75d12931a63c1147eed0919384a77bcb1ddccab0906299ead306f48a9b7622a`.

The pilot remains `failed-before-worker-start`/driver `failed` with its explicit master cleanup error. The next two attempts remain failed at released block 32. The fourth remains failed on the 900-second catch-up budget, released through 672 with the last retained physical assertion at 651. No earlier failure is relabeled as a pass or profiling success.

| New diagnostic | Original archive SHA-256 | Owned fixture run | Observer logs | CPU profiles | Result |
| --- | --- | --- | --- | --- | --- |
| CPU on | `aac8bcb2a5f3f46bc33eec4359caabfa12b61cfed528b9d9c46b25f041f166dc` | `74942bd48477` | 14 | 14 | `profiled-prefix` |
| CPU off | `ce2337166d56a1e2a089a7d1760e11a7406ce1ebdc41c03c6ef84b0048889450` | `60e852bd9b85` | 14 | 0 | `profiled-prefix` |

Both actual invocations have exit code 0 and empty sampling errors. Invocation, report and source/emission receipts agree on HEAD `03dd3e9758473bc563bf8d7cbbbc0557232f17dc`, reversible finality and native Node 24.19.0. The runtime receipt agrees on binary SHA-256 `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`. The commands explicitly include `--experimental-transform-types --profile-prefix 288 --cpu-profile on|off` and retain their bounded CPU/memory/tasks/deadline settings. No Node22 run is inferred from these Node24 cases.

Both have `profileOnly=true`, `diagnosticSuccess=true`, `fullRecoveryPassed=false`, no primary/asynchronous errors, no crash records, one stable prefix stage and nine successful driver cleanup records. Mongo cleanup, original core/Redis cleanup receipts, fixture run identities and zero remaining owned core containers/volumes/networks agree. Each master has exactly 12 clean child exits and the API shuts down cleanly; no forced, failed or unresolved child remains. The 64 MiB pressure budget and actual pre-start node disk settings/headroom are present for all three owned Elasticsearch nodes under the opt-in 8/4/2 GiB fixture profile. These are disposable fixture settings, not production recommendations.

## Independent prefix and process checks

Both stable stages serve block 288 ID `0000012031c10959618b967b737582f1c1d93bcaaf5cff5c4b47c68c6723d1e7`. For all three projection instances, the physical Mongo binding/checkpoint/revision exactly matches the paired HTTP 200 body. The state headers identify that checkpoint, `reversible`, `last-valid=false` and `cache-control: no-store`. Rows are independently expected to be empty, and exact counts are zero. The retained original raw-row receipt has no selected-table row event through 288; the actual `sysio.msgch` ABI deployment is block 222. All three physical projections are initialized, without pending/gap/rollback state, and retain exactly 256 empty undo entries for blocks 33..288, linked to the original frame identities and floor block 32.

Each source session has zero outstanding credits. Across sessions, the sent and acknowledged block sequence is exactly 1..288 without skips or duplicates. The actual request starts at 1 with empty positions, fetches block/traces/deltas and allows eight messages in flight; ACK requests total 288. The live Rabbit queue records 288 deliveries and 288 acknowledgments with zero ready/unacked/redelivered residue; all retained broker queues are drained. The canonical source control is following through 288. All 1,484 original input hashes, including frames 1..1480, and both oracle hashes match a fresh read of the retained original local inputs. End-of-run input re-audit hashes equal the initial input inventory. This verifies evidence consistency; no live Wire node or consensus/fork behavior is inferred.

Raw observer logs, rather than report aggregates alone, match the owned parent PID, parent fork records, child exit records and shutdown child-exit set exactly. Both master/API directories have precisely the expected ordinary files: master plus 12 children and the API, without missing, duplicated or foreign PID logs. Every PID has one start, successful zero-drop flush after the stable boundary, clean shutdown and exit code 0. Completion metadata agrees with these raw records. CPU on has exactly one bounded valid V8 profile per observed PID: receipt hash/size, profile start/save/flush state, sample/node/time-delta structure and duration all match, at 10,000 microseconds with a 900-second/32 MiB bound. CPU off has disabled profile state, no profile-start/save events and zero profile files.

## Separate auxiliary emission archive

The auxiliary contains exactly the 602 pre-run pinned emitted-code, collector, lockfile and package-metadata members (4,171,166 bytes), plus the original pin receipt, all ordinary files. Every member path/size/hash matches the identical pre-run receipts retained in both cases. Its receipt accurately says it was captured after both runs and verified against those pre-run pins. Both complete 511-file in-run profiling inventories also match each other; their 508 overlapping members match the auxiliary. The remaining `tsconfig.json`, adapter `tsconfig.json` and `.bun-version` remain hash-only in this auxiliary scope. The original six-case bundle correctly says actual code bytes are not bundled there; the separate auxiliary provides these scoped bytes without changing that original artifact.

This is not a complete dependency or runtime bundle. Runtime binaries, the complete dependency tree and original input corpus bytes are excluded; retaining hashes and rechecking local inputs is not a claim that all such bytes are present in either publication archive. A Rust component artifact pin is not proof that the Rust codec executed.

## Content exposure and limits

All 160,614,041 public UTF-8 bytes, the external metadata sidecars and all auxiliary code bytes were checked. No live credential or incumbent connection/configuration dump was found. The public raw data has no credential-pattern or user/password URI candidate; its 1,923 authorization arrays are public action payloads. The auxiliary's nine credential-assignment-like matches are source references to configuration/options or a prompt label; its three user/password URI matches are unexpanded interpolation code. These exact locations/hashes and classifications are retained privately without reproducing credential-like values. No user-home path candidate remains. CPU call-frame URLs are owned temporary fixture file URLs, Node builtins, empty frames or WebAssembly module identifiers. Other retained addresses are loopback/unspecified fixture listeners, owned Docker addresses or reviewed public software URLs; runtime/library version strings are classified separately.

Pattern scans and selected exact-content review are supporting evidence, not proof against every possible secret encoding. Raw logs and profiles intentionally preserve temporary fixture paths, owned identifiers/container addresses and public software banners; named derivations do not claim complete anonymization.

The prefix covers empty selected tables after default undo retention fills. It does not execute insert/update/delete, a fork, crash/restart, gap recovery or the complete scenario, and supplies no full recovery, authentic Wire, Rust/rs_abieos, legacy-route or release qualification. A matching CPU-off control is retained, but profiler overhead, repeated-run variance and bottleneck attribution require analysis; this audit includes no attribution report or optimization recommendation. Later profiles, derived interpretations or changed publication artifacts need separate review.

Private supporting scripts/results and their hashes are recorded alongside this report. No repository, original evidence, service or publication changes were made.
