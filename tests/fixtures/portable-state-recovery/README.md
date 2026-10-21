# Portable state canonical recovery engineering fixture

This is a bounded, synthetic fork over the separately audited original Wire corpus
in [portable-state-worker](../portable-state-worker/README.md). It is input material,
not a passing-run report or a node-authenticated Wire fork.

The original archive and plan stay unchanged. Original nested block/trace/delta
sections through common block1243 are preserved. Outer head/LIB controls are
synthetic. Branch A1244–1247 and B1244–1249 use codec-correct, unsigned synthetic
headers, empty traces, and a fixed mutation program over the original physical
`sysio.msgch` rows. Original official `clio` receipts supply the value oracle.
The manifest declares that program and the exact derived record inventory hash.

At A1247, reversible state contains counter9 and envelope IDs3/4. Irreversible
state remains at common1243 with no such effects. At B1248, reversible state
contains counter5 and IDs1/2; irreversible state has those values at B1246.
The existing `attestations` table is an independently audited empty projection.
Physical membership, HTTP rows/count/headers and checkpoint/revision must agree.
Empty B1249 advances LIB to1247 and supplies fresh canonical input for the bounded-gap isolation case.

Prepare the locked dependencies/native build and owned services as described in
the [original reproduction guide](../../../docs/qualification/portable-state-worker.md).
Use a fresh service fixture for each runtime/mode run, with the declared64MiB
Elasticsearch indexing-pressure limit. The driver rejects another pressure budget.
It creates its own pinned Mongo8.0.34 replica set. Run on native Linux Node22/24;
do not point it at a production service.

```sh
python tests/fixtures/portable-state-worker/prepare.py out/p246-original
node scripts/qualification/portable-state-recovery-input.ts out/p246-original/plan.json out/p246-input-receipt.json
bun check -p tsconfig.json
bun check -p scripts/qualification/tsconfig.json
bun test tests/unit/portable-state-recovery-harness.test.ts tests/unit/reader-progress.test.ts
node scripts/qualification/portable-state-recovery.ts out/p246-services/worker-state.json out/p246-original/plan.json out/p246-reversible reversible
```

Repeat with a fresh fixture/output and `irreversible`. Keep original failed attempts,
the source derivation receipt, process logs, API transcripts, frontier transitions,
physical Mongo observations, service ownership and cleanup reports. Revalidate the
original source after each run. Clean services with the original ownership-checked
helper. The driver limits itself to15minutes plus90seconds for cleanup.

The SHiP server obeys requested ranges, anchors, credits and reconnect sessions; it
never supplies a skipped replacement prefix to conceal a faulty reader resume.
The reversible run records a real successful majority+journal rollback-intent
command, stops that exact owned projection process, independently verifies durable
metadata and retryable HTTP503 with unrelated history200, then kills it and checks
the master's replacement worker. Both modes also restart the full launcher.
The observer changes no adapter results, global database settings or source facts.

After that restart, the driver stops the launcher/API, adds a fresh genesis
projection over the same audited table and changes the configured source recovery
window to3blocks. Existing stored journal bytes confer no proof outside that bound.
The new instance must persist an exact canonical gap, remain at checkpoint0 with
HTTP503, while existing instances serve successfully. B1249 then proves canonical
history and healthy state continue. Three blocks include the legitimate startup
replay parent B1245 behind B1248; a window of2would also break coordinator replay.

This fixture leaves the following acceptance separate: authentic Wire producer
fork/consensus capture, Rust/rs_abieos, full historical-source replay/rebuild,
all remaining crash boundaries, legacy route/cache equivalence, AtomicAssets and
full release qualification. A green engineering run must not close those gates.
