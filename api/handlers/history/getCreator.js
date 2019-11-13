const {getCreatorSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");

const route = '/get_creator';

async function getActionByGS(client, gs) {
    console.log(gs);
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
    return results['body']['hits']['hits'][0]['_source'];
}

async function getCreator(fastify, request) {
    const {redis, elastic, eosjs} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query) + 'v3');
    if (cachedResponse) {
        return cachedResponse;
    }
    const newact = request.query.account;
    const response = {
        account: newact,
        creator: '',
        timestamp: '',
        block_num: 0,
        trx_id: '',
    };
    let account_data = null;
    try {
        account_data = await eosjs.rpc.get_account(newact);
    } catch (e) {
        const err = new Error();
        err.statusCode = 404;
        err.message = 'account not found';
        throw err;
    }
    response.timestamp = account_data['created'];
    const queryBody = {
        size: 1000,
        query: {
            bool: {
                must: [
                    {term: {"act.name": "newaccount"}},
                    {term: {"act.account": process.env.SYSTEM_DOMAIN}},
                    {term: {"@timestamp": account_data['created']}}
                ]
            }
        }
    };
    const results = await elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "body": queryBody
    });
    for (const action of results['body']['hits']['hits']) {
        const actData = action._source.act.data;
        let valid = false;
        response.block_num = action._source.block_num;
        if (actData.newact === newact) {
            response.creator = actData.creator;
            response['trx_id'] = action._source['trx_id'];
            valid = true;
        } else {
            if (action._source['@newaccount']) {
                if (action._source['@newaccount']['newact'] === newact) {
                    response.creator = actData.creator;
                    response['trx_id'] = action._source['trx_id'];
                    valid = true;
                }
            }
        }

        // if (action._source.parent !== 0 && valid) {
        //
        //     // Find indirect creator by global seq
        //     const creationAction = await getActionByGS(elastic, action._source.parent);
        //
        //     if (creationAction.act.name === 'transfer') {
        //         response['indirect_creator'] = creationAction['@transfer']['from'];
        //         response['trx_id'] = creationAction['trx_id'];
        //     } else {
        //         response['indirect_creator'] = creationAction.act.authorization[0].actor;
        //         response['trx_id'] = creationAction['trx_id'];
        //     }
        // }

    }

    redis.set(hash, JSON.stringify(response), 'EX', 600);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getCreatorSchema.GET
    }, async (request) => {
        return await getCreator(fastify, request);
    });
    next()
};
