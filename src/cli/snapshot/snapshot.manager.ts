import { IndexerController } from '../controller-client/controller.client.js';
import { QueueManager } from '../queue-manager/queue.manager.js';
import { readConnectionConfig } from '../repair-cli/functions.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@elastic/elasticsearch';

const execAsync = promisify(exec);

interface SnapshotOptions {
    host?: string;
    output?: string;
    force?: boolean;
    compress?: boolean;
    collections?: string;
    archive?: boolean;
    removeAfterArchive?: boolean;
}

interface SnapshotMetadata {
    chain: string;
    last_indexed_block: number;
    timestamp: string;
    hyperion_version: string;
    collections: string[] | 'all';
    compressed: boolean;
    snapshot_path: string;
}

export class SnapshotManager {
    async createSnapshot(chain: string, options: SnapshotOptions = {}): Promise<void> {
        console.log(`📸 Creating MongoDB snapshot for chain: ${chain}`);
        console.log('═'.repeat(60));
        console.log('⚠️  IMPORTANT: This creates a MongoDB snapshot ONLY');
        console.log('   Elasticsearch data is NOT included in this snapshot.');
        console.log('   For Elasticsearch snapshots, use native ES snapshot API.');
        console.log('═'.repeat(60));

        // Check for required MongoDB tools
        await this.checkMongoDbTools();

        // Test MongoDB connection
        await this.testMongoConnection(chain);

        const indexerController = new IndexerController(chain, options.host);
        const queueManager = new QueueManager();
        let indexerStopped = false;

        try {
            // Step 1: Stop the indexer
            console.log('\n1️⃣  Stopping indexer...');
            try {
                await indexerController.stop();
                indexerStopped = true;
                console.log('✅ Indexer stopped successfully');
            } catch (error: any) {
                // Check if the error indicates the indexer is not running (connection refused)
                const isConnectionRefused = error.message.includes('ECONNREFUSED') || 
                                          error.message.includes('Failed to connect to Hyperion Controller');
                
                if (isConnectionRefused) {
                    console.log('✅ Indexer appears to be already stopped (connection refused)');
                    // Don't set indexerStopped = true since we didn't actually stop it
                } else {
                    console.error(`❌ Failed to stop indexer: ${error.message}`);
                    if (!options.force) {
                        throw new Error('Cannot proceed with snapshot while indexer is running. Use --force to override.');
                    }
                    console.warn('⚠️  Warning: Proceeding despite indexer stop failure (--force used)');
                }
            }

            // Step 2: Check if queues are empty
            console.log('\n2️⃣  Checking queue status...');
            const queues = await queueManager.listQueues(chain, { showEmpty: true });
            const chainQueues = queues.filter(q => q.name.startsWith(`${chain}:`));
            const nonEmptyQueues = chainQueues.filter(q => q.messages > 0);

            if (nonEmptyQueues.length > 0) {
                console.log(`⚠️  Found ${nonEmptyQueues.length} non-empty queues:`);
                nonEmptyQueues.forEach(q => {
                    console.log(`   - ${q.name}: ${q.messages} messages`);
                });

                if (!options.force) {
                    throw new Error('Cannot create snapshot with non-empty queues. Use --force to override.');
                }
                console.warn('⚠️  Warning: Proceeding with non-empty queues (--force used)');
            } else {
                console.log('✅ All queues are empty');
            }

            // Step 3: Get last indexed block
            console.log('\n3️⃣  Getting last indexed block...');
            const lastBlock = await this.getLastIndexedBlock(chain);
            console.log(`✅ Last indexed block: ${lastBlock}`);

            // Step 4: Create snapshot
            console.log('\n4️⃣  Creating MongoDB snapshot...');
            const snapshotPath = await this.createMongoSnapshot(chain, lastBlock, options);
            console.log('\n✅ MongoDB snapshot completed successfully!');
            console.log(`📸 MongoDB snapshot location: ${snapshotPath}`);
            
            // Final reminder about what this snapshot includes
            console.log('\n📋 Snapshot Summary:');
            console.log('═'.repeat(50));
            console.log('✅ MongoDB data: INCLUDED');
            console.log('ℹ️  Elasticsearch data: NOT INCLUDED (use ES Snapshot API)');
            console.log('');
            console.log('💡 For a complete backup, you also need:');
            console.log('   • Elasticsearch snapshot (use ES Snapshot API)');
            console.log('   • Configuration files (config/ directory)');
            console.log('');
            console.log('📖 Elasticsearch snapshot docs:');
            console.log('   https://www.elastic.co/guide/en/elasticsearch/reference/current/snapshot-restore.html');

        // Remind user about indexer restart
        if (indexerStopped) {
            console.log('\n📝 Important Notes:');
            console.log('═'.repeat(40));
            console.log('🛑 The indexer has been stopped for this snapshot.');
            console.log('🔄 To restart the indexer when ready, run:');
            console.log(`   ./run ${chain}-indexer`);
            console.log('');
            console.log('💡 For migration scenarios, you may want to keep');
            console.log('   the indexer stopped until the migration is complete.');
        }

    } catch (error: any) {
        console.error(`\n❌ MongoDB snapshot failed: ${error.message}`);
        
        // Still remind about indexer restart on failure
        if (indexerStopped) {
            console.log('\n⚠️  Important: The indexer was stopped but snapshot failed.');
            console.log(`   To restart the indexer, run: ./run ${chain}-indexer`);
        }
        
        throw error;
    } finally {
        indexerController.close();
    }
    }

    private async getLastIndexedBlock(chain: string): Promise<number> {
        try {
            // Initialize Elasticsearch client
            const config = readConnectionConfig();
            const esClient = this.initESClient(config);

            // Query last block from Elasticsearch using the same pattern as common_functions.ts
            const blockIndex = `${chain}-block-*`;
            const results = await esClient.search<any>({
                index: blockIndex,
                size: 1,
                query: { bool: { filter: { match_all: {} } } },
                sort: [{ block_num: { order: "desc" } }]
            });

            // Extract the last block number using the same logic as getLastResult
            if (results.hits?.hits?.length > 0) {
                const firstHit = results.hits.hits[0];
                if (firstHit.sort) {
                    return firstHit.sort[0] as number;
                } else {
                    return (firstHit._source as any).block_num;
                }
            } else {
                console.warn('⚠️  No blocks found in Elasticsearch index');
                return 0;
            }
        } catch (error: any) {
            console.warn(`⚠️  Could not fetch last indexed block from Elasticsearch: ${error.message}`);
            console.warn('   Using 0 as default');
            return 0;
        }
    }

    private initESClient(config: any): Client {
        const node = `${config.elasticsearch.protocol}://${config.elasticsearch.host}`;
        return new Client({
            nodes: [node],
            auth: {
                username: config.elasticsearch.user,
                password: config.elasticsearch.pass
            },
            tls: {
                rejectUnauthorized: false
            }
        });
    }

    private async createMongoSnapshot(chain: string, lastBlock: number, options: SnapshotOptions): Promise<string> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const snapshotDir = options.output || path.join(process.cwd(), 'snapshots');
        
        // Ensure snapshot directory exists
        if (!fs.existsSync(snapshotDir)) {
            fs.mkdirSync(snapshotDir, { recursive: true });
        }

        const snapshotName = `${chain}_${lastBlock}_${timestamp}`;
        const snapshotPath = path.join(snapshotDir, snapshotName);

        // Read MongoDB config for dump
        const config = readConnectionConfig();
        const mongoHost = config.mongodb.host || '127.0.0.1';
        const mongoPort = config.mongodb.port || 27017;
        const dbName = `hyperion_${chain}`;

        // Extract connection details - no need to parse URL, we have host/port directly

        // Build mongodump command
        let dumpCommand = `mongodump --host ${mongoHost} --port ${mongoPort} --db ${dbName} --out ${snapshotPath}`;
        
        if (options.compress) {
            dumpCommand += ' --gzip';
        }

        if (options.collections) {
            const collections = options.collections.split(',');
            collections.forEach((collection: string) => {
                dumpCommand += ` --collection ${collection.trim()}`;
            });
        }

        console.log(`📁 Output directory: ${snapshotPath}`);
        console.log(`🔧 Executing: mongodump...`);
        console.log(`Database: ${dbName}`);
        console.log(`MongoDB Host: ${mongoHost}:${mongoPort}`);

        try {
            const { stdout: dumpOutput, stderr: dumpError } = await execAsync(dumpCommand);
            
            console.log(`📊 Mongodump output:`);
            if (dumpOutput) {
                console.log(dumpOutput);
            }
            if (dumpError) {
                console.log(`stderr: ${dumpError}`);
            }

            // Check if mongodump actually created the output directory
            if (!fs.existsSync(snapshotPath)) {
                throw new Error(`Mongodump completed but output directory was not created: ${snapshotPath}`);
            }

            // Check if the database directory was created inside the snapshot path
            const dbPath = path.join(snapshotPath, dbName);
            if (!fs.existsSync(dbPath)) {
                // List what was actually created
                const createdFiles = fs.readdirSync(snapshotPath);
                console.log(`📂 Created files/directories: ${createdFiles.join(', ')}`);
                
                if (createdFiles.length === 0) {
                    throw new Error(`Mongodump completed but no files were created. This might indicate:\n` +
                                  `  - Database '${dbName}' does not exist\n` +
                                  `  - MongoDB connection failed\n` +
                                  `  - Insufficient permissions`);
                }
            }
            
            if (dumpError && !dumpError.includes('done dumping')) {
                console.warn(`⚠️  Mongodump stderr: ${dumpError}`);
            }
        } catch (error: any) {
            throw new Error(`MongoDB dump failed: ${error.message}`);
        }

        console.log('✅ MongoDB snapshot created successfully');

        // Create metadata file
        const metadata: SnapshotMetadata = {
            chain,
            last_indexed_block: lastBlock,
            timestamp: new Date().toISOString(),
            hyperion_version: this.getHyperionVersion(),
            collections: options.collections ? options.collections.split(',') : 'all',
            compressed: options.compress || false,
            snapshot_path: snapshotPath
        };

        try {
            const metadataPath = path.join(snapshotPath, 'snapshot_metadata.json');
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            console.log(`📄 Metadata saved to: ${metadataPath}`);
        } catch (metadataError: any) {
            console.warn(`⚠️  Could not create metadata file: ${metadataError.message}`);
            console.warn('   The snapshot was created but without metadata');
        }

        // Optional: Create tar archive if requested
        if (options.archive) {
            console.log('\n5️⃣ Creating archive...');
            const archiveName = `${snapshotName}.tar${options.compress ? '.gz' : ''}`;
            const archivePath = path.join(snapshotDir, archiveName);
            
            const tarCommand = `tar -c${options.compress ? 'z' : ''}f ${archivePath} -C ${snapshotDir} ${snapshotName}`;
            await execAsync(tarCommand);
            
            console.log(`✅ Archive created: ${archivePath}`);

            // Optionally remove the unarchived directory
            if (options.removeAfterArchive) {
                await execAsync(`rm -rf ${snapshotPath}`);
                console.log('🗑️  Original snapshot directory removed');
            }
        }

        return snapshotPath;
    }

    async listSnapshots(chain?: string, options: { output?: string } = {}): Promise<void> {
        try {
            const snapshotDir = options.output || path.join(process.cwd(), 'snapshots');
            
            if (!fs.existsSync(snapshotDir)) {
                console.log('No MongoDB snapshots directory found');
                return;
            }

            const files = fs.readdirSync(snapshotDir);
            const snapshots = files.filter(f => {
                if (chain) {
                    return f.startsWith(`${chain}_`);
                }
                return f.includes('_');
            });

            if (snapshots.length === 0) {
                console.log('No MongoDB snapshots found');
                return;
            }

            console.log('\n📸 Available MongoDB snapshots:');
            console.log('═'.repeat(80));
            console.log('Chain      │ Block      │ Timestamp                  │ Type');
            console.log('───────────┼────────────┼────────────────────────────┼──────────');

            snapshots.forEach(snapshot => {
                const parts = snapshot.split('_');
                if (parts.length >= 3) {
                    const chainName = parts[0];
                    const block = parts[1];
                    const timestamp = parts.slice(2).join('_').replace('.tar.gz', '').replace('.tar', '');
                    const type = snapshot.endsWith('.tar.gz') ? 'Archive (gz)' : 
                               snapshot.endsWith('.tar') ? 'Archive' : 'Directory';
                    
                    console.log(`${chainName.padEnd(10)} │ ${block.padEnd(10)} │ ${timestamp.padEnd(26)} │ ${type}`);
                }
            });
        } catch (error: unknown) {
            console.error('Error listing MongoDB snapshots:', (error as Error).message);
        }
    }

    private async checkMongoDbTools(): Promise<void> {
        console.log('\n🔍 Checking MongoDB tools...');
        
        // Check for required tools
        const requiredTools = [
            { name: 'mongodump', description: 'MongoDB dump utility', required: true }
        ];

        const missingRequired: string[] = [];

        // Check required tools
        for (const tool of requiredTools) {
            try {
                await execAsync(`which ${tool.name}`);
                console.log(`✅ ${tool.name} found`);
            } catch (error) {
                console.log(`❌ ${tool.name} not found (REQUIRED)`);
                missingRequired.push(tool.name);
            }
        }

        // Show installation instructions if required tools are missing
        if (missingRequired.length > 0) {
            console.log('\n🚨 Missing Required MongoDB Tools');
            console.log('═'.repeat(50));
            console.log('The following MongoDB tools are required:');
            missingRequired.forEach(tool => console.log(`  - ${tool}`));
            
            this.showInstallationInstructions();
            
            throw new Error('Required MongoDB tools are not installed. Please install them and try again.');
        }

        console.log('✅ MongoDB tools check completed');
    }

    private showInstallationInstructions(): void {
        console.log('\n📦 Installation Instructions:');
        console.log('');
        console.log('🐧 Ubuntu/Debian:');
        console.log('   sudo apt-get update');
        console.log('   sudo apt-get install mongodb-database-tools');
        console.log('');
        console.log('🎩 CentOS/RHEL/Fedora:');
        console.log('   sudo yum install mongodb-database-tools');
        console.log('   # OR for newer versions:');
        console.log('   sudo dnf install mongodb-database-tools');
        console.log('');
        console.log('🍎 macOS:');
        console.log('   brew install mongodb/brew/mongodb-database-tools');
        console.log('');
        console.log('🐳 Docker Alternative:');
        console.log('   You can use MongoDB tools via Docker:');
        console.log('   alias mongodump="docker run --rm -v $(pwd):/backup --network host mongo:latest mongodump"');
        console.log('');
        console.log('📋 Manual Installation:');
        console.log('   Download from: https://www.mongodb.com/try/download/database-tools');
        console.log('');
    }

    private async testMongoConnection(chain: string): Promise<void> {
        console.log('\n🔍 Testing MongoDB connection and Elasticsearch access...');
        
        try {
            const config = readConnectionConfig();
            
            // Test Elasticsearch connection
            const esClient = this.initESClient(config);
            await esClient.ping();
            console.log('✅ Elasticsearch connection successful');

            // Test MongoDB connection with a simple ping
            const mongoHost = config.mongodb.host || '127.0.0.1';
            const mongoPort = config.mongodb.port || 27017;
            
            try {
                const testCommand = `mongodump --host ${mongoHost} --port ${mongoPort} --db admin --collection test_connection --limit 0 --dryRun 2>/dev/null || echo "connection_ok"`;
                const { stdout } = await execAsync(testCommand);
                if (stdout.includes('connection_ok') || stdout.includes('done dumping')) {
                    console.log('✅ MongoDB connection successful');
                } else {
                    console.warn(`⚠️  MongoDB connection test inconclusive: ${stdout}`);
                }
            } catch (error) {
                console.warn(`⚠️  Could not test MongoDB connection: ${(error as Error).message}`);
                console.warn('   Proceeding anyway - mongodump will show errors if connection fails');
            }

            // Check if the target database exists (informational only)
            const dbName = `hyperion_${chain}`;
            console.log(`📊 Target database: ${dbName}`);
            console.log(`📊 Elasticsearch block index: ${chain}-block-*`);
            
        } catch (error: any) {
            throw new Error(`Connection test failed: ${error.message}`);
        }
    }

    private getHyperionVersion(): string {
        try {
            const packageJsonPath = path.join(process.cwd(), 'package.json');
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            return packageJson.version || 'unknown';
        } catch (error: any) {
            console.warn(`⚠️  Could not read version from package.json: ${error.message}`);
            return 'unknown';
        }
    }
}
