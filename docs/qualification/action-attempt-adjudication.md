# Private action attempt adjudication (#288)

This slice joins a freshly acknowledged action handoff or disposition write to the exact physical worker attempt that produced it. The parent receives a bounded `observe` message from that attempt, waits for its authentic quiescent end, then checks the retained admission, current producer configuration, Elasticsearch target UUID, source selection and irreversible canonical block before writing a private association. The supervisor's end records an ACK *attempt*; the retained association says `brokerSettlement: unknown`. Neither releases reader capacity or declares source coverage complete.

The write ticket is process local. An immutable bundle `prepare()` issues it only after the configured copies acknowledge the manifest, including an idempotent retry. The worker forwards the exact returned object while its original scope is active. Reading the stored handoff/disposition, copying its JSON, or moving the result to another scope cannot issue a new ticket. Its typed classification is derived from that original result and checked against the retained record and stored association. The parent binds the ticket to its original worker object, incarnation, parent epoch, attempt, receipt and channel census. A redelivery has a different attempt even when it produces identical semantic work.

The parent accepts up to 32 fresh writes and 8 KiB of write metadata per attempt. Overflow leaves the ordinary worker root and ACK path intact but makes association unresolved. Post-end adjudication has a 256-item queue and four concurrent checks, outside the supervisor's serial mutation lane. Queue overflow or unavailable storage also leaves the attempt unresolved. Completed associations use the existing `history-source-admission-v1` immutable store; `readAttemptAssociation()` provides restart inspection only and cannot recreate an opaque end or broker settlement.

Current checks distinguish confirmed handoff, intentional no-effect, intentional suppression, source incomplete, contract incomplete and raw incomplete. Generic hook/proof/I/O failure, source quarantine without admission, missing original ordinal, uncertain end, missing fresh write, failed current target/configuration/canonical check, and process exit remain unresolved. No classification is a sink, API, or capacity grant.

The configured RPC alone is insufficient to establish the current reversible SHIP fork. Association therefore requires the RPC to report the source block irreversible. When a live reader is enabled, its authenticated physical worker must also have reported an irreversible anchor at or above that block, and the RPC must resolve that anchor to the same block ID. A reversible head attempt remains unresolved in this slice. The stored `sourceChecked` value records a point-in-time observation, not a lasting canonical or fork authority; any later capacity decision must recheck its source. Current reversible selection/generation validation is a remaining #288 gate.

## Evidence and remaining gates

Focused tests exercise cross-attempt redelivery, copied results and ends, foreign physical owners, observation retry, conflicting effects, overflow, stale config/target/fork, failed association storage, and restart readback. The native cluster IPC fixture exercises two owned workers with identical semantic work: only the first produces a fresh result and can be associated; a replayed observation from the second physical owner is rejected. It uses controlled source/target authority and does not prove a live broker ACK.

Separate Node 22/24 cases run the original Wire genesis frame through the Reader and MainDS callback, and original block 33 native handoff plus block 36 no-effect and constructed contract-finalization-failure inputs through the DS callback, in managed children. The parent receives their authentic ends, reads test-only retained storage snapshots, and associates source-incomplete, confirmed-handoff, intentional-no-effect, and contract-incomplete results. Each successful case asserts fresh-write observation precedes the original ACK, which precedes the end. Additional managed MainDS cases hold and fail its attempt-manifest write. While held, the parent sees neither a fresh-write observation, original ACK, nor an end. On failure, the original callback produces an authenticated thrown end for the original frame, no fresh write or ACK, and an unresolved adjudication. Storage, broker, and canonical authority remain controlled. Existing original Wire36 MainDS/DS fixtures exercise configured-copy failures and held confirm/drain before original ACK in controlled-local mode. The combined live broker/storage/fork path and complete hold/fail matrix remain open.

Run after `npm ci --allow-git=all`:

```sh
npm run typecheck
npm run build
bun test tests/unit/action-fresh-write.test.ts tests/unit/action-attempt-adjudicator.test.ts tests/unit/action-attempt-managed-wire-ipc.test.ts tests/unit/worker-attempt-fresh-write.test.ts tests/unit/worker-attempt-quiescence.test.ts
npm test
```

For native Node 22/24, set `HYPERION_NATIVE_NODE` to the exact executable and rerun the emitted worker tests. The six original Wire callback plus managed-parent cases passed locally on isolated Node 22.23.3 and 24.19.0 binaries; Linux Node 22/24 CI for the added held- and failed-write cases remains a release gate. Live broker, Elasticsearch, and current-fork authority still require combined qualification. The Linux 1–1480 Wire/Mongo replay and #277 count-and-byte capacity reservation are separate work.
