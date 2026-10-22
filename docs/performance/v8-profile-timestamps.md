# V8 CPU profile timestamps and signed deltas

Research date: 2026-10-22. Scope: the Node 24.19.0 comparison capture in
[#252](https://github.com/eosrio/hyperion-history-api/issues/252), not a runtime
upgrade or a change to the qualification guard.

The inspected protocol does not promise that every `timeDeltas` entry is nonnegative.
V8's producer preserves processing order, while the inspected DevTools consumer can
sort reconstructed timestamps together with their samples. A negative delta alone
does not establish clock failure, hardware failure or a corrupt profile. It also
does not justify accepting arbitrary malformed data or silently rewriting timestamps.
The failed comparison attempt described below remains failed.

## Source pins and contract

The official Node `v24.19.0` tag resolves to commit
[`cdc1b38d40cb567b7ad0b39c86addf830a0af0ae`](https://github.com/nodejs/node/commit/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae).
Its [V8 version header](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/include/v8-version.h#L11-L14)
declares 13.6.233.17. References below use that vendored source, including Node's
patches, rather than assuming an unrelated V8 checkout matches the executable.
The DevTools reference is pinned separately at
[`f22c645573adc85e4553747c577eebb874c3fb43`](https://github.com/ChromeDevTools/devtools-frontend/commit/f22c645573adc85e4553747c577eebb874c3fb43);
this is a consumer implementation reference, not a claim that this frontend
processed the Hyperion capture.

The pinned [Profiler schema](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/include/js_protocol.pdl#L896-L909)
defines start/end timestamps in microseconds, sample node IDs, and optional integer
microsecond deltas between adjacent samples. The first delta is relative to the
profile start. It specifies no nonnegative minimum or monotonic sample-array rule.
The [V8 API](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/include/v8-profiler.h#L233-L261)
documents a common unspecified timestamp origin; these values are not documented
as Unix timestamps or process CPU time. Node's
[inspector documentation](https://nodejs.org/download/release/v24.19.0/docs/api/inspector.html#cpu-profiler)
shows receiving and saving the V8 profile; it adds no per-delta ordering guarantee.

## Producing and consuming order

The [inspector serializer](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/src/inspector/v8-profiler-agent-impl.cc#L109-L141)
walks recorded samples in index order, converts successive timestamp differences
to protocol integers, and advances the previous timestamp. It does not sort or
clamp those differences.

V8 has a VM sample queue and a sampling circular queue. The
[processing loop](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/src/profiler/cpu-profiler.cc#L255-L276)
prioritizes an eligible VM record, then examines the sampling queue, using
code-event order. It does not merge the queues by timestamp. VM/deoptimization
sample paths are visible in the
[same source](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/src/profiler/cpu-profiler.cc#L152-L184).
The [profile accumulator](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/src/profiler/profile-generator.cc#L621-L640)
appends eligible samples; its filter rejects null/before-start timestamps, not an
earlier timestamp than the previous appended sample.

The [sample timestamp](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/src/profiler/tick-sample.cc#L210-L212)
uses `TimeTicks::Now`. That clock is
[documented as nondecreasing](https://github.com/nodejs/node/blob/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/deps/v8/src/base/platform/time.h#L418-L435).
**Inference:** a nondecreasing clock does not make a later merge/processing order
chronological. These source paths explain why ordering cannot be inferred from
the clock contract alone; they do not identify the producing path or cause of
Hyperion's particular backward step. No clock, hardware or scheduling cause has
been established for that observation.

The pinned DevTools CPU-profile model
[accumulates signed deltas](https://github.com/ChromeDevTools/devtools-frontend/blob/f22c645573adc85e4553747c577eebb874c3fb43/front_end/models/cpu_profile/CPUProfileDataModel.ts#L138-L148),
then [sorts timestamp/sample pairs](https://github.com/ChromeDevTools/devtools-frontend/blob/f22c645573adc85e4553747c577eebb874c3fb43/front_end/models/cpu_profile/CPUProfileDataModel.ts#L258-L275).
Its [timestamp normalization](https://github.com/ChromeDevTools/devtools-frontend/blob/f22c645573adc85e4553747c577eebb874c3fb43/front_end/models/cpu_profile/CPUProfileDataModel.ts#L282-L312)
converts units and can append an estimated final interval; this inspected path
does not clamp raw deltas. Its tree also uses a
[hit-count/average-interval model](https://github.com/ChromeDevTools/devtools-frontend/blob/f22c645573adc85e4553747c577eebb874c3fb43/front_end/models/cpu_profile/CPUProfileDataModel.ts#L213-L223)
for [node self values](https://github.com/ChromeDevTools/devtools-frontend/blob/f22c645573adc85e4553747c577eebb874c3fb43/front_end/models/cpu_profile/CPUProfileDataModel.ts#L21-L41).
These are derived presentation conventions. Separately, the trace
[SamplesIntegrator](https://github.com/ChromeDevTools/devtools-frontend/blob/f22c645573adc85e4553747c577eebb874c3fb43/front_end/models/trace/helpers/SamplesIntegrator.ts#L447-L458)
clamps synthetic call durations to zero; that operation is not raw-delta repair.
Neither implementation is a blanket validity guarantee for every profile or client.

## Retained failed comparison

The campaign stopped at `h252-n24-mon-con-r1`. Its unchanged raw archive SHA-256 is
`1c0bedb73c3c18f4dd8b8e36216f8d2a62f071ae189e292a7f67a80559c8ea1f`.
There are 14 saved CPU profiles. Exactly one contains a negative delta:

- Member: `h252-n24-mon-con-r1/observer/master-0/worker-2098088.cpuprofile`.
- Profile SHA-256: `01e4bc6d485fbc462ac2f3274cd389a6d3833e742aecbc6aa99c297b8e025ccd`.
- 40,572 aligned samples/deltas; sample node references exist.
- Zero-based delta index 45 is **−4 µs**; indices 43..47 are `[21, 155, -4, 293, 12]`.
- Recording elapsed window: 409,102,260 µs; signed delta sum: 409,102,052 µs;
  end minus reconstructed last sample: 208 µs.
- Cumulative offsets, including the initial zero, range from 0 to 409,102,052 µs.
  The other 13 profiles have no negative delta.

These facts were rechecked by bounded, read-only archive inspection without
extraction or profile mutation. The raw case report remains `failed`; recorded
cleanup succeeds. Successful cleanup/postflight does not qualify the capture.
Keep its failed label, original profile bytes and timing records even if a later
guard policy changes. Fresh runs under a corrected policy are separate evidence;
this research does not retroactively promote the stopped attempt or complete the
interrupted comparison campaign.

## What each metric can establish

| Metric | Supported interpretation | Required separation |
| --- | --- | --- |
| Raw sample ID counts/fractions | Frequency of the recorded sampled stacks, with declared node/category classification. | Not function invocation counts or exact function CPU time. Preserve sample IDs, multiplicity and health diagnostics. |
| Reconstructed sample instants | Start plus cumulative **signed** deltas in the recorded order. | Record backward steps; missing deltas remain unavailable, not invented zeros. Do not sort deltas independently of samples. |
| End minus start | The recorded elapsed profiling window. | Delta sum ends at the last sample, not necessarily profile end. Do not force equality by inventing a terminal weight. |
| Time-weighted attribution | A derived result requiring an explicit ordering, tie, interval-assignment and boundary convention. | Pin the consumer/algorithm and retain original indices, source hash and every transformation. Do not call normalized weights raw observations. |
| Process CPU counters | Independently observed user/system CPU consumption for the stated process and interval. | Do not derive them from profile elapsed weights or combine their clock origins implicitly. |

[Node's CPU accounting contract](https://nodejs.org/download/release/v24.19.0/docs/api/process.html#processcpuusagepreviousvalue)
reports user/system microseconds and permits totals greater than elapsed time when
multiple cores work for the process. It is distinct from the sampled profile and
from elapsed observer spans.

For the retained profile, replacing −4 with zero would add 4 µs to the delta sum
and shift subsequent reconstructed instants. Dropping the sample would change raw
sample frequency. Neither is a neutral validation step. If a future analysis uses
sorting or a duration clamp, publish it only as a separately identified derivation
with raw hashes, method/version, pairing/index map, affected-sample counts and
boundary policy. No normalization is selected here, and the sources establish no
universal epsilon or allowed count of negative deltas. Structural checks and
qualification limits still need an explicit contract; absence of a per-delta
nonnegative guarantee is not permission to discard those checks.

## Reproducible source bytes

SHA-256 values below identify the primary files read for this research. Source
links above include immutable commits and the relevant line ranges.

| File | SHA-256 |
| --- | --- |
| Node vendored `include/js_protocol.pdl` | `9541b1454d1c352ef852dc0b6321569438271731068c803f980afb65def58982` |
| Node vendored `src/inspector/v8-profiler-agent-impl.cc` | `95c96243eec1180e3dab1d2dd44a05e9d30c93ca7ad8de460cfa05240b1862c1` |
| Node vendored `include/v8-profiler.h` | `5e4e427164d4c886edcd978100a9b43851cf754a28576a3884b9a853d43eecf6` |
| Node vendored `src/profiler/cpu-profiler.cc` | `39fc9d2d4da68b1066110dd5a6717d1b57cf6c749e830a02710c2e79eb906403` |
| Node vendored `src/profiler/profile-generator.cc` | `dded53c2404f78c87f769f21758fb23f373dca0b829a1da2c4b2a3297fd90336` |
| Node vendored `src/profiler/tick-sample.cc` | `797b1c404d60e19af21429583e446efd0f9b2e4ac65d83132e2e308411a86209` |
| Node vendored `src/base/platform/time.h` | `782b33c096706ed08a6f34a71f608aa88b42e942103159f6408dd4e48b247cda` |
| DevTools `CPUProfileDataModel.ts` | `710dfae00238647201fe3243c133641e3a0930dada500f46cc85e1527c14a82b` |
| DevTools `SamplesIntegrator.ts` | `b72c78ef1ae39e031e5d5ab0a8fbe3464e8b9552238f064dd6f54da019573d2c` |
