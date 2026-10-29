# Wire managed state qualification

This qualification-only plugin exercises the current managed state host for HAPI #191/#366.
It is disabled unless both the existing plugin state and chain configuration enable it, and
`qualificationOnly: true` is explicit. It is not a standard distribution plugin or a Wire release
compatibility declaration. MongoDB stores state and Elasticsearch retains history/source journals.

The plugin follows the existing `plugins/<name>/build/index.js` loader. Copy the complete
`tests/fixtures/wire-managed-state-v2/plugin` directory to a **new**
`plugins/wire-managed-state` directory in the selected checkout. Merge the example
`plugins.state.example.json` into the existing `plugins/.state.json` without replacing other
entries. Merge `config.overlay.json` into that checkout's complete `references/config.ref.json`;
the overlay alone is not a complete connection, API or indexer configuration. Choose a fresh
chain/index/database/generation and materialize private connection configuration separately.
No installation helper starts services or edits existing plugin state.

The existing entrypoints remain `build/indexer/launcher.js` and `build/api/server.js`, with the
ordinary `CONFIG_JSON` configuration selection. The master creates the existing projection
worker and routes request probes over the existing control path. No additional listener,
database port, broker or publication protocol is introduced by the plugin. A reviewed operator
must establish exact commands, current source range, initial LIB target, resource limits, service
ownership and cleanup before executing either entrypoint.

The original component packet used integration commit
`f66205cd85b322d84c86cd2bf7531bed3bd591d9` and SDK
`58d68c5cea81490bbb1c9a7736d633d465bab3ef`. This source-only composition starts from
HAPI #400 (`aae6ba6ecb8f6bf0145a8d5799784fe69b164a2f`) and retains its committed
locks: both caller and independently installed native adapter use SDK
`dd85ee590dcd1e359509c6c41ee99b541706b1f6`, while Wire
`18d235e34a9b7ab8c3e9f9a322874444d90eed8a` keeps its own SDK58d graph. Fastify
remains 5.12.7. The reviewed worker binding-fence fix from #399 and the original managed
plugin/historical proof components are composed without enabling either optional feature.
Run separate normal `npm ci --prefix packages/backend-mongodb --allow-git=all` and
`npm ci --allow-git=all`, `npm run build` and `bun check -p tsconfig.json`.

The two native Wire fixture callers explicitly admit
`stateful-owner-v2-dd85ee5-18d235e-engineering` before running their cases. CI selects the
same exact profile. Its separate normal-installed Wire716 recipe selects
`stateful-owner-v2-dd85ee5-7167659-engineering`, retaining Wire's own SDK339 graph.
The old SDK58d profiles retain their original predicates and refuse this new caller graph;
no profile is an alias or a default release compatibility claim. Historical proofs and managed
projection configuration remain opt-in, and the default ancestry limit remains 256.

## State and API

One compound projection selects the actual `sysio.msgch` `attseq` and `outenvelopes` tables.
It maintains exact uint64 strings, meaningful sequence/envelope fields, physical table IDs,
all raw key bytes, payer observations and separate secondary-index relationships. A secondary
entry never becomes a primary row or a synthetic scoped row. Deletions remove the exact
physical identity. The host resolves original ABI epochs and owns source admission, candidate
custody, durable effects, recovery, rollback and serving authority.

The plugin adds the private qualification route:

```text
GET /v2/qualification/wire/attseq/1067/0000000000000000
GET /v2/qualification/wire/outenvelopes/18398/0000000000000003
```

The route performs one request-scoped SDK composition and returns the actual stored row or
null. The API host supplies `hyperion-state-block-num`, `hyperion-state-block-id` and
`hyperion-state-last-valid`, revalidates publication and returns retryable 503 on owner/control
loss. The plugin supplies neither native queries nor readiness/header substitutes.

## Focused source qualification and remaining gates

Run the native focused test with Node 24 and Node 26:

```text
node --test tests/unit/wire-managed-state-v2-native.mjs
```

The test uses the unchanged original 1..1480 archive and member hashes, the current installed
Wire decoder/native-genesis path, real source journals/coordinator, actual plugin loader,
managed ProjectionWorker/controller, SDK owner-v2, Mongo adapter command fixture and API
request/probe/onSend code. Elasticsearch/Mongo commands and IPC/control transports are
controlled fixtures; no physical server or listener is started. State values are compared with
the independently retained official-clio barriers. This does not replace physical fullsync,
restart, rollback/fork or current-Hyperion-3 acceptance.

A source-preloaded-to-1480/fresh-owner-zero attempt was refused by the unchanged 256-block
canonical ancestry bound. The positive interleaved test keeps source/owner distance within that
bound. It must not be represented as cold historical catch-up. A source-authorized historical
proof path is implemented by the separately opt-in historical source port described below.
Do not increase the bound or synthesize a bootstrap snapshot to hide it.

One immutable declaration currently resolves its startup ABI epoch. A historical redeployment
catalogue/cutover under #389 remains a separate gate if the actual selected range contains more
applicable epochs. The plugin never pins a guessed first/final ABI or invents a deployment.
Current Wire testnet source coverage, ABI changes after the retained range, initial LIB catch-up,
physical durability and live continuation remain unverified until the reviewed operator runs.

## Opt-in historical source port (#389)

Leave `settings.protocol_abi_coordination.historical_certificates` absent to preserve the
existing default path. To qualify cold catch-up, explicitly supply all work limits:

```json
{
  "interface_version": 1,
  "max_commits_per_drain": 16,
  "max_commit_bytes_per_drain": 8388608,
  "max_ms_per_drain": 250
}
```

These are prospective qualification limits, not a measured throughput recommendation. The
commit-byte limit counts decoded canonical commit JSON examined in one background drain; the
small address queue is independently bounded by the same count/byte limits. Immutable-store
chunk, record, root and bucket limits, transport deadlines and request proof budgets still apply.
This setting is not a cap on aggregate network traffic. The work deadline is checked between
awaited operations; it does not extend an in-flight storage request or replace its timeout.
Queued live admissions interrupt the background walk between bounded store calls. An in-progress
store call retains its existing bounds; this path does not retry or cancel that physical call. Ordinary source
commits and history publication keep priority, and a historical failure leaves old sources
unavailable while recent source processing can continue.

The coordinator walks exact immutable commit IDs backward from its current adopted canonical
head. It verifies each complete parent/block link and genesis coverage, then prepares and reads
back certificates under the current owner/generation/profile. An exact-height locator is only
an address. The existing control CAS atomically selects a separate immutable address-map root, its
activation-certificate ID and the original verified anchor, followed by a settled root certificate; primary visibility, an orphan prepared locator or an unselected
root certificate cannot grant historical access. Reads use exact GETs through that selected
root and freshly revalidate current source authority after asynchronous operations. No search,
new progress journal, wider 256-link recovery window or bootstrap state is introduced. A normal
forward head retains that exact settled activation without re-sealing; current owner, generation,
selected root and anchor still undergo fresh checks. The activation certificate alone grants no
membership or current authority.

Owner replacement, reader-generation change or fork recovery clears activation and discards
the process-local walk. A replacement re-certifies from its currently adopted head; it cannot
adopt the old owner's or generation's historical certificates. Unknown acknowledgments remain
unavailable until the existing exact preparation/control repair path settles. Missing, corrupt
or no-longer-retained inputs remain explicit unavailable results. Newly issued historical proofs
still recheck owner/generation/root membership and final publication authority.

`node --test tests/unit/protocol-abi-history-native.mjs` covers those refusals, interrupted work
and recovery, and a fresh actual managed owner from checkpoint zero over original retained
blocks 1..258 after the source has reached258. It uses the unchanged default256 ancestry bound
and real absent genesis traces. This is controlled component evidence, not physical MongoDB/ES,
Hyperion-3 fullsync, whole retained-range cold catch-up, ABI redeployment/cutover or live acceptance.
The original commit and settled-head certificate formats are unchanged; the opt-in adds locator
records, a distinct immutable map root and an optional field on existing coordinator control.

The current address root inherits the existing map's256 hash buckets, each limited to20,000
entries and4MiB. That is an upper cardinality bound of5,120,000 addresses per active generation;
bucket skew and the existing byte/node limits may refuse sooner. This is not a global disk
retention quota. Immutable records from earlier roots/generations can accumulate, and no new
retention/garbage-collection policy is introduced here. A bounded drain batch publishes at most
one new selected address root. At the observed1.73million-plus Wire head, bucket rewrites,
certificate storage and re-walking after every authority rotation may dominate fullsync cost.
That is an unmeasured risk: scaled transport/storage cost, retention capacity and current-testnet
acceptance remain open. The0→258 fixture does not establish production readiness.
