import {Command} from "commander";
import {AccountSynchronizer} from "./sync-modules/sync-accounts.js";
import {VoterSynchronizer} from "./sync-modules/sync-voters.js";
import {ProposalSynchronizer} from "./sync-modules/sync-proposals.js";
import {ContractStateSynchronizer} from "./sync-modules/sync-contract-state.js";
import {readConnectionConfig} from "./repair-cli/functions.js";
import {WebSocket} from 'ws';

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

            // Set a connection timeout
            const connectionTimeout = setTimeout(() => {
                if (this.ws) {
                    this.ws.close();
                }
                reject(new Error(`Connection timeout when connecting to ${hyperionIndexer}/local`));
            }, 5000);
    
            this.ws = new WebSocket(hyperionIndexer + '/local');
    
            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                console.log('Connected to Hyperion Controller');
                resolve();
            });
    
            this.ws.on('error', (error: any) => {
                clearTimeout(connectionTimeout);
                reject(new Error(`Failed to connect to Hyperion Controller: ${error.message}`));
            });
        });
    }

    async pause(type: string): Promise<string> {
        await this.connect();
        return await new Promise<string>((resolve, reject) => {
            console.log()
            console.log()
            
            // Set a timeout for the pause response
            const pauseTimeout = setTimeout(() => {
                reject(new Error('Timeout waiting for indexer to pause'));
            }, 10000);
            
            this.ws!.send(JSON.stringify({
                event: 'pause-indexer',
                type: type,
            }));
    
            const messageHandler = (data: any) => {
                try {
                    const message = JSON.parse(data);
                    if (message.event === 'indexer-paused') {
                        clearTimeout(pauseTimeout);
                        this.ws!.off('message', messageHandler);
                        console.log('Indexer paused');
                        resolve(message.mId);
                    }
                } catch (e) {
                    console.error('Error parsing pause response:', e);
                }
            };
    
            this.ws!.on('message', messageHandler);
            
            this.ws!.on('close', () => {
                clearTimeout(pauseTimeout);
                reject(new Error('Connection closed while waiting for indexer to pause'));
            });
    
            this.ws!.on('error', (error: any) => {
                clearTimeout(pauseTimeout);
                reject(new Error(`WebSocket error during pause operation: ${error.message}`));
            });
        });
    }

    async resume(type: string, mId: string): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.connect();
        }
        await new Promise<void>((resolve, reject) => {
            // Set a timeout for the resume response
            const resumeTimeout = setTimeout(() => {
                reject(new Error('Timeout waiting for indexer to resume'));
            }, 10000);
            
            this.ws!.send(JSON.stringify({
                event: 'resume-indexer',
                type: type,
                mId: mId
            }));
    
            const messageHandler = (data: any) => {
                try {
                    const message = JSON.parse(data);
                    if (message.event === 'indexer-resumed') {
                        clearTimeout(resumeTimeout);
                        this.ws!.off('message', messageHandler);
                        console.log('Indexer resumed');
                        resolve();
                    }
                } catch (e) {
                    console.error('Error parsing resume response:', e);
                }
            };
    
            this.ws!.on('message', messageHandler);
            
            this.ws!.on('close', () => {
                clearTimeout(resumeTimeout);
                reject(new Error('Connection closed while waiting for indexer to resume'));
            });
    
            this.ws!.on('error', (error: any) => {
                clearTimeout(resumeTimeout);
                reject(new Error(`WebSocket error during resume operation: ${error.message}`));
            });
        });
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
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
    await syncWithPauseResume(chain, 'dynamic-table', new ContractStateSynchronizer(chain), host);
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
