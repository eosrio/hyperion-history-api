# Portable projection operation and metadata measurements

This is the actual-worker measurement slice of [#252](https://github.com/eosrio/hyperion-history-api/issues/252).
It extends the [owned prefix fixture](portable-state-prefix-profiling.md) with optional operation/load counters,
synchronous loaded-metadata validation spans and a fixed-head observation. The
[audited native Linux pilots](evidence/projection-validation-20261022/README.md) retain a measurement-on/off
pair with CPU sampling disabled. Repeated instrumentation comparisons remain pending; one pair does not
estimate overhead or capacity. The separate [kernel harness](projection-validation-kernel.md) measures
validator calls without services.

Use the existing fixture preparation, ownership checks, exact source plan, disposable services and cleanup.
Run the actual Node 22 or 24 executable on Linux. Each output directory must be new:

```sh
node --experimental-transform-types scripts/qualification/portable-state-recovery.ts \
  /owned/services/worker-state.json /owned/source/plan.json /owned/new-output reversible \
  --profile-prefix 288 --cpu-profile off \
  --projection-measurements on --held-head-ms 10000
```

Both measurement and held-head controls are explicit. The initial comparison accepts exactly the existing
1–288 prefix and a ten-second wait. Ordinary recovery qualification retains its original source ranges,
faults, deadlines and acceptance requirements.

| Phase | Work and evidence |
| --- | --- |
| Startup | Attach to the owner's actual adapter before initialization. Discover the API's separate adapter during its first metadata load. Its already running first public operation is explicitly unobserved. |
| Prefix | Require attachment acknowledgments from the independently owned projection/API PIDs before releasing block 1. Keep the existing pacing, physical/API checks, paired revisions, source credits and broker acknowledgments through block 288. |
| Held head | Hold source release at 288 for ten seconds, without issuing HTTP queries. Preserve actual background polling; do not assume that metadata reads occur only during block application. |
| Verification | Check the same complete physical and HTTP state again, including finality, exact counts, undo 256/floor 32 and unchanged source inputs. |
| Shutdown | Seal new measurement roots, allow existing measured descendants to finish within a bounded wait, persist receipts, then use the existing clean shutdown and service cleanup. |

Phase acknowledgments attest attachment and transition, not quiescence. Spans retain both starting and ending
phases. Cross-phase work remains identifiable. A failed seal, incomplete measured spans, observer errors,
missing processes or exhausted measurement budgets fail measurement acceptance. Application results and
errors still follow their original path, and fixture cleanup runs after a measurement failure.

The first API 503 establishes only the API's unavailable response. The driver separately waits up to ten
seconds for the owned projection process's start receipt. A valid first prefix request then waits up to five
seconds for its actual adapter attachment before changing phase or acknowledging. Block 1 stays held until
both process acknowledgments arrive. Delayed startup is accepted within these bounds; a missing attachment
fails the measurement without releasing the source.

Earlier preloads already listen to IPC and can consume a prefix before the measurement listener registers.
The parent retries that initial request every 100 ms with the same request ID within its original ten-second
deadline. Exact duplicate requests advance the observer once. Receipts retain attempt count and retry interval;
later phases do not retry. Native IPC controls include an existing earlier listener and delayed registration.

The preload decorates real instances only in the owned fixture. Production source and emitted modules are
unchanged. It preserves receivers, argument objects, results, thrown errors and original promises. Added
settlement handlers and async context tracking have overhead and affect rejection bookkeeping; this is
measurement instrumentation, not a claim of universal JavaScript transparency.

Session restoration uses weak references and a hard ceiling of 50,000 slots. Original method descriptors
live in a WeakMap keyed by the session; the observer does not keep completed sessions alive. Suppressed
session-creation calls install no new hooks. The `sessionHooks` receipt reports the slot ceiling, allocated
weak-reference slots and limit failures; slot count is not a count of live sessions. Exceeding that budget
fails measurement acceptance. Native GC controls cover both suppressed calls and hooked sessions whose
original methods refer back to themselves; those service-free checks do not establish worker leak freedom.

| Observation | Interpretation |
| --- | --- |
| Adapter initialize/open/recovery/retained-checkpoint/admission/apply/rollback/query calls | Inclusive asynchronous spans and settlements by logical operation. |
| Actual metadata collection `findOne` calls | Native read attempts, including initialization reads that bypass `load`. These are not physical command-retry counts. |
| Storage `load` | Inclusive read/decode/validation span, attributed to the caller and transaction context. |
| Instance validation callback | Synchronous loaded-metadata validation. Direct lexical initialization/admission/candidate validation and individual SDK function entries are outside this wrapper. |
| Actual session transaction starts and commits | Successful starts count transaction-body attempts; commit-method attempts remain separate from internal wire retries. The original callbacks and options remain intact. |

Nested spans overlap. Do not add a load span to its synchronous validation span or interpret elapsed time as
CPU time. Counters, retained-descriptor visits, sampled CPU, process CPU, memory and service work have distinct
units. The kernel's precise V8 coverage is a separate count-only experiment and is not enabled in this worker
measurement mode.

For initial comparisons, collect at least five fresh runs per selected condition and alternate controls where
feasible. Keep source, emitted code, runtime executable, services, durability, host bounds and correctness
oracles identical. Retain failed attempts and the full distributions.

| Projection measurements | CPU sampling | Purpose |
| --- | --- | --- |
| off | off | Existing resource observer control, with the same held-head wait. |
| on | off | Operation/load attribution and measurement-overhead comparison. |
| off | on | CPU attribution with the resource observer. |
| on | on | Combined diagnostic; interpret overhead against the other conditions. |

Receipts live in `projection-observer/projection-PID.json`; the parent report pins their sizes and SHA-256
digests, actual module hashes, process identities and phase request IDs. Off mode must leave that directory
empty. Raw arguments and documents are not serialized by the observer. Preserve the existing source re-audit,
process/profile inventories, actual cleanup outcomes and protected-host postflight with each run.

The selected tables are empty in this prefix. These measurements do not qualify populated-row cost, busy-chain
capacity, full fork/restart/finality recovery, Wire consensus or release support. Keep
[#246](https://github.com/eosrio/hyperion-history-api/issues/246),
[#250](https://github.com/eosrio/hyperion-history-api/issues/250) and
[#191](https://github.com/eosrio/hyperion-history-api/issues/191) open for their remaining acceptance work.
Use the measured evidence before proposing a separate SDK or adapter optimization.
