# Independent native kernel evidence audit — HAPI #252

Result: verified, with no evidence consistency finding. This read-only audit covers the four frozen native reports from source `d95d797fc3de8c695e2817a2952eedebeb4b3241`. It makes no timing ranking, optimization, actual-worker frequency or release claim. No H1/service access or source modification occurred; all new files are in this fresh C: audit directory.

The four raw hashes match their logs and the coordinator's separately captured hashes:

| Report | SHA-256 |
| --- | --- |
| Node22 count | `d513341457a858ca4025a5e0cefaab330a6f7190d54e1627d90516525dbe185a` |
| Node22 timing | `4308b3f23ca731ebf5e5f60b76b6f3928ac4a68f1d56bded0106b48675978fa7` |
| Node24 count | `462d0688c3924dc0e8c1d0c2b9dab51e90bd18b5e939282fa5e43ace9de8bd87` |
| Node24 timing | `4fea13b786db6f7ab5f4d364a425eef5cc1e69f95ec0b323539533f9b5668ba6` |

Native Linux x64 Node 22.23.3 and 24.19.0 executable paths/hashes agree across preparation, actual invocations and reports. All four exits are zero; the commands retain CPU 600%, memory 2 GiB, tasks 128 and external timeout 130 seconds. Reports retain empty `execArgv` and no `NODE_OPTIONS`. The exact committed harness/fixture/origin bytes match their report hashes. Original private/public archives and auxiliary emission were independently rehashed; the selected original metadata and all three measured module bytes match their origin pins. Backend-nested SDK resolution is explicit. BSON receipts identify backend-resolved MongoDB 7.2.0 → BSON 7.3.3 with export-identity checks and explicit options.

All four provenance objects agree. The six suffix fixtures retain checkpoint 288, fixed 256 replay receipts and the real positive retention policy. Independent reconstruction matches all 12 logical/stored JSON documents and their BSON bytes/hashes, lengths and round trips. The audit uses its own BSON encoder/decoder for this ordinary JSON subset. All 13 independently reconstructed negative-input hashes match the recorded `projection.invalid-contract` rejections, including stored revision fencing. Validators were not reexecuted by this audit. Dependency-library identities are captured receipts and committed harness assertions; the original auxiliary does not include those complete libraries.

Each count report has 33 windows: nine calibrated control windows and 24 valid-input windows. Known-call controls are 0/1/3/0; recursive controls produce 5/15 entries; JS encoder controls are 0/1/3. Every selected metric matches its exact named raw coverage entry, source identity and range. Across runtimes, all 429 metric availability/count pairs agree: 254 available, 175 missing per report. Every available valid-input metric scales exactly 1:3 across the one/three-call windows.

Observed entries per logical **or** stored call for these six inputs:

| Undo descriptors | Definition | Apply | Validating | Snapshot / freeze / canonical, each | String | JS encode wrapper |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 2 | unavailable | 5 | 89 | 159 | 299 |
| 1 | 3 | 1 | 7 | 128 | 229 | 431 |
| 32 | 34 | 32 | 69 | 1,337 | 2,399 | 4,523 |
| 64 | 66 | 64 | 133 | 2,585 | 4,639 | 8,747 |
| 128 | 130 | 128 | 261 | 5,081 | 9,119 | 17,195 |
| 256 | 258 | 256 | 517 | 10,073 | 18,079 | 34,091 |

Both entry paths observe one `validateRollbackState` and one backend `validateMetadata` entry per call. Only stored calls observe the `validateRollbackMetadata` wrapper; its logical-call entry is unavailable. `COUNTS.json` preserves all 13 metrics, raw one/three-call counts, missing states and exact selector names. Missing entries remain unavailable/null, including Apply at zero descriptors. Zero named native `encodeUtf8String` entries is **not** a native zero-call measurement; native encoding calls/bytes remain unavailable. Function entries, including recursive entries, are not CPU weights or disjoint costs.

Each timing report contains exactly 24 ordered rows: six sizes × two entry paths × forward/reverse, one warmup and one measured iteration per size, entry and pass. Clock arithmetic, process CPU sums, RSS observations and independently recomputed clipped/unioned GC overlaps are consistent; precise coverage is disabled in timing mode. This is plumbing evidence only. These directions are not independent repetitions, and no runtime ranking, speedup or quantified profiler overhead follows from them.

`audit.py`, `audit-results.json` and `COUNTS.json` retain the exact checks and source hashes. The fixed empty-row kernel does not establish a production bottleneck, worker call frequency, full recovery, consensus or busy-chain qualification. The separate actual-worker pilot is outside this audit.
