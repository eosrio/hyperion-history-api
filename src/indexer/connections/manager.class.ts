import {ConfigurationModule} from "../modules/config.js";
import {Client} from '@elastic/elasticsearch'
import {HyperionConnections} from "../../interfaces/hyperionConnections.js";
import {HyperionConfig} from "../../interfaces/hyperionConfig.js";
import {amqpConnect, checkQueueSize, getAmpqUrl} from "./amqp.js";
import {ChannelModel, connect} from "amqplib";
import {purgeChainQueues} from "../helpers/queue-purge.js";
import {StateHistorySocket} from "./state-history.js";
import {exec} from "child_process";
import {hLog} from "../helpers/common_functions.js";
import {esConnectionOptions} from "../helpers/es-connection.js";
import {join} from "node:path";
import {existsSync, readFileSync} from "fs";
import {MongoClient} from "mongodb";
import {APIClient} from "@wharfkit/antelope";
import {StatefulCompleteKindMongoClient} from './stateful-complete-kind-client.js';

export class ConnectionManager {

    cm: ConfigurationModule;
    config: HyperionConfig;
    conn: HyperionConnections;

    chain: string;
    last_commit_hash?: string;

    // hyperion version
    current_version?: string;

    esIngestClients: Client[];
    esIngestClient!: Client;

    mongodbClient?: MongoClient;
    private mongoConnection?: {uri: string; options: import('mongodb').MongoClientOptions};
    private readonly completeKindMongo = new StatefulCompleteKindMongoClient(() => {
        if (!this.mongoConnection) this.prepareMongoClient();
        if (!this.mongoConnection) throw new Error('Complete-kind MongoDB connection is unavailable');
        return this.mongoConnection;
    });
    statefulCompleteKindMongoClient(operationTimeoutMS: number): Promise<MongoClient> {return this.completeKindMongo.get(operationTimeoutMS);}
    closeStatefulCompleteKindMongoClient(): Promise<void> {return this.completeKindMongo.close();}

    constructor(cm: ConfigurationModule) {

        this.cm = cm;
        this.config = cm.config;
        this.conn = cm.connections;

        if (!this.conn.amqp.protocol) {
            this.conn.amqp.protocol = 'http';
        }

        this.chain = this.config.settings.chain;
        this.esIngestClients = [];

        this.prepareESClient();
        this.prepareIngestClients();
    }

    /**
     * Read index target for a tiered type. With `settings.use_read_aliases` enabled, reads resolve
     * through the per-type read alias (`<chain>-<type>-read`); otherwise the wildcard
     * (`<chain>-<type>-*`). Physical index names are unchanged, so the wildcard stays a valid
     * fallback and the flag is a safe, reversible toggle.
     */
    readIndexset(type: 'action' | 'delta'): string {
        return this.config.settings.use_read_aliases === true
            ? `${this.chain}-${type}-read`
            : `${this.chain}-${type}-*`;
    }

    get nodeosApiClient() {
        return new APIClient({fetch, url: this.conn.chains[this.chain].http});
    }

    /**
     * Applies `indexer.purge_queues` at startup. Queues that still hold messages are only deleted
     * when the start rewrites its range or the setting is `"force"`; see `purgeChainQueues`.
     */
    async purgeQueues(): Promise<void> {
        const amqp = this.conn.amqp;
        const apiUrl = `${amqp.protocol ?? 'http'}://${amqp.api}`;
        const vHost = encodeURIComponent(amqp.vhost);
        const headers = new Headers();
        headers.set('Authorization', 'Basic ' + Buffer.from(amqp.user + ":" + amqp.pass).toString('base64'));
        let connection: ChannelModel | undefined;
        try {
            connection = await connect(getAmpqUrl(amqp));
            const channel = await connection.createChannel();
            await purgeChainQueues(this.chain, this.config.indexer.purge_queues, this.config.indexer.rewrite === true, {
                listQueues: async () => {
                    const response = await fetch(`${apiUrl}/api/queues/${vHost}`, {headers, signal: AbortSignal.timeout(30000)});
                    const body: unknown = await response.json().catch(() => undefined);
                    if (!response.ok || !Array.isArray(body)) {
                        throw new Error(`RabbitMQ management API returned HTTP ${response.status} listing queues of vhost "${amqp.vhost}"; check the vhost, the credentials and amqp.api`);
                    }
                    return body.map(queue => ({name: String(queue.name), messages: Number(queue.messages) || 0}));
                },
                countReadyMessages: async name => (await channel.checkQueue(name)).messageCount,
                deleteQueue: async name => {
                    const response = await fetch(`${apiUrl}/api/queues/${vHost}/${encodeURIComponent(name)}`, {
                        method: 'DELETE', headers, signal: AbortSignal.timeout(30000)
                    });
                    if (!response.ok && response.status !== 404) {
                        throw new Error(`RabbitMQ management API returned HTTP ${response.status} deleting queue ${name}`);
                    }
                },
                log: hLog
            });
        } catch (e: any) {
            hLog(`Failed to purge ${this.chain} queues: ${e.message}`);
            process.exit(1);
        } finally {
            await connection?.close().catch(() => undefined);
        }
    }

    prepareESClient() {
        const _es = this.conn.elasticsearch;
        if (!_es.protocol) {
            _es.protocol = 'http';
        }
        this.esIngestClient = new Client({
            node: `${_es.protocol}://${_es.host}`,
            auth: {
                username: _es.user,
                password: _es.pass
            },
            tls: _es.protocol === 'https' ? {
                rejectUnauthorized: false
            } : undefined,
            ...esConnectionOptions()
        });
    }

    get elasticsearchClient() {
        return this.esIngestClient;
    }

    prepareIngestClients() {
        const _es = this.conn.elasticsearch;
        if (!_es.protocol) {
            _es.protocol = 'http';
        }
        if (_es.ingest_nodes) {
            if (_es.ingest_nodes.length > 0) {
                for (const node of _es.ingest_nodes) {
                    this.esIngestClients.push(new Client({
                        node: `${_es.protocol}://${node}`,
                        auth: {
                            username: _es.user,
                            password: _es.pass
                        },
                        pingTimeout: 100,
                        tls: _es.protocol === 'https' ? {
                            rejectUnauthorized: false
                        } : undefined,
                        ...esConnectionOptions()
                    }));
                }
            }
        }
    }

    get ingestClients() {
        if (this.esIngestClients.length > 0) {
            return this.esIngestClients;
        } else {
            return [this.esIngestClient];
        }
    }

    async createAMQPChannels(onReconnect: ([Channel, ConfirmChannel]) => void, onClose: () => void) {
        return await amqpConnect(onReconnect, this.conn.amqp, onClose);
    }

    async checkQueueSize(queue: string) {
        return await checkQueueSize(queue, this.conn.amqp);
    }

    get shipClient(): StateHistorySocket {
        return new StateHistorySocket(
            this.conn.chains[this.config.settings.chain].ship,
            this.config.settings.max_ws_payload_mb,
            this.config.settings.protocol
        );
    }

    get ampqUrl() {
        return getAmpqUrl(this.conn.amqp);
    }

    calculateServerHash() {
        exec('git rev-parse HEAD', (err, stdout) => {
            if (err) {
                // hLog(`\n ${err.message}\n >>> Failed to check last commit hash. Version hash will be "custom"`);
                hLog(`Failed to check last commit hash. Version hash will be "custom"`);
                this.last_commit_hash = 'custom';
            } else {
                hLog('Last commit hash on this branch is:', stdout);
                this.last_commit_hash = stdout.trim();
            }
            this.getHyperionVersion();
        });
    }

    getServerHash() {
        return this.last_commit_hash;
    }

    getHyperionVersion() {
        const packageJsonPath = join(import.meta.dirname, '../../../package.json');
        if (existsSync(packageJsonPath)) {
            const packageData = JSON.parse(readFileSync(packageJsonPath).toString()) as any;
            this.current_version = packageData.version;
            if (this.last_commit_hash === 'custom') {
                this.current_version = this.current_version + '-dirty';
            }
        } else {
            console.error('package.json not found');
            process.exit(1);
        }
    }

    prepareMongoClient() {
        if (this.mongodbClient) return;
        if (!this.conn.mongodb) {
            console.error('MongoDB connection not specified!');
            process.exit(1);
        }
        let uri = "mongodb://";
        if (this.conn.mongodb.user && this.conn.mongodb.pass) {
            uri += `${this.conn.mongodb.user}:${this.conn.mongodb.pass}@${this.conn.mongodb.host}:${this.conn.mongodb.port}`;
        } else {
            uri += `${this.conn.mongodb.host}:${this.conn.mongodb.port}`;
        }
        const {directConnection, replicaSet} = this.conn.mongodb;
        if (directConnection !== undefined && typeof directConnection !== 'boolean') {
            throw new Error('MongoDB directConnection must be a boolean');
        }
        if (replicaSet !== undefined && (typeof replicaSet !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(replicaSet))) {
            throw new Error('MongoDB replicaSet must be a bounded replica-set name');
        }
        const options = {
            ...(directConnection === undefined ? {} : {directConnection}),
            ...(replicaSet === undefined ? {} : {replicaSet}),
        };
        this.mongoConnection = {uri, options};
        this.mongodbClient = new MongoClient(uri, options);
    }
}
