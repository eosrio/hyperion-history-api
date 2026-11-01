# Native MongoDB operator-list qualification

HAPI #414 provides this **unexecuted physical harness** for the executor-owned Linux qualification lane. Local controls use `offline.test.mjs` and the adapter's modeled/pinned-driver tests; they do not open a database. `runner.mjs` must only be run against a separately admitted disposable single-member MongoDB **8.0.34** replica, never an existing operator database. It does not start or stop MongoDB, Docker, services or processes.

Before execution, the executor must review/freeze the source commit, use normal lifecycle-enabled `npm ci` from both committed locks, perform complete Bun checks and a fresh native TypeScript 7.0.2 build on Node 24/26, and independently admit the resulting compiled bytes. Root SDK741/Wire69/f163 engineering profiles are not silently upgraded or qualified by this slice; only the adapter's isolated SDK429a pin provides operator lists. A later combined engineering profile is separate work.

From a fresh exact checkout, capture its native compiled inventory with this read-only command:

```sh
node scripts/qualification/operator-list-mongodb/inventory.mjs > reviewed-compiled-inventory.json
```

The `sha256` field is SHA-256 of `JSON.stringify(files)` in that exact inventory order. Pass the independently reviewed value, not a value obtained by accepting an unreviewed installed tree. A checksum alone does not prove a fresh source build. The runner refuses a different HEAD, dirty/untracked native/qualification sources, wrong SDK/driver/compiler pins, mismatched compiled bytes, a pre-existing output directory, non-loopback/authenticated/default-port URI, or the wrong replica/version. It binds source TS, compiled files, installed SDK module, Node executable and server identity into the report.

The explicitly authorized run is:

```sh
export HYPERION_OPERATOR_LIST_MONGO_URI='mongodb://127.0.0.1:37017/?directConnection=true&replicaSet=h45_operator_lists'
node scripts/qualification/operator-list-mongodb/runner.mjs \
  --run --allow-failpoints --database h45_lists_012345abcdef \
  --output /owned/new-evidence-directory --source EXACT_FROZEN_40_HEX_COMMIT \
  --compiled-sha256 EXACT_REVIEWED_64_HEX_COMPILED_INVENTORY
```

The executor chooses a fresh database suffix/output, exact source/artifact pins and the already-admitted port/replica identity. URI, credentials and command payloads are not emitted. The runner additionally refuses a nonempty database or already-armed failCommand failpoint before creating a fixture owner marker. Failpoints are restricted by this fixture client's unique appName. Restoration of that admitted failpoint, ownership-checked database cleanup, original session termination and both client closes are recorded independently of test outcomes. An original failure is retained if later cleanup fails.

The workload imports more than 20 MiB of UTF-8 items across separate list/item documents, then reads bounded subsets. Actual driver command events prove attempts, empty/getMore/exhaustion pages, stable snapshot `atClusterTime` and lsid, zero-attempt completed cache hits, no hidden commit/abort loops, shared budgets and bounded cursor cleanup. A possible cleanup dispatch consumes the original allowance. A test-only native transport barrier makes two already-verified immutable publications reach the original pointer CAS boundary before either runs; commands, sessions and original signals are preserved. Exactly one pointer CAS must match and both complete revisions remain retained. The barrier's pure controls do not establish physical results.

Additional cases exercise source/generation unavailability, partial owned storage, missing-index native errors, cancellation/config retirement after an actual response, and an appName-restricted blocked find under a 50 ms deadline. Terminal timing includes driver cleanup and is reported separately; no successful response may be admitted after expiry. Remote cursor closure uncertainty is retained as failure evidence, not inferred from `endSession`. This runner has not established generic hard real-time cleanup guarantees.

Artifacts are `report.json`, bounded sanitized `trace.json`, and an exact size/SHA-256 index. The report says `passed-native-only` only after all native cases and cleanup succeed; artifact collection never turns a failed workload into a pass. It does **not** qualify HAPI request composition/final onSend, HTTP cache semantics, AtomicAssets/AtomicMarket SQL parity, a live Wire node or full Wire/MongoDB replay. In-flight moize promise coalescing also remains pending integration/parity qualification.

MongoDB's [snapshot read specification](https://github.com/mongodb/specifications/blob/master/source/sessions/snapshot-sessions.md) and [snapshot read concern documentation](https://www.mongodb.com/docs/manual/reference/read-concern-snapshot/) define the nontransactional session semantics. The exact installed 7.2.0 `sessions.js`, `responses.js`, timeout and command executor sources are the evidence for the focused driver controls; physical server behavior remains a separate run.
