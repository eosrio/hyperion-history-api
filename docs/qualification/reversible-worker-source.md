# Original reversible worker source qualification

This component suite belongs to History API #321. It starts four native Node processes:
the original emitted reader, MainDS and two DS worker roles. The parent uses the emitted
master's own handler map and adjudicator factory, the real ABI coordinator, source binding,
frontier and action admission store implementations. Source IDs and generations come from
the original reader/coordinator IPC exchange. No canonical-current callback or selection
predicate is replaced with a success boolean.

The worker objects initialize the fields needed by these original callbacks. They do not
run the complete production launch/connect lifecycle. ES, RabbitMQ, Redis, source delivery
and canonical RPC transports are explicit controls. The history queue is an observed sink.
The source's frames and the original physical reader probes share one FIFO; source credit
and capacity are not qualified by this fixture.

## Inputs and independent expectations

The source archive, schema, extraction plan and every frame are checked against their
existing pins in tests/fixtures/portable-state-worker. The fixture uses the original prefix
1..34. It constructs head/LIB envelopes with LIB zero so the sources are reversible, and
verifies that each block, trace and delta payload remains byte-for-byte unchanged.

Block 33's native output is checked against the installed source-pinned Wire native oracle.
Block 34's onblock header is checked against the independently captured, checksum-pinned
block-33 RPC response in tests/fixtures/wire-rpc-block-33.json. Its transaction ID, global
sequence and raw action bytes are literal capture expectations. RPC's strong-QC boolean
corresponds to the native ABI's explicit value 1. Expected contract data is never produced
by decoding the output under test.

This is constructed source/transport evidence, not a live reversible chain or a new node
launch pin. Existing Wire and builtin Antelope fixtures remain intact. Builtin Antelope's
extension-gated source selection boundary is unchanged; this suite uses Wire's existing
selected-source path.

## Cases

- **baseline**: actual native callbacks, fresh configured two-copy result and authentic
  quiescent end reach a private source-checked association through the actual master,
  coordinator and physical reversible-reader probe.
- **revoke**: hold the original post-fresh control response, then revoke through the
  authenticated physical reader. The real master fences the original DS scope. Its proof
  rejects reuse and its IO remains physically pending. Reconnect with the reader's new
  session/generation; an independent DS worker completes block 34 while the old operation
  remains held. Late configuration/target reads refuse association. Redelivery of 34 needs
  its own conditional write, fresh observation and authentic end. Release the original
  response only afterward; the old attempt drains with no ACK/association or post-fence
  effects.
- **late-rpc**: hold a canonical RPC result after the actual master captures its source,
  then revoke that source. The same block identity returns, but its issued observation is
  stale and a JSON copy cannot become issued. The old authentic end remains unresolved
  after replacement; a new source/worker can complete block 34.

Block 34 is current-source continuation and redelivery. These cases do not claim that the
fenced block-33 delivery has recovered or that a full projection/history replay completed.
Old failed/unknown outcomes and broker settlement remain explicit. No reader grant, queue
budget, deadline, ancestry limit, dependency, public activation or production setting changes.

## Running and retaining observations

Use the normal npm lock installation, complete project check and native TypeScript build.
Run the focused suite on the selected native Node 24 and 26 runtimes:

~~~sh
bun test tests/unit/reversible-original-attempts.test.ts
~~~

HYPERION_NATIVE_NODE selects the native executable for the Bun wrapper. The native driver
also accepts an optional absolute, non-existing evidence filename:

~~~sh
node tests/unit/reversible-original-attempts.mjs revoke /absolute/owned/path/run.json
~~~

The file retains original source/expected pins, fixture hashes, complete retained store
snapshots, parent/worker messages, authentic end descriptions, process/runtime identities
and raw failure outcomes. Repeated long journal/IPC strings are retained once by SHA256;
each original position is recorded in the reference list. The data structure, string
contents and every observation remain lossless. Each reference is checked against the
original observation before writing. The encoded snapshot is bounded to 64 MiB and never
overwrites an earlier run.
Successful output follows verification of all four owned process exits. Forced cleanup
on a failed case is recorded separately. Treat the bytes as observations, not executable
instructions or replacement authority.

The read-only evidence checker verifies every interned string/reference, all 34 frame
checksums, all four exact process exits, the original native service request/reply pairs
and end replies, and typed retained associations without storage writes:

~~~sh
node tests/unit/reversible-worker-evidence-check.mjs /absolute/owned/path/run.json
~~~

For cold inspection it uses the existing read-only immutable-bundle and source-journal
readers beneath the admission validator. This does not reissue a fresh receipt, accepted
end, canonical observation or readiness/capacity authority.

All three cases retain the normal validators and default five-second proof/fence/drain
limits. Production service durability, combined live fork/storage/broker recovery, the full
original 1..1480 matrix, capacity/backpressure, public query readiness and release acceptance
remain separate requirements under #288/#277 and the release roadmap.
