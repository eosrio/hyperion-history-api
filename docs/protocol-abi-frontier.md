# Canonical ABI frontier

This implements the live-source coordinator portion of [#213](https://github.com/eosrio/hyperion-history-api/issues/213),
on top of the [source handoff](protocol-source-bindings.md) and immutable ABI observation PREPARE journal.
It creates internal canonical input/state bindings. The [proof consumers](protocol-abi-consumers.md)
validate settled certificates, exact bindings and current fork authority before action/KV decoding or API
encoding. Missing certified ancestry and unproven inputs remain unavailable.
This implementation does not establish release or Wire testnet qualification.

## Source ownership and ordered activation

Only an extension master configured with a live reader acquires the per-chain control record. The master
loads and verifies its own provider/component pins. It authenticates requests against the actual current
live-reader worker reference; bulk/repair workers and completed deserializers cannot choose the branch.
Standalone bulk processes retain observations without acquiring the live owner's control record.

Each physical connection first validates its chain status. The reader then opens an exact retained context
with the master and awaits durable authority before requesting blocks. Before Rabbit publication it awaits
admission of the exact source selection. The coordinator serializes those admissions and checks parent
links. Parallel deserializer completion is only a hint to read a durable selection-to-observation link.
A periodic, coalesced drain recovers lost hints. Source ACK still follows durable PREPARE; it is separate
from canonical activation. Activation needs an exact validated observation, immutable state/bindings and
commit readback, followed by the control CAS with a complete configured-copy receipt.

The selected SHiP endpoint is an operator-trusted chain source. The runtime checks source/chain/profile
identity and topology; it does not independently implement chain consensus or treat a receipt sequence
as a canonical certificate. Qualified historical/bulk admission remains open in #213.

## ABI knowledge

Accounts start UNKNOWN unless previous canonical commits establish their state. Ordinary account-row
omission is never authoritative absence or full-snapshot coverage. Listed final rows may establish only
post-block state. Cleared, deleted and malformed/unsupported raw ABIs remain barriers; they never fall
back to older bytes. The reducer does not parse ABI bodies.

Execution is ordered by lossless uint64 global sequence, including values above JavaScript's safe integer
range. An originating input binds before its native ABI effect; notifications reuse that input binding.
Later fresh inputs can see the new publication. Final account rows must reconcile every native publication;
missing or conflicting rows produce explicit incomplete coverage. Final-block state and action-input epochs
remain distinct. Compact immutable bindings retain anchors, input hashes and account-state IDs rather than
duplicating a large ABI for every action.

Incomplete observations or known bounded-capacity failures retain the original PREPARE and publish an
explicit gap with no input bindings, no carried account state, and no ABI coverage start. The canonical
source cursor can continue while ABI knowledge restarts UNKNOWN. A later complete run cannot repair the
earlier gap by implication. Storage transport, unsafe settings and incomplete durable receipts propagate
to supervision; they cannot become a successful incomplete-source acknowledgment.

## Native genesis

[#240](https://github.com/eosrio/hyperion-history-api/issues/240) adds an optional synchronous
`ProtocolProvider.verifyNativeGenesis` hook through the independently versioned SDK. The extension owns
source-specific native initialization semantics. The host retains an explicitly discriminated
`native-genesis` observation, then invokes its own selected, artifact-verified provider again from the
original retained schema/header/state sections before reducing it. Journaled provider facts alone grant
no coverage. Both executions must produce the same bounded portable facts.

This path requires actual block 1, an absent original trace section and SHiP predecessor position, and a
verified zero predecessor in the decoded block header. `source.previousBlockId:null`, capture bytes,
capture kind and source-ID derivation remain unchanged. No empty trace vector, native action, deployment
or receipt is fabricated. Ordinary observations still require traces and deltas. Native ABI states use
block-end provenance and original physical row ordinals; present-empty ABI bodies remain stored barriers.

The immutable canonical commit can additionally attest `nativeGenesis:{previousBlockId,applicationState:'empty'}`.
`ProtocolAbiProofReader.nativeGenesisFrame` accepts only a view issued by that reader and revalidates
current authority before producing the actual block-1 empty application frame. Empty action bindings
cannot supply this fact. Projections still initialize at `{blockNum:0,blockId:zero64}` and process actual
block 1 followed by every contiguous actual source block. Callers must revalidate authority after
asynchronous work and before publication, as for other proof consumers. Production projection job/worker
integration remains [#191](https://github.com/eosrio/hyperion-history-api/issues/191).

Readers may fetch the single native genesis gap when state retention includes block 1, trace retention
starts at 2, full blocks/deltas are requested, and the selected provider supports verification. This is
fetch eligibility only. Missing native evidence or a later source gap still fails verification. The
derived light-block document uses the decoded zero header parent for block 1; it does not mutate the
original absent SHiP position. Any later missing predecessor is rejected.

The real-source fixture retains the unchanged [Tools PR58](https://github.com/eosrio/hyperion-tools/pull/58)
capture. Its production parser/coordinator/proof/runtime exercise uses in-memory broker/storage seams.
The companion unchanged actual block-2–4 capture establishes contiguous forward processing with ordinary
ABI observations and native-ABI action bindings. Each later header has zero transactions but one real
trace action, so header transaction emptiness is deliberately insufficient evidence. Native Node 22.23.3
and 24.19.0 pass this fixture through checkpoint 4; a skipped source block is refused.
It does not establish MongoDB durability, a Rust worker, full worker/API or release qualification. The
current public action-coverage gate stays disabled; native genesis action membership remains a separate
incomplete result rather than a fabricated trace inventory.

## Forks, restart and recovery

Fork recovery first durably changes generation and gates the pending branch, then locates a parent among
the admitted common prefix or bounded immutable ancestor commits. It restores the ancestor account root
and last execution sequence before reducing the replacement branch. Former generations and runtime owners
cannot publish using stale CAS tokens. A durable replacement replay boundary survives interruption during
ancestor lookup. Physical disconnect invalidates pending continuations; writes awaiting receipts are
replayed under the next source epoch rather than promoted into its resume point.

If immutable certificate publication fails after a settled head CAS, the owner's next drain repairs it
even with no new block. Read-only consumers remain unavailable until that certificate is stored and
read back. An in-memory certificate ID avoids repeated idle writes after successful publication; a new
owner, generation or head requires a new settled certificate.

A new runtime owner preserves verified committed progress, clears old admissions and resumes from that
frontier, or from a pending fork's replacement boundary. A new local Rabbit publication epoch still needs
fresh publisher-confirmed irreversible input before it can update the master's history checkpoint. Rabbit
positions do not establish canonical ABI authority. If a replacement parent lies outside verified recovery
coverage, the coordinator records that gap and starts later knowledge UNKNOWN. Historical recovery remains
required; it cannot fabricate earlier input bindings from a later account snapshot.

Before the first commit, the earliest admitted block is itself a durable replay boundary. Reconnect and
owner replacement preserve it even when Rabbit has confirmed later publications. It clears only after a
canonical commit establishes the projection cursor. A resolved fork replay marker likewise clears after
successful ancestor reconciliation, so later restarts can resume forward.

Per-chain settings are optional:

```json
{"settings":{"protocol_abi_coordination":{"max_pending_blocks":128,"recovery_window_blocks":256}}}
```

Both values accept 1 through 4096. Capacity pressure leaves one reader selection waiting and lets worker
PREPARE/drain work continue outside that wait. The existing RabbitMQ publisher confirms, queue budgets and
Elasticsearch reader backpressure remain in use.

## Storage and limits

The control and immutable frontier-record indices are dedicated, owned projections with strict mappings,
stored source, request translog durability, all configured-copy receipts, exact-ID realtime reads, and
refusal of pruning pipelines or ILM/rollover. Identical CAS repair needs a fresh complete receipt. A primary
GET alone grants no durability. Immutable bundles compare exact canonical UTF8 bytes, including on readback.
Existing observation IDs and valid retained bytes stay compatible.

Account state uses copy-on-write roots over 256 hash buckets. Updated account values are immutable records;
only changed bucket references and the root are rewritten. A bucket has at most 20,000 entries and 4 MiB;
control is bounded at 1 MiB; state batches have at most 10,000 updates and 64 MiB; individual immutable
commit/state records remain within the 128 MiB bundle budget. The reducer bounds retained source facts and
distinct resolved prior account states separately at 64 MiB. These are implementation limits, not measured
capacity or throughput claims.

These bounds do not enforce cumulative journal retention. Safe retention/checkpoint/compaction ownership,
qualified historical/bulk recovery, trusted bootstrap manifests and complete
fork/query qualification remain open before production activation. The new projection is initialized
separately; existing Elasticsearch history needs no full reindex.

## Evidence

Focused tests exercise actual adapters, asynchronous ordering, incomplete resets, same-size ABI changes,
self-setabi/notifications, exact CAS/fork/restart races and bounded capacity. The coupled worker fixture
exercises reader/master/MainDS methods with source-pinned codec inputs. The disposable ES9.5.5 script also
checks the real control/state/commit adapters and coordinator. These tests do not launch or qualify a Wire
testnet. Elapsed profiler spans include awaited storage; CPU, allocations, IO, latency distributions and
representative sustained load still require the component profiling program.
