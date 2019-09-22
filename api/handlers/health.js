const amqp = require('amqplib');
const {ConnectionManager} = require('../../connections/manager');
const manager = new ConnectionManager();

function createHealth(name, status) {
    let time = Date.now();
    return {
        service: name,
        status: status,
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

module.exports = function (fastify, opts, next) {
    fastify.get('/health', {}, async (request, reply) => {
        const t0 = Date.now();
        const {redis, elastic} = fastify;
        let response = {
            health: []
        };
        response.health.push(await checkRabbit());
        response.health.push(await checkRedis(redis));

        try {
            let esStatus = (await elastic.cat.health({
                format: 'json',
                v: true
            }))['body'];
            let stat = 'OK';
            esStatus.forEach(status => {
                if (status.status === 'yellow' && stat !== 'Error') {
                    stat = 'Warning'
                } else if (status.status === 'red') {
                    stat = 'Error'
                }
            });
            response.health.push(createHealth('Elasticsearch', stat));
        } catch (e) {
            console.log(e, 'Elasticsearch Error');
            response.health.push(createHealth('Elasticsearch', 'Error'));
        }
        response['query_time'] = Date.now() - t0;
        reply.send(response);
    });
    next();
};
