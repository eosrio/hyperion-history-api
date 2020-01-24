let conn;
try {
    conn = require('../connections.json');
} catch (e) {
    console.log(e);
    console.log(`Failed to parse connections.json!`);
    process.exit(1);
}
const redis = require("redis");
const elasticsearch = require('@elastic/elasticsearch');
const fetch = require('node-fetch');
const {StateHistorySocket} = require("./state-history");
const {amqpConnect, checkQueueSize} = require("./rabbitmq");
const {JsonRpc} = require('eosjs');
const got = require('got');
const config = require(`../${process.env.CONFIG_JSON}`);

class ConnectionManager {

    constructor() {

    }

    async createAMQPChannels(onReconnect) {
        return await amqpConnect(onReconnect, conn.amqp);
    }

    get ampqUrl() {
        const _amqp = conn.amqp;
        return `amqp://${_amqp.user}:${_amqp.pass}@${_amqp.host}/%2F${_amqp.vhost}`;
    }

    async checkQueueSize(queue) {
        return await checkQueueSize(queue, conn.amqp);
    }

    get shipClient() {
        return new StateHistorySocket(conn.chains[config.settings.chain]['ship']);
    }

    get redisOptions() {
        return {
            host: conn.redis.host,
            port: conn.redis.port
        };
    }

    get redisClient() {
        return redis.createClient(this.redisOptions);
    }

    getESClient() {
        let es_url;
        const _es = conn['elasticsearch'];
        if (_es.user !== '') {
            es_url = `http://${_es.user}:${_es.pass}@${_es.host}`;
        } else {
            es_url = `http://${_es.host}`
        }
        return new elasticsearch.Client({node: es_url});
    }

    get elasticsearchClient() {
        return this.getESClient();
    }

    get ingestClients() {
        const _es = conn['elasticsearch'];
        if (_es['ingest_nodes']) {
            const clients = [];
            const nodes = _es['ingest_nodes'];
            if (nodes.length > 0) {
                for (const node of nodes) {
                    let es_url;
                    const _user = _es['user'];
                    const _pass = _es['pass'];
                    if (_es['user'] !== '') {
                        es_url = `http://${_user}:${_pass}@${node}`;
                    } else {
                        es_url = `http://${node}`
                    }
                    clients.push(new elasticsearch.Client({node: es_url, pingTimeout: 100}));
                }
            }
            return clients;
        } else {
            return [this.getESClient()];
        }
    }

    get nodeosJsonRPC() {
        return new JsonRpc(conn.chains[config.settings.chain]['http'], {fetch});
    }

    async purgeQueues(queue_prefix) {
        console.log(`Purging all ${queue_prefix} queues!`);
        const apiUrl = `http://${conn.amqp.user}:${conn.amqp.pass}@${conn.amqp.api}`;
        const getAllQueuesFromVHost = apiUrl + `/api/queues/%2F${conn.amqp.vhost}`;
        const result = JSON.parse((await got(getAllQueuesFromVHost)).body);
        for (const queue of result) {
            if (queue.name.startsWith(queue_prefix + ":")) {
                const msg_count = parseInt(queue.messages);
                if (msg_count > 0) {
                    try {
                        await got.delete(apiUrl + `/api/queues/%2F${conn.amqp.vhost}/${queue.name}/contents`);
                        console.log(`${queue.messages} messages deleted on queue ${queue.name}`);
                    } catch (e) {
                        console.log(e);
                        process.exit(1);
                    }
                }
            }
        }
    }
}

module.exports = {ConnectionManager};
