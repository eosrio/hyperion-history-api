const {getCacheByHash} = require("../../helpers/functions");

const schema = {
    description: 'get controlled accounts by controlling accounts',
    summary: 'get controlled accounts by controlling accounts',
    tags: ['state'],
    body: {
        type: ['object', 'string'],
        properties: {
            "controlling_account": {
                description: 'controlling account',
                type: 'string'
            },
        },
        required: ["controlling_account"]
    },
    response: {
        200: {
            type: 'object',
            properties: {
                "controlled_accounts": {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            }
        }
    }
};

async function getKeyAccounts(fastify, request) {
    const {redis, elastic} = fastify;
    if (typeof request.body === 'string') {
        request.body = JSON.parse(request.body)
    }
    let controlling_account = request.body.controlling_account;
    const [cachedResponse, hash] = await getCacheByHash(redis, JSON.stringify(request.body));
    if (cachedResponse) {
        return cachedResponse;
    }
    const results = await elastic.search({
        index: process.env.CHAIN + '-action-*',
        size: 100,
        body: {
            query: {
                bool: {
                    should: [
                        {term: {"@updateauth.auth.accounts.permission.actor": controlling_account}},
                        {term: {"@newaccount.active.keys.key.keyword": controlling_account}},
                        {term: {"@newaccount.owner.keys.key.keyword": controlling_account}}
                    ],
                    minimum_should_match: 1
                }
            },
            sort: [
                {"global_sequence": {"order": "desc"}}
            ]
        }
    });

    const response = {
        controlled_accounts: []
    };

    const hits = results['body']['hits']['hits'];
    if (hits.length > 0) {
        response.controlled_accounts = hits.map((v) => {
            if (v._source.act.name === 'newaccount') {
                if (v._source['@newaccount'].newact) {
                    return v._source['@newaccount'].newact;
                } else if (v._source.act.data.newact) {
                    return v._source.act.data.newact;
                } else {
                    return null;
                }
            } else if (v._source.act.name === 'updateauth') {
                return v._source.act.data.account;
            } else {
                return null;
            }
        });
    }
    if (response.controlled_accounts.length > 0) {
        response.controlled_accounts = [...(new Set(response.controlled_accounts))];
        redis.set(hash, JSON.stringify(response), 'EX', 30);
    }
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.post('/get_controlled_accounts', {schema}, async (request) => {
        return getKeyAccounts(fastify, request);
    });
    next()
};
