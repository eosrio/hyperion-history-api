import {APIClient, Name, UInt64} from "@wharfkit/antelope";
import {Client} from "@elastic/elasticsearch";
import { join } from "path";
import { readFileSync } from "fs";
import { HyperionConnections } from "../../interfaces/hyperionConnections.js";
import { Collection, MongoClient } from "mongodb";
import { IVoter } from "../../interfaces/table-voter.js";
import { cargo } from "async";

export class AccountStateSynchronizer {
    private chain: string;
    private indexName: string;
    private connections: HyperionConnections;
    private elastic: Client;
    private client: APIClient;
    private mongoClient?: MongoClient;
    private voterCollection?: Collection<IVoter>;
    private currentBlock: number = 0;
    private totalAccounts: number = 0;

    constructor(chain: string) {
        this.chain = chain;
        this.indexName = `${chain}-table-voters-v1`;
        this.connections = this.loadConnections();
        this.elastic = this.createElasticClient();
        this.client = new APIClient({url: "http://localhost:8888"});
    }

    private loadConnections(): HyperionConnections {
        const configDir = join(import.meta.dirname, '../../../config');
        return JSON.parse(readFileSync(join(configDir, "connections.json")).toString());
    }

    private createElasticClient(): Client {
        const _es = this.connections.elasticsearch;
        return new Client({
            node: `${_es.protocol}://${_es.host}`,
            auth: {
                username: _es.user,
                password: _es.pass
            },
            pingTimeout: 100,
            tls: _es.protocol === 'https' ? {
                rejectUnauthorized: false
            } : undefined
        });
    }

    private async setupMongo() {
        const _mongo = this.connections.mongodb;
        if (_mongo && _mongo.enabled) {
            let uri = "mongodb://";
            if (_mongo.user && _mongo.pass) {
                uri += `${_mongo.user}:${_mongo.pass}@${_mongo.host}:${_mongo.port}`;
            } else {
                uri += `${_mongo.host}:${_mongo.port}`;
            }
            this.mongoClient = new MongoClient(uri);
            await this.mongoClient.connect();
            this.voterCollection = this.mongoClient.db(`${_mongo.database_prefix}_${this.chain}`).collection('voters');
            await this.voterCollection.createIndex({voter: 1}, {unique: true});
            await this.voterCollection.createIndex({producers: 1}, {unique: false});
            await this.voterCollection.createIndex({is_proxy: 1}, {unique: false});
            const ping = await this.mongoClient?.db(`admin`).command({ping: 1});
            console.log(ping);
        }
    }

    private async* scan() {
        let lb: UInt64 | undefined = undefined;
        let more = false;
        do {
            const result = await this.client.v1.chain.get_table_rows({
                code: "eosio",
                table: "voters",
                scope: "eosio",
                limit: 300,
                lower_bound: lb ? lb : undefined
            });

            for (const voter of result.rows) {
                const data = {
                    block_num: this.currentBlock,
                    is_proxy: voter.is_proxy === 1,
                    last_vote_weight: voter.last_vote_weight,
                    primary_key: Name.from(voter.owner).value.toString(),
                    producers: voter.producers,
                    proxied_vote_weight: voter.proxied_vote_weight,
                    proxy: voter.proxy,
                    staked: voter.staked,
                    voter: voter.owner,
                }
                this.totalAccounts++;
                yield data;
            }
            lb = result.next_key;
            more = result.more;
        } while (more);
    }

    public async run() {
        const info = await this.client.v1.chain.get_info();
        this.currentBlock = info.head_block_num.toNumber();

        await this.setupMongo();

        try {
            if (this.voterCollection) {
                const cargoQueue = cargo((docs: any[], cb) => {
                    this.voterCollection!.bulkWrite(docs.map(doc => {
                        return {
                            updateOne: {
                                filter: {
                                    voter: doc.voter
                                },
                                update: {
                                    $set: {
                                        block_num: doc.block_num,
                                        is_proxy: doc.is_proxy,
                                        last_vote_weight: doc.last_vote_weight,
                                        producers: doc.producers,
                                        proxied_vote_weight: doc.proxied_vote_weight,
                                        proxy: doc.proxy,
                                        staked: doc.staked,
                                    }
                                },
                                upsert: true
                            }
                        };
                    })).finally(() => {
                        cb();
                    });
                }, 1000);

                for await (const doc of this.scan()) {
                    cargoQueue.push(doc).catch(console.log);
                }

                await cargoQueue.drain();

                console.log(`Processed ${this.totalAccounts} accounts`);
                await this.mongoClient?.close();
            } else {
                const bulkResponse = await this.elastic.helpers.bulk({
                    flushBytes: 1000000,
                    datasource: this.scan(),
                    onDocument: (doc) => [{index: {_id: doc.voter, _index: this.indexName}}, doc],
                    onDrop: (doc) => console.log('doc', doc),
                });
                console.log(`bulkResponse`, bulkResponse);
                console.log(`${bulkResponse.successful} accounts`);
            }
        } catch (e) {
            console.log(e);
            process.exit();
        }
    }
}