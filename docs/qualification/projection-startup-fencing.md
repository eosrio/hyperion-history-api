# Projection startup fencing diagnostics

This is the bounded diagnosis slice of [#332](https://github.com/eosrio/hyperion-history-api/issues/332),
following the failed #329 / #330 Linux capture. It adds qualification observations and native
characterization controls. It does not change production retry, frame-failure, relaunch, query
readiness or shutdown behavior.

## Reproduced distinction

The native fixture uses the emitted `ProjectionWorker.run`, `PortableStateController`,
`DeclarativeProjectionRuntime`, `PortableProjectionSource`, `WorkerAttemptClient` and supervisor.
An actual second cluster child uses the original reader coordinator RPC. Its request runs the
original master's source-open handler and its `fenceActive` call. Worker construction,
MongoDB/Elasticsearch operations and canonical coordinator results are controlled; this is not a
complete master startup, live SHiP run or database durability test.

The original experiment required every source fence to recover in the same physical worker.
On Node 24.19.0 it failed in about two seconds: the initialization had a returned, quiescent end,
while a distinct first `projection-frame` root threw `ProofConsumerFencedError` from the real
controller catch path. A real source mapping read remained retained until its callback settled.
The frame then drained and received its own authentic end before worker exit 1. Parent epoch and
incarnation were unchanged. This reproduces the archived stack shape without exhausting four
initialization attempts or reusing an initialization scope.

Moving the fence to the original Mongo connection or the real adapter initialization callback
permits one new accepted initialization after drainage. A retained setup operation blocks its end
and retry until it settles. A bound late callback from the old scope cannot issue effects. Ordinary
initialization errors and constructed fence errors remain fatal despite a simultaneous genuine
source fence. The existing initialization suite retains the maximum of four attempts and its
stop, retirement, lost/stale end, foreign error and owner-transition controls.

The frame result is the current fail-closed/relaunch path, outside the initialization-only retry.
The native test explicitly expects exit 1 for that path; it does not reinterpret a failed full
service run as passing. The historical projection PID 19531 lacks this diagnostic evidence, so a
matching stack is not proof that its exact cause was this source transition. A new owned service
capture must identify that cause before #332 can close. #331's broker-exit provenance is separate.

## Run the controls

Install from the npm lockfile, run the complete project check and emit normal Node artifacts:

```sh
npm ci --allow-git=all
npm run typecheck
npm run build
node tests/unit/projection-controller-startup.mjs frame-read
node tests/unit/projection-controller-startup.mjs initialize-retained
bun test tests/unit/projection-controller-startup.test.ts tests/unit/projection-startup-fencing.test.ts
```

Select an explicit native Node 24 or 26 executable through `HYPERION_NATIVE_NODE` for the Bun test
wrapper and repeat on both majors. `frame-read` passes its characterization assertion while retaining
`projectionExit: 1` and `fullWorkerQualification: false`. `frame-control` omits the source change.
`initialize-mutating` proves a sink cannot change an original accepted end by editing its JSON copy.
`diagnostic-failure` retains sink failures while preserving the original worker exception/result.
`bounded` verifies omitted attempts are explicit after the selected diagnostic window ends.

For a standalone retained observation, `HAPI_PROJECTION_REPRO_OUT` may identify a new output file;
the fixture refuses to overwrite it. Its optional JSON is a controlled observation, never a proof
or restart/retry capability. Native child cleanup is independent of the expected software result.

## Bounded qualification observations

The existing guarded native worker observer installs `portable-state-projection-diagnostics.mjs`.
It records the first **eight** projection attempts per physical client and the first **eight**
source-fence/source-open observations per installed parent observer. Each row is detached plain JSON
and bounded to **64 KiB**, within the existing native observer's aggregate file budget. Later attempt,
fence and source-open omissions remain explicit in `observer_metrics.projectionDiagnostics`.
Descriptions, rows and counters grant no retry, end, source, effect, progress, ACK or capacity authority.

The rows distinguish:

- Attempt begin, root return/throw, scope fence and terminal return/throw, including the exact
  original descriptor, checkpoint binding, scope state and pending retained-operation count.
- Current parent epoch/incarnation, local stopped/active-fence state and the original scope's
  ownership of the thrown fence error. A normal close also fences its scope; `activeFence` distinguishes
  that from an authenticated parent fence.
- The original initialization retry decision, after the actual lifecycle method makes it.
- Parent projection census when an active fence is sent, and source-open before/after state with
  the physical reader PID, current-reader match, reader session and source generation.

The parent census retains at most eight projection owners and eight attempts per selected owner,
with omitted counts. It does not attest all owners outside that bound. Reporting failures are counted,
never substituted for an original result/error; the guarded observer marks the qualification process
unsuccessful when its diagnostic reporting failed. This is a startup observation window, not complete
lifetime coverage, loaded-module attestation, fresh OS census, database acknowledgment or live-chain
qualification. Additional synchronous diagnostic I/O is bounded but not measured as a performance gain.

The next actual Linux run must preserve source/oracles, native binaries, grants, the 256-block
ancestry window, queue/resource budgets and all original deadlines. Retain full workload, strict
software shutdown, physical cleanup and protected-service observations separately. The old 813/800
replay failure, four nonzero children and false software shutdown remain failed.
