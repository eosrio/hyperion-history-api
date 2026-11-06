# Durable cursor wait clocks

The portable worker qualification report includes `cursorWaitPhases` for the
existing durable contiguous projection cursor waits. Each row records the source
target, phase entry, original effective deadline, completion, and `pending`,
`passed`, or `failed` status. Completion is retained when the wait rejects,
including child/error guards and expired deadlines. The original error is unchanged.

Entry is the same `performance.now()` sample used to compute the original phase
deadline. The enclosing clock includes the driver PID and
`performance.timeOrigin`, matching `lastRecoveryPoll.clock`. Within that process,
compare these monotonic values directly; `processTimeOriginMs + startedMs` or
`completedMs` provides a wall-clock correlation with worker pause/resume events.
Do not subtract monotonic timestamps from different processes.

Only the latest 128 phases are retained in memory; `attempts` and `omittedRecords`
make truncation explicit and the latest failed wait remains visible. The report
uses its existing final write. There are no added polls, timers, file writes, or
default profiling flags. The 60-second cursor phase, 900-second whole-run and
90-second cleanup budgets, polling interval, source credits and correctness
checks are unchanged. These elapsed spans include awaited work and scheduling;
they do not measure exclusive CPU or establish a throughput improvement.

Service-free native Node 24/26 controls exercise the actual wait body with held
and rejected operations, inherited deadlines and child/error guards. A full
Wire/MongoDB replay is still required; historical reports have no reconstructed
phase timestamps and do not gain a passing result from this observation change.
