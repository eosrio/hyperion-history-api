# Private action attempt observations

HAPI #284 adds source-bound observations to the guarded action-source admission engineering path. Public admission remains disabled. These records describe a processing stage; they do not authenticate terminal settlement, completeness, sink acceptance, capacity release, or readiness. #277 and production/release qualification remain open.

| Disposition | Eligible evidence | Output meaning |
| --- | --- | --- |
| `source-unprocessable` | Original missing traces/predecessor, or an explicitly tagged pure source validator failure | Unresolved; no invented plan, transaction ordinal, or zero-effect count |
| `policy-excluded` | Independently rederived effective policy excludes a source transaction | No output required at the source stage |
| `no-effects` | A complete explicit source vector or transaction has no expected groups | A dispatched transaction is observed only after its actual DS processing stage |
| `operator-disabled` | The captured `fetch_traces` or `disable_indexing` branch suppresses work | Expected membership remains intact and unresolved |
| `contract-output-incomplete` | An opaque fault issued at synchronous ABI/output validation with applicable original authority | No output authority; complete siblings remain unresolved |
| `raw-incomplete-handoff` | All expected groups have owned confirm **and** drain tickets, exact source membership, fragment and headers; at least one checked schema2 raw group | Confirmed broker handoff of the whole mixed group, without sink acceptance |

Generic `ActionSourceInventoryError` construction, error text, unavailable proof, and arbitrary async hook rejection do not issue a contract reason. Pure validation throw sites have a separate process-local tag. Existing schema1/Antelope hook failures retain narrower isolated diagnostics and acknowledgment behavior. A native hook failure may instead produce an independently checked raw handoff. Pre-admission quarantine retains its durable capsule-only boundary and cannot invent an admission-level record.

`ActionSourceAdmissionStore` prepares opaque owner/store-bound evidence through `prepareSourceAttemptDispositions`, `prepareTransactionAttemptDisposition`, `prepareContractAttemptDisposition`, or `prepareRawIncompleteAttemptDisposition`. `recordAttemptDisposition` freshly rederives the original association and requires all configured write copies, including an idempotent retry. `readAttemptDisposition` returns observed JSON only. The `h45actionattempt1:` identity hashes canonical `{work,disposition,reason}`; output is immutable value, so a different output for the same semantic observation conflicts. Different reasons and later successful handoffs may coexist.

Work includes retained source/admission/ingress, source selection, original block/capture and transaction/dispatch digests, policy, producer/configuration/plugin/executable pins, and physical target identity. Actual workers retain current source, channel, configuration, target and applicable original ABI/native view checks around new awaits. Store rederivation itself is not a fresh cluster or canonical grant. The parser awaits the MainDS ACK while original delivery scopes remain alive. New persistence failures escape contract-error catches before ACK.

Bounds are 100,000 records/effects, aggregate 128 MiB, 64 KiB headers, four top-level store operations and existing four CAS attempts. Ticket count and SUM checks precede payload copies/parsing. These validation bounds are not measured memory budgets.

Run the complete typechecks and normal native build before focused tests:

```sh
bun check -p tsconfig.json
bun check -p scripts/qualification/tsconfig.json
npm run build
HYPERION_NATIVE_NODE=/absolute/path/to/node bun test tests/unit/action-attempt-disposition-worker.test.ts
```

Use pinned Bun 1.4.4 / embedded TypeScript 7.0.2 and native Node 22/24. The test invokes emitted workers with the normally installed Wire716 provider/SDK339, original archive SHA256 `42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`, and controlled broker/cache/ES transports. Original genesis still omits traces. No genuine normal-policy no-effect source is claimed: the DS no-effect control uses unchanged block36 with overlapping `sysio::setabi` whitelist/blacklist; the explicit empty vector is constructed.

The mixed control encodes a new inline `setpriv` action under the actual certified system ABI alongside an original native root, then obtains fresh observations, source capture, coordinator proof and native grants. No provider decisions or grants are injected. Follow-on constructed inputs use monotonically increasing receipt sequences. Separate malformed ABI and untyped hook controls retain unresolved siblings and isolated progress. Held writes, unknown durability, original owner/configuration/target changes, concurrent-operation bounds and actual coordinator revocation are checked at MainDS/DS ACK seams. Controlled transport tests do not qualify RabbitMQ recovery, production workers, consensus, or the release.
