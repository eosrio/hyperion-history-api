# Changelog

## 4.0.4 (2026-03-22)

### Fixes

*   **Fastify Deprecation**: Moved `ignoreTrailingSlash` into `routerOptions` to resolve Fastify 5 deprecation warning ahead of Fastify 6 upgrade.
*   **State Route Double-Callback**: Fixed `"Callback was already called"` error in the MongoDB state ingestor when a cargo batch contained both `permission` and `permission_link` messages. Both `bulkWrite` operations now resolve via `Promise.all` before invoking the callback once.
*   **Streaming Debug Logs**: Gated all verbose `console.log`/`console.table` calls in `ws-router.ts` and `socketManager.ts` behind `debugLog` (controlled by `config.settings.debug`).
*   **Stray Console Logs**: Replaced raw `console.log` calls with `hLog` across `server.ts`, `indexer.ts`, and `mongo-routes.ts` for consistent structured logging.

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
