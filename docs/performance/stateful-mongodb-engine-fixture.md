# Prepared stateful MongoDB engine fixture

Status: **source prepared, engine execution pending**. This is a synthetic qualification consumer
for HAPI #366 and the reviewed opt-in adapter at `e4a46cfa69f0a0cf7f6ca51847a0efa51da80795`,
using SDK `b64bac478fc8015d409d44aa6f100668e0e091d2`. It changes no adapter semantics, host wiring,
dependencies, native/Wire pins, aggregate capacity, worker policy or production activation.

`scripts/qualification/stateful-mongodb-fixture/runner.mjs` imports the **public** stateful SDK and
the actual adapter/driver from an explicitly reviewed local component artifact. Its offline tests
import only runner definitions and built-in modules; they create no clients or sockets. No database,
server, process restart or engine failure has been exercised by preparing these sources.

## Root preparation and custody

Only root may perform the following actual Linux work after independent source review. Each native
major needs its own fresh case and database. The runner does not provision, delete, rebaseline, kill
or clean any database, container, listener or process.

1. Apply the original full Hyperion-1 host/LXC/private-Docker guards and retain their results. Use
   the existing owned H1 LXC and private daemon only after fresh guards; never production Mongo or
   the quarantined H3 LXC. Keep the current Wire fixture, queues, timeouts and resources untouched.
   Root must select a separate owned single-member replica-set fixture with test commands enabled,
   an unused non-default port and a fresh `h45_stateful_<12hex>` set identity. Run mongod bound to
   **127.0.0.1 in the runner's network namespace**, for example with the separately approved private
   fixture's host network inside the isolated LXC. A Docker published-port proxy is refused: the
   pinned actual mongod PID must own the listening socket inode. Root retains the image/config and
   physical resource/lifecycle receipts separately; this source defines no Docker invocation.
2. Build the exact reviewed adapter package from its own committed lock on the selected native
   Node 24.19.0 or 26.4.0; retain original command/PID/wait/source/SDK/driver/emission receipts.
   Stage a new root-owned, non-group/world-writable `$CASE/component` artifact containing its `dist/`,
   required complete local `node_modules/` tree and these exact `runner.mjs`/`guard.mjs` bytes as
   `qualification/runner.mjs` and `qualification/guard.mjs`. Retain the source and immutable artifact
   inventories. `$COMPONENT` must be the exact case directory's `component` child. The manifest inventory covers **every file** under that artifact, including each
   executable dependency and both runner files; no added/missing files or symlinks are accepted.
   Include a second complete SDK package copy as `host-sdk/`. Its emitted inventory must match the
   adapter's `node_modules/@eosrio/hyperion-sdk/dist/` exactly. The public host SDK and adapter SDK
   are then distinct module instances: cloned/foreign handles must still refuse local execution;
   adapter receipt of a host declaration only recaptures for validation. Preserve the unchanged
   top-level host/Wire SDK pins. The driver is the same reviewed7.2.0 subtree used by the adapter.
   Prepare a reviewed regular-file export if install-time `.bin` symlinks exist; never dereference
   an unknown external target. Do not run install/build commands through this runner.
3. Create one new root-owned mode0700 case directory at
   `/opt/hapi329/stateful-qualification/h45_stateful_<12hex>`. Copy the committed synthetic plan as
   `plan.json`; pin its exact bytes/hash. It contains no chain-derived inputs or application data.
   Fill **every pending field** in `manifest.pending.json` from actual observations and operator
   choices, saving mode0600 `manifest.json` in the case directory. The template is intentionally
   invalid. Select explicit phase/operation/transaction, record, output, candidate and artifact
   bounds; the fixture's two-block undo/two-receipt policy is part of this small test plan, not a
   production default or aggregate per-chain capacity configuration.
4. Pin the runtime executable bytes/version, actual mongod PID/birth/executable/cmdline hashes,
   network namespace and sole loopback listening inode, exact server version, set name, single
   member and immutable replicaSetId. Root must audit an initially OFF/empty `failCommand` and pin
   its observed baseline counter. No ambiguous target or missing observation is adoptable. Pin
   the **entire** local module inventory, paths and hashes, plus exact input bytes, and retain the
   manifest SHA256 outside the case. Unset loader/preload, coverage and MongoDB debug-log variables;
   use the exact native executable without extra Node flags. Restrict component files to root.

`hello`, `buildInfo`, `replSetGetConfig`, failpoint inspection/control and session completion are the
only administrative operations. Business reads/writes target only the exact named owned database;
there is no drop or cleanup path. Only `fail-b` enables a once-only appName-scoped DELETE failpoint,
and it disables that exact owned setting in `finally`, independently of the business verdict.
Client closure is attempted even if failpoint verification fails. Native operations and transactions
have explicit deadlines; phase guards check before/after SDK work and refuse further work on expiry.
They do not kill a process or manufacture a terminal result for an unsettled native operation.

## Separate native application invocations

After root verifies the exact manifest and source artifact, invoke each phase in order with the
selected executable. `$NODE`, `$COMPONENT`, `$CASE` and `$MANIFEST_SHA` below are operator variables
for already observed local artifacts, not supplied defaults:

```sh
"$NODE" "$COMPONENT/qualification/runner.mjs" a         "$CASE/manifest.json" "$MANIFEST_SHA"
"$NODE" "$COMPONENT/qualification/runner.mjs" fail-b    "$CASE/manifest.json" "$MANIFEST_SHA"
"$NODE" "$COMPONENT/qualification/runner.mjs" recover-b "$CASE/manifest.json" "$MANIFEST_SHA"
"$NODE" "$COMPONENT/qualification/runner.mjs" fork-c    "$CASE/manifest.json" "$MANIFEST_SHA"
"$NODE" "$COMPONENT/qualification/runner.mjs" retention "$CASE/manifest.json" "$MANIFEST_SHA"
```

Root must retain each actual PID, normal wait/exit, stdout/stderr hashes and host guards. Do not
automatically retry any phase: exclusive intent/receipt files preserve refusals and uncertain state.
The next phase requires its exact preceding successful receipt and unchanged manifest. A successful
`fail-b` means the expected engine abort was observed; it does not mean B committed.

- **A** refuses a nonempty database, initializes complete synthetic genesis, applies generic JSON
  values and checks public reads against independent physical records, progress, receipts and undo.
- **fail-b** stages repeated replacements and a put-then-delete through SDK execution. Candidate
  custody is bounded, exclusively created, fsynced and directory-fsynced before adapter application.
  The actual owned failpoint rejects DELETE with BadValue2 and no transient labels. Assertions
  require a successful outside durable intent UPDATE, earlier successful transactional writes, the
  failed transactional DELETE, successful abort and actual failpoint entry counter. A separate
  primary/snapshot client proves A's business data/undo/receipts/progress unchanged and pending B
  retained. No synthetic throw is counted as an engine error.
- **recover-b** requires a different application PID/birth and absence of the old application
  identity. A newly imported SDK handle and new adapter use the exact fsynced candidate; the hook
  must not run. It proves one original before-image per key, exact/conflicting replay, full JSON
  values and rejection of A's stale checkpoint even though ordinary application kept the revision.
- **fork-c** rolls B back to A through the public bounded rollback API, rejects pre-rollback views,
  applies replacement C and proves completed rollback redelivery cannot overwrite C. It retains a
  fixed rollback request and compares actual rows/images and retained branch identities.
- **retention** exceeds the explicit two-block window, then proves unavailable older ancestry stays
  incomplete with a rotated revision, unchanged rows/progress and refused ready views.

Every physical inspection additionally compares the **complete** image and undo inventory with the
synthetic plan and fixed custody candidates. After A there are exactly two null before-images;
after B there are exactly five images (A's two and B's three original values). Rolling B back must
leave only A's two images. C adds exactly one collection before-image. Empty D prunes A, leaving
only C's image; empty E prunes C, leaving **zero physical images**, with two empty-block undo
descriptors. An orphan B image or any pruned A/C image refuses the phase. The oracle checks exact
block/target/key identities, original canonical before-values, descriptor ordering/count/hash and
BSON bytes, retained receipts/floor receipt and public recovery coverage at the same revision and
checkpoint. It derives expected BSON lengths through the pinned driver's public serializer, without
importing adapter validation helpers. Observed post-C or post-retention digests are additional
stability checks, never the sole expected inventory.

Physical inspection uses a **separate primary client**, a snapshot transaction and linearizable
metadata observations around it. It validates actual collection rows, exact canonical values,
key/image identities, receipts and original before-images; observations are bounded. Stdout and
phase receipts expose counts/digests and synthetic view metadata only. A separately pinned private
command observation file retains command names, ordering, transaction flags and error codes, with
no command bodies or URI. Candidate files and the
manifest stay private to the case. Do not upload raw runtime files or URIs to Palace/public issues.

## Offline reproduction and remaining gates

```sh
node --check scripts/qualification/stateful-mongodb-fixture/guard.mjs
node --check scripts/qualification/stateful-mongodb-fixture/runner.mjs
node --test scripts/qualification/stateful-mongodb-fixture/offline.test.mjs
```

Run these built-in-only checks on both exact native majors. No root package install, artifact build,
TypeScript gate or full HAPI suite is needed for this standalone `.mjs` fixture-only source change.
Root separately builds and authenticates the adapter's own package for actual engine work.
The offline inventory controls use explicitly constructed BSON-size expectations; they detect
extra/missing/changed images, wrong descriptors, pruned receipts and incoherent coverage. They do not
validate native BSON encoding or substitute for the actual driver/engine phase assertions.

An app restart here is a clean separately invoked application process, **not** an engine crash,
power loss, HA/failover or uncertain native commit qualification. The runner supplies no constructed
lost-ACK test and no automatic retry/ACK/source authority. Actual MongoDB durability/atomicity and
process/resource/cleanup acceptance remain pending until root executes and independently audits the
physical case. Host journals/canonical source/fork/finality/serving, original PostgreSQL comparison,
AtomicAssets/AtomicMarket APIs, full #366/SDK #32/#10 and full parity remain open.
