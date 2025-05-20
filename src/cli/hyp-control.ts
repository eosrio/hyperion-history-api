import {Command} from "commander";
import {IndexerController} from "./controller-client/controller.client.js";
import {AccountSynchronizer} from "./sync-modules/sync-accounts.js";
import {ContractStateSynchronizer} from "./sync-modules/sync-contract-state.js";
import {ProposalSynchronizer} from "./sync-modules/sync-proposals.js";
import {VoterSynchronizer} from "./sync-modules/sync-voters.js";


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
    await syncWithPauseResume(chain, 'dynamic-table', new ContractStateSynchronizer(chain), host);
}

async function stopIndexer(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    await indexerController.stop();
    indexerController.close();
}

(() => {
    const program = new Command();

    const indexer = program.command('indexer');

    // Action to stop the indexer
    indexer.command('stop <chain>')
        .description('Stop the indexer for a specific chain')
        .action(async (chain: string, args: any) => {
            try {
                await stopIndexer(chain, args.host);
                console.log('Indexer stopped');
            } catch (error: any) {
                console.error('Error stopping indexer:', error.message);
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
                await syncContractState(chain);
                console.log('Sync completed for contractState');
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
                await syncContractState(chain);
                console.log(`Sync completed for all components`);
            } catch (error) {
                console.error('Error during sync:', error);
            }
        });

    program.parse(process.argv);
})();

//stop - stop chain
//resume - resume chain
//pause - pause chain
//start - start chain
