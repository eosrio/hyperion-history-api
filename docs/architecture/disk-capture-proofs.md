# Proving catalog-covered history from the node's logs

## Problem

With the extension protocol provider, the API serves a decoded action only after proving it
against the block it came from. Today the proof reads records the indexer stored in
Elasticsearch for that block:

- a source selection and its context, which bind one SHiP read of the block;
- an observation link and an **ABI observation**, which hold the block's exact SHiP sections
  (`block`, `traces` and `deltas` as hex), the SHiP handshake text and the facts the
  provider computed from them;
- for native actions, a native observation and its link.

The API reads these records back, re-runs the provider over the stored sections and compares.

Every one of these records is a function of bytes the node already keeps in its state-history
and block logs. Copying them into Elasticsearch has two costs:

- **Size.** On a 3.6-million-block Wire testnet index, the observation index is 188 GB and the
  coordinator's frontier records 129 GB, for about 21 GB of history.
- **Coupling.** Only rows the indexer itself wrote can be served. A row loaded by any other tool,
  such as a direct-from-disk importer, has no stored selection and is refused with
  `input_not_bound`.

## Design

For blocks covered by the configured disk ABI catalog (`settings.protocol_abi_history`), the
proof reader recomputes these records from the logs instead of reading them.

### 1. Capture

`DiskCaptureSource` reads block `n` from the node's logs:

- **Chain-state and trace entries**, located through each log's index. Each read checks the
  entry's magic, the block number and id in its header, its payload bounds and its position
  trailer, then inflates the zlib stream with its declared size.
- **The block-log entry**, located through its index. Its position trailer is checked, and the
  bytes must hash, as a block header, to the block's id.

Every id must equal the catalog's pinned id for `n`, and the previous block's id the catalog's
id for `n - 1`. The three sections and the catalog's pinned handshake form the same
`unattested-ship-result-sections-v1` capture that SHiP delivers. On the Wire testnet, the
sections of 33 sampled blocks between 919,992 and 3,537,956 equal the stored captures byte for
byte.

### 2. Observations

The indexer's observation code moves into pure functions in `source-observation.ts`. The
deserializer and the proof reader both call them, so a recomputed ABI or native observation is
identical to the one the indexer stores for the same block: same bytes, same ids, same digests.

### 3. Disk selection

A catalog-covered occurrence may name the deterministic selection
`h45abidiskselection1:` + sha256 of the canonical position `{blockId, blockNum, chainId,
previousBlockId}`. `openDisk` and the native reader resolve it to the recomputed records. Stored
`h45srcsel1:` selections keep working unchanged.

### 4. Occurrence metadata (schema 3)

A row produced from the logs carries only the occurrence:

```json
{"schemaVersion":3,
 "source":{"chainId":"…","blockNum":N,"blockId":"…"},
 "selectionId":"h45abidiskselection1:…",
 "input":{"transactionId":"…","actionOrdinal":n,"receiver":"…","account":"…","name":"…",
          "rawHex":"…","globalSequence":"…","receiptAbiSequence":"…","inputActionOrdinal":n}}
```

Every field derives from the block's traces and position, so an importer needs neither the
provider nor any stored record to write it.

The API resolves schema 3 in four steps:

1. Open the disk views for the block.
2. Classify the action with the native reader.
3. Expand the row to exactly the schema-1 (contract) or schema-2 (native) metadata the indexer
   would have written under the disk selection.
4. Run the unchanged checks: binding equality, ABI decode and re-encode equality, and native
   envelope and value verification.

## Trust

Recomputed records rest on the same evidence as stored ones. Both are unattested sections from
the node. Both are bound by block id to the catalog's pinned membership, and both are checked by
the same pinned provider.

A disk proof additionally requires each log entry to be the indexed, canonical one for its
block, and the block-log bytes to hash to the catalog id. A stored capture is checked only
through the link digest recorded at write time.

## Configuration

`settings.protocol_abi_history.capture` names the node's `state_history_dir` and `blocks_dir`,
and the `ship_abi` handshake file, whose SHA-256 must equal the catalog's `shipAbiSha256`.
Without `capture`, behavior is unchanged.

## Out of scope

- Removing stored records from existing indices.
- Having the indexer write schema-3 rows when it replays a catalog-covered range.
- Blocks after the catalog's end. The live tail keeps the coordinator; extend the catalog to
  move blocks under disk proofs.
