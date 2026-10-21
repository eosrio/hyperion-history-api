# Actual Wire portable-state source

Use the [reproduction guide](../../../docs/qualification/portable-state-worker.md)
for the existing-worker/Mongo/HTTP tracer. These files contain inputs and helpers;
they are not a successful worker-run report.

- `source-1-1480-20261020.tar.gz`: unchanged original source archive,
  3,382,093 bytes, SHA256
  `42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`.
- `manifest.json`: exact 1488 ordinary members, 27,982,958 uncompressed bytes.
  Blocks 1-1480 are selected from an original 1-2400 capture. The original capture
  receipt, schema, binary payloads, status/get_info, retained-subrange record and
  independent official-clio input/conversion receipts remain unchanged.
- `plan.template.json`: same definitions, hashes and expected rows as the original
  Linux plan; only machine paths become portable source-relative paths.
- `prepare.py`: preflight all hashes/member paths, extract into a new directory and
  resolve a path-only absolute `plan.json` for the actual driver.
- `services.py`: create or clean exclusively owned ES/Rabbit/Redis services. It uses
  the existing core fixture with a 64 MiB pressure budget; the driver owns its Mongo
  replica. It verifies/removes Redis before core cleanup.
- `test_helpers.py`: resource-free path, archive-preflight and Redis ownership/
  cleanup-order guards. These guards do not start or qualify services.
- `SHA256SUMS` and local `.gitattributes`: preserve the reviewed bundle bytes across
  platforms. The preparation helper pins the archive/inventory and path-independent
  plan digest independently of this checksum list.

The source chain is
`9ccd94e823fda51363bd4265ad618a909c4985c445078c79f8d030fe9697b71d`;
the selected profile is `wire-sysio-6508c9e8-engineering-v1`. Eight original physical
`sysio.msgch` row changes and exact official-clio value conversions establish two
healthy primary-table projection oracles at 1244/1480. No expected row derives from
the tested worker/database. A separate fixture-only invalid mapping exercises
failure isolation when the driver runs.

Prepublication inspection found no private-key/credential signatures or machine
drive/home paths in the archived files. The nine original `/proc/self/fd/3` oracle
arguments identify its descriptor-provided ABI input, not a machine-specific file.
Those arguments and all original payload bytes are retained. No assertion here
qualifies forks, crashes, Rust, Bun, other contracts/backends or full Wire support.

The portable driver's bulk observation budget is 20,000 requests and 256 MiB of
combined request/response bytes, recorded in `report.bulkCapture`. The shared
ledger keeps its 10,000-request default for other qualification callers. Reaching
either bound fails the run; no publication or assertion is omitted.
