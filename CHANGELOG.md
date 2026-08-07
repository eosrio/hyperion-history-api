# Changelog

## 4.1.0 (2026-08-07)

### New Features

*   **Hot-first routing for `get_actions` account polls** (PRs #176, #177 — opt-in, default off): unbounded newest-first account polls (e.g. `?account=X&limit=100`, desc, no time bound) previously fanned out across **every** `<chain>-action-*` partition — including old/warm/cold ones — even though the latest N actions all live in the newest partitions. With `api.hot_first_actions: true`, an eligible poll searches only the newest `api.hot_first_window` partitions first and widens to the full set **only if** that window returns fewer than `limit` hits, so heavy pollers on busy contracts never touch old shards. Eligibility is intentionally narrow: default `global_sequence`-desc sort, `skip=0`, no `after`/`before`; everything else keeps the existing path. The newest partitions are resolved via a TTL-cached (30s), stampede-safe `_cat/indices` lookup that degrades to the `<chain>-action-*` wildcard on any error — never failing a request. Responses served from the hot window carry `hot_first: true`. Also fixed along the way: `?hot_only=true` previously targeted a `<chain>-action` alias that nothing ever creates (guaranteed `index_not_found`); it now routes through the same resolver and actually works.

*   **Recent-first routing for `get_transaction`** (PR #180 — opt-in, default off): without a `block_hint`, a `trx_id` lookup carries no block range, so shard pre-filtering (`can_match`) cannot prune anything and every action partition — cold tier included — pays a term-dictionary seek per lookup. Since all of a transaction's action documents share a single block (hence a single partition), a recent-first probe is exact: with `api.hot_first_transaction: true`, the hot window (reusing `api.hot_first_window`) is searched first, a non-empty result is returned as-is (it is provably complete), and only a miss widens to the full `<chain>-action-*` set. Recent-transaction lookups never fan out to old shards; older or non-existent ids still resolve correctly via the fallback.

*   **Opt-in profiling for the `get_transaction` recent-first path** (PR #181): `api.hot_first_transaction_profiling: true` logs one `[gtx-profile]` line per `get_transaction` served without a `block_hint` — which phase served it (`hot`/`full`), per-phase Elasticsearch timings, and `parts_back` (how many partitions older than head the transaction was found in). Aggregating `parts_back` over a sample shows the block-age distribution of lookups, letting operators size `hot_first_window` from data instead of guessing. One log line per request — enable briefly to sample, then disable.

### Improvements

*   **`sort=asc` now accepts a `global_sequence` (or `block_num`) range as a valid bound** on `get_actions` (v2) (PR #182). Previously only `after`/`before` (ISO date or block number) satisfied the bound requirement, so a request like `get_actions?account=X&global_sequence=<from>-<to>&sort=asc` was rejected as unbounded even though the range already constrains the scan. Because `global_sequence` is the default sort field, such a range bounds the candidate set directly — there is no full-index reverse scan to guard against. Bare positive `global_sequence`/`block_num` values are accepted too; `0` and non-numeric input are not.

### Fixes

*   **Stream history replay hardened against unbounded cold-tier walks** (PR #178): a history replay (`start_from` in the streaming API) scrolls `<chain>-<type>-*` — every index, including the oldest cold-tier shards — and had three weaknesses that let a single aggressive client saturate a cold tier: (1) `stream_scroll_limit` unset *or* `-1` both meant **unlimited**, so one subscription could scroll all of history; (2) no concurrency limit — reconnect storms spawned unbounded parallel full-history scrolls; (3) early exits (scroll-limit reject, ack timeout, NACK) leaked the scroll context, pinning old segments until the 120s keepalive expired. Now: replays are capped at `api.stream_max_concurrent_replays` concurrent per API process (default 4, clear "server busy, retry" rejection beyond that), `stream_scroll_limit` defaults to **50000** when unset (`-1` still means unlimited but logs a loud warning past 100k docs), and the scroll context is released in a `finally` on every exit path.

*   **Row deletions (`present=0` deltas) can be indexed again** (opt-in): deletion deltas stopped being indexed when the delta-updater worker was removed in 4.0, so `get_deltas` only ever returned create/modify rows and operators tracking row removals (e.g. rows deleted from a deposits table) lost that history. Indexing of `present=0` contract-row deltas as distinct deletion documents is restored behind `features.index_deltas_deletions` (default off, to preserve current index sizes). Operators that need deletion history should enable it and reindex the affected range.

*   **`get_transaction` no longer masks Elasticsearch errors**: a non-404 ES error previously fell through to a `TypeError` on an undefined result; it now propagates with the real cause.

### New Config Options

New optional fields in the chain config:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `api.hot_first_actions` | `boolean` | `false` | Hot-first routing for unbounded latest-N `get_actions` account polls: search the newest partitions first, widen only if the window returns fewer than `limit` hits. |
| `api.hot_first_window` | `number` | `2` | Number of newest action partitions in the hot window (shared by `hot_first_actions` and `hot_first_transaction`). |
| `api.hot_first_transaction` | `boolean` | `false` | Recent-first routing for `get_transaction` without a `block_hint`: probe the hot window first, widen to all partitions only on a miss. |
| `api.hot_first_transaction_profiling` | `boolean` | `false` | Diagnostic: log one line per hint-less `get_transaction` with phase timings and `parts_back`, to size `hot_first_window` from data. Noisy — sample briefly. |
| `api.stream_max_concurrent_replays` | `number` | `4` | Maximum concurrent stream history replays per API process; excess replays are rejected with a retry message. |
| `api.require_bounded_asc` | `boolean` | `true` | When `false`, disables the `sort=asc` bound requirement (and the `max_asc_window_days` window check) on `get_actions` (v1 & v2). For self-hosted operators who accept the performance cost of unbounded ascending scans on their own infrastructure. |
| `features.index_deltas_deletions` | `boolean` | `false` | Index `present=0` contract-row deltas as deletion documents (restores pre-4.0 deletion history in `get_deltas`). |

### Behavior Changes

*   `api.stream_scroll_limit` left **unset** now defaults to `50000` docs per replay (previously unlimited). Existing configs with an explicit `-1` keep unlimited scrolls (now logged past 100k docs), but the new concurrency cap applies regardless.
*   With `api.hot_first_actions` enabled, a poll served from the hot window reports a `total` that reflects the hot window only (these polls already cap `total` at 10k, so the impact is limited) and carries `hot_first: true` in the response.
*   `sort=asc` on `get_actions` (v2) is satisfied by **any** of: a valid `after`/`before`, or a `global_sequence`/`block_num` range/value.
*   Setting `api.require_bounded_asc: false` makes `sort=asc` behave as it did before the v4.0.3 guard — no bound required, no window cap. The guard remains **on by default**.

### Internal

*   `get_actions` account/generic/code-action filters briefly moved to Elasticsearch filter context (PR #176) and were reverted back to scoring context (PR #179): for low-selectivity accounts over large cold-tier segments, building the query-cache bitset costs far more than the BM25 scoring it saves and defeats index-sort early termination. Net change across the two PRs: none (time-range filters remain in filter context, as before).

## 4.0.8 (2026-06-02)

### Fixes

*   **`get_actions` `sort=asc` rejected mixed date/block bounds**: combining a block-number bound with an ISO-date bound (e.g. `after=<block>&before=<ISO date>`) returned `400 Invalid time value [after]`, because `after` and `before` were forced into a single date-*or*-block branch and the block number was then passed to `new Date(...)`. Each bound is now classified independently — a bare positive integer filters on `block_num`, anything else on `@timestamp` — and the two can be mixed, in both v1 and v2. This makes the documented escape hatch for querying ranges older than `max_asc_window_days` actually usable: pass block numbers for the bound(s), which legitimately bypass the recency window. The `sort=asc … must be within the last N days` error message now points operators at that workaround. Specifically:
    *   Classification uses a strict integer test (`Number.isInteger(Number(v)) && Number(v) > 0`) rather than `parseInt`, so a date without a `T` (e.g. `2026-01-01`) is no longer misread as block number `2026`.
    *   The `sort=asc` recency window now applies to **any** date `after` bound, not only strings containing `T` — closing a hole where `after=2020-01-01` (or `after=0`, which parses to year 2000) bypassed the guard entirely.
    *   The **v1** route schema no longer pins `after`/`before` to `format: date-time`, so block-number bounds reach the handler (previously rejected by schema validation before `getActions` ran). v1 also gains real `block_num` filtering — previously a block-number `after`/`before` was silently dropped into the `@timestamp` range.

*   **`/v2/state/get_tokens` missing balances — token-contract detection in `sync accounts`**: `./hyp-control sync accounts` (and `sync all`) resolved a contract's transfer parameter struct by the hard-coded struct name `"transfer"`. Per the ABI spec the struct backing an action is named by the action's `type` field, which is frequently *not* the action name — e.g. several contracts declare a fully standard transfer (`from:name, to:name, quantity:asset, memo:string`) under the struct name `transfer_token`. Those contracts were silently skipped, so their balances were never backfilled into the MongoDB `accounts` collection and `get_tokens` returned only the symbols the live indexer happened to capture — producing a "same contract, some symbols present and some missing" result on upgraded nodes. The struct is now resolved through the transfer action's declared `type`. **After upgrading, re-run `./hyp-control sync accounts <chain>` (or `sync all`) to backfill the previously skipped contracts.**

*   **`ds_pool` dropped traces for unassigned contracts** (PR #169): in heatmap routing mode, a contract with no heatmap assignment yet — fresh or low-traffic chains, or any contract not seen since the last `update_pool_map` — had its traces published to `ds_pool:2` due to an off-by-one: `selected_q` was initialized to `1` and then incremented, while `ds_pool` workers consume `ds_pool:1..ds_pool_size`. With `scaling.ds_pool_size: 1` only `ds_pool:1` exists, so those traces went to a queue with no consumer. Unassigned contracts now route to the first worker (`ds_pool:1`).

*   **`hyp-control indexer stop` failed on pre-4.0 configs**: the CLI client and repair tool did not fall back to control_port `7002` when the field was absent from `connections.json` (the indexer master already did), producing `Invalid URL: ws://localhost:undefined/local`. All three CLI entrypoints now mirror that fallback and warn so the operator can add the field explicitly.

### Improvements

*   **Accurate live progress for `sync accounts`** (PR #171): the progress line was driven by completed-contract counts under misleading names, so a single-contract sync sat at `0/1 (0.00%)` and looked stuck. It now surfaces continuously-moving "holders scanned" and "balances" counters, shows the contract currently in progress, and resets per-contract scope state cleanly.

### Security

*   **`ws` — *Uninitialized memory disclosure* (GHSA, medium)**: the direct `ws` dependency was already `8.20.1`, but transitive dependencies still resolved `ws@8.17.1` / `8.18.x` (< 8.20.1), leaving the advisory open. Added an `overrides` entry pinning `ws` to `8.20.1` across the dependency tree; both lockfiles were regenerated.

### Maintenance

*   Dependency bumps: `nodemailer` 8.0.7 → 8.0.10, `ioredis` 5.10.1 → 5.11.0, `@types/node` 25.5.0 → 25.9.1.
*   CI now runs Build & Test on `dev` (push + PRs), not only `main` (PR #168).

## 4.0.7 (2026-05-16)

> **4.0.6 was skipped.** The 4.0.6 version sat on `main` untagged for a period and some operators deployed it directly from `main` before any release tag existed. To avoid ambiguity between those pre-tag production deployments and the official artifact, this work is released as **4.0.7**. There is no separate 4.0.6 entry. Going forward, `main` only advances to tagged releases and active development happens on `dev`.

### New Features

*   **Optional pm2-independent deployment**: Hyperion can now run under **systemd** instead of pm2. Adds `systemd/hyperion-api@.service` and `systemd/hyperion-indexer@.service` unit templates (mirroring pm2 semantics — API `Restart=always`, indexer `Restart=no` with a graceful controller `ExecStop`), plus an opt-in `HYP_NO_PM2=1` mode for `./run` / `./stop` that routes to `systemctl`. **pm2 remains the default and is unchanged when `HYP_NO_PM2` is unset.** Scope is single-instance: pm2 cluster-mode scaling (`api.pm2_scaling`) is intentionally *not* reproduced without pm2.

### Fixes

*   **`sync all` skipped permissions**: `./hyp-control sync all <chain>` now runs the permissions synchronizer (previously only voters/accounts/proposals/contract-state) with a proper indexer pause on the `state` worker. The standalone `sync permissions` command was also routed through pause/resume, closing a pre-existing race with the live indexer.
*   **Contract-state sync crashed on a bad chain config**: a malformed or missing `config/chains/<chain>.config.json` now produces a clear, actionable error naming the file and parse problem, and no longer aborts the rest of `sync all`.
*   **`./stop <chain>-api` stopped the wrong thing**: `./stop` blindly treated every argument as an indexer, so stopping an API tried to reach a nonexistent indexer controller. It now mirrors `./run` routing — `-api` → `pm2 stop`, `-indexer` → graceful controller stop, bare chain → both.
*   **Redis on a replica / Sentinel topology** (PR #164, thanks @rwcii): startup cache-invalidation `DEL`s now tolerate `READONLY` (transient Sentinel failover or replica-pointed clients) instead of crash-looping; non-`READONLY` errors still propagate. `RedisConfig` now surfaces auth + Sentinel fields (passthrough was always supported, now discoverable in the types).
*   **Indexer status check no longer assumes pm2**: the `hyp-es-config` repartition guard now probes the indexer control socket (`isOnline()`) instead of shelling out to `pm2 jlist` — works under pm2, systemd, or bare node, and fixes a latent bug where the old process-name filter never matched real pm2 names.
*   **Query validation**: invalid query parameters now return HTTP **400** instead of 500; E2E test suite fixes.
*   **Action regrouping**: correctly handles notifications and inline actions.

### Maintenance

*   Dependency refresh: `@wharfkit/antelope` 1.2.0, `amqplib` 2.0.1, `mongodb` 7.2.0, `fastify` 5.8.5, `undici` 8.3.0, `ws` 8.20.1, `zod` 4.4.3, `typescript` 6.0.3, `uWebSockets.js` v20.67.0, plus Fastify plugin patches. Reconciled `package.json` / `bun.lock` / `package-lock.json` (they had drifted three ways on `uWebSockets.js`).

### Upgrade Notes

*   **Platform requirement — glibc ≥ 2.38 (Ubuntu 24.04+)**: `uWebSockets.js` prebuilt binaries require `GLIBC_2.38`. Hyperion's API/stream and indexer-controller **will not start on Ubuntu 22.04 (glibc 2.35)** — the symptom is `GLIBC_2.38 not found ... uws_linux_x64_*.node`. This is unchanged by the dependency bump (all versions in range need 2.38); it is now documented. Remediation: upgrade the OS, run in a glibc ≥ 2.38 container, build `uWebSockets.js` from source, or — to stay on Ubuntu 22.04 — force-install the last glibc-2.35-compatible build after each rebuild: `npm install --no-save github:uNetworking/uWebSockets.js#v20.52.0` ([v20.52.0](https://github.com/uNetworking/uWebSockets.js/releases/tag/v20.52.0)).
*   If you relied on `./hyp-control sync all <chain>` to populate state, re-run it once after upgrading to backfill the MongoDB `permissions` collection that was previously skipped.

### Acknowledgements

*   Thanks to [@eosusa](https://github.com/eosusa) for the field reports that drove several of these fixes — the launcher / process-management issues (`./stop` on the API process, the glibc startup failure) and the `sync all` failures (contract-state on a bad chain config). And to [@rwcii](https://github.com/rwcii) (#164) for the Redis replica/Sentinel resilience work.

## 4.0.5 (2026-03-31)

### Fixes

*   **Notification Dedup Regression** (High — affects transaction query correctness): A v4.0.4 regression stored notification traces (e.g. `eosio.token::transfer` notifications) as **separate documents** instead of merging them into a single action with multiple receipts, causing `get_transaction` to return duplicate transfer actions (exchanges triple-counting deposits).
    *   **Indexer**: dedup grouping key changed to `creator_action_ordinal`, correctly distinguishing notifications (merge with parent) from genuinely distinct duplicate actions (kept separate, per #148).
    *   **API (no re-index required)**: `v1` and `v2` `get_transaction` re-group fragmented notification documents on read, so v4.0.4-indexed data returns correct responses immediately after upgrading. The v2 response now includes a `notified` field (comma-separated notified accounts).
*   **Duplicate identical actions in the same transaction** (#148): genuinely distinct duplicate actions are now preserved instead of being collapsed.
*   **Proposal transaction data** (#154): the indexer now stores proposal transaction data in MongoDB during live indexing.
*   **0-precision tokens** (#131): `/v2/state/get_tokens` now handles 0-precision tokens correctly.

### Testing

*   Comprehensive Playwright explorer E2E suite (standalone execution, recursive nested-suite report parsing, SSR SSRF/themes fixes).

### Upgrade Notes

*   Pull and rebuild from `v4.0.5`, then restart the API. Optionally re-index from blocks to reclaim ~3× storage overhead from fragmented v4.0.4 documents.

## 4.0.4 (2026-03-22)

### Fixes

*   **Health Report Indicator Error**: Fixed `resource_not_found_exception: Did not find indicator shards_availability,disk` caused by the `@elastic/elasticsearch` client serializing the `feature` array into a comma-joined URI path. The health report now fetches all indicators and extracts `shards_availability` and `disk` locally. Also raised the version gate from ES 8.7 to 8.12 (when `shards_availability` was introduced).
*   **Fastify Deprecation**: Moved `ignoreTrailingSlash` into `routerOptions` to resolve Fastify 5 deprecation warning ahead of Fastify 6 upgrade.
*   **State Route Double-Callback**: Fixed `"Callback was already called"` error in the MongoDB state ingestor when a cargo batch contained both `permission` and `permission_link` messages. Both `bulkWrite` operations now resolve via `Promise.all` before invoking the callback once.
*   **Streaming Debug Logs**: Gated all verbose `console.log`/`console.table` calls in `ws-router.ts` and `socketManager.ts` behind `debugLog` (controlled by `config.settings.debug`).
*   **Stray Console Logs**: Replaced raw `console.log` calls with `hLog` across `server.ts`, `indexer.ts`, `mongo-routes.ts`, and `health.ts` for consistent structured logging.

### Improvements

*   **Config Wizard ES Host Prompt**: Added `--es-host` CLI option and interactive host:port prompt to `hyp-config connections init`.
*   **Reference Config**: Set `mongodb.enabled: true` in `connections.ref.json` (mandatory in v4) and cleared the example chain entry.

## 4.0.3 (2026-03-20)

### Security

*   **Configurable Query Guards for `sort=asc`**: Prevents unbounded ascending sort queries on `get_actions` (v1 & v2) that could overload Elasticsearch by forcing full reverse segment scans across all shards.

### New Config Options

Two new optional fields in the `api` section of the chain config:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `query_timeout` | `string` | `"10s"` | Elasticsearch search timeout per query |
| `max_asc_window_days` | `number` | `90` | Maximum time range (in days) for `sort=asc` requests |

### Behavior Changes

*   `sort=asc` on `get_actions` now **requires** a valid `after` or `before` parameter:
    *   ISO date strings (must contain `T`, e.g., `2026-03-19T00:00:00Z`)
    *   Positive integer block numbers (e.g., `425000000`)
*   ISO date `after` values must be within `max_asc_window_days` of the current time.
*   All `get_actions` queries (v1 + v2) now include a configurable Elasticsearch `timeout`.
*   `sort=desc` (default) is **unchanged** — no new restrictions apply.

### Testing

*   Added 17 unit tests for `getSortDir` validation covering bounds checks, max window enforcement, block number acceptance, and garbage input rejection.

---

## 4.0.2 (2026-03-18)

### Testing

*   **E2E High-Fidelity Test Framework**: 8-phase Docker-based test pipeline with port-isolated infrastructure, contract deployment, manifest-based load generation, and integrity checking.
*   **CI Workflow**: Target main branch, integrate unit tests into CI pipeline.

### Maintenance

*   Updated all dependencies and fixed security vulnerabilities.

---

## 4.0.1 (2026-03-08)

### Fixes

*   **Dynamic `global-agent` Loading**: Load `global-agent` dynamically via `createRequire` to resolve ESM import errors.

### Maintenance

*   Upgraded all dependencies.
*   Added unit test suite (Bun-based) for API helpers, common functions, and config validation.

---

## 4.0.0-beta.5 (2025-11-04)

### Fixes

*   **IndexerController**: Guard against missing chain config in `connect()` — reject and clear `connectionPromise` when config is not found.
*   **getFirstIndexedBlock**: Handle empty `cat.indices` results, add try/catch with error logging.

### Maintenance

*   Dependency updates: `@elastic/elasticsearch` → 9.2.0, `commander` → 14.0.2, `ioredis` → 5.8.2, `typescript` → 5.9.3, `uWebSockets.js` → v20.55.0, `zod` → 4.1.12.

---

## 4.0.0-beta.4 (2025-09-30)

### Features

*   **RabbitMQ Install Script**: Added `rabbit.sh` for automated RabbitMQ installation on Ubuntu.
*   **Explorer Oracle Metadata**: Explorer metadata route now includes oracle configuration.

### Fixes

*   MongoDB client typing workaround for type compatibility.
*   Plugin loading cleanup — removed noisy error logs, improved type definitions.

### Maintenance

*   Dependency updates: `@elastic/elasticsearch` → 9.1.1, `fastify` → 5.6.1, `mongodb` → 6.20.0, `typescript` → 5.9.2, `zod` → 4.1.11.

---

# Changelog - Hyperion History API 4.0.0-beta.3 (pre-release)

This changelog summarizes the significant changes leading up to the `4.0.0-beta.3` release, based on Pull Request #157.

## Project Evolution & Ecosystem

*   **Full TypeScript Migration with ES Modules (Strict Mode)**:
    *   The entire Hyperion History API codebase has been migrated to **TypeScript**.
    *   The project now utilizes modern **ES Modules** and is compiled in **strict mode**, significantly enhancing code quality, maintainability, and the developer experience.

*   **Complete Migration from eosjs**:
    *   Replaced `eosjs` functionality with a combination of `@wharfkit/antelope` library and `node-abieos`
    *   `node-abieos` continues to handle high-performance deserialization needs
    *   `@wharfkit/antelope` provides modern TypeScript-first blockchain interaction APIs
    *   New `fastify-antelope` plugin provides centralized chain API access
    *   Enhanced serialization/deserialization with dual support and automatic fallback between both libraries

*   **Standalone Hyperion Explorer**:
    *   Compatibility with the new **standalone Hyperion Explorer**. The explorer application is now a separate project, available at [https://github.com/eosrio/hyperion-explorer](https://github.com/eosrio/hyperion-explorer), and is no longer a Hyperion plugin.

*   **New Delphi Oracle Plugin & HPM**:
    *   Introduction of the [hyperion-delphioracle-plugin](https://github.com/eosrio/hyperion-delphioracle-plugin). This new plugin allows Hyperion instances to track and serve data from on-chain price oracles, such as those powered by DelphiOracle.
    *   The **Hyperion Plugin Manager (hpm)** remains fully functional for installing and managing this new plugin and existing ones.

## Key Architectural Changes

*   **State Queries Overhauled: Hybrid MongoDB & Elasticsearch Architecture**:
    *   A fundamental re-architecture of state queries, with MongoDB handling contract state and Elasticsearch managing historical data. This major shift aims to significantly enhance performance, scalability, and query flexibility.
    *   Introduces the **Hyperion Account State Synchronizer** (`8ebf919`) as the core engine for this new MongoDB-based state management.
    *   New `state-reader` worker with advanced ABI caching and serialization strategies.
    *   Fallback mechanisms between `node-abieos` and Antelope deserializers for maximum compatibility.
    *   Provides robust support for **custom contract indexing**. Operators can now define how data from specific smart contracts is indexed and made available for queries, powered by a new `custom_indexer_controller` (`c5711a5`).

*   **Streaming SDK Rewrite**:
    *   The client-facing **Streaming SDK has been completely rewritten** (`@eosrio/hyperion-stream-client` v3.6+). This overhaul focuses on improved performance, expanded features, and better maintainability for developers building real-time applications on Hyperion.
    *   **Enhanced Developer Experience**: New TypeScript-first API with full ES Modules support, AsyncIterator pattern for sequential data processing, and flexible event-driven architecture
    *   **Powerful Filtering & Data Consumption**: Server-side filtering with dot-notation support, dual consumption patterns (event-driven and AsyncIterator), and automatic metadata processing
    *   **Robust Connection Management**: Automatic reconnection with replay capabilities, connection timeout controls, and comprehensive error handling
    *   **Migration Note**: The new streaming client (v3.6+) is only compatible with Hyperion servers v3.6 onwards

*   **Advanced Index Management (Elasticsearch)**:
    *   Significant enhancements to Elasticsearch index lifecycle management. Hyperion now offers built-in capabilities for **auto-pruning** of aged data and implementing **tiered storage allocation rules**.
    *   This advanced index management operates independently of Elastic's built-in policies, providing operators with more direct and granular control over their Hyperion data on Elasticsearch.

## New Features & Major Enhancements

*   **Comprehensive State Synchronization Suite**:
    *   `sync-accounts`: Synchronizes complete account metadata including creation date, permissions, and resource limits
    *   `sync-permissions`: Rebuilds permission hierarchies and tracks permission changes over time
    *   `sync-voters`: Tracks voting power, delegations, and producer votes for governance analysis
    *   `sync-proposals`: Indexes multisig proposals with their approval status and execution state
    *   `sync-contract-state`: Enables custom indexing of smart contract tables and state changes

*   **Enhanced Repair CLI (`hyp-repair`)**:
    *   New `scan-actions` feature for deep action data validation
    *   Added `monitor` mode for real-time repair tracking
    *   Improved interfaces for repair operations with better error recovery
    *   New `APIClient` integration for direct chain queries during repairs

*   **Extensive CLI Tooling Updates**:
    *   This release brings numerous updates and enhancements across the suite of **Command Line Interface (CLI) tools**. These changes improve usability, add new functionalities, and resolve existing bugs.
    *   Notable additions include a new **Table Scanner Helper** (`cfb2188`) for data diagnostics or management.
    *   The `hyp-repair` tool has received fixes, including improved Elasticsearch library compatibility (`9738d1f`), and now includes a new **`scan-actions`** feature for more targeted diagnostics and repair of action data.

## API & Endpoint Changes

*   **New Route: `/v2/stats/get_trx_count`**: Adds a new endpoint to retrieve transaction counts, likely with various filtering options.
*   **New Route: `/v2/history/get_block`**: Adds a new endpoint to fetch individual block details.

## Breaking Changes

*   **MongoDB Now Required**:
    *   MongoDB is now a mandatory dependency for state queries and contract indexing
    *   State table indices on Elasticsearch are deprecated and will stop receiving updates
    *   All state-related data will be migrated to MongoDB for improved performance and most importantly, less disk wear

*   **Configuration File Location**:
    *   Configuration files must be moved to the new `config` directory
    *   Legacy configuration locations are no longer supported

*   **API Response Format Changes**:
    *   Modified error response formats for better consistency
    
*   **Plugin Compatibility**:
    *   Existing plugins may need updates for TypeScript strict mode
    *   Custom deserializers must handle new Antelope type system

## Migration from 3.x

*   **Required Actions**:
    1. Install MongoDB (now required for state queries)
    2. Move configuration files to the new `config` directory
    3. Review custom plugins for TypeScript compatibility
    4. Test streaming clients with new SDK
    
*   **For detailed migration instructions, see the official documentation at**: https://hyperion.docs.eosrio.io/
    
*   **Deprecations**:
    *   Legacy streaming API protocol deprecated

## Other Fixes & Improvements

*   **Type Safety for `account_name` (`45e63da`, `5d14196`, `32c2530`)**: Multiple commits ensure correct type handling for account names.
*   **Memory Usage Optimization (`11cc4b9`)**: Implements changes to reduce the memory footprint of Hyperion services.
*   **Monitoring Enhancements (`da8025c`, `8a448eb`)**: Improvements to internal monitoring capabilities.
*   **Logging System Fixes (`5b5fc88`)**: General fixes and improvements to the logging infrastructure.
*   **Controller Connection Sequence (`1d31968`)**: Updates and refines the connection sequence for the Hyperion controller service.

## Maintenance & Internal (Selected Commits from PR #157)

*   **Dependency Updates & Code Cleanup (`a6ad50f`, `d2964aa`, `522ece3`)**.
*   **Log Output Refinements (`7e90eaf`, `4d596dd`, `843b6b8`, `60018a0`)**.
*   **Repository Maintenance (`145e1c0`)**: Removal of ignored files.

*Note: Commit SHAs in parentheses refer to commits within PR #157 that are indicative of the described changes. Some high-level changes reflect broader development efforts not captured by a single commit.*
