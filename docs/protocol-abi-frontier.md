# Canonical ABI frontier

This implements the live-source coordinator portion of [#213](https://github.com/eosrio/hyperion-history-api/issues/213),
on top of the [source handoff](protocol-source-bindings.md) and immutable ABI observation PREPARE journal.
It creates internal canonical input/state bindings. Action-pool decoding, historical KV selection and API
encoding retain their existing guards until their consumers validate those bindings and fork generations.
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

## Forks, restart and recovery

Fork recovery first durably changes generation and gates the pending branch, then locates a parent among
the admitted common prefix or bounded immutable ancestor commits. It restores the ancestor account root
and last execution sequence before reducing the replacement branch. Former generations and runtime owners
cannot publish using stale CAS tokens. A durable replacement replay boundary survives interruption during
ancestor lookup. Physical disconnect invalidates pending continuations; writes awaiting receipts are
replayed under the next source epoch rather than promoted into its resume point.

A new runtime owner preserves verified committed progress, clears old admissions and resumes from that
frontier, or from a pending fork's replacement boundary. A new local Rabbit publication epoch still needs
fresh publisher-confirmed irreversible input before it can update the master's history checkpoint. Rabbit
positions do not establish canonical ABI authority. If a replacement parent lies outside verified recovery
coverage, the coordinator records that gap and starts later knowledge UNKNOWN. Historical recovery remains
required; it cannot fabricate earlier input bindings from a later account snapshot.

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
qualified historical/bulk recovery, trusted bootstrap manifests, downstream proof consumption and complete
fork/query qualification remain open before production activation. The new projection is initialized
separately; existing Elasticsearch history needs no full reindex.

## Evidence

Focused tests exercise actual adapters, asynchronous ordering, incomplete resets, same-size ABI changes,
self-setabi/notifications, exact CAS/fork/restart races and bounded capacity. The coupled worker fixture
exercises reader/master/MainDS methods with source-pinned codec inputs. The disposable ES9.5.5 script also
checks the real control/state/commit adapters and coordinator. These tests do not launch or qualify a Wire
testnet. Elapsed profiler spans include awaited storage; CPU, allocations, IO, latency distributions and
representative sustained load still require the component profiling program.
