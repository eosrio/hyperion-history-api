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
