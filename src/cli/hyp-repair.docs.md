# Hyperion Repair CLI (`hyp-repair`) Documentation

This document outlines the commands available in the `hyp-repair` CLI tool, used for finding and repairing forked blocks, missing blocks, and missing actions in Hyperion indexer databases.

## `scan`

Scan for missing and forked blocks using traditional sequential scanning method.

### `scan <chain>`

Performs a comprehensive scan for forked and missing blocks by comparing indexed blocks with the blockchain state. This command processes blocks in batches and validates block hashes against the chain to detect forks.

**Usage:**
```bash
./hyp-repair scan <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to scan (e.g., `wax`, `eos`, `telos`).

**Options:**
*   `-o, --out-file <file>`: Specify output file for forked-blocks.json (default: `.repair/<chain>-<first>-<last>-forked.json`).
*   `-f, --first <number>`: Initial block number to start validation from.
*   `-l, --last <number>`: Last block number to validate (defaults to latest indexed block).
*   `-b, --batch <number>`: Batch size for processing blocks (default: 2000).

**Examples:**
```bash
# Scan entire chain for forked blocks
./hyp-repair scan wax

# Scan specific range with custom batch size
./hyp-repair scan wax --first 100000 --last 200000 --batch 1000

# Scan and save results to custom file
./hyp-repair scan eos --out-file my-fork-scan.json
```

**Output:**
Creates a JSON file containing detected forked ranges and missing block ranges that can be used with the `repair` and `fill-missing` commands.

## `quick-scan`

Scan for missing blocks using binary tree search for faster detection.

### `quick-scan <chain>`

Uses a binary search algorithm to quickly identify missing blocks by counting indexed blocks in ranges and recursively narrowing down to find exact missing block ranges.

**Usage:**
```bash
./hyp-repair quick-scan <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to scan.

**Options:**
*   `-f, --first <number>`: Initial block number to start validation from.
*   `-l, --last <number>`: Last block number to validate (defaults to latest indexed block).

**Examples:**
```bash
# Quick scan entire chain
./hyp-repair quick-scan wax

# Quick scan specific range
./hyp-repair quick-scan telos --first 50000000 --last 60000000
```

**Output:**
Displays missing block ranges and creates a JSON file in `.repair/` directory for use with `fill-missing` command.

## `scan-actions`

Scan for missing actions using binary tree search and action validation API.

### `scan-actions <chain>`

Uses the Hyperion API's `/v2/stats/get_trx_count` endpoint with action validation to perform a binary search for blocks that have missing actions. This is the most advanced scanning method that can detect action indexing issues.

**Usage:**
```bash
./hyp-repair scan-actions <chain> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to scan.

**Options:**
*   `-f, --first <number>`: Initial block number to start validation from.
*   `-l, --last <number>`: Last block number to validate (defaults to latest indexed block).
*   `-o, --out-file <file>`: Custom output file prefix for missing-actions.json.
*   `-m, --min-range-size <number>`: Minimum range size to continue binary search (default: 1). Stops subdividing ranges when they reach this size.
*   `-v, --verbose`: Enable verbose logging showing details for all ranges (default: quiet mode).

**Examples:**
```bash
# Scan for missing actions (quiet mode)
./hyp-repair scan-actions wax

# Scan with verbose output
./hyp-repair scan-actions wax --verbose

# Scan with early stop optimization for faster scanning
./hyp-repair scan-actions wax --min-range-size 100

# Scan specific range
./hyp-repair scan-actions eos --first 200000000 --last 210000000

# Combine all options
./hyp-repair scan-actions telos --first 100000 --last 200000 --min-range-size 50 --verbose --out-file custom-scan
```

**Performance Options:**
*   `--min-range-size`: Controls search granularity. Higher values = faster scanning but less precise ranges.
  *   `1` (default): Search down to individual blocks (most precise)
  *   `100`: Stop subdividing at 100-block ranges (good balance)
  *   `1000`: Stop subdividing at 1000-block ranges (fastest)

**Output Modes:**
*   **Quiet Mode (default)**: Shows progress updates every 5 seconds, minimal console output
*   **Verbose Mode (`--verbose`)**: Shows detailed logs for every range checked

**Output:**
Creates a JSON file containing block ranges with missing actions for use with `fill-missing` command.

## `repair`

Repair forked blocks using scan results.

### `repair <chain> <file>`

Repairs forked blocks by deleting incorrect blocks from the database based on scan results. This command removes forked blocks that don't match the canonical chain.

**Usage:**
```bash
./hyp-repair repair <chain> <file> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to repair.
*   `<file>`: Path to the JSON file containing forked block ranges (created by `scan` command).

**Options:**
*   `-h, --host <host>`: Hyperion local control API host (defaults to configuration).
*   `-d, --dry`: Perform a dry-run without actually deleting or repairing blocks.
*   `-t, --check-tasks`: Check for running indexer tasks before proceeding.

**Examples:**
```bash
# Repair forked blocks (dry run first)
./hyp-repair repair wax .repair/wax-forked.json --dry

# Actually repair the blocks
./hyp-repair repair wax .repair/wax-forked.json

# Repair with custom control API host
./hyp-repair repair eos fork-results.json --host localhost:7001
```

## `fill-missing`

Fill missing blocks using scan results.

### `fill-missing <chain> <file>`

Processes missing blocks by re-indexing them from the blockchain. This command handles both missing blocks (from `quick-scan`) and missing actions (from `scan-actions`).

**Usage:**
```bash
./hyp-repair fill-missing <chain> <file> [options]
```

**Arguments:**
*   `<chain>`: The short name of the chain to repair.
*   `<file>`: Path to the JSON file containing missing block ranges or missing action ranges.

**Options:**
*   `-h, --host <host>`: Hyperion local control API host (defaults to configuration).
*   `-d, --dry`: Perform a dry-run without actually processing blocks.

**Examples:**
```bash
# Fill missing blocks from quick-scan results
./hyp-repair fill-missing wax .repair/wax-missing-blocks.json

# Fill missing actions from scan-actions results
./hyp-repair fill-missing wax .repair/wax-missing-actions.json --dry

# Fill with custom control API host
./hyp-repair fill-missing telos missing-ranges.json --host localhost:7001
```

## `view`

View forked block scan results.

### `view <file>`

Displays the contents of scan result files in a human-readable format.

**Usage:**
```bash
./hyp-repair view <file>
```

**Arguments:**
*   `<file>`: Path to the JSON file containing scan results.

**Example:**
```bash
./hyp-repair view .repair/wax-forked.json
```

## `monitor-queues`

Monitor block processing queues for a chain.

### `monitor-queues <chain>`

Displays real-time information about block processing queues, showing queue sizes, processing rates, and other queue metrics.

**Usage:**
```bash
./hyp-repair monitor-queues <chain>
```

**Arguments:**
*   `<chain>`: The short name of the chain to monitor.

**Example:**
```bash
./hyp-repair monitor-queues wax
```

## `connect`

Test connection to Hyperion Indexer.

### `connect`

Tests connectivity to the Hyperion control API to ensure the repair tool can communicate with the indexer.

**Usage:**
```bash
./hyp-repair connect [options]
```

**Options:**
*   `-h, --host <host>`: Hyperion local control API host to test.

**Examples:**
```bash
# Test default connection
./hyp-repair connect

# Test specific host
./hyp-repair connect --host localhost:7001
```

## Typical Workflows

### Complete Chain Validation and Repair

1. **Scan for forked blocks:**
   ```bash
   ./hyp-repair scan mychain
   ```

2. **Quick scan for missing blocks:**
   ```bash
   ./hyp-repair quick-scan mychain
   ```

3. **Scan for missing actions:**
   ```bash
   ./hyp-repair scan-actions mychain
   ```

4. **Repair forked blocks (dry run first):**
   ```bash
   ./hyp-repair repair mychain .repair/mychain-forked.json --dry
   ./hyp-repair repair mychain .repair/mychain-forked.json
   ```

5. **Fill missing blocks:**
   ```bash
   ./hyp-repair fill-missing mychain .repair/mychain-missing-blocks.json
   ```

6. **Fill missing actions:**
   ```bash
   ./hyp-repair fill-missing mychain .repair/mychain-missing-actions.json
   ```

### Large Chain Optimization

For chains with hundreds of millions of blocks:

1. **Use optimized action scanning:**
   ```bash
   # Fast scan with early stop optimization
   ./hyp-repair scan-actions mychain --min-range-size 1000
   
   # Quiet mode for less console output
   ./hyp-repair scan-actions mychain --min-range-size 100
   ```

2. **Scan in chunks for very large ranges:**
   ```bash
   # Scan in 10M block chunks
   ./hyp-repair scan-actions mychain --first 100000000 --last 110000000
   ./hyp-repair scan-actions mychain --first 110000000 --last 120000000
   # ... continue in chunks
   ```

### Debugging and Troubleshooting

1. **Use verbose mode for detailed insights:**
   ```bash
   ./hyp-repair scan-actions mychain --verbose --first 1000000 --last 1001000
   ```

2. **Test connectivity:**
   ```bash
   ./hyp-repair connect
   ```

3. **Monitor processing:**
   ```bash
   ./hyp-repair monitor-queues mychain
   ```

## Output Files

All scan operations create output files in the `.repair/` directory:

*   **Forked blocks**: `.repair/<chain>-<first>-<last>-forked.json`
*   **Missing blocks**: `.repair/<chain>-<first>-<last>-missing.json`
*   **Missing actions**: `.repair/<chain>-<first>-<last>-missing-actions.json`

These files contain structured data that can be used by the repair commands and are compatible with existing Hyperion repair workflows.

## Performance Considerations

### `scan-actions` Performance Options

*   **`--min-range-size`**: Higher values significantly reduce API calls and execution time
  *   For massive chains: Use 1000+ for initial broad scanning
  *   For precise repair: Use 1-100 for detailed analysis
  
*   **Quiet vs Verbose Mode**:
  *   Quiet mode reduces console I/O overhead for large scans
  *   Verbose mode provides detailed debugging information

### Expected Performance

*   **Small ranges** (< 1M blocks): Minutes to complete
*   **Medium ranges** (1M - 10M blocks): 10-30 minutes
*   **Large ranges** (10M+ blocks): Hours, use `--min-range-size` optimization

The binary search algorithm typically requires `O(log n)` API calls, making it very efficient even for large block ranges.
