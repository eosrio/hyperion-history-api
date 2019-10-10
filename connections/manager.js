let conf;
try {
    conf = require('../connections.json');
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
const prettyjson = require('prettyjson');

class ConnectionManager {

    constructor() {

    }

    async createAMQPChannels(onReconnect) {
        return await amqpConnect(onReconnect, conf.amqp);
    }

    get ampqUrl() {
        return `amqp://${conf.amqp.user}:${conf.amqp.pass}@${conf.amqp.host}/%2F${conf.amqp.vhost}`;
    }

    async checkQueueSize(queue) {
        return await checkQueueSize(queue, conf.amqp);
    }

    get shipClient() {
        return new StateHistorySocket(conf.chains[process.env.CHAIN]['ship']);
    }

    get redisOptions() {
        return {
            host: conf.redis.host,
            port: conf.redis.port
        };
    }

    get redisClient() {
        return redis.createClient(this.redisOptions);
    }

    get elasticsearchClient() {
        let es_url;
        if (conf.elasticsearch.user !== '') {
            es_url = `http://${conf.elasticsearch.user}:${conf.elasticsearch.pass}@${conf.elasticsearch.host}`;
        } else {
            es_url = `http://${conf.elasticsearch.host}`
        }
        return new elasticsearch.Client({node: es_url});
    }

    get nodeosJsonRPC() {
        return new JsonRpc(conf.chains[process.env.CHAIN]['http'], {fetch});
    }

    async purgeQueues(queue_prefix) {
        console.log(`Purging all ${queue_prefix} queues!`);
        const apiUrl = `http://${conf.amqp.user}:${conf.amqp.pass}@${conf.amqp.api}`;
        const getAllQueuesFromVHost = apiUrl + `/api/queues/%2F${conf.amqp.vhost}`;
        const result = JSON.parse((await got(getAllQueuesFromVHost)).body);
        for (const queue of result) {
            if (queue.name.startsWith(queue_prefix + ":")) {
                const msg_count = parseInt(queue.messages);
                if (msg_count > 0) {
                    try {
                        await got.delete(apiUrl + `/api/queues/%2F${conf.amqp.vhost}/${queue.name}/contents`);
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
