const {getTransactionSchema} = require("../../schemas");
const _ = require('lodash');
const {getCacheByHash} = require("../../helpers/functions");
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

async function getTransaction(fastify, request) {
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const pResults = await Promise.all([rpc.get_info(), elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "body": {
            "query": {
                "bool": {
                    must: [
                        {term: {"trx_id": request.query.id.toLowerCase()}}
                    ]
                }
            },
            "sort": {
                "global_sequence": "asc"
            }
        }
    })]);
    const results = pResults[1];
    const response = {
        "trx_id": request.query.id,
        "lib": pResults[0].last_irreversible_block_num,
        "actions": []
    };
    if (results['body']['hits']['hits'].length > 0) {
        const actions = results['body']['hits']['hits'];
        for (let action of actions) {
            action = action._source;
            const name = action.act.name;
            if (action['@' + name]) {
                action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
                delete action['@' + name];
            }
            response.actions.push(action);
        }
    }
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_transaction', {
        schema: getTransactionSchema.GET
    }, async (request, reply) => {
        reply.send(await getTransaction(fastify, request));
    });
    next()
};
