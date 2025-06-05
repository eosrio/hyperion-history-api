import { Command } from 'commander';
import { request } from 'undici';
import { IndexerController } from './controller-client/controller.client.js';
import { printHeapStats, printMemoryUsage, printUsageMap } from './stats.control.js';
import { AccountSynchronizer } from './sync-modules/sync-accounts.js';
import { ContractStateSynchronizer } from './sync-modules/sync-contract-state.js';
import { ProposalSynchronizer } from './sync-modules/sync-proposals.js';
import { VoterSynchronizer } from './sync-modules/sync-voters.js';
import { QueueManager } from './queue-manager/queue.manager.js';
import { PermissionsSynchronizer } from './sync-modules/sync-permissions.js';
import { readConnectionConfig } from './repair-cli/functions.js';

async function syncWithPauseResume(chain: string, type: string, synchronizer: any, host?: string, contract?: string, table?: string) {
    const indexerController = new IndexerController(chain, host);
    let pauseMId: string | null = null;
    let shouldResume = false;

    try {
        // Try to pause the indexer
        try {
            pauseMId = await indexerController.pause(type);
            shouldResume = true;
        } catch (error) {
            console.warn(`⚠️ Warning: Indexer seems to be offline or can't be reached. Proceeding with synchronization without pausing.`);
            console.warn(`   ${(error as Error).message}`);
        }

        // Perform the synchronization
        await synchronizer.run(contract, table);
        console.log(`${type} synchronization completed.`);

        // Resume the indexer if we previously paused it
        if (shouldResume && pauseMId) {
            console.log(`Resuming indexer...`);
            try {
                await indexerController.resume(type, pauseMId);
            } catch (error) {
                console.warn(`⚠️ Warning: Failed to resume indexer. It may need to be manually restarted.`);
                console.warn(`   ${(error as Error).message}`);
            }
        }
    } catch (error) {
        console.error(`Error during ${type} synchronization:`, error);
    } finally {
        indexerController.close();
    }
}

async function syncVoters(chain: string, host?: string) {
    await syncWithPauseResume(chain, 'table-voters', new VoterSynchronizer(chain), host);
}

async function syncAccounts(chain: string, host?: string) {
    await syncWithPauseResume(chain, 'table-accounts', new AccountSynchronizer(chain), host);
}

async function syncProposals(chain: string, host?: string) {
    await syncWithPauseResume(chain, 'table-proposals', new ProposalSynchronizer(chain), host);
}

async function syncContractState(chain: string, host?: string, contract?: string, table?: string) {
    const contractStateSynchronizer = new ContractStateSynchronizer(chain);
    // Check if contract state is enabled before proceeding
    if (!contractStateSynchronizer.isEnabled()) {
        console.log(`Contract state synchronization is not enabled for chain: ${chain}`);
        return false; // Return false to indicate no sync was performed
    }
    await syncWithPauseResume(chain, 'dynamic-table', contractStateSynchronizer, host, contract, table);
    return true; // Return true to indicate sync was performed
}

async function stopIndexer(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    await indexerController.stop();
    indexerController.close();
}

async function startIndexer(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    // Assuming IndexerController has a start() method
    await indexerController.start();
    indexerController.close();
}

async function listQueues(chain: string, options: any) {
    const queueManager = new QueueManager();
    try {
        const queueOptions = {
            showAll: options.all,
            showEmpty: options.empty,
            sortBy: options.sort,
            filterPattern: options.filter
        };

        const queues = await queueManager.listQueues(chain, queueOptions);

        if (options.categorize) {
            queueManager.formatCategorizedQueues(queues, options.verbose);
        } else {
            queueManager.formatQueueList(queues, options.verbose);
        }
    } catch (error: any) {
        console.error('Error listing queues:', error.message);
    }
}

async function showQueueDetails(chain: string, queueName: string) {
    const queueManager = new QueueManager();
    try {
        const queue = await queueManager.getQueueDetails(queueName);
        if (!queue) {
            console.error(`Queue '${queueName}' not found.`);
            return;
        }

        console.log(`\nQueue Details: ${queueName}`);
        console.log('─'.repeat(50));
        console.log(`Messages: ${queue.messages}`);
        console.log(`Consumers: ${queue.consumers}`);
        console.log(`Memory: ${(queue.memory / 1024 / 1024).toFixed(2)}MB`);
        console.log(`State: ${queue.state}`);
        console.log(`Node: ${queue.node}`);
        console.log(`VHost: ${queue.vhost}`);
        console.log(`Durable: ${queue.durable}`);
        console.log(`Auto Delete: ${queue.auto_delete}`);
        console.log(`Exclusive: ${queue.exclusive}`);

        if (queue.arguments && Object.keys(queue.arguments).length > 0) {
            console.log('\nArguments:');
            for (const [key, value] of Object.entries(queue.arguments)) {
                console.log(`  ${key}: ${value}`);
            }
        }
    } catch (error: any) {
        console.error('Error getting queue details:', error.message);
    }
}

async function purgeQueue(chain: string, queueName: string, options: any) {
    const queueManager = new QueueManager();
    try {
        if (!options.force) {
            // In a real implementation, you might want to add a confirmation prompt
            console.log('Use --force to confirm purging the queue');
            return;
        }

        await queueManager.purgeQueue(queueName);
        console.log(`✅ Queue '${queueName}' has been purged.`);
    } catch (error: any) {
        console.error('Error purging queue:', error.message);
    }
}

// Worker management functions
async function getControllerPort(chain: string): Promise<number> {
    try {
        const config = readConnectionConfig();
        const controlPort = config.chains[chain]?.control_port;
        if (!controlPort) {
            throw new Error(`No control_port configured for chain '${chain}' in connections.json`);
        }
        return controlPort;
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            throw new Error(
                `\n[Hyperion CLI Error]\n` +
                    `Could not find the required configuration file: 'config/connections.json'.\n` +
                    `\nTo fix this, you can:\n` +
                    `  1. Run \x1b[36m./hyp-config connections init\x1b[0m to create a new configuration interactively.\n` +
                    `  2. Or copy the example: \x1b[36mcp references/connections.ref.json config/connections.json\x1b[0m\n` +
                    `\nSee './hyp-config connections --help' for more options.`
            );
        }
        throw new Error(`Error reading connection config for chain '${chain}': ${error.message}`);
    }
}

async function makeControllerRequest(chain: string, endpoint: string, host?: string): Promise<any> {
    const port = await getControllerPort(chain);
    const baseUrl = host ? `http://${host}:${port}` : `http://127.0.0.1:${port}`;
    const url = `${baseUrl}${endpoint}`;

    try {
        const response = await request(url);
        const data = await response.body.text();
        return JSON.parse(data);
    } catch (error: any) {
        throw new Error(`Failed to connect to controller at ${url}: ${error.message}`);
    }
}

async function listWorkers(chain: string, host?: string) {
    try {
        const workers = await makeControllerRequest(chain, '/get_workers', host);

        // Fetch queue data from RabbitMQ
        let queueData = new Map<string, any>();
        try {
            const queueManager = new QueueManager();
            const queues = await queueManager.listQueues(chain, { showEmpty: true });
            queues.forEach((queue) => {
                queueData.set(queue.name, queue);
            });
        } catch (error: any) {
            console.warn(`⚠️  Could not fetch queue data: ${error.message}`);
        }

        console.log(`\n📋 Workers for chain: ${chain}`);
        console.log('═'.repeat(110));
        console.log('ID  │ Role              │ Queue                      │ Local │ Live  │ Fails │ Msgs  │ Consumers │ Rate(msg/s)');
        console.log('────┼───────────────────┼────────────────────────────┼───────┼───────┼───────┼───────┼───────────┼────────────');

        workers.forEach((worker: any) => {
            const id = worker.worker_id.toString().padEnd(3);
            const role = (worker.worker_role || 'unknown').padEnd(17);

            // Better queue formatting - shorten common prefixes and handle long names
            let queue = worker.queue || worker.worker_queue || '';
            let fullQueueName = queue;

            // Special case for ds_pool_worker: construct queue name from local_id
            if (worker.worker_role === 'ds_pool_worker' && worker.local_id) {
                fullQueueName = `${chain}:ds_pool:${worker.local_id}`;
                queue = `<- ds_pool:${worker.local_id}`;
            } else if (worker.worker_role === 'router') {
                queue = `<- stream`;
            } else if (worker.worker_role === 'continuous_reader') {
                queue = '-> live_blocks'; // continuous_reader publishes to live_blocks
            } else if (worker.worker_role === 'reader') {
                queue = '-> blocks:*'; // reader published to all blocks queues
            } else {
                // Ensure fullQueueName has chain prefix for lookup
                if (queue && !queue.startsWith(`${chain}:`)) {
                    fullQueueName = `${chain}:${queue}`;
                }
                // Remove chain prefix for display
                if (queue.startsWith(`${chain}:`)) {
                    queue = '<- ' + queue.substring(chain.length + 1);
                }
            }

            if (queue.length > 26) {
                queue = queue.substring(0, 23) + '...';
            }
            if (queue === '') queue = '—';
            queue = queue.padEnd(26);

            const localId = worker.local_id ? worker.local_id.toString().padEnd(5) : '—'.padEnd(5);

            // Format live mode more clearly
            let liveMode = '—';
            if (worker.live_mode === 'true' || worker.live_mode === true) {
                liveMode = '✓';
            } else if (worker.live_mode === 'false' || worker.live_mode === false) {
                liveMode = '✗';
            }
            liveMode = liveMode.padEnd(5);

            const failures = (worker.failures || 0).toString().padStart(5);

            // Get queue metrics - try multiple matching strategies
            let queueInfo = null;

            // Strategy 1: Direct match with full queue name
            if (fullQueueName) {
                queueInfo = queueData.get(fullQueueName);
            }

            // Strategy 2: Try constructing queue name based on worker role and local_id
            if (!queueInfo && worker.local_id) {
                const roleBasedQueues = [
                    `${chain}:${worker.worker_role}:${worker.local_id}`,
                    `${chain}:index_${worker.worker_role}:${worker.local_id}`,
                    `${chain}:${worker.worker_role.replace('_worker', '')}:${worker.local_id}`
                ];

                for (const queueName of roleBasedQueues) {
                    if (queueData.has(queueName)) {
                        queueInfo = queueData.get(queueName);
                        break;
                    }
                }
            }

            // Strategy 3: For specific worker types, use known patterns
            if (!queueInfo) {
                if (worker.worker_role === 'action_worker' && worker.local_id) {
                    queueInfo = queueData.get(`${chain}:index_actions:${worker.local_id}`);
                } else if (worker.worker_role === 'block_worker' && worker.local_id) {
                    queueInfo = queueData.get(`${chain}:blocks:${worker.local_id}`) || queueData.get(`${chain}:index_blocks:${worker.local_id}`);
                } else if (worker.worker_role === 'delta_worker' && worker.local_id) {
                    queueInfo = queueData.get(`${chain}:index_deltas:${worker.local_id}`);
                } else if (worker.worker_role === 'abi_worker' && worker.local_id) {
                    queueInfo = queueData.get(`${chain}:index_abis:${worker.local_id}`);
                } else if (worker.worker_role === 'continuous_reader') {
                    // continuous_reader publishes to live_blocks, doesn't consume from any queue
                    // Show live_blocks rate as it represents the reader's output
                    queueInfo = queueData.get(`${chain}:live_blocks`);
                } else if (worker.worker_role === 'router') {
                    // router consumes from the stream queue
                    queueInfo = queueData.get(`${chain}:stream`);
                } else if (worker.worker_role === 'deserializer') {
                    // deserializers with live mode consume from live_blocks
                    // deserializers without live mode consume from blocks queues
                    if (worker.live_mode === 'true' || worker.live_mode === true) {
                        queueInfo = queueData.get(`${chain}:live_blocks`);
                    }
                    // For non-live deserializers, the blocks queue should already be matched by Strategy 1
                }
            }

            const messages = queueInfo ? (queueInfo as any).messages.toString().padStart(5) : '—'.padStart(5);
            const consumers = queueInfo ? (queueInfo as any).consumers.toString().padStart(9) : '—'.padStart(9);

            // Extract message rate
            let publishRate = '—';
            if (queueInfo) {
                const queueObj = queueInfo as any;
                try {
                    const rate = queueObj.message_stats?.publish_details?.rate;
                    if (typeof rate === 'number') {
                        publishRate = rate > 0 ? rate.toFixed(2) : '0.00';
                    }
                } catch (error) {
                    // If there's any error accessing the rate, keep default '—'
                }
            }
            publishRate = publishRate.padStart(11);

            console.log(`${id} │ ${role} │ ${queue} │ ${localId} │ ${liveMode} │ ${failures} │ ${messages} │ ${consumers} │ ${publishRate}`);
        });

        console.log('═'.repeat(110));
        console.log(`Total workers: ${workers.length}`);

        // Add queue metrics summary
        if (queueData.size > 0) {
            const totalMessages = Array.from(queueData.values()).reduce((sum, queue) => sum + queue.messages, 0);
            const totalConsumers = Array.from(queueData.values()).reduce((sum, queue) => sum + queue.consumers, 0);
            const queuesWithMessages = Array.from(queueData.values()).filter((queue) => queue.messages > 0).length;

            // Calculate total publish rate
            const totalPublishRate = Array.from(queueData.values()).reduce((sum, queue) => {
                try {
                    const rate = queue.message_stats?.publish_details?.rate;
                    return sum + (typeof rate === 'number' ? rate : 0);
                } catch (error) {
                    return sum;
                }
            }, 0);

            const queuesWithActivity = Array.from(queueData.values()).filter((queue) => {
                try {
                    const rate = queue.message_stats?.publish_details?.rate;
                    return typeof rate === 'number' && rate > 0;
                } catch (error) {
                    return false;
                }
            }).length;

            console.log(
                `Queue metrics: ${totalMessages} total messages, ${totalConsumers} total consumers, ${totalPublishRate.toFixed(2)} msg/s total rate`
            );
            console.log(
                `Activity: ${queuesWithMessages}/${queueData.size} queues with messages, ${queuesWithActivity}/${queueData.size} queues with publish activity`
            );
        }

        // Add summary by role
        const roleCount: Record<string, number> = {};
        workers.forEach((worker: any) => {
            const role = worker.worker_role || 'unknown';
            roleCount[role] = (roleCount[role] || 0) + 1;
        });

        console.log('\n📊 Summary by role:');
        Object.entries(roleCount).forEach(([role, count]) => {
            console.log(`   ${role}: ${count}`);
        });
    } catch (error: any) {
        console.error('Error listing workers:', error.message);
    }
}

async function getWorkerDetails(chain: string, workerId: string, host?: string) {
    try {
        const worker = await makeControllerRequest(chain, `/get_worker/${workerId}`, host);

        console.log(`\n🔍 Worker Details: ${workerId}`);
        console.log('─'.repeat(50));
        console.log(`Worker ID: ${worker.worker_id}`);
        console.log(`Role: ${worker.worker_role}`);
        console.log(`Last Processed Block: ${worker.last_processed_block || 'N/A'}`);
        console.log(`Process ID: ${worker.pid || 'N/A'}`);
        console.log(`Failures: ${worker.failures}`);
        console.log(`Status: ${worker.killed ? '❌ Killed' : '✅ Running'}`);
    } catch (error: any) {
        console.error('Error getting worker details:', error.message);
    }
}

async function killWorker(chain: string, workerId: string, host?: string, force?: boolean) {
    try {
        if (!force) {
            console.log('Use --force to confirm killing the worker');
            return;
        }

        const result = await makeControllerRequest(chain, `/kill_worker/${workerId}`, host);

        console.log(`\n💀 Worker Kill Result:`);
        console.log('─'.repeat(40));
        console.log(`Message: ${result.message}`);
        console.log(`Worker ID: ${result.worker_id}`);
        console.log(`Role: ${result.worker_role}`);
        console.log(`Last Block: ${result.last_processed_block || 'N/A'}`);
        console.log(`Process ID: ${result.pid}`);
        console.log(`Status: ${result.killed ? '❌ Killed' : '⚠️ Still Running'}`);
    } catch (error: any) {
        console.error('Error killing worker:', error.message);
    }
}

async function getScalingInfo(chain: string, host?: string) {
    try {
        const scalingInfo = await makeControllerRequest(chain, '/scaling', host);

        console.log(`\n⚖️ Scaling Information for chain: ${chain}`);
        console.log('═'.repeat(60));

        // Configuration
        console.log('\n📋 Configuration:');
        console.log('─'.repeat(40));
        Object.entries(scalingInfo.config).forEach(([key, value]) => {
            console.log(`${key.padEnd(20)}: ${value}`);
        });

        // Current workers summary
        console.log('\n👥 Current Workers by Role:');
        console.log('─'.repeat(40));
        Object.entries(scalingInfo.current_workers).forEach(([role, count]) => {
            console.log(`${role.padEnd(20)}: ${count}`);
        });
        console.log(`${'Total'.padEnd(20)}: ${scalingInfo.total_workers}`);

        // Detailed workers by role
        console.log('\n🔍 Detailed Workers by Role:');
        console.log('─'.repeat(40));
        Object.entries(scalingInfo.workers_by_role).forEach(([role, workers]) => {
            console.log(`\n${role.toUpperCase()}:`);
            (workers as any[]).forEach((worker) => {
                const status = worker.active ? '✅' : '❌';
                const queue = worker.queue ? ` [${worker.queue}]` : '';
                const failures = worker.failures > 0 ? ` (${worker.failures} failures)` : '';
                console.log(`  ${status} ID:${worker.worker_id}${queue}${failures}`);
            });
        });
    } catch (error: any) {
        console.error('Error getting scaling information:', error.message);
    }
}

(() => {
    const program = new Command();

    const indexer = program.command('indexer');

    // Action to stop the indexer
    indexer
        .command('stop <chain>')
        .description('Stop the indexer for a specific chain')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, args: any) => {
            try {
                console.log(`Stopping indexer for chain ${chain}...`);
                await stopIndexer(chain, args.host);
                console.log(`Indexer stopped for chain ${chain}`);
            } catch (error: any) {
                console.error('Error stopping indexer:', error.message);
            }
        });

    // Action to start the indexer
    indexer
        .command('start <chain>')
        .description('Start or ensure the indexer is actively processing for a specific chain')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, args: any) => {
            try {
                await startIndexer(chain, args.host);
                console.log(`Indexer start command sent for chain ${chain}`);
            } catch (error: any) {
                console.error('Error starting indexer:', error.message);
            }
        });

    const sync = program.command('sync');

    sync.command('permissions <chain>')
        .description('Sync permissions for a specific chain')
        .action(async (chain: string) => {
            try {
                const synchronizer = new PermissionsSynchronizer(chain);
                await synchronizer.run();
                console.log('Sync completed for permissions');
            } catch (error) {
                console.error('Error syncing permissions:', error);
            }
        });

    sync.command('voters <chain>')
        .description('Sync voters for a specific chain')
        .action(async (chain: string, args: any) => {
            try {
                await syncVoters(chain, args.host);
                console.log('Sync completed for voters');
            } catch (error) {
                console.error('Error syncing voters:', error);
            }
        });

    sync.command('accounts <chain>')
        .description('Sync accounts for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncAccounts(chain);
                console.log('Sync completed for accounts');
            } catch (error) {
                console.error('Error syncing accounts:', error);
            }
        });

    sync.command('proposals <chain>')
        .description('Sync proposals for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncProposals(chain);
                console.log('Sync completed for proposals');
            } catch (error) {
                console.error('Error syncing proposals:', error);
            }
        });

    sync.command('contract-state <chain> [contract] [table]')
        .description('Sync contract state for a specific chain')
        .action(async (chain: string, contract?: string, table?: string, args?: any) => {
            try {
                const syncPerformed = await syncContractState(chain, args.host, contract, table);
                // Only show completion message if sync was actually performed
                if (syncPerformed) {
                    console.log('Sync completed for contractState');
                } else {
                    console.log('Contract state synchronization skipped - feature is disabled in config');
                }
                process.exit(0);
            } catch (error) {
                console.error('Error syncing contract state:', error);
                process.exit(1);
            }
        });

    sync.command('all <chain>')
        .description('Sync voters, accounts, proposals, and contract state for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncVoters(chain);
                await syncAccounts(chain);
                await syncProposals(chain);
                const contractStateSynced = await syncContractState(chain);

                console.log(`Sync completed for all components`);
                if (!contractStateSynced) {
                    console.log(`Note: Contract state sync was skipped (feature is disabled in config)`);
                }
            } catch (error) {
                console.error('Error during sync:', error);
            }
        });

    const stats = program.command('stats');

    // Add usage/memory/heap commands
    stats
        .command('get-usage-map <chain>')
        .description('Get the global contract usage map from the indexer')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, args: any) => {
            try {
                await printUsageMap(chain, args.host);
            } catch (error: any) {
                console.error('Error fetching usage map:', error.message);
            }
        });

    stats
        .command('get-memory-usage <chain>')
        .description('Get memory usage from all indexer workers')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, args: any) => {
            try {
                await printMemoryUsage(chain, args.host);
            } catch (error: any) {
                console.error('Error fetching memory usage:', error.message);
            }
        });

    stats
        .command('get-heap <chain>')
        .description('Get V8 heap statistics from all indexer workers')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, args: any) => {
            try {
                await printHeapStats(chain, args.host);
            } catch (error: any) {
                console.error('Error fetching heap stats:', error.message);
            }
        });

    const queues = program.command('queues');

    // List queues command
    queues
        .command('list <chain>')
        .description('List RabbitMQ queues for a specific chain')
        .option('-a, --all', 'Show all queues (not just chain-specific)')
        .option('-e, --empty', 'Show empty queues')
        .option('-v, --verbose', 'Show detailed information')
        .option('-c, --categorize', 'Group queues by category')
        .option('-s, --sort <field>', 'Sort by field (name, messages, consumers)', 'name')
        .option('-f, --filter <pattern>', 'Filter queues by name pattern (regex)')
        .action(async (chain: string, options: any) => {
            try {
                await listQueues(chain, options);
            } catch (error: unknown) {
                console.error('Error executing queue command:', (error as Error).message);
            }
        });

    // Queue details command
    queues
        .command('details <chain> <queueName>')
        .description('Show detailed information about a specific queue')
        .action(async (chain: string, queueName: string) => {
            try {
                await showQueueDetails(chain, queueName);
            } catch (error: unknown) {
                console.error('Error executing queue-details command:', (error as Error).message);
            }
        });

    // Purge queue command
    queues
        .command('purge <chain> <queueName>')
        .description('Purge all messages from a queue')
        .option('--force', 'Force purge without confirmation')
        .action(async (chain: string, queueName: string, options: any) => {
            try {
                await purgeQueue(chain, queueName, options);
            } catch (error: unknown) {
                console.error('Error executing purge-queue command:', (error as Error).message);
            }
        });

    const worker = program.command('worker');

    // List workers command
    worker
        .command('list <chain>')
        .description('List all workers for a specific chain')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, options: any) => {
            try {
                await listWorkers(chain, options.host);
            } catch (error: unknown) {
                console.error('Error listing workers:', (error as Error).message);
            }
        });

    // Get worker details command
    worker
        .command('details <chain> <workerId>')
        .description('Get detailed information about a specific worker')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, workerId: string, options: any) => {
            try {
                await getWorkerDetails(chain, workerId, options.host);
            } catch (error: unknown) {
                console.error('Error getting worker details:', (error as Error).message);
            }
        });

    // Kill worker command
    worker
        .command('kill <chain> <workerId>')
        .description('Kill a specific worker')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .option('--force', 'Force kill without confirmation')
        .action(async (chain: string, workerId: string, options: any) => {
            try {
                await killWorker(chain, workerId, options.host, options.force);
            } catch (error: unknown) {
                console.error('Error killing worker:', (error as Error).message);
            }
        });

    // Get scaling information command
    worker
        .command('scaling <chain>')
        .description('Get scaling information and worker distribution')
        .option('-h, --host <host>', 'Optional host for the indexer controller')
        .action(async (chain: string, options: any) => {
            try {
                await getScalingInfo(chain, options.host);
            } catch (error: unknown) {
                console.error('Error getting scaling information:', (error as Error).message);
            }
        });

    program.parse(process.argv);
})();
