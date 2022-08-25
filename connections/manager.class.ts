import { Client } from '@elastic/elasticsearch';
import { exec } from "child_process";
import fetch from 'cross-fetch';
import { JsonRpc } from "eosjs/dist";
import got from "got";
import { hLog } from "../helpers/common_functions";
import { HyperionConfig } from "../interfaces/hyperionConfig";
import { HyperionConnections } from "../interfaces/hyperionConnections";
import { ConfigurationModule } from "../modules/config";
import { amqpConnect, checkQueueSize, getAmpqUrl } from "./amqp";
import { StateHistorySocket } from "./state-history";

export class ConnectionManager {

    config: HyperionConfig;
    conn: HyperionConnections;

    chain: string;
    last_commit_hash: string;
    current_version: string;

    private esIngestClients: Client[];
    private esIngestClient: Client;

    constructor(private cm: ConfigurationModule) {
        this.config = cm.config;
        this.conn = cm.connections;
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
        const getAllQueuesFromVHost = apiUrl + `/api/queues/%2F${this.conn.amqp.vhost}`;
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
                            await got.delete(apiUrl + `/api/queues/%2F${this.conn.amqp.vhost}/${queue.name}/contents`, opts);
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
        let es_url;
        const _es = this.conn.elasticsearch;
        if (!_es.protocol) {
            _es.protocol = 'http';
        }
        if (_es.user !== '') {
            es_url = `${_es.protocol}://${_es.user}:${_es.pass}@${_es.host}`;
        } else {
            es_url = `${_es.protocol}://${_es.host}`
        }
        this.esIngestClient = new Client({
            requestTimeout: 120000,
            node: es_url,
            ssl: {
                rejectUnauthorized: false
            }
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
                    let es_url;
                    if (_es.user !== '') {
                        es_url = `${_es.protocol}://${_es.user}:${_es.pass}@${node}`;
                    } else {
                        es_url = `${_es.protocol}://${node}`
                    }
                    this.esIngestClients.push(new Client({
                        requestTimeout: 120000,
                        node: es_url,
                        pingTimeout: 100,
                        ssl: {
                            rejectUnauthorized: false
                        }
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

    async createAMQPChannels(onReconnect, onClose) {
        return await amqpConnect(onReconnect, this.conn.amqp, onClose);
    }

    async checkQueueSize(queue) {
        return await checkQueueSize(queue, this.conn.amqp);
    }

    get shipClient(): StateHistorySocket {
        return new StateHistorySocket(this.conn.chains[this.config.settings.chain]['ship'], this.config.settings.max_ws_payload_kb);
    }

    get ampqUrl() {
        return getAmpqUrl(this.conn.amqp);
    }

    calculateServerHash() {
        exec('git rev-parse HEAD', (err, stdout) => {
            console.log('Last commit hash on this branch is:', stdout);
            this.last_commit_hash = stdout.trim();
        });
    }

    getServerHash() {
        return this.last_commit_hash;
    }

    getHyperionVersion() {
        this.current_version = require('../package.json').version
    }
}
