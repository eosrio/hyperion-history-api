# Private action attempt adjudication (#288)

This slice joins a freshly acknowledged action handoff or disposition write to the exact physical worker attempt that produced it. The parent receives a bounded `observe` message from that attempt, waits for its authentic quiescent end, then checks the retained admission, current producer configuration, Elasticsearch target UUID, source selection and irreversible canonical block before writing a private association. The supervisor's end records an ACK *attempt*; the retained association says `brokerSettlement: unknown`. Neither releases reader capacity or declares source coverage complete.

The write ticket is process local. An immutable bundle `prepare()` issues it only after the configured copies acknowledge the manifest, including an idempotent retry. The worker forwards the exact returned object while its original scope is active. Reading the stored handoff/disposition, copying its JSON, or moving the result to another scope cannot issue a new ticket. Its typed classification is derived from that original result and checked against the retained record and stored association. The parent binds the ticket to its original worker object, incarnation, parent epoch, attempt, receipt and channel census. A redelivery has a different attempt even when it produces identical semantic work.

The parent accepts up to 32 fresh writes and 8 KiB of write metadata per attempt. Overflow leaves the ordinary worker root and ACK path intact but makes association unresolved. Post-end adjudication has a 256-item queue and four concurrent checks, outside the supervisor's serial mutation lane. Queue overflow or unavailable storage also leaves the attempt unresolved. Completed associations use the existing `history-source-admission-v1` immutable store; `readAttemptAssociation()` provides restart inspection only and cannot recreate an opaque end or broker settlement.

Current checks distinguish confirmed handoff, intentional no-effect, intentional suppression, source incomplete, contract incomplete and raw incomplete. Generic hook/proof/I/O failure, source quarantine without admission, missing original ordinal, uncertain end, missing fresh write, failed current target/configuration/canonical check, and process exit remain unresolved. No classification is a sink, API, or capacity grant.

The configured RPC alone is insufficient to establish the current reversible SHIP fork. Association therefore requires the RPC to report the source block irreversible. When a live reader is enabled, its authenticated physical worker must also have reported an irreversible anchor at or above that block, and the RPC must resolve that anchor to the same block ID. A reversible head attempt remains unresolved in this slice. The stored `sourceChecked` value records a point-in-time observation, not a lasting canonical or fork authority; any later capacity decision must recheck its source. Current reversible selection/generation validation is a remaining #288 gate.

## Evidence and remaining gates

Focused tests exercise cross-attempt redelivery, copied results and ends, foreign physical owners, observation retry, conflicting effects, overflow, stale config/target/fork, failed association storage, and restart readback. The native cluster IPC fixture exercises two owned workers with identical semantic work: only the first produces a fresh result and can be associated; a replayed observation from the second physical owner is rejected. It uses controlled source/target authority and does not prove a live broker ACK. Existing original Wire36 MainDS/DS fixtures exercise the production callbacks, configured-copy failures and held confirm/drain before original ACK; their controlled-local mode does not itself issue a parent-accepted end.

Run after `npm ci --allow-git=all`:

```sh
npm run typecheck
npm run build
bun test tests/unit/action-fresh-write.test.ts tests/unit/action-attempt-adjudicator.test.ts tests/unit/worker-attempt-fresh-write.test.ts tests/unit/worker-attempt-quiescence.test.ts
npm test
```

For native Node 22/24, set `HYPERION_NATIVE_NODE` to the exact executable and rerun the emitted worker tests. The new owned-child association case passed on isolated Node 22.23.3 and 24.19.0 binaries. Node 22/24 CI and the combined original Wire output plus managed parent IPC acceptance remain release gates. The Linux 1–1480 Wire/Mongo replay and #277 count-and-byte capacity reservation are separate work.
