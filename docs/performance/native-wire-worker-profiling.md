# Current native Wire worker CPU capture

This is the guarded instrumentation slice for [#297](https://github.com/eosrio/hyperion-history-api/issues/297)
under [#198](https://github.com/eosrio/hyperion-history-api/issues/198). It reuses the installed native
Wire provider, original source, worker launcher and observer. It selects no optimization and changes
no public/default admission, dependency, queue budget, ancestry window or qualification deadline.

The ordinary `portable-state-worker.ts` command keeps CPU capture disabled, including when inherited
environment variables try to enable it. Explicit capture requires the native source-bounded RPC form:

```sh
node --experimental-strip-types scripts/qualification/portable-state-worker.ts \
  OWNED_WORKER_STATE.json AUDITED_PLAN.json NEW_OUTPUT_DIRECTORY \
  --native --authority-rpc http://SELECTED_WIRE_RPC_ORIGIN:PORT --profile
```

Use the pinned native Node 24/26 executable. Historical Node 22 captures keep their original runtime
and source labels. The existing source/RPC identity checks still apply.
Only the exact `--profile` form is accepted; invalid options are rejected before fixture allocation.
The original 1..1480 source, complete held-prefix schedule, independent oracles, actual MongoDB,
HTTP, history replicas, native seals, broker accounting and teardown checks remain required. This
command adds no prefix-success mode or automatic retry. A failure still exits unsuccessfully.

The existing observer samples CPU every 10 ms, with the existing 900-second upper bound and
32 MiB per-file cap. The launched primary PID and every parent-observed physical worker fork must
match exactly one observer start with the correct parent. Orphan starts or lifecycle evidence fail
the census. Each API/master/worker start must match one successful flush and an ordinary
`worker-PID.cpuprofile` file in that component's owned observer directory. Receipts record component,
raw observer role, PID, relative filename, SHA-256, bytes, sample count and recorded interval. API
primaries can report raw role `master`; the component keeps them distinct. Missing, duplicated,
foreign, malformed, unsampled or excess files fail the profile evidence gate.

`report.profiling.status` is `captured` only when both API and master component censuses have complete
evidence. A missing component or profile is `incomplete`. This is separate from actual process/service
cleanup and from `report.status`. A failed replay can retain complete profiles while remaining failed;
a valid CPU file never repairs missing source coverage or progress. The control reports `disabled`
and refuses residual CPU profile files. Raw profiles and normal observer/resource records are retained
on failure as well as success. Publish pinned source/build/dependency/runtime manifests and sanitized,
checksummed evidence before drawing conclusions from a capture.

CPU samples attribute CPU execution, not exclusive elapsed waits or actual ancestry GET requests/bytes.
Those remain required in [#248](https://github.com/eosrio/hyperion-history-api/issues/248) and
[#277](https://github.com/eosrio/hyperion-history-api/issues/277). The earlier projection-prefix profiles
in #251 use another recovery branch/workload and need validation against this current native path.
One sequential profile/control pair does not rank runtimes, quantify profiler overhead or establish
production capacity, leak freedom, complete Wire support or release readiness.

The [2026-10-23 capture and published analysis](native-wire-worker-profile-20261024.md) retains all
14 profiles from the frozen `3febe95e` run. Replay remains failed. The archive verifier checks the
physical census and exact native/prefix/bulk bytes separately from normalized diagnostic paths.
