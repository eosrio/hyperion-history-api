const {getCreatorSchema} = require("../schemas");
const {getCacheByHash} = require("../helpers/functions");
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

async function getActionByGS(client, gs) {
    const results = await client['search']({
        index: process.env.CHAIN + '-action-*',
        body: {
            query: {
                bool: {
                    must: [
                        {term: {"global_sequence": gs}}
                    ]
                }
            }
        }
    });
    return results['hits']['hits'][0]['_source'];
}

async function getCreator(fastify, request) {
    const {redis, elasticsearch} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const newact = request.query.account;
    const response = {
        account: newact,
        creator: '',
        timestamp: '',
        trx_id: '',
    };
    let account_data = null;
    try {
        account_data = await rpc.get_account(newact);
    } catch (e) {
        console.log(e);
    }
    if (!account_data) {
        response['error'] = 'account not found';
        return response;
    }
    response.timestamp = account_data['created'];
    const queryBody = {
        size: 1000,
        query: {
            bool: {
                must: [
                    {term: {"act.name": "newaccount"}},
                    {term: {"act.account": "eosio"}},
                    {term: {"@timestamp": account_data['created']}}
                ]
            }
        }
    };
    const results = await elasticsearch['search']({
        "index": process.env.CHAIN + '-action-*',
        "body": queryBody
    });
    for (const action of results['hits']['hits']) {
        const actData = action._source.act.data;
        if (actData.newact === newact) {
            response.creator = actData.creator;
            response['trx_id'] = action._source['trx_id'];
            if (action._source.parent !== 0) {
                // Find indirect creator by global seq
                const parent_result = await getActionByGS(elasticsearch, action._source.parent);
                const creationAction = parent_result;
                if (creationAction.act.name === 'transfer') {
                    response['indirect_creator'] = creationAction['@transfer']['from'];
                    response['trx_id'] = creationAction['trx_id'];
                } else {
                    console.log(creationAction);
                }
            }
        }
    }
    redis.set(hash, JSON.stringify(response), 'EX', 3600);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_creator', {
        schema: getCreatorSchema.GET
    }, async (request, reply) => {
        reply.send(await getCreator(fastify, request));
    });
    next()
};
