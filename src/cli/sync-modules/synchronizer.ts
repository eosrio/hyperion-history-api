import {Client} from "@elastic/elasticsearch";
import {APIClient} from "@wharfkit/antelope";
import {readFileSync} from "fs";
import {Collection, MongoClient, Document as MongoDoc} from "mongodb";
import {join} from "path";
import {HyperionConnections} from "../../interfaces/hyperionConnections.js";

export abstract class Synchronizer<T extends MongoDoc> {
    protected chain: string;
    protected indexName: string;
    protected connections: HyperionConnections;
    protected elastic: Client;
    protected client: APIClient;
    protected mongoClient?: MongoClient;
    protected collection?: Collection<T>;
    protected currentBlock: number = 0;
    protected totalItems: number = 0;

    protected constructor(chain: string, collectionType: string) {
        this.chain = chain;
        this.indexName = `${chain}-table-${collectionType}-v1`;
        this.connections = this.loadConnections();
        this.elastic = this.createElasticClient();
        this.client = this.createAPIClient();
    }

    protected loadConnections(): HyperionConnections {
        const configDir = join(import.meta.dirname, '../../../config');
        return JSON.parse(readFileSync(join(configDir, "connections.json")).toString());
    }

    protected createElasticClient(): Client {
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

    protected createAPIClient(): APIClient {
        const chainConfig = this.connections.chains[this.chain];
        if (!chainConfig) {
            throw new Error(`Chain ${this.chain} not found in connections.json`);
        }
        return new APIClient({url: chainConfig.http});
    }

    protected async setupMongo(collectionName: string, indexConfigs: Array<{
        fields: Record<string, number>,
        options?: object
    }> = []) {
        const _mongo = this.connections.mongodb;
        if (_mongo) {
            let uri = "mongodb://";
            if (_mongo.user && _mongo.pass) {
                uri += `${_mongo.user}:${_mongo.pass}@${_mongo.host}:${_mongo.port}`;
            } else {
                uri += `${_mongo.host}:${_mongo.port}`;
            }
            this.mongoClient = new MongoClient(uri);
            await this.mongoClient.connect();
            this.collection = this.mongoClient.db(`${_mongo.database_prefix}_${this.chain}`).collection(collectionName);

            // Create indexes
            for (const indexConfig of indexConfigs) {
                await this.collection.createIndex(indexConfig.fields, indexConfig.options);
            }

            const ping = await this.mongoClient?.db(`admin`).command({ping: 1});
            console.log(ping);
        }
    }

    abstract run(): Promise<void>;
}
