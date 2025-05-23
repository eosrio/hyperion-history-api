import { Command } from 'commander';
import { IndexerController } from './controller-client/controller.client.js';
import { AccountSynchronizer } from './sync-modules/sync-accounts.js';
import { ContractStateSynchronizer } from './sync-modules/sync-contract-state.js';
import { ProposalSynchronizer } from './sync-modules/sync-proposals.js';
import { VoterSynchronizer } from './sync-modules/sync-voters.js';

// --- Usage/Memory/Heap commands ---
async function printUsageMap(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    try {
        const usageMap = await indexerController.getUsageMap();
        console.log('Global Usage Map:');
        console.dir(usageMap, { depth: null, colors: true });
    } catch (error: any) {
        console.error('Error fetching usage map:', error.message);
    } finally {
        indexerController.close();
    }
}

async function printMemoryUsage(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    try {
        const memUsage = await indexerController.getMemoryUsage();
        console.log('Memory Usage:');
        console.dir(memUsage, { depth: null, colors: true });
    } catch (error: any) {
        console.error('Error fetching memory usage:', error.message);
    } finally {
        indexerController.close();
    }
}

async function printHeapStats(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    try {
        const heapStats = await indexerController.getHeapStats();
        console.log('Heap Stats:');
        console.dir(heapStats, { depth: null, colors: true });
    } catch (error: any) {
        console.error('Error fetching heap stats:', error.message);
    } finally {
        indexerController.close();
    }
}

async function syncWithPauseResume(chain: string, type: string, synchronizer: any, host?: string) {
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
        await synchronizer.run();
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

async function syncContractState(chain: string, host?: string) {
    const contractStateSynchronizer = new ContractStateSynchronizer(chain);
    // Check if contract state is enabled before proceeding
    if (!contractStateSynchronizer.isEnabled()) {
        console.log(`Contract state synchronization is not enabled for chain: ${chain}`);
        return false; // Return false to indicate no sync was performed
    }
    await syncWithPauseResume(chain, 'dynamic-table', contractStateSynchronizer, host);
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
                await stopIndexer(chain, args.host);
                console.log(`Indexer stop command sent for chain ${chain}`);
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

    sync.command('contract-state <chain>')
        .description('Sync contract state for a specific chain')
        .action(async (chain: string) => {
            try {
                const syncPerformed = await syncContractState(chain);
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

    // Add usage/memory/heap commands
    program
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

    program
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

    program
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

    program.parse(process.argv);
})();

//stop - stop chain
//resume - resume chain
//pause - pause chain
//start - start chain
