# Retained Wire fixture stage observations

This opt-in diagnostic addresses the unmeasured stage/resource boundary of
[HAPI #191](https://github.com/eosrio/hyperion-history-api/issues/191). Its exact parent
is 2bf8afdc073c12f750441008513abd5f4b3140d2. The original retained test file, 1480 blocks,
assertions and 180000 ms deadline remain byte-identical. Product/native sources,
compiled assemblies, dependency pins and frozen engineering profile data are unchanged.
No actual workload or host/service was run while preparing this source slice.

For a separately admitted Linux capture, Root runs the existing command with one
explicit diagnostic flag, retaining its original exit status and complete streams:

```sh
HYPERION_RETAINED_WIRE_STAGES=1 node --test tests/unit/wire-managed-state-v2-native.mjs
```

The existing `HYPERION_NATIVE_SOURCE_PROFILE` admission is still required. Record the
actual runtime executable/npm/assembly receipts, Git tree and archived input hashes
alongside stdout/stderr. The source fixture independently verifies the original
3,382,093-byte archive SHA256
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`
and 1488 member hashes. Its capture is Wire 1..1480, original chain
`9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d`
and protocol `wire-sysio-6508c9e8-native-engineering-v1`. Generated coordinator
generation/certificate bytes can differ because of randomUUID; compare retained
input identity and report generated-corpus differences rather than inventing a
byte-identical paired performance result. Node 24.22.1 and 26.13.0 are the observed
failing/passing runtime versions; 26.13 remains an engineering candidate, not runtime acceptance.

The existing Linux Node 24.x/26.x build matrix runs the eleven pure observer controls
alongside the existing source/profile/snapshot controls. Only the retained test
command receives the inline observation flag; the following ABI-history command
and other fixtures keep it unset. CI uses the unchanged admitted source/profile
graph and normal full Git checkout, which includes the observer and its existing
`portable-state-worker-proof-metrics.mjs` import. No admission predicate or snapshot
source closure is bypassed or weakened.

`retained-wire-stage-snapshot/v1` is one bounded JSON line per second plus initial
and final observations: at most 300 lines, 32768 UTF8 bytes each, 500000 span starts,
64 active spans, 256 live wrapped methods and 50000 total wrapper installations. Completed
session/cursor close restores those methods immediately, releasing references to
their objects. Stage names are fixed. Each stage retains
started/completed/failed/active counts, latest completed input block, and count,
total/minimum/maximum nanoseconds plus 64 log2 histogram buckets. The active list
retains stage/input block/monotonic elapsed time. `source.advance` labels its
requested end block; `source.frame` labels the actual decoded frame. Counters or
labels never grant source, checkpoint, test-pass or cleanup authority.
Per-record observations only update counters/histograms; they emit no rows.
The cap is 9,830,400 raw JSON payload bytes, excluding newlines, Node test-reporter
framing and ordinary test output. Collectors identify the JSON `kind` inside the
retained test log rather than assuming the whole stdout stream is bare JSONL.

The two existing fixture helpers observe setup, per-frame selection/ABI observation,
source admission/canonical publication, actual emitted source/controller/worker-frame
and native adapter calls, controlled native commands/transactions/session close,
plugin reduction and actual host cleanup. The native-command timings include the
existing fixture copying/lookup work; they are not physical MongoDB execution.
`fixture.before-source` begins when the observer module loads and ends at the first
source preparation, encompassing the test's earlier archive/preparation phase plus
module/test scheduling. It is not a precise Python subprocess timer. Host cleanup is
timed separately; the original outer test-file deletion and test verdict remain the
original harness's responsibility. A final observation with an active cleanup span
does not prove closure.

This table-selector fixture does not run DSPool action publication/admission or
physical services/IPC. Those omissions are explicit in every row. The existing
`scripts/qualification/portable-native-stage-timing.mjs` retains its separate actual
action admission/processTraces/handoff instrumentation for full-worker qualification.
It is unchanged; there is no relabeling of ABI publication as action publication.

Resource context is process cumulative and interval CPU microseconds, RSS/heap/
external memory, interval event-loop utilization, and actual interval drift.
These are not exclusive per-stage CPU, host quotas/cgroup pressure, V8 samples or
native stacks. Nested awaited wall spans overlap and must not be summed as CPU.
Periodic sampling cannot run during a synchronous event-loop stall; the subsequent
drift and resource delta expose the gap without attributing it. Snapshot construction,
extra audited promise reactions and stdout writes add overhead. Retain a separate
unprofiled original verdict and do not infer speedup or a causal hot module from a
single diagnostic run.

Watched calls return the exact original promise, including repeated calls sharing
one in-flight controller promise. Observation reactions discard their return values
and settle to undefined on fulfillment or rejection; a guarded handler observes any
diagnostic reaction rejection. Original resolved values/rejection objects, receiver,
arguments and native session identity are preserved. Counts describe watched method
invocations, which may share one underlying promise. Attaching observation does add
a rejection handler to the original promise: these audited fixture callers await it,
and this observer makes no generic ignored-promise/unhandled-event parity claim.
The separate existing generic unobservable policy in the full-worker action observer
is unchanged. The two added controls reproduce and prevent the prior promise
substitution without importing or executing the actual retained fixture.

The timer is unref'd. Explicit close or process `beforeExit` clears it and restores
original methods; the fixed snapshot cap also closes with a censored boundary.
Diagnostics cannot keep the worker alive. Pending spans are retained as pending,
never fabricated as completed. Resource/emission/restoration failures are diagnostic
failures and do not replace an original method result/error. Missing final rows,
omitted spans/wrappers, active final work, observation failures or truncated streams
are incomplete observation coverage, not a successful collection or workload waiver.
Root retains the original 300 s outer envelope and original test verdict independently.
`process-before-exit` is the observer's final lifecycle boundary, not proof of test
success or original stream closure. `snapshot-bound-censored` stops sampling and
restores methods at the row cap even if work remains. The inert controls model
1480 block updates plus late cleanup at 245 seconds using fewer than 300 snapshots;
that models observation coverage and does not extend the real 180000 ms workload.

Focused controls:

```sh
node --test tests/native/retained-wire-stage-observer.test.mjs
```

They use an inert clock/scheduler/lifecycle and modeled command objects, never import
the retained workload/host fixtures, and do not start or stop a service/process.
They establish observer bounds and identity/failure semantics only. Actual Linux
stage attribution, physical engine/full-worker replay and release qualification remain pending.
