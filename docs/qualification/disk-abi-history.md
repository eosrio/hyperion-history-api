# Disk ABI history qualification (#451)

The optional `settings.protocol_abi_history` supplies an immutable, irreversible ABI
history prefix independently of live ABI coordinator progress. It is data for the
installed, component-pinned protocol provider; it cannot select or update executable
Node/Rust components. Existing Elasticsearch history and RabbitMQ delivery stay in place.

The scanner seals three files: an NDJSON sparse epoch catalog, a binary index with
32 bytes of block identity per height, and a manifest written last. The manifest pins
the chain, producer profile, node revision, exact SHiP handshake hash, complete range
starting at block one, fixed irreversible boundary, last receipt sequence, member
lengths, hashes and counts. Deployment rows carry exact target ABI sequence and action
position; identical ABI redeployments and empty clears remain separate epochs. Optional
decoded ABI JSON is informational; original bytes and source positions govern decoding.

Generate configuration pins from the validated manifest:

```json
{
  "protocol_abi_history": {
    "interface_version": 1,
    "manifest": "/absolute/path/wire-abis.ndjson.manifest.json",
    "manifest_sha256": "<sha256 of exact manifest bytes>",
    "producer_profile_id": "<producerProfileId>",
    "node_revision": "<nodeRevision>",
    "ship_abi_sha256": "<shipAbiSha256>"
  }
}
```

These pins explicitly assert data compatibility with the installed provider. The Tools
engineering producer profile and HAPI native engineering consumer profile have distinct
names. No suffix rewriting or arbitrary profile equivalence is accepted. The actual
retained source must match the selected consumer components and exact handshake hash.
Changing the catalog requires a controlled worker/API restart. Artifact members are
hashed once at load; each issued use checks retained file/path identity and metadata.

Within the covered prefix, the reader matches the source block ID against the binary
index and resolves sparse ABI epochs directly. Original action occurrence membership
still comes from the retained source selection/observation. Native authorization still
re-decodes original bytes through the installed provider. Malformed/empty contract ABIs
cannot grant decoding; unrelated source processing continues under existing isolation.

Raw capture readiness is separate from ABI coverage. After retaining a complete original
observation, its selection link and native observations, MainDS publishes an `h45srcpub1`
locator in the existing source-binding store. Its deterministic address is chain/block
identity; equivalent recaptures retain the first selection, and conflicting source,
context, capture or observation bytes refuse publication. Unknown/partial writes do not
acknowledge the source. Projections use this locator to find original inputs; an absent
locator returns retryable `source_publication_pending`, never an empty completed frame.

The coordinator imports one explicit `disk-abi-baseline` commit containing the sparse
account root at the boundary. It does not create prefix ABI block commits, historical
addresses, live source selections or publication checkpoints from disk. The first live
tail block must follow the exact boundary ID. Tail commits carry the catalog identity;
ordinary canonical recovery continues above that fixed irreversible floor. Pre-existing
heads at/above the cutoff without this catalog ancestry are refused before ownership
takeover; choose a new validated cutoff ahead of that head. Matching catalog tail
restarts preserve their existing progress and incompleteness.

Controls cover exact decimal sequences, same-block/repeated deployment epochs, empty
barriers, pin/file replacement, cancellation, API reader construction, actual StateReader
and MainDS methods, equivalent/conflicting source recapture, pending raw input, captured
Wire genesis/blocks 2–4, and catalog-to-live-tail fork recovery. These are component
controls with controlled transports, not evidence that Hyperion-3 has synced or that
MongoDB/AtomicAssets parity is qualified. Activation and live replay acceptance are
recorded separately.

## Historical serving after the catalog cutoff (#456)

The fixed catalog covers its irreversible prefix. Retained tail actions also need
the historical certificate-address map once they are more than the ordinary
256-block verified ancestry window behind the canonical ABI head. Without that
map, previously decoded native actions become temporarily unavailable and delayed
worker openings retain explicit raw/incomplete output. The block Explorer then
shows its chain-header fallback because `/v1/trace_api/get_block` returns 503.

Configure the indexer and API consistently. The measured Wire catch-up profile is:

```json
{
  "protocol_abi_coordination": {
    "max_pending_blocks": 128,
    "recovery_window_blocks": 256,
    "historical_certificates": {
      "interface_version": 1,
      "max_commits_per_drain": 32,
      "max_commit_bytes_per_drain": 16777216,
      "max_ms_per_drain": 3000,
      "allow_pending_work": true
    }
  }
}
```

`allow_pending_work` explicitly permits one bounded historical quantum after the
normal live drain. Existing source ownership, generation, epoch, ancestry and
activated-root CAS checks still apply. The absent option retains idle-only history
maintenance and yields to queued live admissions. MainDS, action-pool and API
readers all select the same historical path when configured.

The commit and byte budgets bound the verified backward walk and the pending
address queue. The deadline is checked around storage operations; already-issued
I/O retains its normal durability ownership. During a walk, the bounded queue is
reserved for that walk. Newer live heads remain ordinarily certified and are
covered by the next incremental walk. A completed scheduling anchor advances only
after queued addresses have been activated. It supplies no query membership:
readers always verify the current activated immutable root and exact certificates.
Source epoch, owner or generation changes discard this volatile progress.

Apply the configuration with the reviewed release using a controlled single-writer
restart. Confirm an activated current root covers an old post-cutoff action and
that its transaction and trace-block routes return decoded history after the head
advances beyond 256 blocks. Previously decoded stored documents need no rewrite.
Raw/incomplete documents require bounded replay of their post-cutoff source range,
using the normal source-equivalence checks and deterministic action IDs. This
repairs the affected tail independently of the older Elasticsearch history and
the catalog prefix.

Qualification separately measures the configured maintenance budget under load.
The regression controls cover sustained pending work, repeated queue overflow,
all tail addresses beyond 256 blocks, actual MainDS/API reader openings, map
preparation failure, deadline expiry, and source/owner fencing.

On Hyperion-3, the v1 profile with 256 entries and a 3000 ms deadline did not
activate a historical root within three minutes, despite 200 prepared addresses.
A separately versioned v2 profile used 32 entries, the same 16 MiB and 3000 ms
budgets, 128 pending blocks and the 256-block recovery window. With active source
artifact `e405eafdcf02edcd9776d41269805126fee7cde4`, a root was observed on
2026-11-05 at 22:34:49, about 20 seconds after the 22:34:29 restart. A post-cutoff
block 2950583 / global sequence 5522976, over 275
blocks behind the head, returned decoded actions, transaction and trace-block
responses with HTTP 200. One `authority_changed` 503 occurred during root growth;
a retry returned 200. Full-tail coverage, backfill and repair of incomplete
records remain pending. This observation does not qualify CPU behavior or
MongoDB/AtomicAssets parity.
