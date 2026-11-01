# Complete-kind native MongoDB controls

This runner is inert by default. `node runner.mjs --validate-plan` prints the plan;
`node --test offline.test.mjs` checks the evidence validator without a database.
Neither command qualifies MongoDB or starts a service.

The `projection-mongodb` CI matrix calls `ci.mjs NEW_EVIDENCE_DIRECTORY` on
Node 24 and 26. That controller accepts no URI or Docker target. It reuses the
existing `OwnedMongoFixture` fixed image digest, per-invocation labels, exact
container IDs, network/volume ownership and cleanup checks. It admits the source
profile before Docker effects, records the resolved image/container IDs, and
normally awaits the child and both log streams. Timeout or cleanup grace remains
failed. The workflow always uploads only that invocation's evidence directory.

Root owns physical execution after reviewing the exact Git-LF source profile.
Use the already prepared dedicated MongoDB 8.0.34 single-member replica set with
test commands enabled. The runner requires a loopback nondefault port, an empty
uniquely named database, explicit failpoint authority and a new evidence directory.
It creates no server, changes no application configuration and uses no public route.

```sh
export HYPERION_COMPLETE_KIND_MONGO_URI='mongodb://127.0.0.1:29555/?directConnection=true&replicaSet=h45_owned'
node scripts/qualification/stateful-complete-kind-mongodb/runner.mjs \
  --run --allow-failpoints --database h45_kind_0123456789ab --output /owned/new-evidence
```

The URI remains outside reports. Source admission precedes any client creation.
The managed host client is the actual nonretrying client used for native owner
operations, metadata and data transactions. Driver monitoring retains actual
commands, failures, cursor exhaustion, LSID/transaction identity and sanitized
metadata. Every counted data command requires a successful native metadata
inspection in its own snapshot. A separate retry-enabled client is only a
fault-harness positive control. A test-only gate arms an actual server failpoint
immediately before a data command; it does not synthesize replies or errors.

Cases cover true empty/nonempty exhaustion, exact fields and 64-bit text,
shared budgets, overflow refusal, adaptive retries, callback retries, foreign
tokens/clients/sessions, cancellation after native response, closed plugin port,
changed final view, persisted gap, takeover, rollback/replacement and declaration
refusal. Cursor/session/client closure and owned-database cleanup are recorded.
An already armed failpoint or nonempty database refuses admission; only a DB
carrying this invocation's random ownership marker can be dropped. Failed runs
retain reports and traces and fail process status, including cleanup failure.

`responseBytes` bounds successful SDK JSON envelopes/final composition. The
separate BSON reply estimates include authority/lifecycle work and are not wire,
compression, native buffer, documents-examined or query-CPU metrics. A failed
overflow probe may fetch one extra row. No public ordering or pagination contract
is inferred from incidental native row order.

This synthetic native-engine evidence is separate from a physical managed
worker/API source chain, real HTTP final-onSend fences, full Atomic parity and
public serving. Those remain downstream acceptance gates even after a successful
native run. Historical SDK/native profiles stay in their frozen assemblies.

The commands engineering profile additionally retains actual wire `maxTimeMS`
values: the initial find must equal the explicit operation bound and non-tailable
getMore must omit the field. Failure diagnostics retain bounded names, messages,
numeric/string codes and at most two nested causes, without stack or command
payloads. This preserves the server reason if cursor cleanup also fails.

The executor profile additionally requires a controlled full-driver
test using the actual root-managed client/session and the separately installed
adapter driver. It covers the public option allowlist, real execution/server
command path, exact initial bound, getMore omission, transaction callback retries,
shared attempt refusal and foreign-client refusal. Those controls have no socket
or database and cannot replace this physical replica-set run.

The `stateful-owner-v2-7412889-18d235e-complete-kind-metadata-engineering`
profile combines the reviewed canonical JSON and native metadata changes. Its
new native and caller inventories are pinned separately from every older
profile. The qualification gates use the bounded client's selected server
command boundary, await before sending and after the actual response, and leave
metadata, cleanup and unrelated clients outside those gates. Five focused
no-socket cases cover these gates, fault-triggered callback retry, cancellation
and argument/result identity. They supplement the six existing execution
controls and two pure source-profile checks; physical MongoDB remains a
separate CI requirement.

The current `stateful-owner-v2-7412889-69a6606-complete-kind-engineering` profile
pins the merged Wire hexadecimal codec source and exact installed Node/Rust
descriptor members. The SDK, MongoDB adapter and caller output inventories
remain unchanged; a separate caller package pin records the updated dependency.
All earlier profiles and outcomes retain their original source and artifact
pins. The same physical MongoDB cases and original replay/deadline/resource
gates remain required.
