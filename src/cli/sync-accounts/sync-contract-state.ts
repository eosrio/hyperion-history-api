import { readFileSync } from "node:fs";
import { APIClient, Asset, Name } from "@wharfkit/antelope";
import { MongoClient, Db, IndexDescription } from "mongodb";
import { join } from "node:path";
import { cargo } from "async";
import { findAndValidatePrimaryKey } from "../utils/check-primary-key.js";

interface ChainConfig {
    features: {
        contract_state: {
            enabled: boolean;
            contracts: Record<string, Record<string, any>>;
        };
    };
}

export class ContractStateSynchronizer {
    private chain: string;
    private config: ChainConfig;
    private client: APIClient;
    private mongoClient: MongoClient;
    private db: Db | undefined;
    private currentBlock: number = 0;
    private currentBlockId: string = '';
    private currentBlockTime: string = '';
    private processedDocs: number = 0;

    constructor(chain: string) {
        this.chain = chain;
        this.config = this.loadConfig();
        this.client = this.createAPIClient();
        this.mongoClient = this.createMongoClient();
    }

    private loadConfig(): ChainConfig {
        const configDir = join(import.meta.dirname, '../../../config/chains');
        const configPath = join(configDir, `${this.chain}.config.json`);
        return JSON.parse(readFileSync(configPath, 'utf-8'));
    }

    private loadConnections() {
        const configDir = join(import.meta.dirname, '../../../config');
        return JSON.parse(readFileSync(join(configDir, "connections.json"), 'utf-8'));
    }

    private createAPIClient(): APIClient {
        const connections = this.loadConnections();
        const endpoint = connections.chains[this.chain].http;
        if (!endpoint) {
            throw new Error("No HTTP Endpoint!");
        }
        return new APIClient({ url: endpoint });
    }

    private createMongoClient(): MongoClient {
        const connections = this.loadConnections();
        const _mongo = connections.mongodb;
        let uri = `mongodb://${_mongo.host}:${_mongo.port}`;
        if (_mongo.user && _mongo.pass) {
            uri = `mongodb://${_mongo.user}:${encodeURIComponent(_mongo.pass)}@${_mongo.host}:${_mongo.port}`;
        }
        if (_mongo.authSource) {
            uri += `/?authSource=${_mongo.authSource}`;
        }
        return new MongoClient(uri);
    }

    private async setupIndices() {
        if (!this.db) {
            throw new Error("Database not initialized");
        }

        if (this.config.features.contract_state.contracts) {
            for (const [contract, tables] of Object.entries(this.config.features.contract_state.contracts)) {
                for (const [table, config] of Object.entries(tables)) {
                    const collectionName = `${contract}-${table}`;
                    const collection = this.db.collection(collectionName);

                    const indices: IndexDescription[] = [];

                    // Add default indices
                    if (config.auto_index === true) {
                        indices.push(
                            { key: { '@pk': -1 } },
                            { key: { '@scope': 1 } },
                            { key: { '@block_num': -1 } },
                            { key: { '@block_time': -1 } },
                            { key: { '@payer': 1 } }
                        );
                    }

                    if (config.auto_index === true) {
                        console.log(`Auto-indexing enabled for ${collectionName}`);
                        const contractAbi = await this.client.v1.chain.get_abi(contract);
                        if (contractAbi && contractAbi.abi) {
                            const tables = contractAbi.abi.tables;
                            const structs = contractAbi.abi.structs;
                            const extractStructFlat = (structName: string) => {
                                const struct = structs.find(value => value.name === structName);
                                if (struct?.base) {
                                    extractStructFlat(struct.base);
                                }
                                struct?.fields.forEach(value => {
                                    indices.push({ key: { [value.name]: 1 } });
                                });
                            };
                            const tableData = tables.find(value => value.name === table);
                            if (tableData) {
                                extractStructFlat(tableData.type);
                            }
                        }
                    } else if (config.indices) {
                        console.log(`Using defined indices for ${collectionName}`);
                        for (const [field, direction] of Object.entries(config.indices)) {
                            indices.push({ key: { [field]: direction === 'desc' ? -1 : 1 } });
                        }
                    }

                    if (indices.length > 0) {
                        console.log(`Creating ${indices.length} indices for ${collectionName}`);
                        await collection.createIndexes(indices);
                    } else {
                        console.log(`No indices to create for ${collectionName}`);
                    }
                }
            }
        }
    }

    private async* processContractState() {
        if (this.config.features.contract_state.contracts) {
            for (const [contract, tables] of Object.entries(this.config.features.contract_state.contracts)) {
                for (const [table, config] of Object.entries(tables)) {

                    let pkField = await findAndValidatePrimaryKey(contract, table, this.client);

                    if (!pkField?.field) {
                        console.error(`Primary key not found for ${contract}-${table}`);
                        continue;
                    } else {
                        console.log(`Primary key found for ${contract}-${table}: ${pkField.field}`);
                    }



                    console.log(`Processing ${contract}-${table}`);
                    let lowerBound: string | null = null;
                    let totalRows = 0;
                    do {
                        try {
                            const scopes = await this.client.v1.chain.get_table_by_scope({
                                code: contract,
                                table: table,
                                limit: 1000,
                                lower_bound: lowerBound ? Name.from(lowerBound).value.toString() : undefined
                            });

                            for (const scopeRow of scopes.rows) {
                                const scope = scopeRow.scope.toString();
                                // console.log(`Aqui scope`, scope)
                                const result = await this.client.v1.chain.get_table_rows({
                                    code: contract,
                                    scope: scope,
                                    table: table,
                                    limit: 1000,
                                    json: true,
                                    show_payer: true
                                });


                                if (result.ram_payers) {
                                    for (const [index, row] of result.rows.entries()) {
                                        let pkValue = ''
                                        switch (pkField.type) {
                                            case 'asset':
                                                pkValue = Asset.from(row[pkField.field]).symbol.code.value.toString();
                                                break;
                                            case 'name':
                                                pkValue = Name.from(row[pkField.field]).value.toString();
                                                break;
                                            case 'uint64':
                                                pkValue = row[pkField.field].toString();
                                                break;
                                            default:
                                                pkValue = row[pkField.field].toString();
                                                break;
                                        }

                                        // console.log(`pkValue`, pkValue, scope)

                                        totalRows++;
                                        yield {
                                            contract,
                                            table,
                                            data: row,
                                            scope: scope,
                                            primary_key: pkValue,
                                            payer: result.ram_payers[index].toString()
                                        };
                                    }
                                }
                            }
                            lowerBound = scopes.more;
                            console.log(`Fetched ${totalRows} rows from ${contract}-${table}. Total: ${totalRows}`);
                        } catch (error) {
                            console.error(`Error processing ${contract}-${table}:`, error);
                            lowerBound = null;
                        }
                    } while (lowerBound);
                    console.log(`Finished processing ${contract}-${table}. Total rows: ${totalRows}`);
                }
            }
        } else {
            console.log("No contracts defined in the configuration");
        }
    }

    public async run() {
        console.log(`Starting contract state sync for chain: ${this.chain}`);
        const tRef = Date.now();
        try {
            if (!this.config.features.contract_state.enabled) {
                console.log("Contract state synchronization is not enabled in the config.");
                return;
            }

            const info = await this.client.v1.chain.get_info();
            this.currentBlock = info.head_block_num.toNumber();
            this.currentBlockTime = info.head_block_time.toString();
            this.currentBlockId = info.head_block_id.toString();
            console.log(`Current block: ${this.currentBlock}`);

            await this.mongoClient.connect();
            console.log("Connected to MongoDB");
            this.db = this.mongoClient.db(`hyperion_${this.chain}`);

            await this.setupIndices();

            const cargoQueue = cargo(async (docs: any[], cb) => {

                const groupedOps = new Map<string, any[]>();

                docs.forEach(doc => {

                    // const pk = String(Name.from(doc.primary_key).value);
                    // const pk = String(Name.from(doc.data.account).value);
                    // console.log(`pk`, pk)

                    const op = {
                        updateOne: {
                            filter: {
                                '@scope': doc.scope,
                                '@pk': doc.primary_key
                            },
                            update: {
                                $set: {
                                    '@scope': doc.scope,
                                    '@pk': doc.primary_key,
                                    '@payer': doc.payer || '',
                                    '@block_num': this.currentBlock,
                                    '@block_id': this.currentBlockId,
                                    '@block_time': this.currentBlockTime,
                                    ...doc.data
                                }
                            },
                            upsert: true
                        }
                    };

                    const collection = `${doc.contract}-${doc.table}`;
                    const col = groupedOps.get(collection);
                    if (col) {
                        col.push(op);
                    } else {
                        groupedOps.set(collection, [op]);
                    }
                });

                const promises: Promise<any>[] = [];

                groupedOps.forEach((value, key) => {
                    if (this.db) {
                        // console.log(`Inserting ${value.length} documents into ${key}`);
                        promises.push(this.db.collection(key).bulkWrite(value, { ordered: false }));
                    }
                });

                try {
                    const results = await Promise.all(promises);
                } catch (error) {
                    console.error("Error during bulk write:", error);
                } finally {
                    cb();
                }
            }, 1000);

            console.log("Starting to process contract state");
            for await (const doc of this.processContractState()) {
                this.processedDocs++;
                cargoQueue.push(doc);
                if (this.processedDocs % 1000 === 0) {
                    console.log(`Processed ${this.processedDocs} documents`);
                }
            }

            console.log(`Waiting for queue to drain...`);
            await cargoQueue.drain();
            console.log(`Queue drained. Total processed documents: ${this.processedDocs}`);
        } catch (e) {
            console.error("Error during contract state sync:", e);
            throw e;
        } finally {
            await this.mongoClient.close();
            console.log("MongoDB connection closed");
            const tFinal = Date.now();
            console.log(`Processing took: ${(tFinal - tRef)}ms`);
        }
    }
}