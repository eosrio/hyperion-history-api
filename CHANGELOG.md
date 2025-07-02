# Changelog - Hyperion History API 4.0.0-beta.3 (Preview)

This changelog summarizes the significant changes leading up to the `4.0.0-beta.3` release, based on Pull Request #157 (targeting the `release/4.0` branch) and detailed information from project maintainers.

## Project Evolution & Ecosystem

*   **Full TypeScript Migration with ES Modules (Strict Mode)**:
    *   The entire Hyperion History API codebase has been migrated to **TypeScript**.
    *   The project now utilizes modern **ES Modules** and is compiled in **strict mode**, significantly enhancing code quality, maintainability, and the developer experience.

*   **Dependency Modernization**:
    *   The `eosjs` library has been **removed** as a core dependency.
    *   Hyperion now leverages the latest version of `node-abieos` for efficient ABI processing and utilizes libraries from the **Wharfkit/Antelope** suite for blockchain interactions.

*   **Standalone Hyperion Explorer**:
    *   Compatibility with the new **standalone Hyperion Explorer**. The explorer application is now a separate project, available at [https://github.com/eosrio/hyperion-explorer](https://github.com/eosrio/hyperion-explorer), and is no longer a Hyperion plugin.

*   **New Delphi Oracle Plugin & HPM**:
    *   Introduction of the [hyperion-delphioracle-plugin](https://github.com/eosrio/hyperion-delphioracle-plugin). This new plugin allows Hyperion instances to track and serve data from on-chain price oracles, such as those powered by DelphiOracle.
    *   The **Hyperion Plugin Manager (hpm)** remains fully functional for installing and managing this new plugin and existing ones.

## Key Architectural Changes

*   **State Queries Overhauled: MongoDB & Custom Contract Indexing**:
    *   A fundamental re-architecture of state queries, migrating primary responsibility to **MongoDB**. This major shift aims to significantly enhance performance, scalability, and query flexibility.
    *   Introduces the **Hyperion Account State Synchronizer** (`8ebf919`) as the core engine for this new MongoDB-based state management.
    *   Provides robust support for **custom contract indexing**. Operators can now define how data from specific smart contracts is indexed and made available for queries, powered by a new `custom_indexer_controller` (`c5711a5`).

*   **Streaming SDK Rewrite & QRY Hub Integration**:
    *   The client-facing **Streaming SDK has been almost completely rewritten**. This overhaul focuses on improved performance, expanded features, and better maintainability for developers building real-time applications on Hyperion.
    *   Introduces the **QRY Hub Publisher** (`bb1068c`, `466d955`), a new system for publishing data streams, forming a key part of the new SDK infrastructure.

*   **Advanced Index Management (Elasticsearch)**:
    *   Significant enhancements to Elasticsearch index lifecycle management. Hyperion now offers built-in capabilities for **auto-pruning** of aged data and implementing **tiered storage allocation rules**.
    *   This advanced index management operates independently of Elastic's built-in policies, providing operators with more direct and granular control over their Elasticsearch clusters.

## New Features & Major Enhancements

*   **Extensive CLI Tooling Updates**:
    *   This release brings numerous updates and enhancements across the suite of **Command Line Interface (CLI) tools**. These changes improve usability, add new functionalities, and resolve existing bugs.
    *   Notable additions include a new **Table Scanner Helper** (`cfb2188`) for data diagnostics or management.
    *   The `hyp-repair` tool has received fixes, including improved Elasticsearch library compatibility (`9738d1f`), and now includes a new **`scan-actions`** feature for more targeted diagnostics and repair of action data.

## API & Endpoint Changes

*   **New Route: `/v2/stats/get_trx_count`**: Adds a new endpoint to retrieve transaction counts, likely with various filtering options.
*   **New Route: `/v2/history/get_block`**: Adds a new endpoint to fetch individual block details.
*   **`/v2/state/get_top_holders` Fix (`4c376bc`)**: Corrects the Elasticsearch response format or content for the `get_top_holders` endpoint.
*   **Health Check Precision (`c3e3567`)**: The health check endpoint now enforces numerical precision for active shard counts, offering more accurate cluster status reporting.
*   **API History Publishing Fix (`e15daf9`)**: Addresses issues related to the publishing of API history data, potentially linked to the new streaming SDK.

## Other Fixes & Improvements

*   **Type Safety for `account_name` (`45e63da`, `5d14196`, `32c2530`)**: Multiple commits ensure correct type handling for account names.
*   **Memory Usage Optimization (`11cc4b9`)**: Implements changes to reduce the memory footprint of Hyperion services.
*   **Monitoring Enhancements (`da8025c`, `8a448eb`)**: Improvements to internal monitoring capabilities.
*   **Performance: Scope Loop Optimization (`cac1a68`, `3e0df9c`, `8048a23`)**: Addresses a repeated scope loop, likely resulting in performance gains.
*   **Logging System Fixes (`5b5fc88`)**: General fixes and improvements to the logging infrastructure.
*   **Controller Connection Sequence (`1d31968`)**: Updates and refines the connection sequence for the Hyperion controller service.

## Maintenance & Internal (Selected Commits from PR #157)

*   **Dependency Updates & Code Cleanup (`a6ad50f`, `d2964aa`, `522ece3`)**.
*   **Log Output Refinements (`7e90eaf`, `4d596dd`, `843b6b8`, `60018a0`)**.
*   **Repository Maintenance (`145e1c0`)**: Removal of ignored files.

*Note: Commit SHAs in parentheses refer to commits within PR #157 that are indicative of the described changes. Some high-level changes reflect broader development efforts not captured by a single commit.*
