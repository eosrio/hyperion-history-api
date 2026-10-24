# Native Wire proof/logger capture, 2026-10-24

Source `7b2fefc0f4d9a79ee73eb23da5e9b37e811d9389`; native Linux Node 24.19.0,
Bun 1.4.4 checker/driver tooling. The original block-685 progress wait **failed**
at observed cursor 661 after holds 1/33/122/256/397. Actual source sent 661 and
ACKed 653. All 14 CPU files and 6,569 proof-open summaries were captured; original
driver/service cleanup passed and incumbent process identities were preserved.

`evidence.tar.gz` contains 8,045 selected files, including 8,012 unchanged bulk,
prefix and native observer files. CPU frame URLs and general observation paths
are explicitly relocated. Five derived metadata files omit raw configuration and
console output. Original/published hashes are recorded separately; unchanged files
have matching hashes. Privacy checks include known path/endpoint/auth markers and
literal fixture credential strings of at least eight characters from configuration.

`summary.json`, `resources.csv` and `proof-io.csv` are recomputed from the archive.
Native summaries reconcile source/authority, attempted/completed reads, stage
distributions, late I/O and the exact pre-summary write/fsync calls and bytes.
CPU resource deltas and sampled call locations are separate observations. The
report explains timing/body-size scope and all remaining qualification gaps.

```sh
python3 scripts/qualification/native-wire-io-evidence.py verify docs/performance/evidence/native-wire-io-20261024 --node /path/to/node
```

Use native Node 24/26. This runs the existing physical profile census on relocated
files and validates the recorded failure; it starts no workers, services or replay.
The private raw archive is pinned to SHA-256
`54c256368959b6849626a7573c497befe3405788c5e89755f599bcb1480d77ae`.
Public evidence is scoped to the actual captured range and recorded operations.
Full replay, canonical recovery, capacity, busy-chain retention and paired overhead
qualification remain open. See [the analysis](../../native-wire-proof-io-20261024.md).
