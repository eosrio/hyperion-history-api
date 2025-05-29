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

### `chains validate <shortName>`

Validates a chain configuration file against the Zod schema to ensure all required fields are present and have correct types. Can automatically fix missing or invalid fields using reference defaults.

**Usage:**
```bash
./hyp-config chains validate <shortName> [options]
```

**Arguments:**
*   `<shortName>`: The short name of the chain configuration to validate.

**Options:**
*   `--fix`: Automatically fix missing or invalid fields using reference configuration and sensible defaults. Creates a backup before making changes.

**Validation Features:**
*   **Schema Validation**: Validates the entire configuration structure using comprehensive Zod schemas
*   **Detailed Error Reporting**: Groups validation errors by configuration path for easy debugging
*   **Configuration Summary**: On successful validation, displays key configuration details
*   **JSON Syntax Checking**: Catches and reports JSON parsing errors
*   **Auto-Fix Capability**: Automatically adds missing fields with appropriate defaults

**Auto-Fix Behavior:**
When using the `--fix` option, the command will:
1. Create a timestamped backup in `config/configuration_backups/`
2. Apply values from the reference configuration (`config.ref.json`) where available
3. Use sensible defaults for fields not present in the reference
4. Save the fixed configuration and report all changes made

**Examples:**
```bash
# Validate configuration only (shows errors if any)
./hyp-config chains validate wax

# Validate and automatically fix missing fields
./hyp-config chains validate wax --fix
```

**Sample Output (with --fix):**
```
Validating chain config for wax...
🔧 Attempting to fix configuration issues...
📦 Backup created: config/configuration_backups/wax.config.backup.1748562368468.json
   ✓ Fixed missing field: api.provider_logo = "" (default)
   ✓ Fixed missing field: settings.ship_request_rev = "" (default)
   ✓ Fixed missing field: settings.bypass_index_map = false (default)
💾 Fixed configuration saved to config/chains/wax.config.json
🎉 Successfully fixed 3 field(s)!
✅ Chain config for wax is valid!

📋 Configuration Summary:
   Chain: wax
   API Port: 7000
   Stream Port: 1234
   Indexer Enabled: true
   API Enabled: true
   Debug Mode: false
```

## Configuration Editing

Edit and manage configuration values within chain configuration files with automatic validation against the reference configuration.

### `get <chain> <configPath>`

Retrieves a specific configuration value from a chain's configuration file. The configuration path is validated against the reference configuration to ensure it exists and is valid.

**Usage:**
```bash
./hyp-config get <chain> <configPath>
```

**Arguments:**
*   `<chain>`: The short name of the chain whose configuration to read.
*   `<configPath>`: The dot-notation path to the configuration value (e.g., `indexer.start_on`, `scaling.readers`, `api.server_port`).

**Examples:**
```bash
./hyp-config get wax indexer.start_on
./hyp-config get eos scaling.readers
./hyp-config get telos api.server_port
```

### `set <chain> <configPath> <value>`

Sets a specific configuration value in a chain's configuration file. The configuration path and value type are validated against the reference configuration. Creates an automatic backup before making changes.

**Usage:**
```bash
./hyp-config set <chain> <configPath> <value>
```

**Arguments:**
*   `<chain>`: The short name of the chain whose configuration to modify.
*   `<configPath>`: The dot-notation path to the configuration value.
*   `<value>`: The new value to set. Can be a string, number, boolean, or JSON for complex values.

**Type Validation:** The value must match the expected type from the reference configuration:
*   **Numbers:** `1000`, `4096`
*   **Booleans:** `true`, `false`
*   **Strings:** `"example_string"`
*   **Arrays:** `[1,2,3]` or `["item1","item2"]`
*   **Objects:** `{"key":"value"}`

**Examples:**
```bash
./hyp-config set wax indexer.start_on 1000
./hyp-config set eos scaling.readers 4
./hyp-config set telos api.enabled true
./hyp-config set wax api.limits '{"get_actions": 2000}'
```

### `set-default <chain> <configPath>`

Resets a specific configuration value to its default value from the reference configuration. Creates an automatic backup before making changes.

**Usage:**
```bash
./hyp-config set-default <chain> <configPath>
```

**Arguments:**
*   `<chain>`: The short name of the chain whose configuration to reset.
*   `<configPath>`: The dot-notation path to the configuration value to reset.

**Examples:**
```bash
./hyp-config set-default wax indexer.start_on
./hyp-config set-default eos api.server_port
./hyp-config set-default telos scaling.readers
```

### `list-paths <chain> [--filter <category>]`

Lists all valid configuration paths available for modification. Useful for discovering available configuration options and their current values and types.

**Usage:**
```bash
./hyp-config list-paths <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain (used for command context, but paths are from reference config).

**Options:**
*   `--filter <category>`: Filter paths by category (e.g., `api`, `indexer`, `scaling`, `features`).

**Examples:**
```bash
./hyp-config list-paths wax
./hyp-config list-paths wax --filter indexer
./hyp-config list-paths wax --filter scaling
./hyp-config list-paths wax --filter api
```

**Available Categories:**
*   `api` - API server configuration
*   `indexer` - Indexer process configuration  
*   `settings` - General settings
*   `scaling` - Performance and scaling options
*   `features` - Feature toggles
*   `blacklists` - Action and delta blacklists
*   `whitelists` - Action and delta whitelists
*   `prefetch` - Prefetch settings
*   `hub` - Hub configuration
*   `plugins` - Plugin settings
*   `alerts` - Alert system configuration

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
