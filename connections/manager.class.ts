import {ConfigurationModule} from "../modules/config";
import {JsonRpc} from "eosjs/dist";
import got from "got";
import {Client} from '@elastic/elasticsearch'
import {HyperionConnections} from "../interfaces/hyperionConnections";
import {HyperionConfig} from "../interfaces/hyperionConfig";
import {amqpConnect, checkQueueSize} from "./amqp";

const fetch = require('node-fetch');

export class ConnectionManager {

    config: HyperionConfig;
    conn: HyperionConnections;

    chain: string;

    constructor(private cm: ConfigurationModule) {
        this.config = cm.config;
        this.conn = cm.connections;
        this.chain = this.config.settings.chain;
    }

    get nodeosJsonRPC() {
        return new JsonRpc(this.conn.chains[this.chain].http, {fetch});
    }

    async purgeQueues() {
        console.log(`Purging all ${this.chain} queues!`);
        const apiUrl = `http://${this.conn.amqp.user}:${this.conn.amqp.pass}@${this.conn.amqp.api}`;
        const getAllQueuesFromVHost = apiUrl + `/api/queues/%2F${this.conn.amqp.vhost}`;
        const result = JSON.parse((await got(getAllQueuesFromVHost)).body);
        for (const queue of result) {
            if (queue.name.startsWith(this.chain + ":")) {
                const msg_count = parseInt(queue.messages);
                if (msg_count > 0) {
                    try {
                        await got.delete(apiUrl + `/api/queues/%2F${this.conn.amqp.vhost}/${queue.name}/contents`);
                        console.log(`${queue.messages} messages deleted on queue ${queue.name}`);
                    } catch (e) {
                        console.log(e);
                        process.exit(1);
                    }
                }
            }
        }
    }

    getESClient() {
        let es_url;
        const _es = this.conn.elasticsearch;
        if (_es.user !== '') {
            es_url = `http://${_es.user}:${_es.pass}@${_es.host}`;
        } else {
            es_url = `http://${_es.host}`
        }
        return new Client({node: es_url});
    }

    get elasticsearchClient() {
        return this.getESClient();
    }

    get ingestClients() {
        const _es = this.conn.elasticsearch;
        if (_es.ingest_nodes) {
            if (_es.ingest_nodes.length > 0) {
                const clients = [];
                for (const node of _es.ingest_nodes) {
                    let es_url;
                    if (_es.user !== '') {
                        es_url = `http://${_es.user}:${_es.pass}@${node}`;
                    } else {
                        es_url = `http://${node}`
                    }
                    clients.push(new Client({node: es_url, pingTimeout: 100}));
                }
                return clients;
            } else {
                return [this.getESClient()];
            }
        } else {
            return [this.getESClient()];
        }
    }

    async createAMQPChannels(onReconnect) {
        return await amqpConnect(onReconnect, this.conn.amqp);
    }

    async checkQueueSize(queue) {
        return await checkQueueSize(queue, this.conn.amqp);
    }
}
