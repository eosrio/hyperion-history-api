import got from "got";
import { JsonRpc } from "enf-eosjs";
import { Client } from '@elastic/elasticsearch';
import { amqpConnect, checkQueueSize, getAmpqUrl } from "./amqp.js";
import { StateHistorySocket } from "./state-history.js";
import fetch from 'cross-fetch';
import { exec } from "node:child_process";
import { hLog } from "../helpers/common_functions.js";
import { readFileSync } from "node:fs";
export class ConnectionManager {
    cm;
    config;
    conn;
    chain;
    last_commit_hash;
    current_version;
    esIngestClients;
    esIngestClient;
    constructor(cm) {
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
    get nodeosJsonRPC() {
        // @ts-ignore
        return new JsonRpc(this.conn.chains[this.chain].http, { fetch });
    }
    async purgeQueues() {
        const conf = this.conn.amqp;
        hLog(`Purging all ${this.chain} queues!`);
        const apiUrl = `${conf.protocol}://${conf.api}`;
        const vHost = encodeURIComponent(conf.vhost);
        const getAllQueuesFromVHost = apiUrl + `/api/queues/${vHost}`;
        const opts = {
            username: conf.user,
            password: conf.pass
        };
        let result;
        try {
            const data = await got(getAllQueuesFromVHost, opts);
            if (data) {
                result = JSON.parse(data.body);
            }
        }
        catch (e) {
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
                        }
                        catch (e) {
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
        }
        else {
            es_url = `${_es.protocol}://${_es.host}`;
        }
        this.esIngestClient = new Client({
            node: es_url,
            tls: { rejectUnauthorized: false }
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
                    }
                    else {
                        es_url = `${_es.protocol}://${node}`;
                    }
                    this.esIngestClients.push(new Client({
                        node: es_url,
                        pingTimeout: 100,
                        tls: { rejectUnauthorized: false }
                    }));
                }
            }
        }
    }
    get ingestClients() {
        if (this.esIngestClients.length > 0) {
            return this.esIngestClients;
        }
        else {
            return [this.esIngestClient];
        }
    }
    async createAMQPChannels(onReconnect, onClose) {
        return await amqpConnect(onReconnect, this.conn.amqp, onClose);
    }
    async checkQueueSize(queue) {
        return await checkQueueSize(queue, this.conn.amqp);
    }
    get shipClient() {
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
            }
            else {
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
        const pkg = JSON.parse(readFileSync('../package.json').toString());
        this.current_version = pkg.version;
        if (this.last_commit_hash === 'custom') {
            this.current_version = this.current_version + '-dirty';
        }
    }
}
