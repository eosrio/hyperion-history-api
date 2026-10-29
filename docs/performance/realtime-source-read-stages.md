# Bounded realtime source read stages

Scope: HAPI #383 / #371. Source base is merged 453a008da68994bc2b3dd8a638c710efbf096a6d,
whose tree matches reviewed 4332c0ae. This is a private journal component, with controlled ES and
synthetic Antelope records. It is not actual Elasticsearch, captured Wire, worker throughput or
full-replay qualification. Existing source derivation/recompilation costs are unchanged.

## Explicit opt-in and preserved boundaries

`ActionHistorySourceJournal(...,{stagedReads:true})` selects staged reads. Its default remains the
original sequential path; existing admission/worker construction and all active/frozen profiles
are unchanged. Worker activation/wiring is separate work after review and physical qualification.

Each logical immutable-bundle read still fetches fresh metadata and validates its original mapping,
source, durability, replica, pipeline and applicable lifecycle predicates. Metadata is never cached
or supplied by the caller. Link manifests/payloads validate before their fragment identifiers select
the next manifest/payload stage. Every existing canonical encoding, chunk identity/base64/digest,
manifest, transaction, source-plan and domain check remains. Full membership still precedes the
original fresh plan/fragment/link all-copy re-prepares, then manifest-before-seal publication.
No read reconstructs a fresh durable receipt or grants canonical/serving authority.

Up to four logical records share document acquisition, with declared byte lengths reserved against
the remaining 128MiB block membership budget before payload reads. Closed link records have separate
bounded 1 KiB-per-link dependency scratch. Records are assembled from size-packed chunk requests;
four entire 128MiB bundles never run concurrently. The original 512KiB / 256 chunk / 128 MiB ranges remain:
a single 128MiB record is exercised at its exact limit. The generic constructor's existing 1 MiB chunk
range is also retained. A request normally has 1 MiB wire/inflated/preparse limits; the supported 1 MiB
chunk constructor uses a derived larger response allowance, always below 2 MiB. Requests remain bounded
to 256 items and 64 KiB JSON. Response caps are transport caps, not new record caps.

The shared request-local SDK child captures every acquired stream before product checks, including
retry/error paths; it destroys and joins actual streams before settlement. It retains configured
Serializer/prototype protection, authentication, original connection/health identity and pool owner.
No shared client mutation, extra sniff owner, timer, retry policy, global snapshot, TTL, data cache,
inline representation, storage migration or default/deadline change is introduced. Opted-in public
operations assert their captured proof owner once more after the final dependency resolves.

## Error observation order

Within a staged window, a later independent metadata/item/transport failure can precede an earlier
fragment validation error or absence. Every returned item is validated before accepting missing data;
item errors, foreign/reordered/partial/malformed replies never become missing. Aggregate overrun may
be refused before chunk acquisition. Missing/incomplete/invalid categories remain distinct; only
actual missing/incomplete errors may produce the existing retryable incomplete result. A final link
arriving after a negative hint still requires a new attempt. Failed attempts issue no seal authority.
The default path preserves its sequential per-chunk validation order.

## Controlled evidence

Normal TS7 emissions match across Node 24.19.0 and 26.4.0. Each runs 37 new native controls, 48 existing
hint and 110 metadata controls; focused Bun tests pass 108 cases and complete-project Bun checking
passes. The new native controls are a separate step in the existing 24/26 CI jobs. CI/full-suite
results and independent review are recorded separately, never inferred from these component checks.

For the same small single-chunk journal subset, observed request counts are 6N versus
2N+4ceil(N/4), with 2N fresh metadata reads. At N64 this is 384â†’192 requests. Method JSON requests
are 66,560â†’50,176 bytes; responses 255,932â†’256,828 bytes. Batching does not reduce payload volume.
In this zero-network-latency instrumented pair, the staged path uses more local elapsed/CPU time;
no CPU, latency, engine or full-worker speedup is established. Windows CPU accounting is quantized,
and method JSON wrappers contribute overhead. JSON counters exclude real HTTP headers/compression.

The exact 128MiB / 256 chunk record remains 258 requests in both paths; no fixed three-round-trip promise
is valid. In one Node 26 pair, process maxRSS was 1,363,336KiB sequential / 1,232,428KiB staged. These
whole-process peaks include fixture setup, retained synthetic storage, decoding/canonical copies and
instrumentation. Sampled RSS/heap/external/array-buffer values are retained too. This is not a hard
RSS cap, attribution of a memory improvement or proof of production capacity.

Controls cover item/HTTP/encoding/JSON failures, full-range/multichunk data, aggregate reservation,
dependency mutation/deletion, current settings, caller cancellation, owner/fork fencing, final-owner
REDâ†’GREEN, configured Serializer, compression preparse limits, product rejection, retries and physical
abort/drain. Physical engine/Wire/worker qualification, activation and full replay remain separate qualification work.
