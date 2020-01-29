const {getTransactionSchema} = require("../../schemas");
const _ = require('lodash');
const {getCacheByHash, mergeActionMeta} = require("../../helpers/functions");

async function getTransaction(fastify, request) {
    const {redis, elastic, eosjs} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const pResults = await Promise.all([eosjs.rpc.get_info(), elastic['search']({
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
    const hits = results['body']['hits']['hits'];
    if (hits.length > 0) {
        for (let action of hits) {
            action = action._source;
            mergeActionMeta(action);
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
