# Actual Wire native genesis input

`ship-preflight-20261020.json` is the unchanged 139,383-byte capture retained by
[Hyperion Tools PR58](https://github.com/eosrio/hyperion-tools/pull/58).
SHA-256: `b8edf652dd0ad265917bf0111ca48789ec7a3f1976f2113783202cc3dd38acb4`.

`receipt-forward-2-4-20261020.json` is the unchanged 226,988-byte bounded read-only
capture of actual irreversible blocks 2, 3 and 4 from the same node/chain/schema.
SHA-256: `38d75b7a1ba28e3abd77512854f963e7723631d6837df73bd7aeff656cc8a450`.
Each has no header transaction but one real trace action; empty header transactions
therefore cannot establish empty source history. Original section/frame hashes,
RPC block IDs, official converter output, process/listener/binary identity and
ACK positions are retained. The fixture verifies the actual contiguous 1 → 2 → 3 → 4
transition and native ABI input bindings, and rejects a skipped projection block.

The verified reader acquired original schema/result/header/state bytes from the
6508c9e8 engineering node on Hyperion-3. Chain ID, executable, schema and section
hashes are retained in the original record. Block 1 has no SHiP `prev_block` and
no trace section; its decoded header predecessor is zero. These facts are distinct.

The host fixture uses the installed, artifact-verified provider, original input,
production parser/coordinator/proof/runtime, and in-memory transport/storage.
It does not establish a production job caller, MongoDB durability, Rust worker,
broker, API, fork/restart or testnet release qualification. No current-head ABI
is used as an initial seed. The public action-coverage gate stays disabled.
