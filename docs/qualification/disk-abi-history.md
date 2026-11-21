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
controls with controlled transports, not evidence that a physical node has synced or that
MongoDB/AtomicAssets parity is qualified. Activation and live replay acceptance are
recorded separately.

## Proving covered history from the node's logs

With `capture`, readers recompute each covered block's source records from the node's own
logs instead of reading the copies retained in Elasticsearch. The design is described in
[disk-capture-proofs.md](../architecture/disk-capture-proofs.md).

```json
{
  "protocol_abi_history": {
    "interface_version": 1,
    "manifest": "/absolute/path/wire-abis.ndjson.manifest.json",
    "manifest_sha256": "<sha256 of exact manifest bytes>",
    "producer_profile_id": "<producerProfileId>",
    "node_revision": "<nodeRevision>",
    "ship_abi_sha256": "<shipAbiSha256>",
    "capture": {
      "state_history_dir": "/absolute/path/node/state-history",
      "blocks_dir": "/absolute/path/node/blocks",
      "ship_abi": "/absolute/path/exact-ship-handshake.json"
    }
  }
}
```

- **Handshake.** The `ship_abi` file must hash to `ship_abi_sha256`, which the manifest also pins.
  Its block header types must keep the layout the reader walks; otherwise the configuration is
  refused.
- **Per-block reads.** For block `n`, the reader takes the chain-state and trace entries through
  their indexes, and the block-log entry. Each entry must carry the catalog's id for `n`: the
  state-history headers name it, and the block bytes must hash to it as a block header. The block
  must also name the catalog's id for `n - 1` as its parent.
- **Errors.** A damaged or replaced entry makes the proof unavailable with
  `disk_capture_invalid`. A block the logs do not hold yields `disk_capture_unavailable`.
- **Records.** The ABI and native observations are recomputed with the indexer's own observers,
  so they equal the stored records byte for byte. Their ids and digests stand in for stored
  links.
- **Selections and rows.** Rows name the deterministic selection
  `h45abidiskselection1:<sha256 of the canonical position>`. A direct-from-disk importer can write
  servable rows with schema-3 occurrence metadata, `{schemaVersion: 3, source, selectionId,
  input}`. The API classifies each one and verifies it exactly as the schema-1 or schema-2
  metadata the indexer would have written.
- **Existing data.** Stored selections keep working, and nothing is removed from existing indices.

Every process that proves covered history (MainDS, action pool and API) needs read access to
these logs. Only catalog-covered blocks are read. They are irreversible, so appends by the
running node do not affect them.

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

In a physical run, the v1 profile with 256 entries and a 3000 ms deadline did not
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

## Extending coverage with sealed segments

With `segments_dir`, the pinned catalog is the start of a chain. A sealer (`range-server --seal` in
hyperion-tools) appends incremental segments (`hyperion-abi-history-segment-v1`) to that directory.
Each segment holds only the blocks it adds and names its base by manifest digest, end block and
last block id:

```json
{
  "protocol_abi_history": {
    "interface_version": 1,
    "manifest": "/absolute/path/wire-abis.ndjson.manifest.json",
    "manifest_sha256": "<sha256 of exact manifest bytes>",
    "producer_profile_id": "<producerProfileId>",
    "node_revision": "<nodeRevision>",
    "ship_abi_sha256": "<shipAbiSha256>",
    "segments_dir": "/absolute/path/segments"
  }
}
```

**Verification.** A segment is verified with the sealer's chain rules before anything uses it:
- it starts right after the adopted tip and names that tip as its base;
- its chain, node revision, profile and SHiP schema equal the pinned catalog's;
- its member lengths, digests and counts match its manifest;
- every record's shape, position, block range and block id check out;
- its boundary ids match, and its global sequence never goes back.

A directory with several candidates for one base offers none of them.

**Attestation.** A verified segment is not used for proofs until the ABI coordinator adopts it. The
coordinator does so only after its own settled head has passed the segment's end, and only after its
commits for those blocks, derived independently from SHiP, agree with the segment on:
- every block id and parent link;
- the set of accounts whose ABI state changes at each block, and their final state;
- the ABI each action decodes with, a notification taking the ABI of the action it reports;
- the last global sequence.

An account that only ever held an empty ABI has no catalog record, whether it appears or is removed. The
coordinator's commits only see an account's ABI sequence in the receipt of an action that runs on it, so a
deployment is also checked by the rule itself: its sequence is its account's previous record plus one, and 1
where the account has no record yet.

On a match, it adopts the segment and publishes `{manifestSha256, endBlock, lastBlockId}` as
`catalog` in its control record. On a disagreement, it refuses the segment for that owner and logs
a warning. The check runs in the background at most every 2 seconds and never delays a drain.

**Readers.** The API and the deserializers follow the published link when they read authority. They
resolve the chain from their own tip and adopt it only if it ends exactly at the link's digest, so
a segment that merely reaches the same block cannot be adopted. The link is followed before anything
about the live source is required, so sealed history stays provable while its owner restarts or
recovers its source. A restarted coordinator follows the previous owner's link again before it reads
its own chain or publishes the link.

**What moves and what does not.** The pinned manifest stays the anchor: `catalogId` and the
coordinator's `disk-abi-baseline` stay where they are, so commits, states and issued views keep
validating. Only coverage grows. Sources at or below the published end prove from the logs, with no
store reads; sources above it use the stores as before.

**Limits.**
- Segment block ids are held in memory, at 32 bytes a block, up to 4,194,304 blocks. Past that, compact
  the chain into a new pinned catalog, which needs a controlled restart.
- Adopting segments does not prune the proof stores.
- Without `segments_dir`, the catalog behaves exactly as before.

## Settling attested ranges

An attested range proves from the logs, but the live indexer's action documents in it still name store
selections. With `settle`, the indexer master replaces them with the range server's documents for the same
blocks. Those differ only in the actions' `protocol` field, which is schema 3 (`{source, disk selectionId,
input}`):

```json
"settle": {"range_server": "http://127.0.0.1:7180", "max_blocks": 512, "interval_ms": 5000, "repair_after_blocks": 1024}
```

**Bounds.** Each step settles blocks after the checkpoint, up to the attested catalog end and at least 128 blocks
below the highest indexed block, so documents still being ingested are not overtaken.

**Checks.** A step writes only after all of these hold:
- the response is the requested range, sealed by an adopted segment;
- every block id matches the catalog, and every block comes with exactly one block document;
- every document sits at the indexer's own index and id;
- every action document is schema 3 and names the disk selection of its own block;
- the live documents are the same set the range produced.

A search or statistics answer that does not cover every shard fails the step, which is retried.

**Repairs.** A document missing near the tip means wait. One missing more than `repair_after_blocks` below the
indexed tip is created, provided no document holds its id; if one appears meanwhile the step fails instead of
replacing it. An undecoded live action is replaced. Any other body difference refuses the step.

**Checkpoint.** It is recorded as `settled` in the ABI coordinator's control record. A range server that is
not on loopback must use https.

**Documents written again.** A settled action document can still be written afterwards: by index work queued
before its block settled, by a repair or bulk reader, by a tool. Settle does not assume a settled range stays
settled. Before each step it reads which action documents at or below the settled block changed since it last
looked, and settles again every block where one of them is not schema 3. This is logged as
`Catalog settle found N settled blocks ... written again`.
- Changes are found by shard sequence number. Each shard's audited position is kept in a small record beside
  the coordinator's control record, so a restart continues where the last one stopped.
- The positions stand for the blocks through the settled block they were taken for. If settling ever moves
  past blocks that were neither settled nor read (a new pinned catalog that ends ahead, a checkpoint that was
  reset), they start over. So do the positions of an action index that was deleted and created again.
- A shard without a started primary fails the step: an answer that leaves a shard out is not an answer.
- The first run has no positions and reads every action document at or below the settled block once,
  50,000 a step. This includes blocks below the pinned catalog end, which settle never visits otherwise.
- The indices that changed are refreshed before they are read, once a step.

## Rotating the proof stores

Settled documents need no stored proof records, so the stores only have to hold the chain above the newest
settled catalog link end. With `rotation` (it needs `settle`), the four record indices (frontier records,
observations, source bindings, native actions) move to a new generation (`<index>-g<N>`; generation 0 keeps the
original names) once they hold `max_bytes`:

```json
"rotation": {"max_bytes": 8589934592, "retire_margin_blocks": 1024, "retire_after_ms": 600000, "drop_previous": false}
```

**Building the new chain.** The coordinator writes a disk baseline at the newest adopted link end at or below
the settled block into the new generation. It then replays the live chain's own selections above it. The live
chain keeps serving and advancing meanwhile, and nothing is read again from the node.

A replay that cannot read one of the live chain's records switches nothing; a later check tries again.

**Switching.** Before the switch, the new generation is fully prepared: all four of its indices exist, the
certificate of the head the switch will name is stored, and with `historical_certificates` so is the new
chain's address map through that head. When the new chain reaches the live head, one control update on the
serial lane switches readers and writers to it. Readers may see one `authority_changed` retry; no read fails.

**Reading across generations.** A record missing in the current generation is read from the previous one, so
documents written against it still prove. A record found in neither is reported missing only after control was
read again: a writer that saw the switch first may have written it to a generation the reader has not heard
of. Every process also refreshes a state older than one second before it reads or writes. No store creates
the index of a generation it only reads, so a deleted generation stays deleted.

Both control reads happen in a process that follows generations: every indexer process when `rotation` is
configured, the API when `segments_dir` is (its configuration needs no `rotation`), and any process once it
has seen a generation above 0. A deployment with neither reads control for none of this. Once the stores are
past generation 0 the indexer refuses to start without `rotation`, before it takes ownership; to stop
rotating, keep it and raise `max_bytes`.

**Retiring.** The previous generation is retired once all of these hold:
- settling is `retire_margin_blocks` past the switch block, and the switch is `retire_after_ms` old;
- every action document at or below the settled block is known to be schema 3 right now (see "Documents
  written again");
- every record the unsettled blocks reference has been copied into the current generation: their selections,
  source contexts, observation links, observations and native observations, and the live source's context.
  Unsettled means above the block the documents were just verified through, even if settling has moved on
  since. Besides the selections the commits name, this covers those admitted and not committed yet, and those
  the action documents above that block name (a repair or bulk reader captures a block under its own).

The copy is by record identity, so it does not matter which generation a writer that had not seen the switch
yet wrote to. It is skipped, and retirement waits, while more than 50,000 blocks are unsettled. A reader
session that stayed idle through a retirement writes its source context again with its next block.

**Projections.** `rotation` cannot be enabled together with `features.stateful_owner_v2`: projections read
every source from the proof stores, whatever the catalog covers, and the indexer refuses to start.

**Deleting.** With `drop_previous`, the indexer then deletes its four indices, and each check also deletes the
indices of any older generation that control no longer reads (left behind by a restart after retirement).
Without it, it logs their names for an operator to delete.

**Restarts.** A restart keeps the rotated chain: its anchor validates against the catalog at that link end,
including when the head is the anchor itself. If the segments that reach the anchor cannot be read, the
start fails and the chain is kept. A new pinned catalog that ends ahead of the retained head replaces the
chain as before, and then no rotation anchor is carried.
