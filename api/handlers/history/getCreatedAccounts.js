const {getCreatedAccountsSchema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");

const route = '/get_created_accounts';

async function getCreatedAccounts(fastify, request) {
    const t0 = Date.now();
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const results = await elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "body": {
            "query": {
                "bool": {
                    must: [
                        {term: {"act.authorization.actor": request.query.account.toLowerCase()}},
                        {term: {"act.name": "newaccount"}},
                        {term: {"act.account": process.env.SYSTEM_DOMAIN}}
                    ]
                }
            },
            sort: {
                "global_sequence": "desc"
            }
        }
    });
    const response = {
        "accounts": []
    };
    if (results['body']['hits']['hits'].length > 0) {
        const actions = results['body']['hits']['hits'];
        for (let action of actions) {
            action = action._source;
            const _tmp = {};
            if (action['act']['data']['newact']) {
                _tmp['name'] = action['act']['data']['newact'];
            } else if (action['@newaccount']['newact']) {
                _tmp['name'] = action['@newaccount']['newact'];
            } else {
                console.log(action);
            }
            _tmp['trx_id'] = action['trx_id'];
            _tmp['timestamp'] = action['@timestamp'];
            response.accounts.push(_tmp);
        }
    }
    response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get(route, {
        schema: getCreatedAccountsSchema.GET
    }, async (request) => {
        return await getCreatedAccounts(fastify, request);
    });
    next()
};
