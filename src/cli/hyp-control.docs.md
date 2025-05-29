# Hyperion Control CLI (`hyp-control`) Documentation

This document outlines the commands available in the `hyp-control` CLI tool, used for managing Hyperion indexer operations, synchronization tasks, performance monitoring, and RabbitMQ queue management.

## `indexer`

Manage the Hyperion indexer lifecycle for specific chains.

### `indexer start <chain>`

Starts or ensures the indexer is actively processing for a specific chain.

**Usage:**
```bash
./hyp-control indexer start <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to start indexing for (e.g., `wax`, `eos`, `telos`).

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control indexer start wax
./hyp-control indexer start telos --host localhost:7000
```

### `indexer stop <chain>`

Stops the indexer for a specific chain.

**Usage:**
```bash
./hyp-control indexer stop <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to stop indexing for.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control indexer stop wax
./hyp-control indexer stop telos --host localhost:7000
```

## `sync`

Synchronize various data components between the blockchain and Hyperion's databases. These operations automatically pause the indexer during synchronization and resume it afterward to prevent conflicts.

### `sync voters <chain>`

Synchronizes voter data for a specific chain.

**Usage:**
```bash
./hyp-control sync voters <chain>
```

**Arguments:**
*   `<chain>`: The short name of the chain to sync voters for.

**Example:**
```bash
./hyp-control sync voters wax
```

### `sync accounts <chain>`

Synchronizes account data for a specific chain.

**Usage:**
```bash
./hyp-control sync accounts <chain>
```

**Arguments:**
*   `<chain>`: The short name of the chain to sync accounts for.

**Example:**
```bash
./hyp-control sync accounts wax
```

### `sync proposals <chain>`

Synchronizes proposal data for a specific chain.

**Usage:**
```bash
./hyp-control sync proposals <chain>
```

**Arguments:**
*   `<chain>`: The short name of the chain to sync proposals for.

**Example:**
```bash
./hyp-control sync proposals wax
```

### `sync contract-state <chain> [contract] [table]`

Synchronizes contract state data for a specific chain. This feature must be enabled in the chain configuration to function.

**Usage:**
```bash
./hyp-control sync contract-state <chain> [contract] [table]
```

**Arguments:**
*   `<chain>`: The short name of the chain to sync contract state for.
*   `[contract]`: Optional specific contract account to sync.
*   `[table]`: Optional specific table within the contract to sync.

**Example:**
```bash
./hyp-control sync contract-state wax
./hyp-control sync contract-state wax eosio.token accounts
```

**Note:**
If contract state synchronization is not enabled in the chain configuration, the command will skip the operation and display an informational message.

### `sync all <chain>`

Synchronizes all data components (voters, accounts, proposals, and contract state) for a specific chain in sequence.

**Usage:**
```bash
./hyp-control sync all <chain>
```

**Arguments:**
*   `<chain>`: The short name of the chain to perform complete synchronization for.

**Example:**
```bash
./hyp-control sync all wax
```

**Note:**
This command runs all synchronization operations sequentially. If contract state synchronization is disabled, it will be skipped with a notification.

## `stats`

Monitor performance and resource usage statistics from the Hyperion indexer.

### `stats get-usage-map <chain>`

Retrieves and displays the global contract usage map from the indexer, showing which contracts are being actively processed.

**Usage:**
```bash
./hyp-control stats get-usage-map <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to get usage statistics for.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control stats get-usage-map wax
./hyp-control stats get-usage-map telos --host localhost:7000
```

### `stats get-memory-usage <chain>`

Retrieves and displays memory usage statistics from all indexer workers.

**Usage:**
```bash
./hyp-control stats get-memory-usage <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to get memory usage for.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control stats get-memory-usage wax
./hyp-control stats get-memory-usage telos --host localhost:7000
```

### `stats get-heap <chain>`

Retrieves and displays V8 heap statistics from all indexer workers, providing detailed information about JavaScript memory allocation.

**Usage:**
```bash
./hyp-control stats get-heap <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to get heap statistics for.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control stats get-heap wax
./hyp-control stats get-heap telos --host localhost:7000
```

## `queues`

Manage and monitor RabbitMQ queues used by the Hyperion indexer for processing blockchain data.

### `queues list <chain>`

Lists RabbitMQ queues for a specific chain with various filtering and display options.

**Usage:**
```bash
./hyp-control queues list <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to list queues for.

**Options:**
*   `-a, --all`: Show all queues (not just chain-specific ones).
*   `-e, --empty`: Show empty queues (queues with 0 messages).
*   `-v, --verbose`: Show detailed information including memory usage and state.
*   `-c, --categorize`: Group queues by category (Block Processing, Action Indexing, etc.).
*   `-s, --sort <field>`: Sort by field (`name`, `messages`, `consumers`). Default: `name`.
*   `-f, --filter <pattern>`: Filter queues by name pattern using regex.

**Examples:**
```bash
# Basic queue listing
./hyp-control queues list wax

# Show all queues with detailed information
./hyp-control queues list wax --all --verbose

# Show categorized queues sorted by message count
./hyp-control queues list wax --categorize --sort messages

# Filter queues containing "blocks" in the name
./hyp-control queues list wax --filter "blocks"

# Show empty queues for debugging
./hyp-control queues list wax --empty --verbose
```

**Queue Categories:**
*   **Block Processing**: Queues handling raw block data
*   **Action Indexing**: Queues processing action data
*   **Delta Processing**: Queues handling state delta information
*   **ABI Processing**: Queues managing contract ABI data
*   **DS Pool Workers**: Deserializer pool worker queues
*   **Live Processing**: Real-time streaming queues
*   **Other**: Miscellaneous queues not fitting other categories

### `queues details <chain> <queueName>`

Shows detailed information about a specific queue, including configuration, statistics, and arguments.

**Usage:**
```bash
./hyp-control queues details <chain> <queueName>
```

**Arguments:**
*   `<chain>`: The short name of the chain.
*   `<queueName>`: The exact name of the queue to inspect.

**Example:**
```bash
./hyp-control queues details wax "wax:blocks:1"
./hyp-control queues details telos "telos:index_actions:1"
```

**Displayed Information:**
*   Message count
*   Consumer count
*   Memory usage
*   Queue state (running, idle, etc.)
*   Node assignment
*   Virtual host
*   Durability settings
*   Auto-delete configuration
*   Exclusivity settings
*   Custom arguments and parameters

### `queues purge <chain> <queueName>`

Purges (removes) all messages from a specific queue. This operation is irreversible and should be used with caution.

**Usage:**
```bash
./hyp-control queues purge <chain> <queueName> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain.
*   `<queueName>`: The exact name of the queue to purge.

**Options:**
*   `--force`: Force purge without confirmation prompt.

**Examples:**
```bash
# Purge with confirmation prompt
./hyp-control queues purge wax "wax:blocks:1"

# Force purge without confirmation
./hyp-control queues purge wax "wax:blocks:1" --force
```

**Important:**
Purging queues removes all pending messages and cannot be undone. Ensure the indexer is stopped or the specific queue is not actively being processed before purging.

## Important Notes

### Indexer Management
- Always ensure proper indexer state management when performing maintenance operations.
- Use the start/stop commands to control indexer lifecycle during updates or maintenance.

### Synchronization Safety
- Sync operations automatically pause the indexer to prevent data conflicts.
- If the indexer is offline during sync operations, a warning is displayed, but the sync continues.
- Always verify indexer status after sync operations complete.

### Queue Management
- Queue operations interact directly with RabbitMQ through its management API.
- Ensure RabbitMQ is accessible and properly configured in `connections.json`.
- Monitor queue sizes regularly to identify processing bottlenecks.
- Use categorized view to understand the data flow through different processing stages.

### Performance Monitoring
- Stats commands provide real-time insights into indexer performance.
- Memory and heap statistics help identify potential memory leaks or resource constraints.
- Usage maps show which contracts are consuming the most processing resources.

## Troubleshooting

- **Connection Issues**: Verify that the indexer controller host is accessible and properly configured.
- **Sync Failures**: Check indexer logs for detailed error information during synchronization operations.
- **Queue Access**: Ensure RabbitMQ management API is enabled and credentials are correct in `connections.json`.
- **Performance Issues**: Use stats commands to identify bottlenecks and monitor resource usage patterns.

## Additional Information

For more details about specific operations or troubleshooting, refer to the Hyperion documentation or contact the development team. Always backup configurations and data before performing maintenance operations.
