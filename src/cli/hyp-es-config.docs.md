# Hyperion Elasticsearch Configuration Tool Usage Guide

## Important Note

Before running repartition commands, ensure that the Elasticsearch indexer is stopped. This is crucial to avoid conflicts or data inconsistencies during the operation.

The repartitioning process keeps the old indices intact to ensure data safety. After validating that the new indices are functioning correctly, it is essential to manually remove the old indices to free up storage, maintain optimal performance, and ensure that no duplicate data is displayed.

The tool creates a file named `.indices-registry.json` inside a `.cli` directory at the root of the project to track information about old and new indices during repartitioning. This file is essential for managing cleanup operations and ensuring that indices are correctly classified. If the `.cli` directory does not exist, it will be created automatically.

## Overview

The `hyp-es-config` tool is a command-line utility designed to manage Elasticsearch indices for Hyperion. It provides commands to list, repartition, and clean up indices, as well as monitor active reindexing tasks.

## Commands

### 1. List Indices

Displays all available Elasticsearch indices.

**Command:**

```bash
./hyp-es-config list
```

**Alias:** `ls`

### 2. List Tasks

Lists and monitors active reindexing tasks in Elasticsearch.

**Command:**

```bash
./hyp-es-config tasks
```

### 3. Repartition Indices

Repartitions indices (block, action, delta) to a new partition size.

**Command:**

```bash
./hyp-es-config repartition <chain>
```

**Options:**

- `--global <size>`: Set the same partition size for all index types (block, action, delta).
- `--blocks <size>`: Set specific partition size for block indices.
- `--actions <size>`: Set specific partition size for action indices.
- `--deltas <size>`: Set specific partition size for delta indices.
- `--force`: Force operation even if target indices already exist.
- `--skip-missing`: Continue even if some index types are not found.
- `--skip-cleanup`: Skip cleanup instructions for old indices.
- `--continue-on-error`: Continue even if errors occur in some operations.
- `-y, --yes`: Skip confirmation prompts.

**Example:**

```bash
# Repartition all index types with the same size
./hyp-es-config repartition telos --global 1000000 -y

# Repartition specific index types with different sizes
./hyp-es-config repartition telos --blocks 500000 --actions 1000000 --deltas 750000 -y
```

**Note:**
You can use the `--global` option to apply the same partition size to all index types or specify sizes individually for `--blocks`, `--actions`, and `--deltas`. This flexibility allows you to tailor the repartitioning process to your specific needs.

When specifying sizes for `--actions` and `--deltas`, note that these sizes are always related to the block indices. The partitioning logic uses block sizes as the reference point, and the sizes for actions and deltas are aligned accordingly.

### 4. Cleanup Indices

Removes old or new indices after successful repartitioning.

**Command:**

```bash
./hyp-es-config cleanup <chain>
```

**Options:**

- `--blocks`: Remove old block indices.
- `--actions`: Remove old action indices.
- `--deltas`: Remove old delta indices.
- `--delete-new-indices`: Remove new indices instead of old ones (default is to remove old indices).
- `-y, --yes`: Skip confirmation prompts.
- `--continue-on-error`: Continue even if errors occur in some operations.

**Example:**

```bash
# Remove old block indices
./hyp-es-config cleanup telos --blocks -y

# Remove new indices instead of old ones
./hyp-es-config cleanup telos --delete-new-indices -y
```

**Important:**

The goal of repartitioning is to divide indices for better performance. To ensure everything is working correctly, old indices are kept initially. However, after validation, it is crucial to remove old indices to avoid unnecessary storage usage.

## Notes

- Ensure the Elasticsearch indexer is stopped before running repartition commands.

  **Command to stop:**

  ```bash
  ./hyp-control stop chain=<chain>
  ```

- Use the `--yes` option to bypass confirmation prompts for automated workflows.
- Always back up your configuration files and registry before performing cleanup operations.

## Troubleshooting

- If no partition size is provided, the tool attempts to fetch sizes from the configuration file.
- Errors during operations can be bypassed using the `--continue-on-error` option.
- For detailed logs, check the `logs/` directory.

## Additional Information

For more details, refer to the source code or contact the development team.
