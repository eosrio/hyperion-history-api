# Hyperion MongoDB Snapshot Management

The MongoDB snapshot feature allows you to create MongoDB database snapshots for specific chains. This is designed primarily for **migration scenarios** and database backups.

⚠️ **IMPORTANT**: This tool creates MongoDB snapshots ONLY. Elasticsearch data is NOT included. For Elasticsearch snapshots, use the native ES Snapshot API.

## Features

- **Safe Operation**: Automatically stops the indexer before creating snapshots
- **Queue Validation**: Ensures all RabbitMQ queues are empty before proceeding
- **Block Tracking**: Includes the last indexed block number in the snapshot name
- **Flexible Output**: Supports compression, archiving, and custom output directories
- **Manual Control**: Does not automatically restart the indexer (suitable for migrations)

## Usage

### Basic Snapshot Creation

```bash
# Create a basic MongoDB snapshot for the 'eos' chain
./hyp-control mongodb-snapshot create eos

# Create a snapshot with custom output directory
./hyp-control mongodb-snapshot create eos -o /backup/snapshots

# Create a compressed snapshot
./hyp-control mongodb-snapshot create eos -c
```

### Advanced Options

```bash
# Create a compressed archive and remove the original directory
./hyp-control mongodb-snapshot create eos -c -a --remove-after-archive

# Snapshot specific collections only
./hyp-control mongodb-snapshot create eos --collections "actions,blocks,deltas"

# Force snapshot even if queues aren't empty (not recommended)
./hyp-control mongodb-snapshot create eos --force
```

### Listing Snapshots

```bash
# List all available MongoDB snapshots
./hyp-control mongodb-snapshot list

# List snapshots for a specific chain
./hyp-control mongodb-snapshot list eos

# List snapshots from custom directory
./hyp-control mongodb-snapshot list -o /backup/snapshots
```

## What's Included in MongoDB Snapshots

✅ **MongoDB Collections**: All Hyperion MongoDB data including:
- Accounts and permissions
- Proposals and voters  
- Custom collections (if specified)

ℹ️ **Elasticsearch Data**: NOT INCLUDED - must be backed up separately using ES Snapshot API

💡 **For Complete Backups**: You also need to backup:
- Elasticsearch indices (use [ES Snapshot API](https://www.elastic.co/guide/en/elasticsearch/reference/current/snapshot-restore.html))
- Configuration files (`config/` directory)

## Command Options

### Create Command Options

- `-h, --host <host>`: Specify indexer controller host (default: localhost)
- `-o, --output <path>`: Output directory (default: ./snapshots)
- `--force`: Force snapshot even if indexer can't be stopped or queues aren't empty
- `-c, --compress`: Compress the MongoDB dump with gzip
- `--collections <collections>`: Comma-separated list of collections to dump
- `-a, --archive`: Create a tar archive of the snapshot
- `--remove-after-archive`: Remove the snapshot directory after creating archive

### List Command Options

- `-o, --output <path>`: Snapshots directory to list from (default: ./snapshots)

## Important Notes

⚠️ **MongoDB Only**: This tool creates MongoDB snapshots only. Elasticsearch data is not included.

⚠️ **The indexer is NOT automatically restarted after snapshot creation**

This is intentional for migration scenarios. After the snapshot is complete, you'll see:

```
📝 Important Notes:
════════════════════════════════════════════════════════════
🛑 The indexer has been stopped for this snapshot.
🔄 To restart the indexer when ready, run:
   ./run.sh your-chain-indexer

💡 For migration scenarios, you may want to keep
   the indexer stopped until the migration is complete.
```

To restart the indexer when ready:
```bash
./run.sh your-chain-indexer
```

## Snapshot Naming Convention

MongoDB snapshots are named using the following format:
```
{chain}_{last_indexed_block}_{timestamp}
```

Examples:
- `eos_12345678_2025-06-13T10-30-00`
- `wax_87654321_2025-06-13T15-45-30`

## Safety Features

1. **Indexer Stop Check**: Verifies the indexer is stopped before proceeding
2. **Queue Validation**: Ensures all chain-specific queues are empty
3. **Automatic Restart**: Restarts the indexer using `./run.sh {chain}-indexer` after completion
4. **Metadata Tracking**: Creates a metadata file with snapshot information
5. **Error Handling**: Comprehensive error handling with rollback capabilities

## Metadata File

Each MongoDB snapshot includes a `snapshot_metadata.json` file with:

```json
{
  "chain": "eos",
  "last_indexed_block": 12345678,
  "timestamp": "2025-06-13T10:30:00.000Z",
  "hyperion_version": "4.0.0-beta.1",
  "collections": [],
  "compressed": true,
  "snapshot_path": "/path/to/snapshot"
}
```

## Recovery

To restore from a MongoDB snapshot, use standard MongoDB tools:

```bash
# Restore from uncompressed MongoDB snapshot
mongorestore --host localhost --port 27017 --db eos_hyperion /path/to/snapshot/eos_hyperion

# Restore from compressed MongoDB snapshot
mongorestore --host localhost --port 27017 --db eos_hyperion --gzip /path/to/snapshot/eos_hyperion
```

⚠️ **Remember**: This only restores MongoDB data. You'll also need to restore Elasticsearch data separately.

## Best Practices

1. **Schedule During Low Activity**: Create snapshots during periods of low blockchain activity
2. **Monitor Disk Space**: Ensure sufficient disk space for the MongoDB snapshot
3. **Test Restores**: Regularly test MongoDB snapshot restoration procedures
4. **Archive Old Snapshots**: Move old snapshots to long-term storage
5. **Document Snapshots**: Keep records of what each snapshot contains
6. **Backup Elasticsearch Separately**: Don't forget to backup Elasticsearch data using ES Snapshot API
7. **Backup Configuration**: Also backup your `config/` directory

## Troubleshooting

### Indexer Won't Stop
- Check if indexer is running: `./hyp-control worker list {chain}`
- Manually stop: `./stop.sh {chain}-indexer`
- Use `--force` flag (not recommended for production)

### Queues Not Empty
- Check queue status: `./hyp-control queues list {chain}`
- Wait for queues to drain naturally
- Use `--force` flag if absolutely necessary

### MongoDB Snapshot Failed
- Check disk space: `df -h`
- Verify MongoDB is accessible: `mongo --eval "db.stats()"`
- Check permissions on output directory

### Missing Elasticsearch Data
- MongoDB snapshots don't include Elasticsearch data
- Use ES Snapshot API: https://www.elastic.co/guide/en/elasticsearch/reference/current/snapshot-restore.html

### Indexer Won't Restart
- Manually restart: `./run.sh {chain}-indexer`
- Check indexer logs for errors
- Verify configuration files are correct
