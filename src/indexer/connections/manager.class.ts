import {ConfigurationModule} from "../modules/config.js";
import {Client} from '@elastic/elasticsearch'
import {HyperionConnections} from "../../interfaces/hyperionConnections.js";
import {HyperionConfig} from "../../interfaces/hyperionConfig.js";
import {amqpConnect, checkQueueSize, getAmpqUrl} from "./amqp.js";
import {StateHistorySocket} from "./state-history.js";
import {exec} from "child_process";
import {hLog} from "../helpers/common_functions.js";
import {join} from "node:path";
import {existsSync, readFileSync} from "fs";
import {MongoClient} from "mongodb";
import {APIClient} from "@wharfkit/antelope";

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

    get nodeosApiClient() {
        return new APIClient({fetch, url: this.conn.chains[this.chain].http});
    }

    async purgeQueues() {
        hLog(`Purging all ${this.chain} queues!`);
        const apiUrl = `http://${this.conn.amqp.api}`;
        const vHost = encodeURIComponent(this.conn.amqp.vhost);
        const getAllQueuesFromVHost = apiUrl + `/api/queues/${vHost}`;
        const opts = {
            username: this.conn.amqp.user,
            password: this.conn.amqp.pass
        };

        let result: any[] = [];

        try {

            const headers = new Headers();
            headers.set('Authorization', 'Basic ' + Buffer.from(opts.username + ":" + opts.password).toString('base64'));
            result = await (await fetch(getAllQueuesFromVHost, {headers})).json();

            // Got Impl
            // const data = await got(getAllQueuesFromVHost, opts);
            // if (data) {
            //     result = JSON.parse(data.body);
            // }
        } catch (e: any) {
            console.log(e.message);
            console.error('failed to connect to rabbitmq http api');
            process.exit(1);
        }

        for (const queue of result) {
            if (queue.name.startsWith(this.chain + ":")) {
                hLog(`Deleting queue ${queue.name}`);
                try {

                    const headers = new Headers();
                    headers.set('Authorization', 'Basic ' + Buffer.from(opts.username + ":" + opts.password).toString('base64'));
                    await fetch(apiUrl + `/api/queues/${vHost}/${queue.name}`, {
                        method: "DELETE",
                        headers
                    });

                    // await got.delete(apiUrl + `/api/queues/${vHost}/${queue.name}/contents`, opts);

                    hLog(`${queue.messages} messages deleted on queue ${queue.name}`);
                } catch (e: any) {
                    console.log(e.message);
                    console.error('failed to connect to rabbitmq http api');
                    process.exit(1);
                }
            }
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
            } : undefined
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
                        node: `${_es.protocol}://${_es.host}`,
                        auth: {
                            username: _es.user,
                            password: _es.pass
                        },
                        pingTimeout: 100,
                        tls: _es.protocol === 'https' ? {
                            rejectUnauthorized: false
                        } : undefined
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
            this.config.settings.max_ws_payload_mb
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
        this.mongodbClient = new MongoClient(uri);
    }
}
