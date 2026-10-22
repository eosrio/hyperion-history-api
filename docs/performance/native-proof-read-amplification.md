# Native Wire proof-read amplification

The unchanged original block-33 action loses fresh proof coverage when canonical
head reaches 290, on native Linux Node 22 and 24 with actual Elasticsearch 9.5.5.
At a stable 232-block lag, the two production proof opens make **2,858 client GET
operations** and return **11,631,525 bytes of serialized response objects** per
repetition. This is measured read amplification; the valid-input expiry in
[#277](https://github.com/eosrio/hyperion-history-api/issues/277) remains unfixed.

The broker is controlled, and no physical action sink or MongoDB is qualified by
this component run. Full #270/#191/#256 worker, fork/recovery and release gates
remain open. The adjacent live-reader backpressure defect is tracked separately
in [#279](https://github.com/eosrio/hyperion-history-api/issues/279).

## Exact experiment

Executed diagnostic code: `fedc4bd4de8c23c83468df3c3ff034b6227ebc26`.
The Linux checkout retained application base
`c914dd8ca6d27f235c2c343d0c5ad1f45916998c` plus the exact diagnostic-only patch
`6ea9e90379970542253081e69b98f4e25f0c21169804008d4419f3dea11b5952`;
canonical diagnostic file hashes match that commit. Production/dependency code is
unchanged. The build manifest contains 248 emitted JavaScript files.

Inputs are original frames 1–290 from archive
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`,
with normal installed profile `wire-sysio-6508c9e8-native-engineering-v1`.
Wire `7167659e9c043cb3351074fcacb40200cc57f3a3` and SDK
`339b5c93d1338968c18ed14254961439dcab16a0` remain the normal committed dependency
pins; no native provider or observation was replaced to obtain a result.

Both runs used native Node executables (24.19.0 and 22.23.3), the locked
Elasticsearch client 8.19.1 / transport 8.10.1 / undici 8.3.0, and the pinned ES
9.5.5 image. TypeScript 7.0.2 and Bun 1.4.4 are the separate authoring/test
toolchain; these runs do not qualify Bun as the production runtime.

The Hyperion-3 fixture was an unprivileged LXD instance with six selected logical
CPUs and a 12 GiB memory limit. Its disposable ES cluster had two data nodes and
a master witness. Exact image digests, resource limits, cluster/index identities,
runtimes, installed packages and source/build receipts are in the archive. Host
load was not controlled; this is not a bare-metal throughput or runtime comparison.

Original source preparation is separate from the measured read windows: 110.6 s
in the Node 24 case and 114.1 s in Node 22, within total process durations of
135.1 s and 141.1 s. Each process measured five repetitions at each stable head
34/65/265/289, always querying the same genuine block-33 action.

## Measured amplification

The following counts are for one ABI open plus one native open. All five
repetitions agree on each runtime. GETs include mapping and settings validation;
they are not only document GETs.

| Head/source distance | Document GETs | Mapping/settings GETs | Total client GETs | Response-object JSON bytes |
|---|---:|---:|---:|---:|
| 1 | 34 | 52 | 86 | 517,193 |
| 32 | 158 | 300 | 458 | 2,003,009 |
| 232 | 958 | 1,900 | 2,858 | 11,631,525 |
| 256 | 1,054 | 2,092 | 3,146 | 12,777,989 |

At distance 232 the ABI open has 470 document and 940 metadata GETs; the native
open has 488 document and 960 metadata GETs. Of their 958 document reads, 932
retrieve canonical commit manifests/chunks; the native walk rereads 466 exact
documents already read by the ABI walk. The earlier 932-GET source statement was
a lower bound for canonical documents, not a total HTTP/request budget.

Native authorization and value decoding each make another six client GETs in
this baseline. Their work remains separately measured. Mapping/settings responses
account for 9,425,004 of the 11,631,525 response-object bytes at distance 232.

| Native Node | ABI open median wall | Native open median wall | ABI median process CPU | Native median process CPU |
|---|---:|---:|---:|---:|
| 24.19.0 | 873.0 ms | 949.6 ms | 332.4 ms | 354.7 ms |
| 22.23.3 | 912.1 ms | 1016.3 ms | 366.5 ms | 473.2 ms |

These are five instrumented samples per cell in one process per runtime. They
do not establish a speed difference between Node releases. Counts and UTF-8 JSON
object byte sizes exclude HTTP framing, compression and actual network bytes.
Client wall includes storage/client/validation work and instrumentation; its CPU
measurements are process totals, not exclusive per-function attribution.

## CPU and correctness boundaries

Eight 1 ms inspector profiles cover only the stable-head read/authorize/decode
windows. They retain idle, garbage-collector and inspector samples. At head 265
on Node 24, the 9.47 s profile includes 6.59 s of idle self samples and 0.33 s in
the transport's secure JSON parser. That does not isolate network delay, server
queueing, hash CPU or production capacity. The probe's own serialization appears
in the profile and is timed separately; the independent service sampler also has
observer cost. No profiler-off paired capacity experiment is claimed.

Both actual-ES processes passed the declared diagnostic checks while reproducing
the defect: at head 290 the delayed native action publishes zero outputs, retains
durable scoped incompleteness, is ACKed once and has no completion seal. Its exact
original bytes still decode. Genuine missing genesis traces remain incomplete;
no empty trace vector or seal is invented. The positive original block-122 control
checks expected native value, membership seal and confirmed-before-ACK ordering
through the controlled publisher. That seal is not a physical sink receipt.

The pre-cancel check performs no GETs. In-flight cancellation holds a real ES
read after its response, so it is not an HTTP cancellation test. The size control
changes a response copy after a real read, not server data. Recovery rewinds and
replays an original selection through the actual coordinator, not a captured
network fork. These distinctions remain explicit in raw output.

## Evidence, cleanup and next work

[Evidence](evidence/native-proof-reads-20261022/README.md) includes the complete
37-member raw archive, machine-readable summary, eight profiles and standalone
verifier. The archive SHA256 is
`5b929c0c6e80f626290d4723905e0afb0ea06b03e9493a653d9af53f7ae66909`.
Two excluded launch attempts stopped before measurement; their original failure
logs are retained. The archive has no redacted or reserialized payloads.

After full export/hash verification, all four owned service containers, four
volumes, network, LXD instance and five host transfer/intent files were removed.
Independent postflight preserves incumbent process IDs/start/executables and the
existing `tibs` instance UUID/configuration. Wire head advanced from 504062 to
509996 and LIB from 504060 to 509994. The published cleanup record is a declared
projection of private inventories, with their original hashes retained.

[Reproduction instructions](../diagnostics/native-worker-proof-credit.md#reproducible-proof-read-measurement)
pin the historical source and describe both controlled and actual-ES modes,
native runtime selection, output semantics, profile bounds and owned cleanup.
Independent Standards review found no documented-standard breach and one
nonblocking duplicated-fixture heuristic. Spec review's missing reproduction
instructions were corrected without changing executable code.

Next, establish strict bounded protection or qualified recovery for unresolved
original inputs in #277. The live-reader correction in #279 and a faster proof
read alone do not establish that safety property. A later performance experiment
may reduce duplicate work within one issued-proof request while preserving fresh
authority/fork, cancellation, completeness and size checks. No optimization,
larger ancestry window, longer timeout or weakened full-worker drain was selected
by this experiment. Re-run the unchanged 1–1480 source and physical MongoDB gates
on native Linux Node 22/24 before calling the full worker qualified.
