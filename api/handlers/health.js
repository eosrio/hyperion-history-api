const amqp = require('amqplib');
const {getLastIndexedBlock} = require("../../helpers/functions");
const {ConnectionManager} = require('../../connections/manager');
const manager = new ConnectionManager();

function createHealth(name, status, data) {
    let time = Date.now();
    return {
        service: name,
        status: status,
        service_data: data,
        time: time
    }
}

async function checkRedis(redis) {
    let result = await new Promise((resolve) => {
        redis.get(process.env.CHAIN + ":" + 'abi_cache', (err, data) => {
            if (err) {
                resolve('Error');
            } else {
                try {
                    const json = JSON.parse(data);
                    if (json['eosio']) {
                        resolve('OK');
                    } else {
                        resolve('Missing eosio on ABI cache.');
                    }
                } catch (e) {
                    console.log(e);
                    resolve('Error');
                }
            }
        });
        resolve('OK');
    });
    return createHealth('Redis', result)
}

async function checkRabbit() {
    const amqp_url = manager.ampqUrl;
    try {
        const connection = await amqp.connect(amqp_url);
        connection.close();
        return createHealth('RabbitMq', 'OK');
    } catch (e) {
        console.log(e);
        return createHealth('RabbitMq', 'Error');
    }
}

async function checkNodeos() {
    const rpc = manager.nodeosJsonRPC;
    try {
        const results = await rpc.get_info();
        if (results) {
            return createHealth('NodeosRPC', 'OK', {
                head_block_num: results.head_block_num,
                last_irreversible_block: results.last_irreversible_block_num,
                chain_id: results.chain_id
            });
        } else {
            return createHealth('NodeosRPC', 'Error');
        }
    } catch (e) {
        return createHealth('NodeosRPC', 'Error');
    }
}

async function checkElastic(elastic) {
    try {
        let esStatus = await elastic.cat.health({format: 'json', v: true});
        let lastIndexedBlock = await getLastIndexedBlock(elastic);
        const data = {
            last_indexed_block: lastIndexedBlock,
            active_shards: esStatus.body[0]['active_shards_percent']
        };
        let stat = 'OK';
        esStatus.body.forEach(status => {
            if (status.status === 'yellow' && stat !== 'Error') {
                stat = 'Warning'
            } else if (status.status === 'red') {
                stat = 'Error'
            }
        });
        return createHealth('Elasticsearch', stat, data);
    } catch (e) {
        console.log(e, 'Elasticsearch Error');
        return createHealth('Elasticsearch', 'Error');
    }
}

module.exports = function (fastify, opts, next) {
    fastify.get('/health', {}, async (request, reply) => {
        const t0 = Date.now();
        const {redis, elastic} = fastify;

        let response = {
            health: []
        };

        response.health.push(await checkRabbit());
        response.health.push(await checkNodeos());
        response.health.push(await checkRedis(redis));
        response.health.push(await checkElastic(elastic));

        response['query_time'] = Date.now() - t0;

        reply.send(response);
    });
    next();
};
