# Hyperion Configuration CLI (`hyp-config`) Documentation

This document outlines the commands available in the `hyp-config` CLI tool, used for managing Hyperion configurations.

## `connections`

Manage the main `connections.json` file.

### `connections init`

Initializes the `connections.json` file by prompting the user for necessary connection details (RabbitMQ, Elasticsearch, Redis, MongoDB) and testing them. If the file already exists, it prompts for confirmation before overwriting.

**Usage:**
```bash
./hyp-config connections init
```

### `connections test`

Tests the connectivity to the infrastructure services defined in `connections.json` (Redis, Elasticsearch, RabbitMQ, MongoDB).

**Usage:**
```bash
./hyp-config connections test
```

### `connections reset`

Removes the existing `connections.json` file after creating a backup (`connections.json.bak`) in the `config/configuration_backups` directory. Prompts for confirmation before proceeding.

**Usage:**
```bash
./hyp-config connections reset
```

## `chains`

Manage individual chain configuration files located in `config/chains/`.

### `chains list`

Lists all configured chains found in the `config/chains/` directory. It displays details like chain name, endpoints, parser version, and status (configured or pending).

**Alias:** `ls`

**Usage:**
```bash
./hyp-config chains list [options]
```

**Options:**
*   `--valid`: Only display chains that have corresponding entries in `connections.json`.
*   `--fix-missing-fields`: Automatically add missing configuration fields with default values based on the reference configuration (`config.ref.json`).

### `chains new <shortName>`

Creates a new chain configuration file (`<shortName>.config.json`) based on the example template (`config.ref.json`) and adds corresponding connection details to `connections.json`. It requires HTTP and SHIP endpoints and attempts to determine the parser version and chain ID automatically.

**Usage:**
```bash
./hyp-config chains new <shortName> --http <http_endpoint> --ship <ship_endpoint>
```

**Arguments:**
*   `<shortName>`: A short, unique identifier for the chain (e.g., `wax`, `eos-testnet`).

**Required Options:**
*   `--http <http_endpoint>`: The HTTP API endpoint for the chain's nodeos instance (e.g., `https://wax.greymass.com`).
*   `--ship <ship_endpoint>`: The State History Plugin (SHIP) WebSocket endpoint (e.g., `wss://ship.wax.eosusa.io`).

### `chains remove <shortName>`

Removes the configuration file for the specified chain (`<shortName>.config.json`) and its entry from `connections.json`. Creates backups of both files in the `config/configuration_backups` directory before deletion.

**Usage:**
```bash
./hyp-config chains remove <shortName>
```

**Arguments:**
*   `<shortName>`: The short name of the chain configuration to remove.

### `chains test <shortName>`

Tests the configured HTTP and SHIP endpoints for a specific chain to ensure connectivity and verify that the Chain ID matches across the configuration, HTTP endpoint, and SHIP endpoint(s).

**Usage:**
```bash
./hyp-config chains test <shortName>
```

**Arguments:**
*   `<shortName>`: The short name of the chain configuration to test.

## `contracts`

Manage contract-specific state indexing configurations within a chain's config file.

### `contracts list <chainName>`

Displays the current contract state indexing configuration for the specified chain, showing which accounts and tables are configured for indexing and their specific index definitions.

**Usage:**
```bash
./hyp-config contracts list <chainName>
```

**Arguments:**
*   `<chainName>`: The short name of the chain whose contract configuration should be listed.

### `contracts add-single <chainName> <account> <table> <autoIndex> <indices>`

Adds or updates the configuration for a single table within a specific contract account for the given chain.

**Usage:**
```bash
./hyp-config contracts add-single <chainName> <account> <table> <autoIndex> <indicesJson>
```

**Arguments:**
*   `<chainName>`: The short name of the chain.
*   `<account>`: The contract account name.
*   `<table>`: The table name within the contract.
*   `<autoIndex>`: Boolean (`true` or `false`) indicating if default indices should be automatically created.
*   `<indicesJson>`: A JSON string defining custom indices (e.g., `'{"field1": 1, "field2": -1}'`). Allowed values are `1`, `-1`, `"text"`, `"date"`, `"2dsphere"`.

### `contracts add-multiple <chainName> <account> <tablesJson>`

Adds or updates the configuration for multiple tables within a specific contract account using a JSON string input.

**Usage:**
```bash
./hyp-config contracts add-multiple <chainName> <account> <tablesJson>
```

**Arguments:**
*   `<chainName>`: The short name of the chain.
*   `<account>`: The contract account name.
*   `<tablesJson>`: A JSON string representing an array of table configurations.
    *   **Example:** `'[{"name": "stat", "autoIndex": true, "indices": {"supply": 1}}, {"name": "accounts", "autoIndex": false, "indices": {"balance": 1}}]'`

## Deprecated Commands

The following commands are deprecated but still functional. Please use the `chains` command group instead.

*   `list chains` (Use `chains list` instead)
    *   Alias: `ls chains`
*   `new chain <shortName>` (Use `chains new <shortName>` instead)
    *   Alias: `n chain <shortName>`
*   `remove chain <shortName>` (Use `chains remove <shortName>` instead)
    *   Alias: `rm chain <shortName>`
