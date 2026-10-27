# Projection startup fencing diagnostics

This records the diagnosis and narrow frame-recovery slice of
[#332](https://github.com/eosrio/hyperion-history-api/issues/332), following the failed #329 / #330
Linux capture. The original diagnostic slice added observations and native characterization only.
The subsequent frame deferral below changes the eligible source-fence path; query readiness,
parent fencing and normal shutdown requirements remain unchanged.

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

The original frame result was the fail-closed/relaunch path, outside the initialization-only retry.
That native characterization explicitly expected exit 1; it did not reinterpret a failed full
service run as passing. The historical projection PID 19531 lacks this diagnostic evidence, so a
matching stack is not proof that its exact cause was this source transition. A new owned service
capture must identify that cause before #332 can close. #331's broker-exit provenance is separate.

Two additional controls fence a captured first frame before its callback enters. `frame-register`
holds the original registration request before the supervisor handles it; the parent's active count
is zero at the real source-open fence. `frame-reply` holds the original successful registration reply,
with one accepted parent attempt. Both release the same original request or reply after the child
has received its authenticated active fence. The original client rejects before invoking the frame
operation, drains and obtains a genuine quiescent thrown end with no frame effects or retry authority.
Initialization returned normally, while the physical projection exited 1 under that earlier policy.

The projection root observer never enters these frame callbacks, so its absent root error and
`originalScopeFence: false` do not classify the exception as foreign. The fixture separately checks
the real client's ownership of the thrown scope error, the unchanged parent owner, empty frame
binding and original accepted end. These controlled interleavings do not identify the historical
Node 26 message send or replace its missing parent comparison evidence.

## Authenticated frame deferral

The subsequent unchanged-source `c32aec85` Linux capture identifies a concrete source transition:
initialization returned with its accepted quiescent end; the current reader's first source-open
then fenced three in-flight frame roots. All three old roots obtained authentic thrown ends.
The original scope-owned error reached `ProjectionWorker.handleProjectionFailure`, which exited 1.
This diagnosis is separate from that run's later target-749 / last-poll-725 failure and does not
attribute either outcome to TCP_NODELAY. The canonical read-only report is
`art_20261027T004420_56f8c59cc634` (SHA256
`93e1927f3f733795130436cce0a23faebadd87d54a9199f902a823672932eb04`).

The worker may now end only the affected frame's drain with `false` after consuming its original,
current-parent source fence, physically drained root/retained operations and accepted quiescent end.
The internal boolean means **no frame applied in this drain**. It grants no source, write, progress,
readiness or proof authority. The existing `Promise.all` join remains: after the current lanes settle,
the ordinary 100 ms worker cadence captures new managed handles and rereads durable checkpoint + 1.
Each deferral belongs to its own handle/error/end; sibling ends, copied handles and copied or foreign
errors cannot authorize it. Consecutive eligible fences defer again through fresh attempts rather
than spending an initialization retry budget. The four-attempt initialization maximum is unchanged.

Once fenced, the controller preserves the original thrown error and issues no recovery I/O. It must
not replace an ordinary database error with a newly issued scope fence, which would incorrectly
make that ordinary error eligible. Stop, retirement, owner changes, lost/stale end replies and
physically undrained operations still reject deferral. Physical-exit unresolved records are not
quiescent ends. All historical child exits remain part of the normal shutdown census.

The source's interpretation catch also captures its original scope. When that scope is aborted,
it forwards the original thrown value before adding a `PortableProjectionFrameError` wrapper.
An owned fence retains its identity; concurrent ordinary/foreign/copied errors retain theirs and
remain ineligible. There is no cause-chain, name or string-based unwrapping. Unfenced source and
contract failures retain their ordinary target/error wrapping and readiness behavior.

`frame-recover` holds the real source input callbacks and separately retained operations for three
definitions over two consecutive original reader/master source-open fences. It checks each old
lane's end remains unavailable before its own retained operation settles, late old callbacks cannot
issue effects, and the next ordinary drain uses fresh accepted scopes and new durable recovery reads.
Storage/canonical results remain controlled: the fresh source is honestly unavailable, and no
application, query readiness or full Wire/MongoDB qualification is claimed. `frame-read`,
`frame-register` and `frame-reply` now expect successful authenticated deferral. Ordinary/foreign/
copied source errors and terminal lifecycle cases retain exit 1 without another frame registration.

The initial new regression failed on native Node 24.19.0 and 26.4.0 against unchanged `c32aec85`.
An over-strong intermediate expectation that a lane restart before the existing sibling join was
corrected to preserve the existing scheduler; that failed observation remains in the evidence.
The original real-service scenario remains a separate, required qualification gate.

`projection-frame-source-fence.mjs` closes the later interpretation/revalidation boundary using
the existing original Wire source fixture and actual emitted source/coordinator/proof methods.
Only Elasticsearch transport is in memory. It holds the original final revalidation callback after
real proof validation, then fences through the original managed parent IPC. Its separately retained
operation must settle before an authentic end can arrive. Owned fences may defer; ordinary, foreign
and copied callback errors must reach the caller as their exact original objects. No further source
I/O, certified frame return, write or readiness is permitted after the held callback is fenced.
This source boundary independently failed on native 24/26 before the wrapping fix and passed after it.

## Run the controls

Install from the npm lockfile, run the complete project check and emit normal Node artifacts:

```sh
npm ci --allow-git=all
npm run typecheck
npm run build
node tests/unit/projection-controller-startup.mjs frame-read
node tests/unit/projection-controller-startup.mjs frame-recover
node tests/unit/projection-controller-startup.mjs frame-register
node tests/unit/projection-controller-startup.mjs frame-reply
node tests/unit/projection-controller-startup.mjs initialize-retained
node tests/unit/projection-frame-source-fence.mjs owned
node tests/unit/projection-frame-source-fence.mjs ordinary
bun test ./tests/unit/projection-controller-startup.test.ts ./tests/unit/projection-startup-fencing.test.ts
bun test ./tests/unit/projection-frame-source-fence.test.ts ./tests/unit/portable-state-source.test.ts
bun test ./tests/unit/projection-observer-results.test.ts
```

Select an explicit native Node 24 or 26 executable through `HYPERION_NATIVE_NODE` for the Bun test
wrapper and repeat on both majors. Eligible `frame-read` now requires `projectionExit: 0`, while
retaining `fullWorkerQualification: false`. `frame-control` omits the source change.
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

Root and terminal outcomes are observed on the original scope and client native promises;
the source-open observer also returns the original promise. Diagnostic callbacks return no value.
They do not await or re-resolve an operation's opaque result or access its `then` property.
Selected, omitted and unrelated paths preserve original promise identity, arguments, results
and synchronous throws. Observation failures are counted without replacing those outcomes.

The native result controls compare an unobserved client against the projection observer alone,
its composition with fatal diagnostics, and a failing diagnostic sink on both supported Node
majors. They cover resolving/rejecting thenables, throwing getters, plain values whose getter
throws only after the baseline's three reads, native promise results and synchronous errors.
Intentionally foreign handles remain rejected without borrowing custody; their unavailable
fatal descriptions are counted explicitly. Parent-source controls use controlled methods and
include selected and omitted source opens. These are resource-free behavioral controls, not
physical source authority or full-worker qualification. The former extra async wrappers could
turn a baseline success into a rejection; this regression does not establish the cause of any
archived service failure.

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
