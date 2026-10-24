# Captured Wire application replay through workers

Owning issue: [History API #212](https://github.com/eosrio/hyperion-history-api/issues/212),
coordinated through [Tools #22](https://github.com/eosrio/hyperion-tools/issues/22).
This qualification uses the existing launcher, continuous reader, deserializers, pools,
RabbitMQ queues and Elasticsearch writers. It complements the
[Antelope contract replay](guarded-contract-replay.md).

## Source and startup view

The current npm lockfile pins the Wire package to `7167659e9c043cb3351074fcacb40200cc57f3a3`.
The published bare-metal evidence was captured with package
`8b7d8a39f098bde77fa8d8f22a20a4fffc3e457b` at worker code `5da54fb77699ce0a92d52f59c7569cb8d3e81ba7`.
The offline guards authenticate the same original corpus against the current installed package;
they do not establish a new full-worker qualification result.

The application corpus contains original Wire v1.0.0 SHiP messages for 119 irreversible
blocks, 2–120 inclusive, under `wire-sysio-7dede884-engineering-v1`. The node source
revision is `7dede884e0150d36fa788e85a119e10653ade8ca`. These pins identify this historical
engineering corpus; selected-testnet qualification remains separate in Tools #22.

Before service writes, the fixture audits the package's two original archives, their
complete ordinary-file inventories and the independent source derivation. The original
schema, result frames, nested payloads, transaction receipts and official serializer
observations remain the source of expectations. Every physical delta stream is consumed,
including the final stream omitted by the source-pinned node's declared vector count.

The original captured SHiP status describes head 123 and LIB 121. The replay preserves
that status and the original result bytes. The fixture's separate RPC `get_info` reply
uses captured block 2 as its head and LIB so the existing continuous reader starts at
the beginning of the retained interval. This derived startup control view identifies
its source hashes and synthetic fields; it is not an original node RPC observation.
All other RPC paths are denied and fail qualification. No current ABI RPC, completed
ABI frontier or checkpoint is seeded. The block-1 predecessor is an observed reference;
ancestry and ABI state before the retained interval remain unknown.

The loopback SHiP service accepts the selected live request shape, honors credits and
ACKs, and emits only the finite original interval. An open-ended live request does not
authorize synthesized messages after block 120. Connection, request, message, byte and
time bounds make the finite external completion check possible while the reader stays live.

## Execution and evidence

Use the pinned Node 24 or 26 runtime after `npm ci --allow-git=all`, the complete
`bun check -p tsconfig.json`, qualifier typecheck and native TypeScript build.
Create a fresh fixture with `scripts/qualification/es955-worker-fixture.ps1` and retain
its state journal. Run:

```sh
node --experimental-strip-types scripts/qualification/wire-worker-replay.ts STATE_FILE NEW_OUTPUT_DIRECTORY
```

Always run the fixture helper's ownership-checked cleanup with the same state file,
including after a failed replay. Each attempt needs a fresh resource journal and output
directory. The existing helper includes Spring and MongoDB; this replay uses the
captured source and does not query or mutate Spring. MongoDB indexing stays disabled
in this default invocation. Explicit enabled/disabled write cases are described below.

The report binds the input archives, installed package and Node/Rust component manifests,
source and emitted worker files, executable identity, owned services and configuration.
It retains the selected component manifests and every member they hash, and verifies
the same installed bytes again after the run. Each block's retained source context,
selection, observation link and observation must resolve to the original captured frame
and independently derived facts. A truthy observation ID or digest alone is insufficient.
It records original replay requests and ACKs, reader confirmations, ABI coordinator
evidence, expected and actual indexed outputs, byte-preserved Elasticsearch bulk
exchanges, queue drain, physical data-node copies and supervised worker shutdown.
Fixture observation overhead makes this a correctness run, not a throughput measurement.

The [2026-10-20 evidence](evidence/wire-worker-20261020/README.md) records successful
bare-metal Linux Node 22/24 runs at the exact tested code commit, together with the
separate failed Windows pilot and its follow-up. It preserves physical-read and bulk
acknowledgment limits rather than treating them as equivalent durability evidence.

Public action-history admission stays disabled. The actual workers must discover the
in-range ABI deployments through their original source observations and the real master
coordinator. Unknown initial system-contract state cannot become a current-head ABI fallback.
The configuration uses legacy sequence storage: existing sequence fields must remain
exact decimal strings, and the gated `h45_sequences_v1` field must be absent. The source
graph diagnostic can inspect retained records after shutdown; it does not establish a
settled, active coordinator or qualify a completed worker run.

## Coverage boundaries

| Check | What it establishes |
| --- | --- |
| Original blocks and reader confirmations | The complete retained interval traversed the actual reader and output path. |
| Application actions and ABI epochs | Decoded application output uses the captured deployments, including actions at 111 and 120 around the replacement at 117. |
| Block 108 | Four grouped action documents account for six distinct receipts; the two byte-identical inline inputs retain their distinct origins. |
| Integer values | Full-width application identifiers and amounts retain their exact decimal representation. Actual sequence counters in this corpus are small. |
| Primary and secondary deltas | Indexed history retains complete logical identities, original bytes and provenance for the observed rows. |
| Primary deletion tombstone | The observed `present: false` source row is retained in delta history. This is separate from deleting a state projection record. |
| Physical Elasticsearch reads | The final expected history documents are visible on both owned data-node copies. This is separate from each bulk response's acknowledgment count. |

The separate legacy Mongo write cases below check actual state-record deletion.
This corpus has two secondary insertions and no secondary update or deletion.
Starting ancestry, a 6508 node capture, Rust/offline worker execution, same-block ABI
replacement or clearing, malformed deployments, fork/reconnect recovery, live/bulk
contention, coordinated distribution and the selected new testnet remain open.
The sink/canonical-history/PIT gates under
[History API #225](https://github.com/eosrio/hyperion-history-api/issues/225) and retained
history upgrade qualification are not completed by this replay.

## Legacy Mongo write qualification

`--contract-state enabled` opts into a separate actual-write case against the worker
fixture's digest-pinned MongoDB 8.0.32, using driver 7.2.0. The fixture uses the
same explicit source-derived contract/table map with `auto_index:false`, enables its
owned Mongo connection, and holds the original source at blocks 78, 81, 84, 87, 90, 93,
96, 99 and 120. At each held prefix, the expected block is indexed, worker queues drain,
and bounded database reads check the complete selected state, including the actual
absence of the deleted primary key after block 87. Primary and secondary identities
remain distinct. Original result/status bytes and source credits are preserved.

`--contract-state disabled` uses the identical configured table map and an enabled owned
Mongo connection, but requires empty selected collections after the complete replay.
This exercises the operator opt-in correction in
[#238](https://github.com/eosrio/hyperion-history-api/issues/238). Explicit plugin-declared
dynamic dependencies keep their existing authorization; these cases install no such plugin.

The [2026-10-20 Mongo write evidence](evidence/wire-state-writes-20261020/README.md)
records both modes under native Node 22 and 24 on bare-metal Linux, including the
excluded version-guard preflight and all ownership-checked cleanup receipts.

These checks inspect the existing Mongo route's effects. They do not grant complete
initial state, a canonical rollback view, checkpoint/restart or HTTP readiness. The
portable runtime/backend integration under #191 and state recovery under #221 remain
required. The earlier speculation about missing body fields in the Elasticsearch dynamic
helper did not describe the active path: that helper is unregistered, while Mongo reads
presence from message headers. Original archived reports keep their unmodified gap text;
the current history assertion records the corrected boundary.
