# Experimental source-credit byte reservations

This is the first ingress slice for #277. It bounds granted encoded SHiP block-response
credits during one supervised master lifetime. It does **not** establish an aggregate
pending-work, memory/RSS, downstream-queue or projection bound, or qualify the full Wire testnet.
Existing configurations retain their current behavior and count-based queue backpressure.

An operator must explicitly set `settings.source_credit_capacity` with `interface_version: 1`,
`qualification_only: true` and a positive safe-integer `maximum_ingress_bytes`. No byte budget
is inferred or enabled by default. The first slice requires an extension protocol,
`indexer.live_reader: true` and `indexer.live_only_mode: true`; historical range reassignment
and repair readers are not supported by this option. The explicit budget must cover the
existing `prefetch.read` window multiplied by the existing `max_ws_payload_mb` frame cap.
The component fixture's 8 MiB/one-MiB-frame values are test inputs, not a selected testnet budget.
The runtime option is fixed for the master lifetime. Contract reload validates it before
changing configuration or filters; mode, active window/frame or budget changes require a
controlled restart. Rejected changes fence new reader forks until the original option is
restored or the master restarts. Ordinary mapping reload with capacity absent remains supported.

The actual master authenticates the physical `Worker` and holds a shared reservation pool
across current and retiring reader objects. A source request is sent only after its complete
existing prefetch window is reserved. Each issued credit reserves the maximum encoded response
size; neither a small observed response nor a diagnostic estimate reduces that reservation.
The reader counts block-flow responses, including unavailable-block responses, against issued
credits. Oversized and ungranted responses refuse before publication.

Only the existing broker-confirmed source-input boundary advances cumulative settlement.
It does not attest any downstream result. Paused readers can report completed source input
without returning credits to SHiP. A later resume sends only newly reserved credits. The
cumulative sequence/session/epoch protocol and physical socket/decoder ownership fence
duplicate requests, replies, callbacks and resumes. There is one bounded IPC waiter and retry
timer per reader; missing, malformed, changed-epoch or failed IPC requests fail closed.

Disconnect, cancellation, fork revocation, failed publication and timeouts do not reclaim
uncertain reservations. Replacing an already reserved source stream uses existing supervised
reader recovery, rather than resetting counters on another socket. Only an actual physical
worker `exit` event releases that worker's remaining ingress reservations. A mere IPC
disconnect leaves the charge intact. This first live-only mode avoids reducing live capacity
for a competing historical reader; full combined bulk/live scheduling remains unqualified.

## Required next transfer and settlement integration

1. Before `StateReader.recursiveDistribute` allocates/publishes another encoded copy, acquire
   a separate downstream reservation through the same master owner. Carry a host-issued
   handoff identity through actual block/deserializer/DS/index queues. Account separately for
   overlapping producer buffers, queued and unacknowledged messages, derived outputs and
   recovery copies. Use exact encoded body/header sizes or validated conservative envelopes;
   the existing V8 shadow header observation is not an AMQP wire-size authority.
2. Bind transfers to actual worker-attempt, original publisher/consumer, source selection and
   generation. Publisher confirms settle the producer-to-broker handoff, not the descendant
   queues or Elasticsearch effects. Release the destination charge only after its original
   durable effect and recoverable progress/acknowledgment, preserving unknown outcomes across
   redelivery. A lost notification or queue-size poll must never manufacture free capacity.
3. Reserve projection raw-input/candidate work before `statefulBlock`/`admitRaw` and retain it
   through the original owner lease, committed inspection and `retireRaw`. Contract failures
   need an explicit durable handoff into independently bounded recovery storage; they must
   remain isolated from unrelated indexing. Do not replace the chain budget with independent
   per-projection limits or count lifetime history journals as pending work.
4. Persist or reconcile capacity ownership across a master restart, including old physical
   reader closure and retained handoff identities, before granting a new master budget. This
   volatile source-credit pool alone does not provide crash/restart aggregate accounting.
   Extend the allocator to declared bulk/live partitions with protected live capacity.

Full #277 acceptance still requires these stages, recovery/fork/late-callback tests and a fresh
owned original/full-testnet replay under an explicit aggregate per-chain budget. No existing
ancestry, queue, prefetch, durability, source-coverage or replay deadline is relaxed by this slice.
