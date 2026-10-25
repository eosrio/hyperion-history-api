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
  session/generation and the original reader's confirmed-publication request boundary.
  Replay that requested prefix 1..33, then recover the original block-33 delivery on an
  independent DS worker with its own fresh result/end and current-source association while
  the old operation remains held. Block 34 then continues independently. Late
  configuration/target reads refuse association. Redelivery of 34 needs
  its own conditional write, fresh observation and authentic end. Release the original
  response only afterward; the old attempt drains with no ACK/association or post-fence
  effects.
- **late-rpc**: hold a canonical RPC result after the actual master captures its source,
  then revoke that source. The same block identity returns, but its issued observation is
  stale and a JSON copy cannot become issued. The old authentic end remains unresolved
  after replacement; a new source replays its requested prefix and a worker can complete block 34.

The recovered block-33 association belongs to a new physical attempt and source selection;
its original failed end remains unresolved. Block 34 is subsequent continuation/redelivery.
These component controls do not establish a completed full projection/history replay.
Old failed/unknown outcomes and broker settlement remain explicit. No reader grant, queue
budget, deadline, ancestry limit, dependency, public activation or production setting changes.

## Publication and plan identities

The reader's confirmed, contiguous irreversible publication cursor is independent of canonical
ABI coverage. Reopening selects the earlier required boundary, preserves its anchor when
applicable, and creates a fresh publication epoch. Callbacks from an old checkpoint, source
context or physical socket cannot advance the new source. The strict finalized-prefix rewind
guard remains active; the source replays the actual requested prefix instead of bypassing it.

Newly produced retained action sources use schema 2. Their history plans include the exact
retained source ID, keeping per-selection output provenance in separate immutable contexts.
Complete document fingerprints still include protocol selection/native-link metadata, and a
different result within the same plan still conflicts. Schema-1 sources keep their original
plan identities and remain readable/retryable. These internal records do not activate the
engineering action-history path or grant readiness, sink completion or capacity authority.

## Running and retaining observations

Cold inspection compares every reported end with its complete retained association or original
native reply. Regression controls change each report copy's payload hash while keeping the
stored records, original IPC and native ends unchanged; those contradictory copies must fail.
These constructed contradictions establish saved-record consistency only.

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
and end replies, and typed retained associations without storage writes. Each retained
association's complete end description must equal its original native parent reply, including
the binding, delivery descriptor and fresh-write receipts:

~~~sh
node tests/unit/reversible-worker-evidence-check.mjs /absolute/owned/path/run.json
~~~

For cold inspection it uses the existing read-only immutable-bundle and source-journal
readers beneath the admission validator. This does not reissue a fresh receipt, accepted
end, canonical observation or readiness/capacity authority.

Authenticate source and emission provenance with the separately sealed run receipt and trusted
input preparer. Cold reads establish snapshot and typed-record consistency; authenticate the
saved bytes against their external artifact hash before relying on that result.

All three cases retain the normal validators and default five-second proof/fence/drain
limits. Production service durability, combined live fork/storage/broker recovery, the full
original 1..1480 matrix, capacity/backpressure, public query readiness and release acceptance
remain separate requirements under #288/#277 and the release roadmap.
