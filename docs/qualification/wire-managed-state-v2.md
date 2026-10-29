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

The source base for this slice is integration commit
`f66205cd85b322d84c86cd2bf7531bed3bd591d9`, with its committed npm lock:
SDK `58d68c5cea81490bbb1c9a7736d633d465bab3ef`, Wire
`18d235e34a9b7ab8c3e9f9a322874444d90eed8a`, the merged native owner-v2 adapter and
Fastify 5.12.7. Run normal `npm ci`, `npm run build` and `bun check -p tsconfig.json`.
The legacy SDK339/Wire716 performance assembly is separate and is not aliased or adopted.

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
proof path remains necessary before a fullsync operator may safely let the source run far ahead
of a new state owner. Do not increase the bound or synthesize a bootstrap snapshot to hide it.

One immutable declaration currently resolves its startup ABI epoch. A historical redeployment
catalogue/cutover under #389 remains a separate gate if the actual selected range contains more
applicable epochs. The plugin never pins a guessed first/final ABI or invents a deployment.
Current Wire testnet source coverage, ABI changes after the retained range, initial LIB catch-up,
physical durability and live continuation remain unverified until the reviewed operator runs.
