const amqp = require('amqplib');
const {getCacheByHash} = require("../helpers/functions");
const {getLastIndexedBlock} = require("../../helpers/functions");
const {ConnectionManager} = require('../../connections/manager');
const manager = new ConnectionManager();

const ecosystem = require('../../ecosystem.config');

function checkFeat(name) {
    return currentENV[name] === 'true';
}

const currentENV = ecosystem.apps.find(app => app.env.CHAIN === process.env.CHAIN && app.script === "./launcher.js")['env'];

// get current github version
let last_commit_hash;
require('child_process').exec('git rev-parse HEAD', function (err, stdout) {
    console.log('Last commit hash on this branch is:', stdout);
    last_commit_hash = stdout.trim();
});

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
    fastify.route({
        url: '/health',
        method: 'GET',
        schema: {
            tags: ['status'],
            summary: "API Service Health Report"
        },
        handler: async (request, reply) => {
            const t0 = Date.now();
            const {redis, elastic} = fastify;

            let cachedResponse, hash;
            [cachedResponse, hash] = await getCacheByHash(redis, 'health');
            if (cachedResponse) {
                cachedResponse = JSON.parse(cachedResponse);
                cachedResponse['query_time'] = Date.now() - t0;
                cachedResponse['cached'] = true;
                reply.send(cachedResponse);
                return;
            }

            let response = {
                version_hash: last_commit_hash,
                host: process.env.SERVER_NAME,
                features: {
                    indices: {
                        all_deltas: checkFeat('INDEX_ALL_DELTAS'),
                        transfer_memo: checkFeat('INDEX_TRANSFER_MEMO'),
                    },
                    tables: {
                        proposals: checkFeat('PROPOSAL_STATE'),
                        accounts: checkFeat('ACCOUNT_STATE'),
                        voters: checkFeat('VOTERS_STATE')
                    },
                    stream: {
                        traces: checkFeat('STREAM_TRACES'),
                        deltas: checkFeat('STREAM_DELTAS')
                    }
                },
                health: []
            };

            response.health.push(await checkRabbit());
            response.health.push(await checkNodeos());
            response.health.push(await checkRedis(redis));
            response.health.push(await checkElastic(elastic));
            response['query_time'] = Date.now() - t0;

            // prevent abuse of the health endpoint
            redis.set(hash, JSON.stringify(response), 'EX', 10);
            reply.send(response);
        }
    });
    next();
};
