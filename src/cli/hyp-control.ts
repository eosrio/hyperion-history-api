import { Command } from 'commander';
import { IndexerController } from './controller-client/controller.client.js';
import { printHeapStats, printMemoryUsage, printUsageMap } from './stats.control.js';
import { AccountSynchronizer } from './sync-modules/sync-accounts.js';
import { ContractStateSynchronizer } from './sync-modules/sync-contract-state.js';
import { ProposalSynchronizer } from './sync-modules/sync-proposals.js';
import { VoterSynchronizer } from './sync-modules/sync-voters.js';
import { QueueManager } from './queue-manager/queue.manager.js';
import { PermissionsSynchronizer } from './sync-modules/sync-permissions.js';

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
        }
    );

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
            } catch (error) {
                console.error('Error syncing contract state:', error);
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

    program.parse(process.argv);
})();