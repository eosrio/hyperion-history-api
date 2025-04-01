import { Command } from "commander";
import { AccountSynchronizer } from "./sync-accounts/sync-accounts.js";
import { VoterSynchronizer } from "./sync-accounts/sync-voters.js";
import { ProposalSynchronizer } from "./sync-accounts/sync-proposals.js";
import { ContractStateSynchronizer } from "./sync-accounts/sync-contract-state.js";
import { readConnectionConfig } from "./repair-cli/functions.js";
import { WebSocket } from 'ws';

const __dirname = new URL('.', import.meta.url).pathname;

class IndexerController {

    ws: any;

    constructor(private chain: string, private host?: string) {
    }

    async pause(type: string) {
        const config = readConnectionConfig();
        const controlPort = config.chains[this.chain].control_port;
        let hyperionIndexer = `ws://localhost:${controlPort}`;
        if (this.host) {
            hyperionIndexer = `ws://${this.host}:${controlPort}`;
        }

        await new Promise((resolve, reject) => {
            const controller = new WebSocket(hyperionIndexer + '/local');

            controller.on('open', async () => {
                console.log('Connected to Hyperion Controller');
                this.ws = controller;
                controller.send(JSON.stringify({
                    event: 'pause-indexer',
                    type: type,
                }));
            });

            controller.on('error', (error: any) => {
                console.error('Error connecting to Hyperion Controller:', error);
                reject(error);
            });

            controller.on('message', (data: any) => {
                const message = JSON.parse(data);
                if (message.event === 'indexer-paused') {
                    console.log('Indexer paused');
                }
            });
        }
        );
    }

}

async function syncVoters(chain: string, host?: string) {
    const synchronizer = new VoterSynchronizer(chain);
    const indexerController = new IndexerController(chain, host);

    //pause
    await indexerController.pause('table-voters');
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
        .action(async (chain: string, args: any) => {
            try {
                await syncVoters(chain, args.host);
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