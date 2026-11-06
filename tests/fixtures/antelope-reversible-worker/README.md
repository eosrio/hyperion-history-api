# Constructed Antelope reversible worker inputs

This fixture belongs to [#327](https://github.com/eosrio/hyperion-history-api/issues/327)
and the original-worker component checks in
[#321](https://github.com/eosrio/hyperion-history-api/issues/321). It is independently
constructed SHiP input, not a signed chain capture or Wire testnet qualification.

`generate.mjs` writes the physical byte layout directly. It imports neither a
production decoder nor Wire. Its pinned schema and contract ABI come from the
unchanged [original Antelope fixture](../antelope-worker/source.json), which records
the Leap v5.0.3 source revision and extracted schema checksum. Tests do not run the
generator. `antelope-reversible-worker-inputs.mjs` verifies the saved fixture,
generator, original fixture, handshake, status and frame checksums before use.

| Block | Original input | Independently specified result |
|---|---|---|
| 1 | Encoded-empty trace vector; a present `counter` account row with its ABI | ABI state available before the next block; no action effect |
| 2 | `counter::setvalue`, global sequence `9007199254740995` | `{"value":"9223372036854775809"}` |
| 3 | Independent continuation, global sequence `9007199254740996` | `{"value":"9223372036854775810"}` |

Block IDs derive from the manually encoded headers. Parent IDs link the three
blocks, every SHiP envelope has LIB zero, and the status includes the constructed
chain ID. Zero K1 signatures are ABI framing only. The fixture cannot certify
consensus, provenance from a running node, source capacity or release acceptance.

The native driver runs the original master handlers/coordinator and separate
reader, MainDS and two DS processes, using retained stores and native IPC. SHiP,
RPC, RabbitMQ and storage transports are explicit controls. Antelope processes
reject Wire imports and record native addon loading and contract decode dispatch.
The contract decoder receives its ABI from the original source proof; this path
does not use historical-index or current-RPC ABI fallback.

The source bridge is behind the existing internal action-admission/live-reader
engineering seam. It adds no operator option or default activation. Its nonempty
component profile uses the existing bounded inventory of emitted host, native
codec, SDK and npm lock bytes; fingerprints cannot create source authority.

`baseline`, `revoke` and `late-rpc` use the same driver as the original Wire
regressions. Revocation holds a required original read through replacement,
recovers the original block-2 delivery with its own fresh result/end, then
processes and redelivers block 3 before settling the old operation. Configuration,
target and late canonical RPC changes remain checked. The saved-evidence verifier
joins complete reported ends to original native replies and retained associations,
checks the fixed Antelope source, and rejects contradictory report copies.

After `npm ci`, `npm run typecheck` and `npm run build`, run
`bun test tests/unit/antelope-source-provider.test.ts tests/unit/reversible-original-attempts.test.ts`.
Set `HYPERION_NATIVE_NODE` to the chosen native Node 24 or 26 executable. To retain
one observation, run `node tests/unit/reversible-original-attempts.mjs revoke
<absolute-unused-evidence-path> antelope`, then pass that file to
`node tests/unit/reversible-worker-report-check.mjs <evidence-path>`.

Additional native ABI controls follow Leap's pinned
[setabi handler](https://github.com/AntelopeIO/leap/blob/d133c6413ce8ce2e96096a0513ec25b4a8dbe837/libraries/chain/eosio_contract.cpp)
and [fc prefix unpacker](https://github.com/AntelopeIO/leap/blob/d133c6413ce8ce2e96096a0513ec25b4a8dbe837/libraries/libfc/include/fc/io/raw.hpp):
native effects precede the receipt, ABI contents remain opaque, and prefix unpacking
retains its upstream handling of noncanonical lengths and trailing action data.
