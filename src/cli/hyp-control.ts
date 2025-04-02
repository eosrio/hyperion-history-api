import { Command } from "commander";
import { AccountSynchronizer } from "./sync-accounts/sync-accounts.js";
import { VoterSynchronizer } from "./sync-accounts/sync-voters.js";
import { ProposalSynchronizer } from "./sync-accounts/sync-proposals.js";
import { ContractStateSynchronizer } from "./sync-accounts/sync-contract-state.js";
import { readConnectionConfig } from "./repair-cli/functions.js";
import { WebSocket } from 'ws';
import { hLog } from "../indexer/helpers/common_functions.js";

const __dirname = new URL('.', import.meta.url).pathname;

class IndexerController {

    ws: any;

    constructor(private chain: string, private host?: string) {
    }


    private async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const config = readConnectionConfig();
            const controlPort = config.chains[this.chain].control_port;
            let hyperionIndexer = `ws://localhost:${controlPort}`;
            if (this.host) {
                hyperionIndexer = `ws://${this.host}:${controlPort}`;
            }

            this.ws = new WebSocket(hyperionIndexer + '/local');

            this.ws.on('open', () => {
                console.log('Connected to Hyperion Controller');
                resolve();
            });

            this.ws.on('error', (error: any) => {
                console.error('Error connecting to Hyperion Controller:', error);
                reject(error);
            });
        });
    }

    async pause(type: string): Promise<string> {
        await this.connect();
        return await new Promise<string>((resolve, reject) => {
            console.log()
            console.log()
            this.ws!.send(JSON.stringify({
                event: 'pause-indexer',
                type: type,
            }));

            this.ws!.on('message', (data: any) => {
                const message = JSON.parse(data);
                if (message.event === 'indexer-paused') {
                    console.log('Indexer paused');
                    resolve(message.mId);
                }
            });
        });
    }

    async resume(type: string, mId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.connect();
        }
        await new Promise<void>((resolve, reject) => {
            this.ws!.send(JSON.stringify({
                event: 'resume-indexer',
                type: type,
                mId: mId
            }));

            this.ws!.on('message', (data: any) => {
                const message = JSON.parse(data);
                if (message.event === 'indexer-resumed') {
                    console.log('Indexer resumed');
                    resolve();
                }
            });
        });
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

async function syncVoters(chain: string, host?: string) {
    const indexerController = new IndexerController(chain, host);
    const synchronizer = new VoterSynchronizer(chain);
    try {
        const pauseMId = await indexerController.pause('table-voters');
        await synchronizer.run();
        console.log("Synchronization completed. Resuming indexer...");
        await indexerController.resume('table-voters', pauseMId);
    } catch (error) {
        console.error('Error during synchronization:', error);
    } finally {
        indexerController.close();
    }
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
                console.log('Sync completed for voters')
            } catch (error) {
                console.error('Error syncing voters:', error);
            }
        });

    sync.command('accounts <chain>')
        .description('Sync accounts for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncAccounts(chain);
                console.log('Sync completed for accounts')
            } catch (error) {
                console.error('Error syncing accounts:', error);
            }
        });

    sync.command('proposals <chain>')
        .description('Sync proposals for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncProposals(chain);
                console.log('Sync completed for proposals')
            } catch (error) {
                console.error('Error syncing proposals:', error);
            }
        });

    sync.command('contract-state <chain>')
        .description('Sync contract state for a specific chain')
        .action(async (chain: string) => {
            try {
                await syncContractState(chain);
                console.log('Sync completed for contractState')
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
                console.log(`Sync completed for all components`)
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