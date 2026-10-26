# Native Wire workers: certificate fix and failed qualification

Executed candidate: `07d6a906a7acc40a5b50c6c2430e85257cbc88c5`, tree
`f4a74eb616cf2ddb0b2a1a57613a5ce6cfeb4c68`. This evidence does **not**
qualify the full worker path. [#270](https://github.com/eosrio/hyperion-history-api/issues/270)
and [#274](https://github.com/eosrio/hyperion-history-api/issues/274) remain open.
The independently confirmed remaining defect is tracked in
[#277](https://github.com/eosrio/hyperion-history-api/issues/277).

The ordinary committed Wire `7167659e9c043cb3351074fcacb40200cc57f3a3` and SDK
`339b5c93d1338968c18ed14254961439dcab16a0` packages were installed with preparation
scripts enabled. The unchanged original 1–1480 engineering capture has SHA256
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`.
The selected profile is `wire-sysio-6508c9e8-native-engineering-v1`.

## Results

| Check | Result |
|---|---|
| Bun 1.4.4 / embedded TypeScript 7.0.2 whole-project checks and native Node emission | Passed; 248 application files and 22 qualifier files. |
| Complete unit suite at the executed candidate | 1,093 tests, 8,507 assertions, zero failures; Bun 1.4.4 with explicit native Node 24 child selection. |
| Fresh native Linux Node 24.19.0 worker replay | Failed after 695.632 seconds at the block-1244 Rabbit queue-drain barrier. |
| Original held prefixes 1/33/122/256/397 | Passed, including native schema-v2 values, lossless strings, exact original-byte re-encoding, native PREPARE-before-source-ACK evidence and original notification seals. |
| Original genesis without traces | Kept explicitly incomplete for native/action membership; unrelated state/raw history progressed. No empty trace vector was invented. |
| Constructed row controls at 397 | Passed and restored; explicitly separate from captured traffic. |
| Healthy state recovery and public API at 1244 | Reached; invalid mapping remained isolated at checkpoint 1243 with source 1244 pending. |
| Independent physical Mongo audits at 1244/1480 | Not reached. |
| Final 1480 checks and full Linux Node 22 worker replay | Pending; not qualified. |
| Owned process/service/instance cleanup and incumbent preservation | Passed. |

The prior `case24-c` failed when an original native action could observe a newly
published canonical head before its immutable certificate was readable. The
native worker now uses a bounded canonical wait and consumes that exact issued
proof. Immediate public opens retain their existing behavior. Deterministic tests
exercise the held-certificate race, cancellation, timeout, corrupt/incomplete
evidence, read-only behavior and fork revocation. Fresh `case24-d` passed the
previous block-397 native/notification hold after that fix.

`case24-d` then exposed a separate real backlog. Its original DS error log has
223 `protocol_action_incomplete` errors stating
`Requested ABI source is outside verified ancestry`: 159 genuine native
`sysio::onblock` actions, every block 829–987, and 64 contract actions. Independent
offline decoding of those original native frames succeeds and reproduces the
original bytes; this is a host proof-coverage failure rather than a codec defect.

The maximum source/DS distance sampled at DS ACKs is 259 blocks. Sweeping both
source-ACK and DS-ACK streams gives a peak distance of 260. At shutdown, source
was at 1244 and the DS worker had reached 1012, with 299 messages left in its
queue and all other queues empty. Later successful processing does not repair
earlier incomplete fragments. Preserve the default 256-block ancestry and the
drain assertion; a larger window or longer timeout cannot make this run pass.

## Profiling scope

The existing child profiler records 293.090 seconds in canonical/native trace
waits within 439.359 seconds of completed trace processing, across 1,278 DS
traces. These nested elapsed spans are not additive or exclusive CPU samples.
Sampled CPU totals 180.977 seconds over 654.538 seconds. Actual per-open GET
counts/bytes, hashing CPU and network-wait attribution remain unmeasured.

Source inspection suggests repeated immutable ancestry walks: at stable lag 232,
two successful walks require at least 932 serial commit GETs per trace. That is
a source-derived lower bound, not a measured request count. Measure each open,
traversal depth, storage wait and validation CPU before selecting an optimization.
The original native boundary observer synchronously writes and fsyncs its records;
these timings include qualification instrumentation overhead.

The run used an owned unprivileged LXD instance on Hyperion-3, bounded to six CPUs,
12 GiB memory and a 45 GiB root disk. It is not an uncontained bare-metal throughput
benchmark. Workers used native Node 24, Elasticsearch 9.5.5 and MongoDB 8.0.34.
Bun 1.4.4 ran source checks/tests; this does not qualify Bun as the production runtime.

## Evidence and cleanup

Run `python verify.py` in this directory. `SHA256SUMS` authenticates the summary,
manifest and archive. The manifest names every public payload with its byte count,
SHA256, original archive member and any declared transformation.

The public archive includes unchanged bulk requests/responses, native and worker
observations, resource/profiling records, held-prefix results, original error logs
and source-check logs from `case24-c`/`case24-d`. Reports are declared projections
that omit configuration/service inspection dumps. The postflight projection omits
host addresses and the unrelated listener inventory. These are not described as
the complete private originals. All ordinary members of all four failed private
runs were transferred and hash-verified before the fixture was removed. The
original convenience error-log symlink is declared omitted; its ordinary target
logfile is retained.

All 12 supervised workers and the master/API exited cleanly. Owned Mongo and
core containers, volumes and networks were removed; the exact owned LXD UUID and
nine byte-verified temporary exports were then removed. Incumbent Wire,
Elasticsearch and nodeos PID/start/executable identities stayed unchanged. Wire's
binary hash and three listener owners stayed unchanged, while its head advanced
from 486956 to 500768. The existing `tibs` instance remained running, with its
configuration unchanged across cleanup; its initial UUID was not captured.

This is a guarded live-path replay with explicit existing engineering admission
activation, streaming disabled and no production configuration change. Default
admission remains disabled. It does not close #191/#256, establish full fork,
restart or finality recovery, qualify retained-history upgrades, stream-client
#231, AtomicAssets/AtomicMarket parity, Rust deployment or Wire release readiness.
