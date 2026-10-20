# Captured Wire application replay through workers

Owning issue: [History API #212](https://github.com/eosrio/hyperion-history-api/issues/212),
coordinated through [Tools #22](https://github.com/eosrio/hyperion-tools/issues/22).
This qualification uses the existing launcher, continuous reader, deserializers, pools,
RabbitMQ queues and Elasticsearch writers. It complements the
[Antelope contract replay](guarded-contract-replay.md).

## Source and startup view

The npm lockfile pins the Wire package to `8b7d8a39f098bde77fa8d8f22a20a4fffc3e457b`.
Its application corpus contains original Wire v1.0.0 SHiP messages for 119 irreversible
blocks, 2–120 inclusive, under `wire-sysio-7dede884-engineering-v1`. The node source
revision is `7dede884e0150d36fa788e85a119e10653ade8ca`. These are engineering pins;
the selected testnet launch pins remain pending.

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

Use the pinned Node 22 or 24 runtime after `npm ci --allow-git=all`, the complete
`bun check -p tsconfig.json`, qualifier typecheck and native TypeScript build.
Create a fresh fixture with `scripts/qualification/es955-worker-fixture.ps1` and retain
its state journal. Run:

```sh
node --experimental-strip-types scripts/qualification/wire-worker-replay.ts STATE_FILE NEW_OUTPUT_DIRECTORY
```

Always run the fixture helper's ownership-checked cleanup with the same state file,
including after a failed replay. Each attempt needs a fresh resource journal and output
directory. The existing helper includes Spring and MongoDB; this replay uses the
captured source and does not query or mutate Spring. MongoDB indexing stays disabled.

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

Dynamic contract-state writes and actual state-record deletion remain separate acceptance
work. This corpus has two secondary insertions and no secondary update or deletion.
Starting ancestry, a 6508 node capture, Rust/offline worker execution, same-block ABI
replacement or clearing, malformed deployments, fork/reconnect recovery, live/bulk
contention, coordinated distribution and the selected new testnet remain open.
The sink/canonical-history/PIT gates under
[History API #225](https://github.com/eosrio/hyperion-history-api/issues/225) and retained
history upgrade qualification are not completed by this replay.
