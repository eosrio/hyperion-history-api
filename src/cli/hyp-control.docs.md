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

## `worker`

Monitor and manage individual Hyperion indexer workers. These commands interact with the local controller's HTTP endpoints to provide real-time worker information and management capabilities.

### `worker list <chain>`

Lists all active workers for a specific chain with detailed information including worker roles, queues, and failure counts.

**Usage:**
```bash
./hyp-control worker list <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to list workers for.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control worker list libre
./hyp-control worker list wax --host localhost:7000
```

**Output Columns:**
*   **ID**: Unique worker identifier
*   **Role**: Worker type (continuous_reader, deserializer, ingestor, router, ds_pool_worker, delta_updater)
*   **Queue**: Assigned processing queue (chain prefix removed for clarity)
*   **Local**: Local worker ID (for pool workers)
*   **Live**: Live mode status (✓ = true, ✗ = false, — = not applicable)
*   **Fails**: Number of failures encountered by the worker

**Worker Roles:**
*   **continuous_reader**: Reads blocks from the blockchain in real-time
*   **deserializer**: Processes and deserializes block data
*   **ingestor**: Indexes processed data into ElasticSearch/MongoDB
*   **router**: Handles streaming connections and routing
*   **ds_pool_worker**: Deserializes actions in a worker pool
*   **delta_updater**: Updates delta records and state changes

### `worker details <chain> <workerId>`

Retrieves detailed information about a specific worker including process details, performance metrics, and current status.

**Usage:**
```bash
./hyp-control worker details <chain> <workerId> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain.
*   `<workerId>`: The unique worker ID to inspect.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control worker details libre 7
./hyp-control worker details wax 15 --host localhost:7000
```

**Displayed Information:**
*   Worker ID and role
*   Last processed block number
*   Process ID (PID)
*   Failure count
*   Current status (running/killed)

### `worker kill <chain> <workerId>`

Terminates a specific worker process. This is useful for restarting problematic workers or performing maintenance.

**Usage:**
```bash
./hyp-control worker kill <chain> <workerId> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain.
*   `<workerId>`: The unique worker ID to terminate.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).
*   `--force`: Force kill without confirmation prompt.

**Examples:**
```bash
# Kill with confirmation prompt
./hyp-control worker kill libre 7

# Force kill without confirmation
./hyp-control worker kill libre 7 --force

# Kill worker on remote host
./hyp-control worker kill wax 15 --host 192.168.1.100 --force
```

**Important:**
*   Killing workers will interrupt their current processing
*   The master process will typically restart killed workers automatically
*   Use this command for troubleshooting stuck or problematic workers

### `worker scaling <chain>`

Displays comprehensive scaling information including configuration parameters, current worker distribution, and detailed worker status by role.

**Usage:**
```bash
./hyp-control worker scaling <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to get scaling information for.

**Options:**
*   `-h, --host <host>`: Optional host for the indexer controller (defaults to configuration).

**Example:**
```bash
./hyp-control worker scaling libre
./hyp-control worker scaling wax --host localhost:7000
```

**Displayed Information:**

**Configuration Section:**
*   `readers`: Number of configured reader workers
*   `ds_threads`: Deserializer threads per queue
*   `ds_queues`: Number of deserializer queues
*   `ds_pool_size`: Deserializer pool worker count
*   `indexing_queues`: Generic indexing queue count
*   `ad_idx_queues`: Action/delta indexing queue count
*   `dyn_idx_queues`: Dynamic table indexing queue count
*   `max_autoscale`: Maximum autoscaling limit
*   `auto_scale_trigger`: Queue size threshold for autoscaling
*   `batch_size`: Processing batch size
*   `max_queue_limit`: Maximum queue message limit
*   `block_queue_limit`: Block queue message limit
*   `routing_mode`: Load balancing routing mode

**Current Workers Summary:**
*   Count of active workers by role
*   Total worker count

**Detailed Workers by Role:**
*   Individual worker details grouped by role
*   Worker status (✅ active, ❌ inactive)
*   Queue assignments and failure counts

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

### Worker Management
- Worker commands interact with the local controller HTTP API running on specific ports per chain.
- Default ports: libre (47012), wax (47013), jungle (47014), ultra (47015), pangea (47016).
- Worker list provides real-time status including failures, which helps identify problematic workers.
- Killing workers is safe as the master process automatically restarts them.
- Use scaling information to understand current worker distribution and configuration.

### Queue Management
- Queue operations interact directly with RabbitMQ through its management API.
- Ensure RabbitMQ is accessible and properly configured in `connections.json`.
- Monitor queue sizes regularly to identify processing bottlenecks.
- Use categorized view to understand the data flow through different processing stages.

### Performance Monitoring
- Stats commands provide real-time insights into indexer performance.
- Memory and heap statistics help identify potential memory leaks or resource constraints.
- Usage maps show which contracts are consuming the most processing resources.
- Worker monitoring helps identify individual worker performance and failure patterns.

## Troubleshooting

- **Connection Issues**: Verify that the indexer controller host is accessible and properly configured.
- **Sync Failures**: Check indexer logs for detailed error information during synchronization operations.
- **Queue Access**: Ensure RabbitMQ management API is enabled and credentials are correct in `connections.json`.
- **Performance Issues**: Use stats commands to identify bottlenecks and monitor resource usage patterns.
- **Worker Issues**: 
  - Use `worker list` to identify workers with high failure counts
  - Use `worker details` to get detailed information about problematic workers
  - Use `worker kill --force` to restart stuck workers
  - Check `worker scaling` to verify configuration matches expected worker distribution
- **Port Issues**: If worker commands fail to connect, verify the local controller port for your chain is accessible.

## Additional Information

For more details about specific operations or troubleshooting, refer to the Hyperion documentation or contact the development team. Always backup configurations and data before performing maintenance operations.
