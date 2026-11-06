# Native Wire CPU evidence, 2026-10-23 capture / 2026-10-24 publication

**Replay failed; profiling captured.** See the [report](../../native-wire-worker-profile-20261024.md).
This archive does not complete the 1..1480, live-fork/restart, proof-capacity or release gates.

The private raw archive is 15,548,790 bytes, SHA-256
`98f5370fd4c47a751a2d2229c3eadd32f633108009d5ac898ab7cd11a4b4c48b`.
Publication verifies all 8,040 raw manifest files, the manifest itself and one bounded log alias
(108,612,712 uncompressed bytes), then re-runs the existing physical-primary/fork profile census.
Raw service configuration, credentials, endpoint addresses and console files stay private.

The published [archive](evidence.tar.gz) contains 8,019 ordinary files:

- **7,986 unchanged files:** 7,962 bulk request/response bodies (3,981 pairs), 14 native observer
  logs and 10 prefix/oracle observations. Their original and published bytes/hashes match.
- **14 CPU profiles:** only call-frame URLs replace the private run/source root. Nodes, IDs,
  samples, call-tree structure and time deltas retain their original values.
- **14 resource/worker logs:** local run/source paths, including argv/config/profile filenames,
  are normalized. Numeric measurements and process/fork/lifecycle records are preserved.
- **Five derived metadata files:** source identity, source-session records, last recorded recovery
  snapshots, build/runtime provenance, and the failed run's selected result/cleanup/image fields.

[manifest.json](manifest.json) identifies each entry's transformation, published SHA-256/size,
and original SHA-256/size where a complete original file was copied. CPU receipts retain separate
original and published hashes; redaction changes their JSON byte length. During verification, an
explicit in-memory overlay relocates paths and substitutes published profile lengths for the
existing auditor. Archived observation bytes and their original length fields are not rewritten
to masquerade as newly observed values. Public verification proves the normalized census and
published integrity; reproducing the private original-file audit requires the private archive.

[summary.json](summary.json) and [resources.csv](resources.csv) are recomputed from archived
observations. Resource units are bytes and microseconds, with the elapsed interval in milliseconds.
Profiles contain sample counts; they are not per-function CPU-second or exclusive-wait receipts.
API's raw observer role is `master`; its component distinguishes it from the worker master.

```sh
# From this evidence directory:
sha256sum -c SHA256SUMS

# From the repository root, using a selected native Node 24/26 executable:
python3 -m unittest discover -s scripts/qualification -p test_native_wire_profile_evidence.py
python3 scripts/qualification/native-wire-profile-evidence.py verify \
  docs/performance/evidence/native-wire-profile-20261024 --node /path/to/node
```

The verifier bounds archive members/bytes, rejects path escapes and links, checks every published
entry and all unchanged-byte claims, recomputes the summary/CSV/source-session progress, and invokes
the existing V8-file/physical-process census. Original-file publication additionally audits the
frozen raw manifest and original CPU receipts. No service, source replay, worker or configuration
is executed by these commands.

Publication is deterministic from the retained private archive:

```sh
python3 scripts/qualification/native-wire-profile-evidence.py publish \
  /path/to/private-raw-evidence.tar.gz /path/to/new-publication-directory --node /path/to/node
```

It refuses a different raw archive, an existing output directory, unsupported native verifier
runtime, or retained private-path/credential markers. README and SHA256SUMS accompany the four
generated files. Failed work, the original source range, budgets and qualification limits remain
explicit; Node 26 verifier success does not relabel this Node 24 capture.
