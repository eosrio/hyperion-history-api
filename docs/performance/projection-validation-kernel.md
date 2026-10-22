# Projection validation kernel measurement

[Issue #252](https://github.com/eosrio/hyperion-history-api/issues/252) measures the
existing MongoDB adapter's logical and stored metadata validators before choosing
a change. This service-free harness calls the real emitted
`validateRollbackState` and `validateRollbackMetadata` functions and their actual
SDK dependency. It does not replace validation, cache results, or contact MongoDB,
Elasticsearch, RabbitMQ, a chain node or any worker.

## Run count capture and timing in separate native processes

Install and build with the committed npm lockfile and pinned TypeScript toolchain,
as described in [the development build guide](../development-build.md). Native
Node major 22 or 24 is required; Bun and other majors are rejected. Current Node
22/24 releases must provide `node:module.findPackageJSON`. The historical private
prototype used Node 22.23.3 and 24.19.0; those minor versions are not a runtime
selection rule for this harness.

Create an ordinary output directory first. Each command requires a fresh,
portable lowercase `.json` filename in an existing directory:

```sh
mkdir -p out/projection-validation
node scripts/qualification/projection-validation-kernel.mjs --mode count --out out/projection-validation/counts.json
node scripts/qualification/projection-validation-kernel.mjs --mode timing --out out/projection-validation/timing.json --warmup 1 --iterations 1 --order both
```

`count` rejects timing flags. `timing` defaults to two warmups and five measured
iterations per state, entry point and pass. Bounds are warmup 0–10, iterations
1–30, and order `forward`, `reverse` or `both`. `both` runs the six cardinalities
forward, then backward, always logical state before stored metadata. Warmups also
run separately for every state, entry and pass. The count capture has fixed
calibration and one/three-call windows; it has no timing options or timing result.

Each mode has a 120-second cooperative deadline checked between calls, a maximum
8 MiB report, and bounded input/GC inventories. A single synchronous validator
call cannot be interrupted by that deadline. Only the pinned engineering fixture
enters those calls. Existing output files, dangling output links, linked output
parents, Windows device aliases and drive-relative paths are rejected. Creation
is exclusive; failed validation produces no success report. A partially written
file from an I/O failure must be preserved as failed evidence and a new filename
used for the next run. Importing the module does no I/O or measurement work.

Run with no ambient coverage, CPU/heap profiler, inspector, trace or preload flags.
The CLI rejects `NODE_V8_COVERAGE` and recognized profiling/preload flags in
`execArgv`/`NODE_OPTIONS`; it does not claim to detect instrumentation outside the
process. Use a separate fresh native process for each observation, including
repeated controls. Forward and reverse passes share process and heap history and
are not independent repetitions.

## Original engineering fixture and validity

[`origin.json`](../../tests/fixtures/projection-validation/origin.json) retains
the SHA-256 and byte sizes of the original public archive, private source archive,
exact stage member, verified emission archive and selected metadata. The fixture
is compressed base64 of the exact minified metadata selected at
`/physical/0/metadata` from the original public stage, preserving JSON member order.
The runner verifies canonical base64, compressed bytes/hash, bounded
decompression, uncompressed bytes/hash and JSON before deriving any states.
The provenance receipt carries these original pins; each run does not reread the
external archives. The extraction recipe is in the
[fixture notes](../../tests/fixtures/projection-validation/README.md).

The original stage was captured at checkpoint 288 with 256 undo descriptors,
coverage floor 32, 256 replay receipts, and no target rows or before images. Its
source was the audited original Wire input prefix with synthetic head/LIB
controls. It was not a node-authenticated fork or a populated-table recovery run.

All six derived states keep checkpoint 288, the same definition, binding,
revision, positive `policy.maxBlocks = 256`, and **all 256 original replay
receipts**. They retain the last 0, 1, 32, 64, 128 or 256 undo descriptors. Their
coverage floor is exactly `288 - descriptors`. The floor receipt comes from the
original floor receipt for block 32 or the original replay receipt for that
block. At zero descriptors, floor and floor receipt advance to checkpoint 288;
the policy does not become zero. Every descriptor has its original receipt,
predecessor identity, zero image bytes and hash of the empty image array.

Before either measurement, both real entry points must accept all six states
without input mutation. Re-encoding the 256-descriptor state as stored metadata
must equal the exact original metadata. Thirteen controls must fail with
`projection.invalid-contract`: nonpositive policy, undo over a positive policy,
empty undo without floor advance, wrong floor receipt identity, a matching
receipt around a broken floor link, broken first predecessor, incomplete undo
suffix, missing receipts, unordered receipts, wrong final receipt identity,
zero-image byte mismatch, malformed image hash and stored revision mismatch.
These checks are validation evidence for this bounded fixture, not a claim that
all malformed inputs or recovery paths have been covered.

Each fixture receipt retains its minified UTF-8 JSON byte sizes and adds
`stateBson` and `metadataBson` receipts. These contain the actual `BSON.serialize`
byte length and SHA-256, `calculateObjectSize` agreement, the real backend's
default `bsonBytes` agreement, and checks that deserialization preserves the
input and reserialization preserves the bytes. The stored checkpoint's revision
field accounts for the difference between logical and stored BSON input sizes.
Both formats describe validator inputs; neither is a database command, network
frame, compressed payload, index footprint or independently varied before image.

The serializer is the actual backend's `mongodb.BSON` export. Resolution follows
the backend to MongoDB, then MongoDB to its BSON package, including a driver-nested
installation. Export identity is checked; a root or backend peer BSON package
cannot silently substitute for the driver's codec. `provenance.bson` records
availability, module and package file hashes/versions, resolution and options.
Serialization uses `checkKeys: false`, `serializeFunctions: false` and
`ignoreUndefined: true`; size calculation uses the latter two. Deserialization
explicitly promotes ordinary values/longs, leaves buffers and bigints unpromoted,
rejects trailing bytes, and enables UTF-8 validation. Remaining codec options use
the pinned installed defaults. A missing API, inconsistent size or failed
round-trip fails setup instead of inventing an unavailable size as zero.

This input-size bookkeeping runs in `loadKernel` before either coverage or timing
capture. It is not part of the measured validator invocation. Its allocations can
affect subsequent heap history, as can other setup and warmups; moving it outside
the spans does not establish zero observation overhead. Compare size/hash receipts
across modes only when the input, codec and options match. BSON bytes are not UTF-8
JSON bytes or a native encoding throughput/call metric.

## What the counters mean

Count mode uses V8 precise coverage with `callCount: true, detailed: false` after
loading and validating inputs. Known functions calibrate reset windows at
0/1/3/0 calls and recursion at five entries per call, once and three times. Each
real state/entry pair is then called once and three times. The output retains
selected raw function-only coverage, source offsets, actual V8 script SHA-256,
and named counters across adapter, contract, SDK and the JavaScript encoding
wrapper. Actual V8 source hashes must match the resolved emitted code. A separate
encoding calibration records whether that wrapper's named count is supported.

Missing or ambiguous named entries remain explicitly unavailable. A known
zero-call calibration window may omit its function; unknown absence is never
coerced to zero. SDK call counts are observations; historical count formulas are
not regression assertions that would forbid a future approved implementation.
The native `encodeUtf8String` counter is not inferred from a JavaScript wrapper,
and the harness reports no native call count, allocation count or per-invocation
native encoding byte count. Static BSON input lengths remain separate setup
receipts. Coverage changes optimization behavior. Counts are neither CPU nor
timing observations.

Timing mode opens no inspector session and requests no precise coverage. It
records each call's monotonic elapsed span, a surrounding `process.cpuUsage`
delta, and discrete before/after RSS samples. The CPU counter envelope includes
clock/counter overhead and any native/helper-thread work; it differs from the
elapsed span. Process-lifetime `resourceUsage.maxRSS` is reported separately in
KiB and is not the maximum of the sampled RSS values in bytes. Clock and CPU
counter resolution can yield zero deltas for short calls. The overall timing
envelope includes warmups, checks, counters and observer drain; it must not be
equated with a sum of kernel spans.

When supported, a bounded `PerformanceObserver` records GC intervals. Per-call
GC entries count interval overlap, clip elapsed GC intervals to the call span,
and use their union so overlapping entries do not count duration twice.
No observed event does not prove no GC, and GC duration is not subtracted from
elapsed time or called process CPU. Unsupported GC observation and unavailable
allocation/native encoding/event-loop delay/actual-worker frequency metrics are
stated directly.
Clock, counter, RSS and GC observation have costs. This harness does not quantify
that overhead, compare runtimes, select an optimization, or infer production
benefit from service-free results.

## Code and execution receipts

The report records exact native Node/V8 versions, executable SHA-256, platform,
architecture and arguments; harness and compact fixture hashes; current Git HEAD
when available; emitted validator and actual SDK bytes/hashes; source and lockfile
hashes; SDK package path/hash/export/version; and backend-resolved MongoDB/BSON
entry hashes. The SDK is resolved from the backend module, including a nested
installation, through its import-only export. Unsupported export shapes fail
instead of guessing. These module entry receipts are not a complete transitive
dependency inventory or proof of equality with a prior machine's install.

Original code pins remain distinct from observed code pins. `originCodeMatches`
reports equality against the captured baseline without requiring unchanged code
for every future experiment. The actual code/fixture files are checked again
after measurement. A matching origin SDK hash alone does not establish SDK Git
identity for arbitrary new installed bytes; the committed lockfile, package and
actual module receipts must be considered together.

The inexpensive pure guards and native subprocess checks can run under the
regular Bun unit suite. Set `HYPERION_NATIVE_NODE` to a native Node 22/24 executable
when Bun's `PATH` would select another major. Native subprocess checks skip when
no supported native executable is selected; they also run directly on each
supported runtime:

```sh
node --test tests/unit/projection-validation-kernel.test.ts
bun test tests/unit/projection-validation-kernel.test.ts
```

Keep actual-worker validation frequency, MongoDB operations, populated rows,
fork/rollback/restart/gap recovery, busy-chain memory and full release
qualification in their separately guarded experiments. Kernel counts and spans
cannot establish their frequency or cost.
