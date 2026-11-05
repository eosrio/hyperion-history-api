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
