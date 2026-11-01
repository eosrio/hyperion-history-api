# SDK49 explicit full-CI source routing

This engineering profile selects the existing 2da indexed assembly and independently
checks the prepared Wire69 descriptor, Node/Rust artifacts, their member hashes,
prepared lock and Wire-local SDK. It separately checks the whole root and native
MongoDB/BSON installations and both installed TypeScript versions. The four
MongoDB/BSON inventory inputs come from official HAPI420 run 41328625498,
artifact 13092362318: that native run failed and supplies input bytes only.
The two MongoDB installations are 7.2.0; the root BSON is 7.2.0 and native
BSON is 7.3.3. The unchanged Wire69 prepared and nested SDK pins come from the
previous independently frozen Linux source profile, not from that run.

The manifest binds the product source/emissions through the unchanged 2da
assembly plus the additional routing sources. It excludes its own bytes and the
reader helper to avoid a hash cycle. The reader pins the manifest bytes. Before
CI admission, `sdk49-ci-source-check.mjs` checks genuine GitHub checkout SHA and
tree, verifies the reader, manifest, routing and assembly sources are tracked
and clean, and emits the actual identity as evidence. Wire snapshot capture
also records the raw static helper/data closure. No source normalization or
caller-selected expected hash grants admission.

Linux/x64 Node 24.22.1 and 26.4.0 are pinned to their reviewed executable bytes;
26.13.0 is explicitly recorded as an engineering runtime candidate with its
actual hash, without inheriting a runtime pass. The previous profiles and their
expected tuples remain unchanged and reject this assembly. Default or unknown
selection remains refused. Operator-list and complete-kind fixtures retain
their case sets, limits, deadlines, source checks and failure/cleanup rules.

Passing this source profile does not establish physical MongoDB, SQL parity,
managed HTTP, full Wire replay, production comparison offers or release
qualification. Every original native workload and terminal outcome must be
observed separately; historical failed runs remain failed.
