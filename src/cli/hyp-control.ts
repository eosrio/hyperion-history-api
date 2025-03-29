import { Command } from "commander";
import { AccountStateSynchronizer as AccountSynchronizer } from "./sync-accounts/sync-accounts.js";
import { AccountStateSynchronizer as VoterSynchronizer } from "./sync-accounts/sync-voters.js";
import { ProposalSynchronizer } from "./sync-accounts/sync-proposals.js";
import { ContractStateSynchronizer } from "./sync-accounts/sync-contract-state.js";

const __dirname = new URL('.', import.meta.url).pathname;

async function syncVoters(chain: string) {
    const synchronizer = new VoterSynchronizer(chain);
    await synchronizer.run();
}

async function syncAccounts(chain: string) {
    const synchronizer = new AccountSynchronizer(chain);
    await synchronizer.run();
}

async function syncProposals(chain: string) {
    const synchronizer = new ProposalSynchronizer(chain);
    await synchronizer.run();
}

async function syncContractState(chain: string) {
    const synchronizer = new ContractStateSynchronizer(chain);
    await synchronizer.run();
}

(() => {
    const program = new Command();

    const sync = program.command('sync');

    sync.command('voters <chain>')
        .description('Sync voters for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncVoters(chain);
            } catch (error) {
                console.error('Error syncing voters:', error);
            }
        });

    sync.command('accounts <chain>')
        .description('Sync accounts for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncAccounts(chain);
            } catch (error) {
                console.error('Error syncing accounts:', error);
            }
        });

    sync.command('proposals <chain>')
        .description('Sync proposals for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncProposals(chain);
            } catch (error) {
                console.error('Error syncing proposals:', error);
            }
        });

    sync.command('contract-state <chain>')
        .description('Sync contract state for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncContractState(chain);
            } catch (error) {
                console.error('Error syncing contract state:', error);
            }
        });

    sync.command('all <chain>')
        .description('Sync voters, accounts, proposals, and contract state for a specific chain')
        .action(async (chain: string) => {
            try {
                console.log('Syncing voters...');
                await syncVoters(chain);
                console.log('Syncing accounts...');
                await syncAccounts(chain);
                console.log('Syncing proposals...');
                await syncProposals(chain);
                console.log('Syncing contract state...');
                await syncContractState(chain);
                console.log('Sync completed for voters, accounts, proposals, and contract state.');
            } catch (error) {
                console.error('Error during sync:', error);
            }
        });

    program.parse(process.argv);
})()

//stop - stop chain
//resume - resume chain
//pause - pause chain
//start - start chain