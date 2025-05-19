import {Command} from "commander";
import {Client} from "@elastic/elasticsearch";
import path from "path";
import {readFile} from "fs/promises";
import {existsSync} from "fs";
import {HyperionConnections} from "../interfaces/hyperionConnections.js";

const program = new Command();
const rootDir = path.join(import.meta.dirname, '../../');
const configDir = path.join(rootDir, 'config');
const connectionsPath = path.join(configDir, 'connections.json');

// Type definition for reindexing tasks
interface ReindexTask {
    taskId: string | number;
    targetIndex: string;
    rangeStart: number;
    rangeEnd: number;
    partition: number;
}

// Gets connection configurations from connections.json file
async function getConnections(): Promise<HyperionConnections | null> {
    if (existsSync(connectionsPath)) {
        const connectionsJsonFile = await readFile(connectionsPath);
        return JSON.parse(connectionsJsonFile.toString());
    } else {
        return null;
    }
}

// Creates an Elasticsearch client based on configuration
async function createEsClient(): Promise<Client | null> {
    const connections = await getConnections();

    if (!connections) {
        console.log(`connections.json file was not found. Run "./hyp-config connections init" to configure it.`);
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

// Main function to partition an index
async function partitionIndex(indexName: string, partitionSize: number, options: any) {
    console.log(`Starting partition of index ${indexName} with size ${partitionSize} blocks per partition`);

    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        // Check if source index exists
        const indexExists = await client.indices.exists({
            index: indexName
        });

        if (!indexExists) {
            console.error(`Error: Index ${indexName} does not exist.`);
            process.exit(1);
        }

        // Assuming that the block_num field always exists, since we're working with a blocks table
        const blockField = "block_num";
        console.log(`Field identified for partitioning: ${blockField}`);

        // Get minimum and maximum values of the block_num field
        const stats = await getFieldStats(client, indexName, blockField);
        if (!stats) {
            console.error(`Error: Could not get statistics for field ${blockField}`);
            process.exit(1);
        }

        const {min, max, count} = stats;
        console.log(`Statistics for field ${blockField}:`);
        console.log(`- Minimum value: ${min}`);
        console.log(`- Maximum value: ${max}`);
        console.log(`- Total documents: ${count}`);

        if (count === 0) {
            console.log(`Index ${indexName} is empty. There are no documents to reindex.`);
            process.exit(0);
        }

        // Calculate partitions based on block_num range
        const numPartitions = Math.ceil(count / partitionSize);

        console.log(`Creating... ${numPartitions} partitions with ${partitionSize} blocks each`);

        // Start reindexing tasks for each partition
        const tasks: ReindexTask[] = [];

        // Calculate initial partition number
        const startPartition = Math.floor(min / partitionSize);
        const lastPartition = Math.floor(max / partitionSize);

        console.log(`Initial partition: ${startPartition}`);


        for (let i = startPartition; i < lastPartition; i++) {
            const partitionNumber = i + 1;
            const paddedNumber = String(partitionNumber).padStart(6, '0');
            const targetIndex = `${indexName}-${paddedNumber}`;

            const rangeStart = i * partitionSize;
            const rangeEnd = rangeStart + partitionSize - 1;

            // Check if target index already exists
            const targetExists = await client.indices.exists({index: targetIndex});
            if (targetExists) {
                if (options.force) {
                    await client.indices.delete({index: targetIndex});
                    console.log(`Index ${targetIndex} deleted for recreation`);
                } else {
                    console.error(`Error: Index ${targetIndex} already exists. Use --force to replace it.`);
                    process.exit(1);
                }
            }

            console.log(`\nStarting reindexing for ${targetIndex}`);
            console.log(`Range of ${blockField}: ${rangeStart} to ${rangeEnd}`);

            const reindexBody = {
                source: {
                    index: indexName,
                    query: {
                        range: {
                            [blockField]: {
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
                // Iniciar a tarefa de reindexação
                const response = await client.reindex({
                    ...reindexBody,
                    wait_for_completion: false,
                    refresh: true
                });

                console

                const taskId = response.task;

                if (!taskId) {
                    console.error(`Error: Could not obtain reindexing task ID.`);
                    process.exit(1);
                }
                tasks.push({
                    taskId,
                    targetIndex,
                    rangeStart,
                    rangeEnd,
                    partition: partitionNumber
                });

                console.log(`✓ Reindexing task started: ${taskId}`);
            } catch (error: any) {
                console.error(`Error starting reindexing for ${targetIndex}: ${error.message}`);

                if (!options.continueOnError) {
                    process.exit(1);
                }
            }
        }

        console.log(`\n${tasks.length} reindexing tasks started`);

        // Display started tasks
        console.log("\nReindexing tasks:");
        console.log("-----------------------------------------");
        tasks.forEach(task => {
            console.log(`Partition ${task.partition}/${numPartitions}: ${task.targetIndex}`);
            console.log(`  Task ID: ${task.taskId}`);
            console.log(`  Range: ${task.rangeStart} to ${task.rangeEnd}`);
            console.log("-----------------------------------------");
        });

        console.log("\nTasks are running in the background.");
        console.log("To check status, run:");
        console.log("  ./hyp-es-config tasks");

    } catch (error: any) {
        console.error(`Erro: ${error.message}`);
        process.exit(1);
    }
}


// Gets statistics (min, max, count) of a numeric field
async function getFieldStats(client: Client, indexName: string, fieldName: string) {
    try {
        const response = await client.search({
            index: indexName,
            size: 0,
            aggs: {
                min_value: {min: {field: fieldName}},
                max_value: {max: {field: fieldName}}
            }
        });

        const countResponse = await client.count({
            index: indexName
        });

        // Access aggregations with type safety
        const minValue = response.aggregations &&
        typeof response.aggregations === 'object' &&
        response.aggregations.min_value &&
        'value' in response.aggregations.min_value ?
            response.aggregations.min_value.value : 0;

        const maxValue = response.aggregations &&
        typeof response.aggregations === 'object' &&
        response.aggregations.max_value &&
        'value' in response.aggregations.max_value ?
            response.aggregations.max_value.value : 0;

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

// Lists available indices
async function listIndices() {
    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        const indices = await client.cat.indices({format: "json"});

        console.log("\nAvailable indices:");
        console.log("------------------------------------------------------------------");
        console.log("Index                           | Documents  |   Size      | Status");
        console.log("------------------------------------------------------------------");

        indices.forEach((index: any) => {
            if (index && index.index) {
                const indexName = index.index.toString().padEnd(30);
                const docsCount = (index.docsCount || index["docs.count"] || "0").padEnd(10);
                const size = (index["pri.store.size"] || index.priStoreSize || "0").padEnd(11);
                const health = index.health || "?";

                console.log(`${indexName} | ${docsCount} | ${size} | ${health}`);
            }
        });

    } catch (error: any) {
        console.error(`Error listing indices: ${error.message}`);
        process.exit(1);
    }
}

// Lists and monitors Elasticsearch tasks
async function listTasks(options: any) {
    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        // Get all active tasks in Elasticsearch
        const tasksResponse = await client.tasks.list({
            detailed: true,
            actions: "*reindex*"
        });

        const tasks = tasksResponse.nodes ?
            Object.entries(tasksResponse.nodes).flatMap(([nodeId, nodeInfo]: [string, any]) =>
                nodeInfo.tasks ?
                    Object.entries(nodeInfo.tasks).map(([taskId, taskInfo]: [string, any]) => ({
                        fullTaskId: `${nodeId}:${taskId}`,
                        nodeId,
                        taskId,
                        action: taskInfo.action,
                        status: taskInfo.status,
                        running_time_ns: taskInfo.running_time_in_nanos,
                        running_time: Math.floor(taskInfo.running_time_in_nanos / 1000000) + 'ms',
                        description: taskInfo.description
                    })) :
                    []
            ) :
            [];

        if (tasks.length === 0) {
            console.log("\nNo reindexing tasks currently running.");
            return;
        }

        console.log("\nActive reindexing tasks:");
        console.log("------------------------------------------------------------------");
        console.log("Task ID                           | Action    | Running Time      | Description");
        console.log("------------------------------------------------------------------");

        tasks.forEach(task => {
            const taskIdFormatted = task.fullTaskId.padEnd(30);
            const action = (task.action || "").padEnd(10);
            const runningTime = (task.running_time || "").padEnd(17);

            console.log(`${taskIdFormatted} | ${action} | ${runningTime} | ${task.description || ""}`);
        });


    } catch (error: any) {
        console.error(`Error listing tasks: ${error.message}`);
        if (error.meta && error.meta.body) {
            console.error(JSON.stringify(error.meta.body, null, 2));
        }
        process.exit(1);
    }
}

// Creating CLI commands
(() => {
    program
        .version("1.0.0")
        .description("Tool for managing Elasticsearch indices for Hyperion");

    // Command to list indices
    program
        .command("list")
        .alias("ls")
        .description("List all Elasticsearch indices")
        .action(listIndices);

    // Command to list tasks
    program
        .command("tasks")
        .description("List and monitor active reindexing tasks")
        .action(listTasks);

    // Command to partition an index
    program
        .command("reindex <index_name> <partition_size>")
        .description("Reindex an index into numbered partitions (e.g. index-000001)")
        .option("--force", "Force operation even if target indices already exist")
        .action((indexName, partitionSize, options) => {
            const size = parseInt(partitionSize, 10);
            if (isNaN(size) || size <= 0) {
                console.error("Error: Partition size must be a positive number");
                process.exit(1);
            }
            partitionIndex(indexName, size, options);
        });

    program.parse(process.argv);
})();
