# Private action-handoff worker outcomes

Issue [#282](https://github.com/eosrio/hyperion-history-api/issues/282) records a successful
confirmed broker handoff for one retained original source transaction before the DS worker
acknowledges its original input. It supplies no capacity release, sink completion, canonical
readiness, or public activation. The existing source-admission engineering gate remains disabled
for operators. Future recovery must obtain fresh authority; `readConfirmedHandoff` only observes
a retained record.

The private publication helper preserves the existing `Promise<void>` entry point and adds
opaque process-local evidence after mandatory, persistent publication confirms **and** any
required drain. It detaches payload bytes, relevant headers, original channel identities and the
original ownership predicate before awaiting confirmation. Serialized, fabricated, stale and
wrong-owner tickets cannot become successful handoffs. Raw MainDS dispatch tickets are rejected
by the final-action route, exact body, admission and prepared-fragment checks.

`ActionSourceAdmissionStore.recordConfirmedHandoff` freshly resolves the retained source and
inventory, validates the exact original dispatch and current captured producer configuration,
and reuses whole-transaction preparation. The semantic ID binds the original source/selection,
transaction ordinal and digest, producer/code/config/plugin identities, target name/UUID and
prepared plan. Its effect root binds the full fragment, exact confirmed canonical payloads and
headers, and final-action route. Random message IDs and valid round-robin queue positions do not
change that ID. A changed root conflicts. An idempotent retry still obtains fresh configured-copy
write receipts; a primary read never repairs uncertain durability by itself.

Persistence is outside the contract-incomplete error catch. Existing cache, target, owner,
configuration, source/proof and native-output checks precede it and repeat afterward, before
ACK. Issued contract proof views survive `processTraces` cleanup through this await. Disabled
indexing, filtered/effect-free work and incomplete output do not become successful outcomes;
their existing isolated processing paths remain in place. Missing genesis traces remain missing.

Validation bounds are 100,000 publications, a SUM of 128 MiB of retained payload/header bytes,
64 KiB per header object, positive uint32 configured action-queue indices, four concurrent store
operations and the existing four immutable-store CAS attempts. Configuration and dispatch are
also bounded before copying. These are input validation caps, **not measured memory budgets**.
No additional in-memory queue, persisted attempt directory, service, dependency, source protocol,
proof window, public API or SDK interface is introduced.

## Reproduce the focused worker checks

From a normally installed checkout (`npm ci --allow-git=all`, committed lockfile and allowScripts
policy), emit the native TypeScript build with Node 24 or 26, run the complete project check,
then run the following with pinned Bun 1.4.4 and the chosen native Node in `HYPERION_NATIVE_NODE`:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json
bun check -p tsconfig.json
bun test tests/unit/action-confirmed-publication.test.ts tests/unit/action-handoff-outcome-worker.test.ts
```

The child executes actual emitted reader, MainDS, DS, source-binding/observation/coordinator,
inventory/admission and immutable-store implementations. It selects installed SDK `339b5c9`
and Wire `7167659` normally under `wire-sysio-6508c9e8-native-engineering-v1`; no provider facade,
native decision injection or Antelope addon fallback is used. The original archive remains
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7` and its preparation/schema/member
hashes are checked. Actual original frames 1 through 39 are authenticated, with the independent
installed native oracle for block 33. Original block 36 independently derives the two-effect
contract transaction `140abb3d398f206518e117c02ccf1f1604b37b9fb55f7abed2034cf2fb374c66`,
trace ordinal 1: `sysio::setcode` sequence `45` and `sysio::setabi` sequence `46`.

The baseline RED reaches the original DS ACK with correct original native output but no handoff
record. The focused GREEN checks confirm/drain/write/receipt/ACK ordering; fresh real ticket
retry across valid queue positions; opaque ticket, raw-dispatch, header and conflicting-root
refusals; unknown primary-visible write without ACK followed by a fresh durability repair;
final I/O failure outside the contract-error catch; partial two-effect confirmation; owner,
configuration and target changes during persistence; configuration mutation during the final
target read; caller snapshot hashes; count/aggregate admission before copies; cancellation;
four held operations and fifth refusal with lease recovery; and original contract authority
revoked during the held outcome write after the transient proof has already been cleared.

Broker confirms, cache/storage transports, held writes, NACKs, replacement owners/targets and
hook failure are explicitly **constructed controls**. Operator-disabled block 37 and filtered
block 38 use real original inputs with freshly captured policy/configuration. The constructed
hook failure on real block 39 follows the existing `native_output_incomplete` raw fallback,
creates no successful handoff and leaves unrelated original work able to progress. Genesis
block 1 genuinely lacks traces; the fixture never invents an empty trace vector. These checks
qualify the private worker ordering and validation logic, not a real broker, cluster durability,
full Wire worker launch, recovery coordinator, capacity or release. Real Elasticsearch component
qualification is recorded separately in `action-source-journal.md`.
