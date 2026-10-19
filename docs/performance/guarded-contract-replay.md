# Guarded contract replay

[API #195](https://github.com/eosrio/hyperion-history-api/issues/195) qualifies a finite, known-genesis action replay. The runner deploys a small no-op contract on a disposable Spring chain, submits six actions under each of two incompatible action ABI revisions, waits for irreversibility, captures SHIP, audits the capture, and starts the production Hyperion master and workers against that capture. An independent oracle compares every contract action and every block with the verified input.

This case supplies ABI history proven against captured account deltas. It bootstraps those two references into its new ABI index before starting the workers. The worker RPC proxy refuses current ABI retrieval for the contract. Genesis block 1 remains a verified input anchor; when Spring advertises trace retention starting at 2, the actual worker range is 2 through the finite end. The status is preserved exactly. This establishes correctness using supplied block-valid history; it does not qualify automatic ABI discovery, historical mainnet input, fork recovery, contract computation, state-table indexing, or sustained throughput.

## Run

Use Node.js 24 with dependencies from `npm ci` and the pinned TypeScript build. Bun 1.4.3 runs the checker and focused tests. The fixture requires Docker and PowerShell 7, including on Linux. Every service uses the existing image digests and resource limits in the worker fixture; production nodeos services are outside the test.

```sh
npm ci
npm run typecheck
npm run build
bun check -p scripts/qualification/tsconfig.json
bun test tests/unit/contract-replay.test.ts

pwsh -NoProfile -File scripts/qualification/es955-worker-fixture.ps1 \
  -Action create -StateFile /absolute/new-fixture.json
node --experimental-strip-types scripts/qualification/contract-replay.ts \
  /absolute/new-fixture.json /absolute/new-result-directory
# Preserve the result and failure pilots before exact, ownership-checked cleanup:
pwsh -NoProfile -File scripts/qualification/es955-worker-fixture.ps1 \
  -Action cleanup -StateFile /absolute/new-fixture.json
```

The result directory and fixture state must be new. The replay also requires no matching indices or queues and no existing `hyp.replay` account. It exposes no reset, purge, wildcard deletion, or forced replacement. A failed deployment leaves its exact fixture available for inspection; create another fixture for a clean final run. The separate fixture cleanup validates all identities, labels, images, volume users and network consumers before deleting owned resources.

## Evidence contract

`fixture/manifest.json` names and hashes the raw protocol ABI, binary status, genesis, expected actions, ABI history and all compressed shards. The record layout is `[u32 frame length][u32 block number][raw result frame]` in little endian. A truncated header or body is fatal. The auditor requires exactly blocks 1 through the finite end, SHIP status coverage through that end, and an irreversible captured end. It decodes each full signed block, recomputes the block ID, checks previous IDs, and verifies both ABI deployments against the captured `account` deltas. Every expected transaction must contain the exact action payload under its deployed ABI revision, with increasing receipt sequence numbers. The exact empty genesis block can have no previous position or traces; a trace log beginning after block 2 is rejected. A block containing transactions requires traces.

Every expected action and ABI deployment transaction must also have an executed receipt in its actual signed block. For packed transactions the auditor independently computes the transaction ID from the packed transaction; a trace claiming an expected ID without that receipt is rejected. An expected user transaction must contain exactly one direct `hyp.replay::record` action with matching authorization and raw data in the packed transaction, expected-output definition and trace. Checksum-only receipts establish membership for ABI deployment transactions, but are insufficient for these user-action checks. Packed transactions may be uncompressed or zlib-compressed; inflation and raw transaction bytes are limited to one MiB, and the decoded transaction must consume every byte. This is a consistency check across signed-block and SHIP trace/state inputs, without a claim of independent consensus or signature attestation.

The replay server binds only loopback. It rejects out-of-range requests, protocol revision changes and payload-flag mismatches. It sends only audited bytes and honors SHIP credits. It does not substitute zeros, clamp incomplete ranges, silently ignore malformed records, or acquire historical ABI data from the chain's current ABI RPC.

`report.json` records runtime identity, exact source/build hashes with copied source bytes, Docker service inspection/configuration, the fixture manifest hash, complete expected and actual outputs, queue-drain observations, reader completion and confirmed-block coverage, and worker shutdown outcomes. Sorted Elasticsearch action IDs, transaction IDs, block IDs, decoded fields, authorization and block coverage must match exactly. The final oracle reads both physical data-node copies and verifies request translog durability. Reader publisher confirms, indexed output, and a crash-safe recovery cursor are distinct facts; recovery cursor semantics are covered by [API #208](https://github.com/eosrio/hyperion-history-api/issues/208).

An Elasticsearch forwarding ledger preserves request and response bodies byte for byte, with their hashes and per-item outcomes. It reports failed items, acknowledging copies and repeated attempts separately. Only an attempt beginning after a prior observed failure response is correlated with that failure; repeated successful writes alone are not labeled retries. This ledger observes the production indexers and adds no synthetic actions or sink stalls. Capture validation, evidence writes and HTTP observation add overhead, so this run does not produce a throughput claim.

## Audit of the existing local replay tools

The local prototypes were inspected read-only before this implementation. They remain unchanged. The new implementation promotes their raw-envelope, shard and SHIP-credit concepts into tracked qualification modules and replaces their unsafe lifecycle and acceptance behavior.

| Audited source | SHA-256 | Boundary found |
| --- | --- | --- |
| `tests/e2e/ship-record.ts` (untracked prototype) | `97c4792b4294a1ed642c599e5b65d583e15f355c85690664f0caec246014256c` | Availability checks do not establish finality, exact record coverage, decoded block hashes or completeness; null `this_block` can finalize a short capture. |
| `tests/e2e/mock-ship.ts` (untracked prototype) | `4f556951f2d5404d02e23f0775e1c871b9219778fe1699e4d8e513701e93f353` | Requests are clamped to captured ranges and incompatible flags merely warn. |
| `tests/e2e/lib/ship-replay.ts` (untracked prototype) | See full audit artifact | Partial record tails are accepted; input metadata/digests and decompression bounds are not verified. |
| `tests/e2e/abi-seed.ts` (untracked prototype) | See full audit artifact | A current ABI stamped at a historical start does not prove historical validity. |
| `tests/e2e/bench.ts` (tracked legacy harness) | See full audit artifact | Fixed `hyp-test` lifecycle includes forced removal, wildcard index deletion and prefix queue purge with swallowed errors. It is not invoked. |

The read-only audit manifest is retained with the qualification evidence. Its SHA-256 is `9f47d38c992d55a503c36e7f01453299daea58336b2d30ee3dae642a839031a6`. It records all 13 inspected file hashes before and after inspection, line references, and the original dirty-worktree status. Legacy dense-load estimates and existing converter tests are not accepted as a clean correctness result for this run.

## Current qualification status

The tracked unit cases cover binary framing, full ABI-encoded capture auditing, manifest and input tampering, missing files, symlinks where supported, ordering/coverage failures, ABI epoch mismatch, exact output mismatches, shared resource refusal, bulk body preservation and active upstream cleanup. The actual pinned Spring genesis envelope is retained as a decoder regression fixture with exact digests.

The first Linux capture passed an offline audit of 712 contiguous blocks, both ABI deployments and all 12 submitted actions. That audited capture alone is not a successful worker replay. A fresh bare-metal Linux reader-to-storage run is being executed separately.

Preparing this case also exposed a production decoder defect: a native ABI context and cached type name could survive an ABI deployment and silently decode newer action bytes with an older schema. A separate runtime change binds selection to the action's block and invalidates type memos when the selected, custom or fallback ABI context changes. Its regression executes the actual compiled pool with the installed native decoder, including shuffled blocks and repeated custom/current fallback calls. This is a correctness change; its added historical ABI lookups still need representative profiling.
