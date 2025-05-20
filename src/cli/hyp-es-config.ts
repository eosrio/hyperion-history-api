import {Command} from 'commander';
import {Client} from '@elastic/elasticsearch';
import path from 'path';
import {readFile, writeFile} from 'fs/promises';
import {existsSync, writeFileSync, mkdirSync} from 'fs';
import {HyperionConnections} from '../interfaces/hyperionConnections.js';

const program = new Command();
const rootDir = path.join(import.meta.dirname, '../../');
const configDir = path.join(rootDir, 'config');
const connectionsPath = path.join(configDir, 'connections.json');
// File to persist index registry between runs
const registryPath = path.join('.cli', '.indices-registry.json');

if (!existsSync('.cli')) {
    mkdirSync('.cli');
}

// Interface to maintain index registry
interface IndicesRegistry {
    oldIndices?: string[];
    newIndices?: string[];
}

// Global storage for index registry
const indicesRegistry: Record<string, IndicesRegistry> = {};

// Task definition for reindexing tasks
interface ReindexTask {
    taskId: string | number;
    targetIndex: string;
    rangeStart: number;
    rangeEnd: number;
    partition: number;
}

// Extended interface for information about each index type
interface IndexTypeInfo {
    pattern: string; // Index pattern (e.g., chain-block-*)
    basePrefix: string; // Base prefix (e.g., chain-block)
    versionPrefix: string; // Prefix with version (e.g., chain-block-v1)
    field: string; // Field for partitioning (e.g., block_num)
    partitionSize: number; // Current partition size
    minValue: number; // Minimum field value
    maxValue: number; // Maximum field value
    count: number; // Total document count
    oldIndices: string[]; // List of old indices
    newIndices: string[]; // List of new indices to create
}

// Interface for Hyperion configuration
interface HyperionChainConfig {
    settings?: {
        chain?: string;
        index_partition_size?: number;
        index_partitions?: {
            block?: {
                enabled?: boolean;
                partition_size?: number;
            };
            action?: {
                enabled?: boolean;
                partition_size?: number;
            };
            delta?: {
                enabled?: boolean;
                partition_size?: number;
            };
        };
    };
}

// Function to save the index registry to file
async function saveRegistryToFile(): Promise<void> {
    try {
        await writeFile(registryPath, JSON.stringify(indicesRegistry, null, 2));
        console.log(`✅ Index registry saved to ${registryPath}`);
    } catch (error: any) {
        console.error(`❌ Error saving index registry: ${error.message}`);
    }
}

// Function to load the index registry from file
async function loadRegistryFromFile(): Promise<void> {
    try {
        if (existsSync(registryPath)) {
            const registryFile = await readFile(registryPath);
            const loadedRegistry = JSON.parse(registryFile.toString());

            for (const [chain, types] of Object.entries(loadedRegistry)) {
                indicesRegistry[chain] = types as IndicesRegistry;
            }

            console.log(`✅ Index registry loaded from ${registryPath}`);
        } else {
            console.log(`⚠️ Index registry file not found. A new one will be created.`);
        }
    } catch (error: any) {
        console.error(`❌ Error loading index registry: ${error.message}`);
    }
}

// Get connections from connections.json file
async function getConnections(): Promise<HyperionConnections | null> {
    if (existsSync(connectionsPath)) {
        const connectionsJsonFile = await readFile(connectionsPath);
        return JSON.parse(connectionsJsonFile.toString());
    } else {
        return null;
    }
}

// Function to get the Hyperion configuration for a chain
async function getChainConfig(chain: string): Promise<HyperionChainConfig | null> {
    const configPath = path.join(configDir, 'chains', `${chain}.config.json`);

    try {
        if (existsSync(configPath)) {
            const configFile = await readFile(configPath);
            return JSON.parse(configFile.toString());
        } else {
            console.log(`Configuration file not found: ${configPath}`);
            return null;
        }
    } catch (error: any) {
        console.error(`Error reading configuration file: ${error.message}`);
        return null;
    }
}

// Function to get the configured partition size
async function getConfiguredPartitionSize(chain: string, indexType: string): Promise<number | null> {
    const config = await getChainConfig(chain);

    if (!config || !config.settings) {
        return null;
    }

    // Check for specific index type configuration
    if (config.settings.index_partitions) {
        const partitionConfig = config.settings.index_partitions[indexType as keyof typeof config.settings.index_partitions];

        if (partitionConfig && typeof partitionConfig.partition_size === 'number') {
            console.log(`Configured partition size for ${indexType}: ${partitionConfig.partition_size} blocks`);
            return partitionConfig.partition_size;
        }
    }

    // Fallback to global configuration
    if (typeof config.settings.index_partition_size === 'number') {
        console.log(`Global partition size configured: ${config.settings.index_partition_size} blocks`);
        return config.settings.index_partition_size;
    }

    console.log(`No partition size configured for ${indexType}`);
    return null;
}

// Create an Elasticsearch client based on settings
async function createEsClient(): Promise<Client | null> {
    const connections = await getConnections();

    if (!connections) {
        console.log(`connections.json not found. Run "./hyp-config connections init" to set it up.`);
        return null;
    }

    const _es = connections.elasticsearch;
    let es_url;

    if (!_es.protocol) {
        _es.protocol = 'http';
    }

    if (_es.user !== '') {
        es_url = `${_es.protocol}://${_es.user}:${_es.pass}@${_es.host}`;
    } else {
        es_url = `${_es.protocol}://${_es.host}`;
    }

    return new Client({
        node: es_url,
        tls: {
            rejectUnauthorized: false
        }
    });
}

// Get statistics (min, max, count) for a numeric field
async function getFieldStats(client: Client, indexName: string, fieldName: string) {
    try {
        const response = await client.search({
            index: indexName,
            body: {
                size: 0,
                aggs: {
                    min_value: {min: {field: fieldName}},
                    max_value: {max: {field: fieldName}}
                }
            }
        } as any);

        const countResponse = await client.count({
            index: indexName
        });

        // Safely access aggregations
        const minValue =
            response.aggregations &&
            typeof response.aggregations === 'object' &&
            response.aggregations.min_value &&
            'value' in response.aggregations.min_value
                ? response.aggregations.min_value.value
                : 0;

        const maxValue =
            response.aggregations &&
            typeof response.aggregations === 'object' &&
            response.aggregations.max_value &&
            'value' in response.aggregations.max_value
                ? response.aggregations.max_value.value
                : 0;

        return {
            min: Math.floor(minValue as number),
            max: Math.ceil(maxValue as number),
            count: countResponse.count
        };
    } catch (error) {
        console.error(`Error getting statistics: ${error}`);
        return null;
    }
}

// Function to infer partition size based on existing indices
async function inferPartitionSize(client: Client, indexNames: string[], field: string): Promise<number | null> {
    try {
        // Map indices and partition numbers
        const partitionData: {
            index: string;
            partNum: number;
            minBlock?: number;
            maxBlock?: number;
            count?: number;
        }[] = [];

        // Extract partition numbers and organize them
        for (const name of indexNames) {
            const partMatch = name.match(/-(\d{6})$/);
            if (partMatch) {
                const partNum = parseInt(partMatch[1]);
                partitionData.push({index: name, partNum});
            }
        }

        // Sort by partition number
        partitionData.sort((a, b) => a.partNum - b.partNum);

        // If we have only one partition, we can't accurately infer
        if (partitionData.length <= 1) {
            console.log("Couldn't infer partition size: insufficient number of partitions");
            return null;
        }

        // For each partition, get min and max block_num
        for (const partInfo of partitionData) {
            try {
                const minResponse = await client.search({
                    index: partInfo.index,
                    size: 1,
                    sort: [{[field]: {order: 'asc'}}],
                    _source: [field]
                });

                const maxResponse = await client.search({
                    index: partInfo.index,
                    size: 1,
                    sort: [{[field]: {order: 'desc'}}],
                    _source: [field]
                });

                const countResponse = await client.count({
                    index: partInfo.index
                });

                if (minResponse.hits?.hits?.length > 0 && maxResponse.hits?.hits?.length > 0) {
                    const minSource = minResponse.hits.hits[0]._source as Record<string, any>;
                    const maxSource = maxResponse.hits.hits[0]._source as Record<string, any>;

                    partInfo.minBlock = minSource[field] as number;
                    partInfo.maxBlock = maxSource[field] as number;
                    partInfo.count = countResponse.count;
                }
            } catch (err) {
                console.warn(`Couldn't get statistics for index ${partInfo.index}`);
            }
        }

        // Calculate partition sizes from complete partitions (middle ones)
        const sizes: number[] = [];

        for (let i = 1; i < partitionData.length; i++) {
            const current = partitionData[i];
            const prev = partitionData[i - 1];

            if (current.minBlock !== undefined && prev.minBlock !== undefined) {
                // Difference between starting blocks is a good estimate
                const diff = current.minBlock - prev.minBlock;
                if (diff > 10000) {
                    // Ignore very small differences
                    sizes.push(diff);
                }
            }

            // Also use internal partition range for estimation
            if (current.minBlock !== undefined && current.maxBlock !== undefined) {
                const range = current.maxBlock - current.minBlock + 1;
                if (range > 10000) {
                    // Ignore very small partitions
                    sizes.push(range);
                }
            }
        }

        if (sizes.length > 0) {
            // Use the median value as estimate
            sizes.sort((a, b) => a - b);
            const medianSize = sizes[Math.floor(sizes.length / 2)];

            // Round to next round value (100k, 1M, etc.)
            const magnitude = Math.pow(10, Math.floor(Math.log10(medianSize)));
            const roundedSize = Math.round(medianSize / magnitude) * magnitude;

            console.log(`Inferred partition size: ${roundedSize} blocks`);
            return roundedSize;
        }

        return null;
    } catch (error: any) {
        console.error(`Error inferring partition size: ${error.message}`);
        return null;
    }
}

// Function to get information about existing index patterns
async function getIndexPattern(client: Client, chain: string, indexType: string): Promise<IndexTypeInfo | null> {
    const basePattern = `${chain}-${indexType}-*`;

    try {
        // Check if indices exist for this pattern
        const indices = await client.cat.indices({
            index: basePattern,
            format: 'json'
        });

        if (!indices || indices.length === 0) {
            console.log(`No indices found for pattern ${basePattern}`);
            return null;
        }

        // Analyze naming pattern
        const indexNames: string[] = [];
        const partitionNumbers: number[] = [];

        for (const idx of indices) {
            if (idx && typeof idx.index === 'string') {
                indexNames.push(idx.index);

                // Extract partition number
                const partMatch = idx.index.match(/-(\d{6})$/);
                if (partMatch) {
                    partitionNumbers.push(parseInt(partMatch[1]));
                }
            }
        }

        if (indexNames.length === 0) {
            console.log(`No valid indices found for pattern ${basePattern}`);
            return null;
        }

        // Detect format (with or without version)
        let versionMatch: RegExpMatchArray | null = null;
        let basePrefix = `${chain}-${indexType}`;
        let versionPrefix = basePrefix;

        // First check if there's any index with version
        for (const name of indexNames) {
            // Check format with version (e.g., chain-block-v1-000001)
            const vPattern = new RegExp(`^(${chain}-${indexType}-v\\d+)(?:-\\d{6})?$`);
            versionMatch = name.match(vPattern);

            if (versionMatch) {
                versionPrefix = versionMatch[1];
                console.log(`Detected version in indices: ${versionPrefix}`);
                break;
            }
        }

        // If no version found in existing indices, check if we should add one
        if (!versionMatch) {
            // If all indices have no version, add v1
            versionPrefix = `${basePrefix}-v1`;
            console.log(`No version detected. Using new version: ${versionPrefix}`);
        }

        // Field for partitioning
        const field = 'block_num'; // We assume block_num is the common field for all types

        // Get field statistics
        const stats = await getFieldStats(client, basePattern, field);
        if (!stats) {
            console.error(`Error: Couldn't get statistics for field ${field} in ${basePattern}`);
            return null;
        }

        // Get current partition size from configuration file
        let partitionSize = 0;

        try {
            const configPartitionSize = await getConfiguredPartitionSize(chain, indexType);
            if (configPartitionSize && configPartitionSize > 0) {
                partitionSize = configPartitionSize;
            }
        } catch (error) {
            console.warn(`⚠️ Couldn't read partition configuration`);
        }

        // If not found in configuration or if it's zero, try to infer
        if (partitionSize <= 0 && indexNames.length > 1) {
            const inferredSize = await inferPartitionSize(client, indexNames, field);
            if (inferredSize) {
                partitionSize = inferredSize;
            }
        }

        // If still couldn't determine, use default
        if (partitionSize <= 0) {
            partitionSize = 10000; // Default value
            console.log(`Using default partition size: ${partitionSize} blocks`);
        }

        // Store indices in registry for later use
        if (!indicesRegistry[chain]) {
            indicesRegistry[chain] = {};
        }

        if (!indicesRegistry[chain][indexType]) {
            indicesRegistry[chain][indexType] = {
                oldIndices: indexNames,
                newIndices: []
            };
        }

        return {
            pattern: basePattern,
            basePrefix,
            versionPrefix,
            field,
            partitionSize,
            minValue: stats.min,
            maxValue: stats.max,
            count: stats.count,
            oldIndices: indexNames,
            newIndices: []
        };
    } catch (error: any) {
        console.error(`Error analyzing index pattern ${basePattern}: ${error.message}`);
        return null;
    }
}

// Function to update the chain configuration file with new partition sizes
async function updateChainConfigPartitions(chain: string, partitionSizes: Record<string, number>): Promise<boolean> {
    const configPath = path.join(configDir, 'chains', `${chain}.config.json`);

    try {
        // Check if configuration file exists
        if (!existsSync(configPath)) {
            console.error(`❌ Error: Configuration file not found for chain ${chain}!`);
            console.error(`   Expected path: ${configPath}`);
            return false;
        }

        // Read current configuration file
        const configFile = await readFile(configPath);
        const config: HyperionChainConfig = JSON.parse(configFile.toString());

        // Validate configuration structure
        if (!config.settings) {
            config.settings = {};
        }

        if (!config.settings.index_partitions) {
            config.settings.index_partitions = {};
        }

        // Update partition settings for each type
        for (const [type, size] of Object.entries(partitionSizes)) {
            if (size <= 0) {
                continue;
            }

            // Ensure object for the type exists
            if (!config.settings.index_partitions[type as keyof typeof config.settings.index_partitions]) {
                config.settings.index_partitions[type as keyof typeof config.settings.index_partitions] = {};
            }

            // Access type configuration object
            const typeConfig = config.settings.index_partitions[type as keyof typeof config.settings.index_partitions];
            if (typeConfig) {
                // Update partition size
                (typeConfig as any).partition_size = size;

                // For blocks, ensure "enabled" is set to true
                if (type === 'block') {
                    (typeConfig as any).enabled = true;
                }
            }
        }

        // Save changes to configuration file
        writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`✅ Chain ${chain} configuration file updated with new partition sizes`);

        return true;
    } catch (error: any) {
        console.error(`❌ Error updating configuration file: ${error.message}`);
        return false;
    }
}

// Check if the indexer is running
async function checkIndexerStatus(chain: string): Promise<boolean> {
    try {
        // Run PM2 command to list processes
        const {execSync} = await import('child_process');
        const pm2Output = execSync('pm2 jlist').toString();

        // Parse PM2 output
        const pm2Processes = JSON.parse(pm2Output);

        // Check if any indexer process for the chain is running
        const indexerProcess = pm2Processes.find((proc: any) => {
            const name = proc.name || '';
            return name.includes('hyp-') && name.includes(chain) && !name.includes('api');
        });

        return !!indexerProcess && ['online', 'launching'].includes(indexerProcess.pm2_env?.status);
    } catch (error) {
        console.warn(`⚠️ Couldn't check PM2 status: ${error}`);
        console.warn('⚠️ Proceeding with the operation, but make sure the indexer is stopped before continuing.');
        return false;
    }
}

// Main function to repartition a specific index type
async function repartitionTypeIndices(
    chain: string,
    type: string,
    partitionSize: number,
    options: any,
    configUpdated: {success: boolean} = {success: false}
): Promise<boolean> {
    const client = await createEsClient();
    if (!client) {
        console.error(`❌ Error: Couldn't create Elasticsearch client`);
        return false;
    }

    try {
        // Get information about existing indices
        const indexInfo = await getIndexPattern(client, chain, type);
        if (!indexInfo) {
            if (options.skipMissing) {
                console.warn(`⚠️ No ${type} indices found for chain ${chain}. Skipping...`);
                return true;
            } else {
                console.error(`❌ Error: Couldn't find ${type} indices for chain ${chain}`);
                return false;
            }
        }

        // Highlight difference between current and new size
        console.log(`\nRepartitioning ${type} indices:`);
        console.log(`  Pattern: ${indexInfo.pattern}`);
        console.log(`  Detected version: ${indexInfo.versionPrefix}`);

        // Display current vs new size
        if (indexInfo.partitionSize !== partitionSize) {
            console.log(`  Current partition size: ${indexInfo.partitionSize} blocks`);
            console.log(`  ↳ New partition size: ${partitionSize} blocks 🔄`);
        } else {
            console.log(`  Current partition size: ${indexInfo.partitionSize} blocks (no change)`);
        }

        console.log(`  Block range: ${indexInfo.minValue} to ${indexInfo.maxValue}`);
        console.log(`  Total documents: ${indexInfo.count}`);

        // Calculate new indices based on specific partition size
        const startPartition = Math.floor(indexInfo.minValue / partitionSize);
        const endPartition = Math.ceil(indexInfo.maxValue / partitionSize);

        console.log(`  Starting partition: ${startPartition}`);
        console.log(`  Ending partition: ${endPartition - 1}`);
        console.log(`  Total partitions to create: ${endPartition - startPartition}`);

        // Confirm before proceeding
        if (!options.yes) {
            console.log(`\n⚠️  WARNING: This operation will reindex all ${type} data and may take a long time.`);
            console.log(`⚠️  Existing indices will remain available until reindexing is complete.`);

            const readline = await import('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const answer = await new Promise<string>((resolve) => {
                rl.question(`\nContinue with ${type} reindexing? [y/N] `, (answer) => {
                    rl.close();
                    resolve(answer);
                });
            });

            if (answer.toLowerCase() !== 'y') {
                console.log(`${type} repartitioning cancelled by user.`);
                return false;
            }

            // Update chain configuration file AFTER user confirmation
            if (!configUpdated.success) {
                const updateObj: Record<string, number> = {};
                updateObj[type] = partitionSize;
                configUpdated.success = await updateChainConfigPartitions(chain, updateObj);
            } else {
                // Add this type to already updated file
                const updateObj: Record<string, number> = {};
                updateObj[type] = partitionSize;
                await updateChainConfigPartitions(chain, updateObj);
            }
        } else if (!configUpdated.success) {
            // If no confirmation needed, update directly
            const updateObj: Record<string, number> = {};
            updateObj[type] = partitionSize;
            configUpdated.success = await updateChainConfigPartitions(chain, updateObj);
        } else {
            // Add this type to already updated file
            const updateObj: Record<string, number> = {};
            updateObj[type] = partitionSize;
            await updateChainConfigPartitions(chain, updateObj);
        }

        // Start reindexing process for each new partition
        const tasks: ReindexTask[] = [];
        const newIndices: string[] = [];

        for (let i = startPartition; i < endPartition; i++) {
            const partitionNumber = i + 1;
            const paddedNumber = String(partitionNumber).padStart(6, '0');
            const targetIndex = `${indexInfo.versionPrefix}-${paddedNumber}`;

            // Add to the new indices list
            newIndices.push(targetIndex);

            // Calculate document range for this specific partition
            const rangeStart = i * partitionSize;
            const rangeEnd = rangeStart + partitionSize - 1;

            // Check if target index already exists
            const targetExists = await client.indices.exists({index: targetIndex});
            if (targetExists) {
                if (options.force) {
                    await client.indices.delete({index: targetIndex});
                    console.log(`  Index ${targetIndex} deleted for recreation`);
                } else {
                    console.error(`❌ Error: Index ${targetIndex} already exists. Use --force to replace it.`);
                    if (!options.continueOnError) {
                        return false;
                    }
                    continue;
                }
            }

            console.log(`\n  Starting reindexing for ${targetIndex}`);
            console.log(`  Range of ${indexInfo.field}: ${rangeStart} to ${rangeEnd}`);

            // Create reindexing task using all old indices as source
            const reindexBody = {
                source: {
                    index: indexInfo.oldIndices.join(','),
                    query: {
                        range: {
                            [indexInfo.field]: {
                                gte: rangeStart,
                                lte: rangeEnd
                            }
                        }
                    }
                },
                dest: {
                    index: targetIndex
                }
            };

            try {
                // Start reindexing task
                const response = await client.reindex({
                    body: reindexBody,
                    wait_for_completion: false, // Ensure reindexing runs as an asynchronous task
                    refresh: true
                } as any);

                // Check if the response contains the 'task' property
                const taskId = response?.task;

                if (!taskId) {
                    console.error(`❌ Error: Couldn't get reindexing task ID. Response:`, response);
                    if (!options.continueOnError) {
                        return false;
                    }
                    continue;
                }

                tasks.push({
                    taskId,
                    targetIndex,
                    rangeStart,
                    rangeEnd,
                    partition: partitionNumber
                });

                // Store the new index in registry
                if (!indicesRegistry[chain]) {
                    indicesRegistry[chain] = {};
                }

                if (!indicesRegistry[chain][type]) {
                    indicesRegistry[chain][type] = {
                        oldIndices: indexInfo.oldIndices,
                        newIndices: []
                    };
                }

                indicesRegistry[chain][type].newIndices.push(targetIndex);

                console.log(`  ✓ Reindexing task started: ${taskId}`);
            } catch (error: any) {
                console.error(`❌ Error starting reindexing for ${targetIndex}: ${error.message}`);

                if (!options.continueOnError) {
                    return false;
                }
            }
        }

        // Update registry with the full list of indices
        if (indicesRegistry[chain] && indicesRegistry[chain][type]) {
            indicesRegistry[chain][type].oldIndices = indexInfo.oldIndices;
            indicesRegistry[chain][type].newIndices = newIndices;

            // Save registry to file
            await saveRegistryToFile();
        }

        if (tasks.length === 0) {
            console.log(`\n❌ No reindexing tasks were started for ${type}`);
            return false;
        }

        console.log(`\n✅ ${tasks.length} reindexing tasks started for ${type}`);
        console.log(`\nTasks are running in the background.`);
        console.log(`To check status, run:`);
        console.log(`  ./hyp-es-config tasks`);

        if (!options.skipCleanup) {
            console.log(`\nAfter all tasks are completed, you can:`);
            console.log(`  - Remove old indices with: ./hyp-es-config cleanup ${chain}`);
            console.log(`  - Or keep old indices and remove new ones: ./hyp-es-config cleanup ${chain} --delete-new-indices`);
        }

        return true;
    } catch (error: any) {
        console.error(`❌ Error during ${type} repartitioning: ${error.message}`);
        if (error.meta && error.meta.body) {
            console.error(JSON.stringify(error.meta.body, null, 2));
        }
        return false;
    }
}

// Function to clean up old or new indices after successful repartitioning
async function cleanupIndices(chain: string, partitionSizes: Record<string, number>, options: any) {
    const deleteNewIndices = options.deleteNewIndices || false;
    const targetType = deleteNewIndices ? 'new' : 'old';

    console.log(`Starting cleanup of ${targetType} indices for chain ${chain}`);

    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        // Load registry from file
        await loadRegistryFromFile();

        const indexTypes = ['block', 'action', 'delta'];
        let totalDeleted = 0;

        for (const type of indexTypes) {
            // Check if the index type was modified during repartitioning
            if (!indicesRegistry[chain] || !indicesRegistry[chain][type]) {
                console.log(`  ⚠️ Nenhuma operação realizada para índices do tipo ${type}. Pulando...`);
                continue;
            }

            // Skip index types without data in the registry and without detected modifications
            if (!indicesRegistry[chain] || !indicesRegistry[chain][type]) {
                console.log(`  ⚠️ No registry data found for ${type} indices. Skipping...`);
                continue;
            }

            // Check if there are indices created during repartitioning
            if (!indicesRegistry[chain] || !indicesRegistry[chain][type]) {
                console.log(`  ⚠️ No registry data for ${type} indices. Trying to detect indices.`);

                // Try to detect indices by pattern
                const info = await getIndexPattern(client, chain, type);
                if (!info) {
                    console.log(`  ⚠️ No ${type} indices found for pattern ${chain}-${type}-*. Skipping...`);
                    continue;
                }

                // If we detect indices but don't have registry info, we can't safely determine old vs new
                console.log(`  ⚠️ Found ${info.oldIndices.length} ${type} indices but no repartitioning registry.`);
                console.log(`     Use partition size as criteria to classify indices.`);

                const partitionSize = partitionSizes[type as keyof typeof partitionSizes] || 0;
                if (partitionSize <= 0) {
                    console.log(`  ⚠️ No partition size defined for ${type}. Skipping...`);
                    continue;
                }

                // Classify indices based on observed size
                const oldIndices: string[] = [];
                const newIndices: string[] = [];

                // For each index, get min/max block_num and determine if new or old
                for (const indexName of info.oldIndices) {
                    try {
                        const stats = await getFieldStats(client, indexName, 'block_num');
                        if (stats && typeof stats.min === 'number' && typeof stats.max === 'number') {
                            const range = stats.max - stats.min + 1;
                            // If range is close to partition size, it's likely a new partitioned index
                            const isLikelyNew = range <= partitionSize * 1.3;

                            if (isLikelyNew) {
                                newIndices.push(indexName);
                            } else {
                                oldIndices.push(indexName);
                            }
                        } else {
                            // If can't determine range, consider as old for safety
                            oldIndices.push(indexName);
                        }
                    } catch (err) {
                        // In case of error querying the index, consider as old for safety
                        oldIndices.push(indexName);
                        console.warn(`  ⚠️ Couldn't analyze index ${indexName}: ${err}`);
                    }
                }

                // Save to registry
                if (!indicesRegistry[chain]) {
                    indicesRegistry[chain] = {};
                }

                indicesRegistry[chain][type] = {
                    oldIndices: oldIndices,
                    newIndices: newIndices
                };

                await saveRegistryToFile();
            }

            // Get indices to delete based on option
            const registry = indicesRegistry[chain][type];

            // Simplify to use only oldIndices and newIndices
            registry.oldIndices = Array.from(registry.oldIndices || []);
            registry.newIndices = Array.from(registry.newIndices || []);

            // Verify if the index type was modified during repartitioning
            if (!registry.oldIndices.length && !registry.newIndices.length) {
                console.log(`  ⚠️ No modifications detected for ${type} indices. Skipping...`);
                continue;
            }

            // Check if there are indices created during repartitioning
            if (deleteNewIndices && (!registry.newIndices || registry.newIndices.length === 0)) {
                console.log(`  ⚠️ No new indices found for ${type}. Skipping...`);
                continue;
            }

            if (!deleteNewIndices && (!registry.oldIndices || registry.oldIndices.length === 0)) {
                console.log(`  ⚠️ No old indices found for ${type}. Skipping...`);
                continue;
            }

            const indicesToDelete = deleteNewIndices ? registry.newIndices || [] : registry.oldIndices || [];
            const indicesToKeep = deleteNewIndices ? registry.oldIndices || [] : registry.newIndices || [];

            console.log(`\n${type} indices:`);
            console.log(`  ${targetType} indices to remove: ${indicesToDelete.length}`);
            console.log(`  Indices to keep: ${indicesToKeep.length}`);

            if (indicesToDelete.length === 0) {
                console.log(`  ✓ No ${targetType} indices to remove for ${type}`);
                continue;
            }

            // Confirm before deleting
            if (!options.yes) {
                console.log(`\n⚠️  WARNING: This operation will delete ${indicesToDelete.length} ${targetType} ${type} indices.`);
                console.log('⚠️  This action CANNOT be undone!');
                console.log(`⚠️  The following indices will be removed: ${indicesToDelete.join(', ')}`);

                const readline = await import('readline');
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                const answer = await new Promise<string>((resolve) => {
                    rl.question(`\nContinue with deleting ${targetType} ${type} indices? [y/N] `, (answer) => {
                        rl.close();
                        resolve(answer);
                    });
                });

                if (answer.toLowerCase() !== 'y') {
                    console.log(`${type} cleanup cancelled by user.`);
                    continue;
                }
            }

            // Delete indices
            for (const idx of indicesToDelete) {
                try {
                    await client.indices.delete({index: idx});
                    console.log(`  ✓ Index ${idx} successfully deleted`);
                    totalDeleted++;
                } catch (error: any) {
                    console.error(`  ❌ Error deleting index ${idx}: ${error.message}`);
                    if (!options.continueOnError) {
                        process.exit(1);
                    }
                }
            }

            // Update registry after deletion
            if (deleteNewIndices) {
                indicesRegistry[chain][type].newIndices = [];
            } else {
                indicesRegistry[chain][type].oldIndices = [];
            }
        }

        // Save updated registry
        await saveRegistryToFile();

        console.log(`\nCleanup completed successfully! Deleted ${totalDeleted} indices.`);
    } catch (error: any) {
        console.error(`Error during cleanup: ${error.message}`);
        if (error.meta && error.meta.body) {
            console.error(JSON.stringify(error.meta.body, null, 2));
        }
        process.exit(1);
    }
}

// List available indices
async function listIndices() {
    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        const indices = await client.cat.indices({format: 'json'});

        console.log('\nAvailable indices:');
        console.log('------------------------------------------------------------------');
        console.log('Index                          | Documents |   Size      | Status');
        console.log('------------------------------------------------------------------');

        indices.forEach((index: any) => {
            if (index && index.index) {
                const indexName = index.index.toString().padEnd(30);
                const docsCount = (index.docsCount || index['docs.count'] || '0').padEnd(10);
                const size = (index['pri.store.size'] || index.priStoreSize || '0').padEnd(11);
                const health = index.health || '?';

                console.log(`${indexName} | ${docsCount} | ${size} | ${health}`);
            }
        });
    } catch (error: any) {
        console.error(`Error listing indices: ${error.message}`);
        process.exit(1);
    }
}

// List and monitor Elasticsearch tasks
async function listTasks(options: any) {
    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        // Get all active tasks in Elasticsearch
        const tasksResponse = await client.tasks.list({
            detailed: true,
            actions: '*reindex*'
        });

        const tasks = tasksResponse.nodes
            ? Object.entries(tasksResponse.nodes).flatMap(([nodeId, nodeInfo]: [string, any]) =>
                  nodeInfo.tasks
                      ? Object.entries(nodeInfo.tasks).map(([taskId, taskInfo]: [string, any]) => ({
                            fullTaskId: `${nodeId}:${taskId}`,
                            nodeId,
                            taskId,
                            action: taskInfo.action,
                            status: taskInfo.status,
                            running_time_ns: taskInfo.running_time_in_nanos,
                            running_time: Math.floor(taskInfo.running_time_in_nanos / 1000000) + 'ms',
                            description: taskInfo.description
                        }))
                      : []
              )
            : [];

        if (tasks.length === 0) {
            console.log('\nNo reindexing tasks currently running.');
            return;
        }

        console.log('\nActive reindexing tasks:');
        console.log('------------------------------------------------------------------');
        console.log('Task ID                         | Action    | Running Time    | Description');
        console.log('------------------------------------------------------------------');

        tasks.forEach((task) => {
            const taskIdFormatted = task.fullTaskId.padEnd(30);
            const action = (task.action || '').padEnd(10);
            const runningTime = (task.running_time || '').padEnd(17);

            console.log(`${taskIdFormatted} | ${action} | ${runningTime} | ${task.description || ''}`);
        });
    } catch (error: any) {
        console.error(`Error listing tasks: ${error.message}`);
        if (error.meta && error.meta.body) {
            console.error(JSON.stringify(error.meta.body, null, 2));
        }
        process.exit(1);
    }
}

// Create CLI commands
(() => {
    // Load registry at startup
    loadRegistryFromFile().catch(console.error);

    program.version('1.0.0').description('Tool to manage Elasticsearch indices for Hyperion');

    // Command to list indices
    program.command('list').alias('ls').description('List all Elasticsearch indices').action(listIndices);

    // Command to list tasks
    program.command('tasks').description('List and monitor active reindexing tasks').action(listTasks);

    // Command to repartition all indices of a chain
    program
        .command('repartition <chain>')
        .description('Repartition indices (block, action, delta) to a new partition size')
        .option('--global <size>', 'Set the same partition size for all index types')
        .option('--blocks <size>', 'Set specific partition size for block indices')
        .option('--actions <size>', 'Set specific partition size for action indices')
        .option('--deltas <size>', 'Set specific partition size for delta indices')
        .option('--force', 'Force operation even if target indices already exist')
        .option('--skip-missing', 'Continue even if some index types are not found')
        .option('--skip-cleanup', "Don't show instructions about cleaning up old indices")
        .option('--continue-on-error', 'Continue even if errors occur in some operations')
        .option('-y, --yes', "Don't ask for confirmation")
        .action(async (chain, options) => {
            // Check if indexer is running
            const pm2Status = await checkIndexerStatus(chain);
            if (pm2Status) {
                console.error(`❌ The indexer for chain ${chain} is still running! Stop it before repartitioning indices.`);
                console.error(`   Use: ./hyp-control stop chain=${chain}`);
                process.exit(1);
            }

            // Validate that at least one size option was provided
            if (!options.global && !options.blocks && !options.actions && !options.deltas) {
                console.error('❌ Error: You must specify at least one partition size using --global, --blocks, --actions or --deltas');
                process.exit(1);
            }

            // Map sizes for each type
            const partitionSizes: Record<string, number> = {
                block: 0,
                action: 0,
                delta: 0
            };

            // If global size provided, apply to all
            if (options.global) {
                const globalSize = parseInt(options.global, 10);
                if (isNaN(globalSize) || globalSize <= 0) {
                    console.error('❌ Error: Global partition size must be a positive number');
                    process.exit(1);
                }
                partitionSizes.block = globalSize;
                partitionSizes.action = globalSize;
                partitionSizes.delta = globalSize;
            }

            // Override with specific sizes if provided
            if (options.blocks) {
                const size = parseInt(options.blocks, 10);
                if (isNaN(size) || size <= 0) {
                    console.error('❌ Error: Block partition size must be a positive number');
                    process.exit(1);
                }
                partitionSizes.block = size;
            }

            if (options.actions) {
                const size = parseInt(options.actions, 10);
                if (isNaN(size) || size <= 0) {
                    console.error('❌ Error: Action partition size must be a positive number');
                    process.exit(1);
                }
                partitionSizes.action = size;
            }

            if (options.deltas) {
                const size = parseInt(options.deltas, 10);
                if (isNaN(size) || size <= 0) {
                    console.error('❌ Error: Delta partition size must be a positive number');
                    process.exit(1);
                }
                partitionSizes.delta = size;
            }

            console.log(`\n🔄 Repartitioning configuration for ${chain}:`);
            for (const [type, size] of Object.entries(partitionSizes)) {
                if (size > 0) {
                    console.log(`   📊 ${type} index: ${size} blocks per partition`);
                }
            }

            // Repartitioning process for each type
            const configUpdated = {success: false};
            for (const [type, size] of Object.entries(partitionSizes)) {
                if (size > 0) {
                    console.log(`\n🔄 Starting repartitioning for ${type} indices with size ${size}`);
                    const success = await repartitionTypeIndices(chain, type, size, options, configUpdated);
                    if (!success && !options.continueOnError) {
                        console.error(`❌ Failed to repartition ${type} indices`);
                        process.exit(1);
                    }
                }
            }
        });

    // Updated cleanup command to infer indices to delete based on the flag and remove the need for size options
    program
        .command('cleanup <chain>')
        .description('Remove old or new indices after successful repartitioning')
        .option('--blocks', 'Remove old block indices')
        .option('--actions', 'Remove old action indices')
        .option('--deltas', 'Remove old delta indices')
        .option('--global <size>', 'Global partition size for all index types')
        .option('--delete-new-indices', 'Remove new indices instead of old ones')
        .option('-y, --yes', "Don't ask for confirmation")
        .option('--continue-on-error', 'Continue even if errors occur in some operations')
        .action(async (chain, options) => {
            const partitionSizes: Record<string, number> = {
                block: 0,
                action: 0,
                delta: 0
            };

            // Automatically infer indices to delete based on options
            if (options.blocks || options.actions || options.deltas) {
                console.log('Inferring indices to delete based on provided options...');
                if (options.blocks) console.log('Selected: Block indices');
                if (options.actions) console.log('Selected: Action indices');
                if (options.deltas) console.log('Selected: Delta indices');
            } else {
                console.log('No specific index type selected. Defaulting to all types.');
            }

            // Execute cleanup operation
            await cleanupIndices(chain, partitionSizes, options);
        });

    program.parse(process.argv);
})();
