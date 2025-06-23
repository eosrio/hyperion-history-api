import { Name, Serializer } from "@wharfkit/antelope";
import { cargo } from "async";
import { Collection } from "mongodb";
import { IAccount } from "../../interfaces/table-account.js";
import { Synchronizer } from "./synchronizer.js";

export class AccountSynchronizer extends Synchronizer<IAccount> {
    private accountCollection?: Collection<IAccount>;
    private contractAccounts: string[] = [];
    private tokenContracts: string[] = [];
    private totalScopes: number = 0;
    private processedScopes: number = 0;
    private totalScopesToProcess: number = 0;
    private currentContractIndex: number = 0;
    private currentContract: string = '';
    private currentScope: string = '';
    private contractFilter?: string;

    constructor(chain: string, contractFilter?: string) {
        super(chain, 'accounts');
        this.contractFilter = contractFilter;
    }

    protected async setupMongo() {
        await super.setupMongo('accounts', [
            { fields: { code: 1 }, options: { unique: false } },
            { fields: { scope: 1 }, options: { unique: false } },
            { fields: { symbol: 1 }, options: { unique: false } },
            { fields: { code: 1, scope: 1, symbol: 1 }, options: { unique: true } }
        ]);

        this.accountCollection = this.collection as Collection<IAccount>;
    }

    private async getAbiHashTable(lb?: any) {
        const data = await this.client.v1.chain.get_table_rows({
            table: 'abihash',
            code: 'eosio',
            scope: 'eosio',
            limit: 100,
            lower_bound: lb
        });
        if (data.rows) {
            for (let row of data.rows) {
                this.contractAccounts.push(row.owner);
            }
            if (data.next_key) {
                await this.getAbiHashTable(data.next_key);
            } else {
                console.log("End of search");
            }
        }
    }

    private async scanABIs() {

        const transferFields = [
            { name: "from", type: "name" },
            { name: "to", type: "name" },
            { name: "quantity", type: "asset" },
            { name: "memo", type: "string" }
        ];

        const contractsToScan = this.contractFilter ? [this.contractFilter] : this.contractAccounts;

        for (const contract of contractsToScan) {
            try {
                const abi = await this.client.v1.chain.get_abi(contract);
                const tables = new Set(abi.abi?.tables?.map(value => value.name));
                if (tables.has("accounts") && tables.has("stat")) {
                    const actions = new Set(abi.abi?.actions?.map(value => value.name));
                    if (actions.has("transfer")) {
                        const transferType = abi.abi?.structs?.find(s => s.name === 'transfer');
                        if (transferType && transferType.fields) {
                            const fields = transferType.fields;
                            let valid = true;
                            for (let i = 0; i < transferFields.length; i++) {
                                if ((fields[i].name === "from" || fields[i].name === "to") && fields[i].type === 'account_name') {
                                    valid = true;
                                    continue;
                                }
                                if (fields[i].name !== transferFields[i].name || fields[i].type !== transferFields[i].type) {
                                    console.error(`Invalid token contract ${contract} ->> ${fields.map(f => (f.name + "(" + f.type + ")").padEnd(24, " ")).join('  ')}`);
                                    valid = false;
                                    break;
                                }
                            }
                            if (valid) {
                                this.tokenContracts.push(contract);
                            }
                        }
                    }
                }
            } catch (e: any) {
                console.log(`Error processing contract: ${contract} - ${e.message}`);
            }
        }
    }

    private async* processContracts() {
        for (let i = 0; i < this.tokenContracts.length; i++) {
            const contract = this.tokenContracts[i];
            this.currentContract = contract;
            this.currentContractIndex = i;
            console.log(`[DEBUG] Starting contract ${i + 1}/${this.tokenContracts.length}: ${contract}`);
            
            let lowerBound: string = '';
            do {
                const scopes = await this.client.v1.chain.get_table_by_scope({
                    table: "accounts",
                    code: contract,
                    limit: 1000,
                    lower_bound: Name.from(lowerBound).value.toString()
                });
                const rows = scopes.rows;
                for (const row of rows) {
                    try {
                        const account = row.scope.toString();
                        const result = await this.client.v1.chain.get_currency_balance(contract, account);
                        this.currentScope = account;
                        const balances = Serializer.objectify(result);
                        for (const balance of balances) {
                            const [amount, symbol] = balance.split(' ');
                            const amountFloat = parseFloat(amount);
                            this.totalItems++;
                            const doc = {
                                amount: amountFloat,
                                block_num: this.currentBlock,
                                code: contract,
                                present: 1,
                                scope: account,
                                symbol: symbol
                            };
                            yield doc;
                        }
                    } catch (e: any) {
                        console.log(`Failed to check balance ${row.scope}@${contract} - ${e.message}`);
                    }
                }
                lowerBound = scopes.more;
            } while (lowerBound !== '');
            
            // Mark this contract as processed
            this.processedScopes = i + 1;
            console.log(`[DEBUG] Completed contract ${i + 1}/${this.tokenContracts.length}: ${contract}`);
        }
        console.log(`[DEBUG] All contracts processed`);
    }

    public async run() {
        const tRef = Date.now();
        const info = await this.client.v1.chain.get_info();
        this.currentBlock = info.head_block_num.toNumber();
        console.log(await this.elastic.ping());
        
        if (this.contractFilter) {
            console.log(`Syncing specific contract: ${this.contractFilter}`);
        } else {
            await this.getAbiHashTable();
            console.log(`Number of contract candidates: ${this.contractAccounts.length}`);
        }
        
        await this.scanABIs();
        console.log(`Number of validated token contracts: ${this.tokenContracts.length}`);
        this.totalScopesToProcess = this.tokenContracts.length;

        await this.setupMongo();

        let progress: NodeJS.Timeout | null = null;
        let isProcessingComplete = false;
        
        progress = setInterval(() => {
            if (isProcessingComplete) {
                if (progress) {
                    clearInterval(progress);
                    progress = null;
                }
                return;
            }
            const progressPercent = this.totalScopesToProcess > 0 ? ((this.processedScopes / this.totalScopesToProcess) * 100).toFixed(2) : '0.00';
            
            let statusMessage = '';
            if (this.processedScopes >= this.totalScopesToProcess) {
                statusMessage = 'finalizing database writes...';
            } else {
                statusMessage = this.currentContract ? `${this.currentScope}@${this.currentContract}` : 'initializing...';
            }
            
            const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS format
            console.log(`[${timestamp}] Progress: ${this.processedScopes}/${this.totalScopesToProcess} (${progressPercent}%) - ${statusMessage} - ${this.totalItems} accounts`);
        }, 1000);

        try {
            if (this.accountCollection) {
                console.log(`[DEBUG] Using MongoDB for storage`);
                const cargoQueue = cargo((docs: any[], cb) => {
                    this.accountCollection!.bulkWrite(docs.map(doc => {
                        return {
                            updateOne: {
                                filter: {
                                    code: doc.code,
                                    scope: doc.scope,
                                    symbol: doc.symbol
                                },
                                update: {
                                    $set: {
                                        block_num: doc.block_num,
                                        amount: doc.amount
                                    }
                                },
                                upsert: true
                            }
                        };
                    })).finally(() => {
                        cb();
                    });
                }, 1000);

                console.log(`[DEBUG] Starting to process contracts...`);
                for await (const doc of this.processContracts()) {
                    try {
                        await cargoQueue.push(doc);
                    } catch (error: any) {
                        console.error(`Error processing document: ${error.message}`);
                    }
                }

                console.log(`[DEBUG] MongoDB processing completed`);
                console.log(`Processed ${this.totalItems} accounts`);
                isProcessingComplete = true;

                await this.mongoClient?.close();
            } else {
                console.log(`[DEBUG] Using Elasticsearch for storage`);
                const bulkResponse = await this.elastic.helpers.bulk({
                    flushBytes: 1000000,
                    datasource: this.processContracts(),
                    onDocument: (doc) => [{
                        index: {
                            _id: `${doc.code}-${doc.scope}-${doc.symbol}`,
                            _index: this.indexName
                        }
                    }, doc]
                });
                console.log(`[DEBUG] Elasticsearch processing completed`);
                console.log(`${bulkResponse.successful} accounts`);
                isProcessingComplete = true;
            }
        } catch (e) {
            console.log(e);
            throw e;
        } finally {
            isProcessingComplete = true;
            if (progress) {
                clearInterval(progress);
            }
            const tFinal = Date.now();
            console.log(`Processing took: ${(tFinal - tRef)}ms`);
        }
    }
}
