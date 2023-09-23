import {ConfigurationModule} from "../modules/config";
import {JsonRpc} from "eosjs";
import got from "got";
import {Client} from '@elastic/elasticsearch'
import {HyperionConnections} from "../interfaces/hyperionConnections";
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {amqpConnect, checkQueueSize, getAmpqUrl} from "./amqp";
import {StateHistorySocket} from "./state-history";
import fetch from 'cross-fetch';
import {exec} from "child_process";
import {hLog} from "../helpers/common_functions";

export class ConnectionManager {

    config: HyperionConfig;
    conn: HyperionConnections;

    chain: string;
    last_commit_hash: string;
    current_version: string;

    esIngestClients: Client[];
    esIngestClient: Client;

    constructor(private cm: ConfigurationModule) {
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

    get nodeosJsonRPC() {
        // @ts-ignore
        return new JsonRpc(this.conn.chains[this.chain].http, {fetch});
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
        let result;
        try {
            const data = await got(getAllQueuesFromVHost, opts);
            if (data) {
                result = JSON.parse(data.body);
            }
        } catch (e) {
            console.log(e.message);
            console.error('failed to connect to rabbitmq http api');
            process.exit(1);
        }
        if (result) {
            for (const queue of result) {
                if (queue.name.startsWith(this.chain + ":")) {
                    const msg_count = parseInt(queue.messages);
                    if (msg_count > 0) {
                        try {
                            await got.delete(apiUrl + `/api/queues/${vHost}/${queue.name}/contents`, opts);
                            hLog(`${queue.messages} messages deleted on queue ${queue.name}`);
                        } catch (e) {
                            console.log(e.message);
                            console.error('failed to connect to rabbitmq http api');
                            process.exit(1);
                        }
                    }
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
            ssl: _es.protocol === 'https' ? {
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
                    this.esIngestClient = new Client({
                        node: `${_es.protocol}://${_es.host}`,
                        auth: {
                            username: _es.user,
                            password: _es.pass
                        },
                        pingTimeout: 100,
                        ssl: _es.protocol === 'https' ? {
                            rejectUnauthorized: false
                        } : undefined
                    });
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

    async createAMQPChannels(onReconnect, onClose) {
        return await amqpConnect(onReconnect, this.conn.amqp, onClose);
    }

    async checkQueueSize(queue) {
        return await checkQueueSize(queue, this.conn.amqp);
    }

    get shipClient(): StateHistorySocket {
        return new StateHistorySocket(this.conn.chains[this.config.settings.chain]['ship'], this.config.settings.max_ws_payload_mb);
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
        this.current_version = require('../package.json').version;
        if (this.last_commit_hash === 'custom') {
            this.current_version = this.current_version + '-dirty';
        }
    }
}
