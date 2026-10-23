# Private action attempt adjudication (#288)

This slice joins a freshly acknowledged action handoff or disposition write to the exact physical worker attempt that produced it. The parent receives a bounded `observe` message from that attempt, waits for its authentic quiescent end, then checks the retained admission, current producer configuration, Elasticsearch target UUID, source selection and canonical block before writing a private association. The supervisor's end records an ACK *attempt*; the retained association says `brokerSettlement: unknown`. Neither releases reader capacity or declares source coverage complete.

The write ticket is process local. An immutable bundle `prepare()` issues it only after the configured copies acknowledge the manifest, including an idempotent retry. The worker forwards the exact returned object while its original scope is active. Reading the stored handoff/disposition, copying its JSON, or moving the result to another scope cannot issue a new ticket. Its typed classification is derived from that original result and checked against the retained record and stored association. The parent binds the ticket to its original worker object, incarnation, parent epoch, attempt, receipt and channel census. A redelivery has a different attempt even when it produces identical semantic work.

The parent accepts up to 32 fresh writes and 8 KiB of write metadata per attempt. Overflow leaves the ordinary worker root and ACK path intact but makes association unresolved. Post-end adjudication has a 256-item queue and four concurrent checks, outside the supervisor's serial mutation lane. Queue overflow or unavailable storage also leaves the attempt unresolved. Completed associations use the existing `history-source-admission-v1` immutable store; `readAttemptAssociation()` provides restart inspection only and cannot recreate an opaque end or broker settlement.

Current checks distinguish confirmed handoff, intentional no-effect, intentional suppression, source incomplete, contract incomplete and raw incomplete. Generic hook/proof/I/O failure, source quarantine without admission, missing original ordinal, uncertain end, missing fresh write, failed current target/configuration/canonical check, and process exit remain unresolved. No classification is a sink, API, or capacity grant.

The configured RPC alone is insufficient to establish the current reversible SHIP fork. For irreversible blocks, a configured live reader must have reported an authenticated LIB anchor at or above the source block, and RPC must resolve that anchor to the same block ID. For reversible Wire inputs, the exact source selection must also be among the bounded recent admissions of the current physical live-reader session and settled coordinator generation. The parent then sends a bounded probe to that reader's ordered SHIP ingress queue. Earlier queued frames, including a replacement fork, are processed before the reader checks its current reversible block map; a timeout, changed socket/session/generation, full 32-probe queue or missing block rejects association. The parent rechecks coordinator control after the reader reply. The coordinator invalidates process-local membership on source replacement, fork recovery and restart; a control read can revoke, but never create, membership from a primary-visible unacknowledged write. The control read stays outside the coordinator's serial mutation lane. A replay of the already committed head with a new selection ID is remembered only when its parent and raw capture digest match the committed selection; changed SHIP head/LIB metadata can replay, while changed traces or deltas cannot inherit authority. Selections older than the configured recovery window and inputs without a source selection remain unresolved until irreversible authority is available. The stored `sourceChecked` value records a point-in-time observation, not lasting canonical or fork authority; any later capacity decision must recheck its source. The generic reversible source path and combined live SHIP fork qualification remain #288 gates.

## Current Wire testnet source preflight

The read-only [source preflight](evidence/action-attempt-live-source-20261023.json)
queried the running Hyperion-3 Wire SHIP and RPC endpoints on 2026-10-23 at 05:41 UTC. It used
the installed `wire-sysio-6508c9e8-native-engineering-v1` codec profile and Node 26.4.0 for the
probe only. The advertised SHIP schema SHA-256 was
`94c5661306467f8c49f22180213e390db10d290be9ebf512fb63314f440ef6f9`, matching the
previously captured engineering schema. The live SHIP LIB was block 586494, ID
`0008f2fe622301b35b47b6a8ca4c308af6689201bc53197895ea483f01abf569`;
RPC independently returned that ID for block 586494 and reported the same chain ID,
`9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d`.
The evidence file SHA-256 is
`00d9359f7b8815d65e53f9dae2c6ecec74c74d1afc9517bc35a0ec6fcd69fd08`.
The profile's source revision is a selected codec pin, not a verification of the running node
binary. This status-only probe issued no block-flow request and exercised no worker, broker,
Elasticsearch write or fork recovery. It establishes a reachable current source for the
combined qualification, which remains open.

## Evidence and remaining gates

Focused tests exercise cross-attempt redelivery, copied results and ends, foreign physical owners, observation retry, conflicting effects, overflow, stale config/target/fork, failed association storage, and restart readback. A native child fixture runs the reader's ordered source probe and the parent's request/reply handler: a replacement frame queued before the probe rejects the old source, while the new branch is accepted. A coordinator test covers a newly selected replay of its committed head. The native cluster IPC fixture exercises two owned workers with identical semantic work: only the first produces a fresh result and can be associated; a replayed observation from the second physical owner is rejected. These use controlled source/target authority and do not prove a live broker ACK.

Separate Node 22/24 cases run the original Wire genesis frame through the Reader and MainDS callback, and original block 33 native handoff plus block 36 no-effect and constructed contract-finalization-failure inputs through the DS callback, in managed children. The parent receives their authentic ends, reads test-only retained storage snapshots, and associates source-incomplete, confirmed-handoff, intentional-no-effect, and contract-incomplete results. Each successful case asserts fresh-write observation precedes the original ACK, which precedes the end. Additional managed MainDS cases hold and fail its attempt-manifest write. While held, the parent sees neither a fresh-write observation, original ACK, nor an end. On write failure, the original callback produces an authenticated thrown end for the original frame, no fresh write or ACK call, and an unresolved adjudication. A separate case throws from the original ACK call after the durable result and fresh-write observation: the end records the ACK attempt and thrown root, the local call does not return, and adjudication remains unresolved with broker settlement unknown. Storage, broker, and canonical authority remain controlled. Existing original Wire36 MainDS/DS fixtures exercise configured-copy failures and held confirm/drain before original ACK in controlled-local mode. The combined live broker/storage/fork path and complete hold/fail matrix remain open.

Run after `npm ci --allow-git=all`:

```sh
npm run typecheck
npm run build
bun test tests/unit/action-fresh-write.test.ts tests/unit/action-attempt-adjudicator.test.ts tests/unit/action-attempt-managed-wire-ipc.test.ts tests/unit/worker-attempt-fresh-write.test.ts tests/unit/worker-attempt-quiescence.test.ts tests/unit/protocol-abi-coordinator.test.ts tests/unit/protocol-source-probe.test.ts tests/unit/reader-progress.test.ts
npm test
```

For native Node 22/24, set `HYPERION_NATIVE_NODE` to the exact executable and rerun the emitted worker tests. The seven original Wire callback plus managed-parent cases passed locally on isolated Node 22.23.3 and 24.19.0 binaries. [Linux CI on `17eee69`](https://github.com/eosrio/hyperion-history-api/actions/runs/39905072793) passed all nine jobs, including 1,203 root tests with zero failures on each Node version. The physical-reader probe still needs original-worker live fork qualification. Live broker, Elasticsearch, and current-fork authority require combined qualification. The Linux 1–1480 Wire/Mongo replay and #277 count-and-byte capacity reservation are separate work.
