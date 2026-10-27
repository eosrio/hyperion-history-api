# Original action-service timing

History API #375 adds fixed-name wall spans through the existing WorkerProfiler
in ds-pool's original processMessages, processActionMessage and flushRedisBatch
callers. It uses the existing settings.ds_profiling activation/reset/IPC path;
no new flag, request, observer promise, sampler or file/fsync path is introduced.
CPU profiling and the qualification stage observer remain separate features.

The closed native26 engineering run aa2abd7e8de4 failed target1340 with both
healthy cursors1316. Shared-reader pause covered its full60-second wait. Existing
completion-reported batch envelopes totaled63.101s versus12.180s process_traces
within that report window, motivating finer measurements outside traces. Those
nested envelopes can cross the window and omit active work: the subtraction is
not exclusive time or a selected cause. This source adds measurements only; it
does not establish a speedup, faithful shortened backlog reproduction, or a full
Wire/MongoDB replay pass. Original workload, limits, ownership and durability stay.

| Fixed metric | Original measured boundary |
| --- | --- |
| action_service_delivery | Original runWorkerAttemptDelivery invocation through its returned completion, including the original physical drain |
| action_service_callback | Its existing async callback, including original message cleanup and per-delivery Redis flush; completes before any later outer drain |
| action_service_admission_begin | Original beginActionAdmission await before processTraces |
| action_service_native_revalidate | Each original native-output revalidation await |
| action_service_owner_current | Each original current-consumer decision before ACK and during seal |
| action_service_try_seal | Original admission trySeal await |
| action_service_handoff_current | Each original current-handoff revalidation await |
| action_service_prepare_raw_disposition | Original raw-incomplete disposition preparation |
| action_service_record_raw_disposition | Original raw-incomplete disposition persistence |
| action_service_record_handoff | Original confirmed-handoff persistence |
| action_service_observe_fresh | Forwarding each original fresh write result through the original worker |
| action_service_owner_assert | Original synchronous admitted-owner assertion after handoff |
| action_service_attempt_current | Each original contract/transaction attempt-current await |
| action_service_prepare_contract_disposition | Original contract-output disposition preparation |
| action_service_record_contract_disposition | Original contract-output disposition persistence |
| action_service_prepare_transaction_disposition | Original transaction disposition preparation |
| action_service_record_transaction_disposition | Its original conditional persistence; absent when preparation returns no evidence |
| action_service_protocol_owner | Original extension-only synchronous delivery-owner assertion |
| action_service_ack | Only the original synchronous consumer ACK invocation after original attempt/mark checks |
| action_service_redis_current | Original protocolCacheIsCurrent await before an existing Redis exec |

Existing redis_batch_exec continues to measure actual Redis execution. A stale
source still discards the old pipeline and skips exec; native errors still
propagate and legacy errors retain their existing handling. Every added span
closes with direct finally at its original await/synchronous call. Original
callbacks, receivers, arguments, result objects, checks and ordering are retained.
There are no block/contract/fragment/owner-derived metric labels.

These are nested wall totals and counts. WorkerProfiler reports and clears
completed measurements, so an emitted report may include work begun earlier and
exclude an active tail. A delivery span includes its callback and physical drain;
admission/guard/record spans can overlap existing tracing/worker measurements.
Do not sum nested spans as CPU or subtract differently completed cohorts to
produce exclusive time. ACK timing is neither broker delivery proof nor business
settlement. A finally timing record does not certify successful processing.

Native24/26 controls import the actual emitted DSPool callers and WorkerProfiler.
Their owned local attempt client and proof scope exercise original cancellation
and physical drainage; an EventEmitter channel exercises the actual publisher's
confirm AND drain. Lower store/trace collaborators are controlled and create no
parent/source/DB authority. Controls cover native/legacy order, held/rejected
handoffs, raw/contract/transaction branches, original error identity, stale owners,
disabled profiling, Redis success/refusal/error handling and synchronous ACK
failure. They do not qualify actual broker/engine performance or full load.

After normal build, run the standalone controls with each native executable:
`node --test tests/unit/native-action-service-timing.mjs`.
The existing Bun unit suite runs them in a separate native child so its own
CONFIG_JSON and working directory cannot affect other tests. Whole-project and
qualification typechecks and normal emission remain separate validation steps.
