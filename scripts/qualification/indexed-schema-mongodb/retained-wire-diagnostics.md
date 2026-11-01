# Retained Wire workload diagnostics

The original failed Build & Test run `41336554377` selected PR head
`9e8860c5fd8fa8d5fb84b4dd0abd3eb453ab64ad`; its actual GitHub merge checkout was
`7dc86e1f96f29b97ee89c0244f52bf0e1499ebd1`, with the same exact tree
`cd02662ed3aaf9cb78f28395d5dc29d4d3af3a6e`. Both build jobs reached the existing
retained Wire `1..1480` test and observed its original `180000ms` timeout. The
original logs have no phase or current-height ledger. They do not establish
preparation cost, a stalled drain, an API wait, or a product regression as cause.

The diagnostic test header forwards the same name, option object and callback
body to `node:test`. It observes that test's existing abort signal. It adds no
timer, timeout extension, cancellation issuer, process stop or authority. The
source guard reconstructs the original file by removing only this exact import
change and the already accepted profile header; all original callback bytes and
assertions must still match the historical hash.

Only this named test opens an AsyncLocalStorage diagnostic context. Other calls
to the shared fixture helpers retain their direct operations and original
results. Scoped observations cover source sessions and decode, source/proof
selection and observation materialization, proof coordinator drains, live proof
checks, owner drains/reduction and API inject waits. The owner drain includes
adapter materialization; it is not an exclusive measurement of adapter CPU.
Nested phase durations overlap and must not be added as independent CPU totals.
Counts named `fixture.native.commands` and `fixture.frontier.calls` describe the
existing modeled transports, not physical database commands.

Before each observed operation the ledger appends its phase and active await.
It records requested and observed source heights separately from reader progress.
CPU microseconds, RSS/heap/external bytes, process maximum RSS in KiB, context
switch counts and fixture counters are sampled on transitions at intervals of at
least one second, and on start/abort/settlement. There is no independent sampling
timer. The sink also records its own synchronous write count, bytes and elapsed
write time; this does not measure every cost of instrumentation.

The ledger has finite event, byte, row and nesting bounds. Overflow fails visibly
instead of discarding evidence. `out/wire-managed-diagnostic-*/progress.jsonl`
stays outside the fixture's temporary cleanup directory and is uploaded by the
existing always-run source-evidence step. On actual GHA, its provenance checks
the already written genuine Git/assembly receipts against the current environment
and actual process version/path. It never substitutes a guessed head SHA or a
previous runtime observation.

An observed timeout remains a timeout even if the callback returns later.
Missing settlement remains unknown. Ledger summaries grant no qualification;
the original Node test and GitHub job verdicts remain authoritative. The new
controls run only the inert ledger/hooks and source checks on Windows. Actual
retained workloads, controllers and native fixtures are reserved for Root's next
owned Linux execution. Product sources/emissions, input bytes, `1..1480`, the
`180000ms` budget and existing resource/lifecycle policy remain unchanged.
