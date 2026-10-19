# Bind protocol deliveries to their reader context

This is a source-handoff requirement of
[#213](https://github.com/eosrio/hyperion-history-api/issues/213). The
[ABI observation journal](protocol-abi-observation-prepare.md) retains exact
sections and the selected schema. A coordinator must additionally know which
reader selected those bytes and which schema that reader used.

The legacy master shares its first SHiP handshake with workers. Readers can
reconnect with a different handshake while earlier deliveries remain queued.
The shared handshake therefore cannot establish an extension delivery's source
context. Block number and block ID alone cannot identify the relevant schema
or raw capture.

## Durable handoff

For an extension protocol, the reader prepares an immutable context containing
the chain ID, exact handshake JSON, protocol profile and loader-verified component
pins. Each selected block receives a separate immutable selection containing that
context ID, reader session/role/assignment, exact frame hash, stable capture digest,
block/parent identity, and the observed head and irreversible positions.
Every connection must report the configured chain ID in its SHiP status before
it can select blocks. Initial endpoint validation does not validate a later
connection to the same address.

The compact `hyperion-source-selection-v1` RabbitMQ header refers to that selection.
Already staged payloads retain their own header across reconnects. Existing
persistent publications, publisher confirmations, reader supervision and queue
backpressure remain in use.
Only block-result frames receive SHiP block-flow credits. Handshake/status frames
receive none, and commands or credits from an old connection cannot reach its
replacement. Buffered stale input and unrouted block responses retain their exact
raw bytes as incomplete capsules.

The consumer resolves and validates the immutable records, checks the chain and
exact installed profile/components, verifies the frame hash, initializes the
delivery's SHiP session, and checks the decoded source/capture against the selection
before processing it. Shared handshake IPC cannot replace that delivery's session
while asynchronous work is pending.
An immutable link records the selection's exact prepared observation ID and digest
before source ACK. Rabbit delivery-tag ownership also remains bound to the channel
that delivered the message; a replacement channel cannot acknowledge an old tag.

An invalid, missing or incompatible binding preserves the exact frame in an
explicit incomplete capsule before source acknowledgment. It does not publish a
completed block or advance projection coverage. Later valid deliveries continue.
Storage or durability failures propagate to the existing supervised redelivery
path; they cannot become a successful quarantine acknowledgment.

The dedicated source-binding index uses the same immutable bundle guarantees as
the observation journal: chunks before manifest, exact-ID realtime reads, complete
configured-copy receipts, identical-byte CAS repair, owned strict mappings, stored
source, request translog durability, and refusal of source-pruning pipelines.
Observation IDs and previously retained journal payloads stay compatible.

## Authority and recovery limits

A source binding proves the runtime's retained handoff context. It does not prove
canonical membership, full snapshot coverage, an applicable contract ABI, or a
ready projection. The observed head/LIB fields are source evidence, not an activated
checkpoint. The current Wire action, historical KV and API encoding gates remain
in place until the canonical coordinator supplies the required proof.

Queued extension frames from before this handoff have no selection header. They
must become explicit incomplete captures; the cached master handshake cannot
retroactively attest them. Recovery needs qualified source data and must preserve
the distinction between retained input and completed indexing. The default
Antelope path keeps its existing transport behavior.

Per-record limits do not establish a cumulative retention policy. Bounded pending
work, checkpoint/retention ownership, historical recovery and operator visibility
remain required by #213 before production activation. This projection is initialized
separately and does not require reindexing existing Elasticsearch history.

## Validation

Validation must exercise the actual reader publication and MainDS/parser methods,
including two schemas, delayed older deliveries, reordered input, missing/bad
headers, wrong pins or chain, frame/capture tampering, storage failures and restart
redelivery. Reconnect cases must also cover buffered and in-flight old input,
per-connection chain validation, exact SHiP credit counts, and AMQP channel replacement.
Dedicated adapter cases run against the owned disposable Elasticsearch
9.5.5 server used by the ABI journal qualification script. These checks establish
implementation behavior; they do not qualify a new Wire testnet or canonical
fork recovery.

The source-context, selection, resolution, verification, link and quarantine spans
use the existing worker profiler. They measure elapsed work, including awaited
storage. Representative CPU, allocation, I/O and sustained-load costs of this new
path remain unmeasured; passing these cases is not a throughput claim.
