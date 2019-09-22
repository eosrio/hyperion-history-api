const conf = require('../connections.json');
const redis = require("redis");
const elasticsearch = require('@elastic/elasticsearch');
const fetch = require('node-fetch');
const {StateHistorySocket} = require("./state-history");
const {amqpConnect, checkQueueSize} = require("./rabbitmq");
const {JsonRpc} = require('eosjs');

class ConnectionManager {

    constructor() {

    }

    async createAMQPChannels(onReconnect) {
        return await amqpConnect(onReconnect, conf.amqp);
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
}

module.exports = {ConnectionManager};
