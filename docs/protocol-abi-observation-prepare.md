# ABI observation journal: PREPARE only

This is the first bounded storage/capture slice of
[#213](https://github.com/eosrio/hyperion-history-api/issues/213), following
[the provider foundation](protocol-provider-foundation.md). It does not publish
canonical coverage, a frontier, an ABI epoch proof or projection readiness. The
existing Wire action, historical KV and API encoding guards remain in effect.

Extension deliveries also require an exact reader/schema handoff. The
[source-binding contract](protocol-source-bindings.md) defines that separate
prerequisite; the master's cached handshake cannot establish source authority.

## Capturing source facts

For selected extensions, MainDS captures full traces and account delta rows before
root-only/transaction filters, contract whitelists and `max_inline` mutation.
Account row ordinals count the full source delta sequence. The provider's optional
SDK observation hook returns detached raw action inputs, native ABI publications
and final-block account ABI states. Global sequence values remain decimal strings.
The hook does not validate contract ABI bodies; empty, malformed and repeated ABI
bytes remain facts and future invalidation barriers.

Every source block produces an observation record, including explicit empty facts
for a no-op block. Missing required input, unsupported observations, absent hooks
or malformed provider output instead produce an explicit incomplete record.
Descriptor-based JSON validation rejects accessors, symbols, sparse arrays, native
objects, unsafe numbers and aggregate byte/node/depth limits without invoking
getters. Contract-specific malformed facts become incomplete records rather than
an empty success.

Both observed and incomplete records retain the selected handshake JSON string
and exact raw block, trace and delta sections as lowercase hex or explicit null.
They also retain chain ID, block number/ID, predecessor and the loader-verified
Node/Rust artifact pins. This preserves the source needed to retry extraction;
a digest alone would not suffice after the source ACK.

The stable input digest covers source block identity and retained sections/schema.
It excludes mutable SHiP envelope head/LIB metadata. Capture contexts are explicitly
`unattested-ship-result-sections-v1`: different schemas, missing-to-complete refills,
debug captures and different raw payloads coexist under distinct capture IDs.
They do not prove equivalent or canonical source. The future coordinator must
validate overlap and semantics before activating any proof. Different derived
facts under the same source/build/capture are immutable conflicts. Component sets
are sorted consistently in both identity and stored records.

## Storage and acknowledgments

The internal Elasticsearch adapter owns a dedicated
`<chain>-protocol-abi-observations-v1` index. It does not reuse or alter legacy
history/ABI indices. New-index creation sets one primary shard, the chain's
configured `es_replicas`, strict owned mappings and request translog durability.
Existing-index ownership/mapping and current durability/copy settings are checked
before writes. Source filtering, disabled/synthetic source and incompatible replay
field mappings are refused. No global cluster settings are changed.
Default and final ingest pipelines must be absent or `_none`; write requests also
disable default ingestion explicitly so a pipeline cannot prune replay payloads.

Canonical JSON is split into at most 256 chunks, each at most 512 KiB before
base64 encoding, with a 128 MiB aggregate record limit. The adapter writes immutable
content-checked chunks before an immutable manifest completion marker. Partial
chunks grant nothing. Every successful create/CAS receipt must identify the exact
document/index and all configured copies. An existing identical record is reasserted
with sequence-number/primary-term CAS and a fresh complete receipt; GET alone does
not establish durability after an earlier partial or unknown result.

Exact-ID realtime reads validate every manifest, chunk, digest and source identity.
They do not depend on search refresh or latest-ABI queries. Immutable conflicts,
unavailable storage, unsafe durability and incomplete receipts escape before source
ACK. Identical redelivery can repair partial preparation idempotently. Only this
journal effect is covered; existing downstream handoff/recovery work remains
separate. Infrastructure failure through the actual MainDS cargo terminates the
extension worker after discarding its pending local tasks, preserving broker
unacknowledged deliveries. Existing master supervision relaunches the slot after
five seconds and supplies its handshake; fresh broker delivery tags are used.
The old cargo is never resumed with already-requeued delivery tags.

The per-record bounds do not bound cumulative journal storage. This slice adds no
automatic deletion, recovery queue or readiness consumer. It is a durable journal,
not an unbounded in-memory retry buffer. Before production activation, #213 must
define checkpoint/retention ownership, bounded pending-work budgets, qualified
historical recovery and canonical fork-generation coordination. Retained source
must not be deleted while required recovery or checkpoint dependencies need it.
Initialize/rebuild this projection separately; retained history needs no reindex.

## Checks and limits

Unit cases cover immutable source/build/capture identities, partial preparation,
copy receipts, CAS redelivery, unsafe durability, corruption, bounded serialization,
retained incomplete source and complete refills. Production MainDS/parser fixtures
exercise capture before filters/truncation, source ACK only after preparation,
head/LIB drift, missing sources and lossless sequence values. Their transports are
replaced; transformed Wire data remains synthetic serialization evidence.

After the canonical dependency install and TypeScript build, run:

```sh
bun test tests/unit/protocol-abi-observation-store.test.ts
bun test tests/unit/protocol-abi-observation-worker.test.ts
node scripts/qualification/check-protocol-abi-store.mjs report.json
```

The last runner owns an exact-image disposable Elasticsearch 9.5.5 container,
generated labels, loopback port and namespace; it accepts no borrowed cluster URL.
It checks actual server create/settings/mapping/receipt shapes, CAS redelivery,
realtime reads with search refresh disabled, immutable conflicts, partial repair
and unsafe dedicated-index durability refusal. Cleanup verifies ownership first.
CI runs it under Node 24; Node 22/24 run the unit and production-method cases.
These are implementation checks, not crash durability, fork recovery, new Wire
testnet or performance qualification.
